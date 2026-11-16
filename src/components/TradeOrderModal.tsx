"use client";

import { useEffect, useMemo, useState } from "react";
import type { TradeSignalPick } from "./MarketScanner";

export interface OrderTargetItem {
  symbol: string;
  lastPrice: number;
  pick: TradeSignalPick;
}

interface SymbolRule {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

const short = (s: string) => s.replace(/USDT$/, "");

function fmtKrw(usd: number, rate: number): string {
  const won = usd * rate;
  if (!Number.isFinite(won)) return "-";
  const abs = Math.abs(won);
  const sign = won < 0 ? "-" : "";
  if (abs >= 100) return `${sign}₩${Math.round(abs).toLocaleString("ko-KR")}`;
  if (abs >= 1) return `${sign}₩${abs.toFixed(2)}`;
  return `${sign}₩${Number(abs.toPrecision(3))}`;
}

function parseRecommendedLev(rec: string): number {
  const m = rec.match(/(\d+)\s*x/i);
  return m ? Math.min(50, Math.max(1, Number(m[1]))) : 5;
}

export default function TradeOrderModal({
  item,
  fxRate,
  onClose,
}: {
  item: OrderTargetItem;
  fxRate: number;
  onClose: () => void;
}) {
  const { symbol, lastPrice, pick } = item;

  // 계좌 잔고 & 심볼 규칙 상태
  const [availUsdt, setAvailUsdt] = useState<number | null>(null);
  const [totalUsdt, setTotalUsdt] = useState<number | null>(null);
  const [rule, setRule] = useState<SymbolRule>({
    tickSize: 0.0001,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
  });
  const [balErr, setBalErr] = useState("");

  // 주문 폼 상태
  const [side, setSide] = useState<"LONG" | "SHORT">(pick.side);
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [marginType, setMarginType] = useState<"ISOLATED" | "CROSSED">("ISOLATED");
  const [leverage, setLeverage] = useState<number>(() =>
    parseRecommendedLev(pick.recLeverage)
  );
  const [marginUsdt, setMarginUsdt] = useState<string>("50");
  const [entryPrice, setEntryPrice] = useState<string>(() =>
    String(Number(pick.entryPrice.toPrecision(6)))
  );

  // TP / SL 상태
  const [enableSl, setEnableSl] = useState(true);
  const [stopLoss, setStopLoss] = useState<string>(() =>
    String(Number(pick.stopLoss.toPrecision(6)))
  );
  const [enableTp1, setEnableTp1] = useState(true);
  const [tp1, setTp1] = useState<string>(() =>
    String(Number(pick.tp1.toPrecision(6)))
  );
  const [tp1RatioPct, setTp1RatioPct] = useState<number>(50);
  const [enableTp2, setEnableTp2] = useState(true);
  const [tp2, setTp2] = useState<string>(() =>
    String(Number(pick.tp2.toPrecision(6)))
  );

  // 전송 상태
  const [confirmStep, setConfirmStep] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultLogs, setResultLogs] = useState<string[]>([]);
  const [submitErr, setSubmitErr] = useState("");

  // 계좌 가용 잔고 & 심볼 정밀도 불러오기
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/order?symbol=${symbol}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setBalErr(data.error || "잔고 조회 실패");
          return;
        }
        setAvailUsdt(data.availableBalance ?? 0);
        setTotalUsdt(data.balance ?? 0);
        if (data.rule) setRule(data.rule);
      } catch (e) {
        if (!cancelled) setBalErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // 주문 방식(시장가 vs 눌림 지정가) 변경 시 추천 진입가 자동 세팅
  const handleOrderTypeChange = (next: "MARKET" | "LIMIT") => {
    setOrderType(next);
    setConfirmStep(false);
    if (next === "MARKET") {
      setEntryPrice(String(Number(lastPrice.toPrecision(6))));
    } else {
      setEntryPrice(String(Number(pick.limitEntryPrice.toPrecision(6))));
    }
  };

  // 실시간 수량 & 예상 손익(PnL) 시뮬레이션 계산
  const sim = useMemo(() => {
    const mUsdt = parseFloat(marginUsdt) || 0;
    const ePx = orderType === "MARKET" ? lastPrice : parseFloat(entryPrice) || lastPrice;
    const notionalUsdt = mUsdt * leverage;
    const rawQty = ePx > 0 ? notionalUsdt / ePx : 0;

    // stepSize 내림 수량
    const inv = rule.stepSize > 0 ? Math.round(1 / rule.stepSize) : 1000;
    const qty = Math.floor(rawQty * inv + 1e-9) / inv;
    const actualNotional = qty * ePx;

    const dir = side === "LONG" ? 1 : -1;
    const slPx = parseFloat(stopLoss) || 0;
    const tp1Px = parseFloat(tp1) || 0;
    const tp2Px = parseFloat(tp2) || 0;

    // 손절 시 예상 손익 (USDT)
    const slPnlUsdt = slPx > 0 ? (slPx - ePx) * dir * qty : 0;
    const slRoiPct = mUsdt > 0 ? (slPnlUsdt / mUsdt) * 100 : 0;

    // TP1 & TP2 예상 수익 (USDT)
    const r1 = enableTp1 && enableTp2 ? tp1RatioPct / 100 : enableTp1 ? 1 : 0;
    const r2 = enableTp2 ? 1 - r1 : 0;

    const tp1PnlUsdt = tp1Px > 0 ? (tp1Px - ePx) * dir * (qty * r1) : 0;
    const tp2PnlUsdt = tp2Px > 0 ? (tp2Px - ePx) * dir * (qty * r2) : 0;
    const totalTpUsdt = tp1PnlUsdt + tp2PnlUsdt;
    const totalTpRoiPct = mUsdt > 0 ? (totalTpUsdt / mUsdt) * 100 : 0;

    return {
      mUsdt,
      ePx,
      notionalUsdt,
      qty,
      actualNotional,
      slPnlUsdt,
      slRoiPct,
      tp1PnlUsdt,
      tp2PnlUsdt,
      totalTpUsdt,
      totalTpRoiPct,
    };
  }, [
    marginUsdt,
    orderType,
    lastPrice,
    entryPrice,
    leverage,
    rule.stepSize,
    side,
    stopLoss,
    tp1,
    tp2,
    enableTp1,
    enableTp2,
    tp1RatioPct,
  ]);

  const submitOrder = async () => {
    setSubmitting(true);
    setSubmitErr("");
    setResultLogs([]);
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          side,
          orderType,
          leverage,
          marginType,
          marginUsdt: parseFloat(marginUsdt) || 0,
          entryPrice:
            orderType === "MARKET" ? lastPrice : parseFloat(entryPrice) || lastPrice,
          enableSl,
          stopLoss: parseFloat(stopLoss) || undefined,
          enableTp1,
          tp1: parseFloat(tp1) || undefined,
          tp1RatioPct,
          enableTp2,
          tp2: parseFloat(tp2) || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "주문 실패");
      }
      setResultLogs(data.logs || ["✅ 주문이 정상 접수되었습니다."]);
      setConfirmStep(false);
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
        {/* 상단 헤더 */}
        <div className="flex items-start justify-between border-b border-neutral-800 pb-3.5">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-black text-white">{short(symbol)}</span>
              <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-300">
                {symbol} Perp
              </span>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-black ${
                  side === "LONG"
                    ? "bg-emerald-500 text-black"
                    : "bg-rose-500 text-white"
                }`}
              >
                {side === "LONG" ? "🟢 LONG" : "🔴 SHORT"}
              </span>
              <span className="text-xs font-bold text-amber-400">
                ({pick.strategyName})
              </span>
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              현재 시장가:{" "}
              <strong className="text-white">{fmtKrw(lastPrice, fxRate)}</strong>{" "}
              <span className="font-mono text-neutral-300">(${lastPrice})</span> · AI 권장 레버리지:{" "}
              <strong className="text-amber-300">{pick.recLeverage}</strong>
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs font-bold text-neutral-300 hover:bg-neutral-700"
          >
            ✕ 닫기
          </button>
        </div>

        {/* 선물 계좌 가용 잔고 바 */}
        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-xs">
          <div className="flex items-center gap-3">
            <span className="text-neutral-400">선물 주문 가능 잔고:</span>
            {availUsdt !== null ? (
              <span className="font-extrabold text-emerald-400">
                {fmtKrw(availUsdt, fxRate)}{" "}
                <span className="font-mono text-neutral-300">
                  (${availUsdt.toFixed(2)} USDT)
                </span>
              </span>
            ) : balErr ? (
              <span className="text-rose-400">{balErr}</span>
            ) : (
              <span className="text-neutral-500">잔고 조회 중…</span>
            )}
          </div>
          {totalUsdt !== null && (
            <span className="text-neutral-500">
              총 선물 지갑: ${totalUsdt.toFixed(2)} USDT
            </span>
          )}
        </div>

        {/* 1. 포지션 방향 & 진입 방식 & 마진 모드 */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* 방향 */}
          <div>
            <label className="mb-1 block text-[11px] font-bold text-neutral-400">
              포지션 방향
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setSide("LONG")}
                className={`rounded-lg py-2 text-xs font-black transition ${
                  side === "LONG"
                    ? "bg-emerald-500 text-black"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                🟢 LONG (매수)
              </button>
              <button
                type="button"
                onClick={() => setSide("SHORT")}
                className={`rounded-lg py-2 text-xs font-black transition ${
                  side === "SHORT"
                    ? "bg-rose-500 text-white"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                🔴 SHORT (매도)
              </button>
            </div>
          </div>

          {/* 주문 유형 */}
          <div>
            <label className="mb-1 block text-[11px] font-bold text-neutral-400">
              진입 방식
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => handleOrderTypeChange("MARKET")}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  orderType === "MARKET"
                    ? "bg-amber-500 text-black"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                ⚡ 시장가 즉시
              </button>
              <button
                type="button"
                onClick={() => handleOrderTypeChange("LIMIT")}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  orderType === "LIMIT"
                    ? "bg-amber-500 text-black"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                🎯 눌림 지정가
              </button>
            </div>
          </div>

          {/* 마진 모드 */}
          <div>
            <label className="mb-1 block text-[11px] font-bold text-neutral-400">
              마진 모드
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setMarginType("ISOLATED")}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  marginType === "ISOLATED"
                    ? "bg-neutral-200 text-black"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                격리 (Isolated)
              </button>
              <button
                type="button"
                onClick={() => setMarginType("CROSSED")}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  marginType === "CROSSED"
                    ? "bg-neutral-200 text-black"
                    : "border border-neutral-800 bg-neutral-950 text-neutral-400"
                }`}
              >
                교차 (Cross)
              </button>
            </div>
          </div>
        </div>

        {/* 2. 레버리지 & 투입 증거금 & 진입가 */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 레버리지 선택 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-neutral-300">레버리지 배율</span>
              <span className="text-base font-black text-amber-400">{leverage}x</span>
            </div>
            <input
              type="range"
              min={1}
              max={30}
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="mt-2 w-full accent-amber-500"
            />
            <div className="mt-1.5 flex gap-1">
              {[2, 3, 5, 7, 10, 15, 20].map((lv) => (
                <button
                  key={lv}
                  type="button"
                  onClick={() => setLeverage(lv)}
                  className={`flex-1 rounded py-1 text-[11px] font-bold ${
                    leverage === lv
                      ? "bg-amber-500 text-black"
                      : "bg-neutral-800 text-neutral-400 hover:text-white"
                  }`}
                >
                  {lv}x
                </button>
              ))}
            </div>
          </div>

          {/* 투입 증거금 (USDT) */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-neutral-300">투입 증거금 (Margin USDT)</span>
              <span className="font-bold text-emerald-400">
                ≈ {fmtKrw(parseFloat(marginUsdt) || 0, fxRate)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                step="any"
                value={marginUsdt}
                onChange={(e) => setMarginUsdt(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-sm font-bold text-white"
                placeholder="투입할 USDT 금액"
              />
              <span className="text-xs font-bold text-neutral-400">USDT</span>
            </div>
            <div className="mt-1.5 flex gap-1">
              {availUsdt && availUsdt > 0
                ? [10, 25, 50, 75, 95].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() =>
                        setMarginUsdt(String(Math.floor((availUsdt * pct) / 100)))
                      }
                      className="flex-1 rounded bg-neutral-800 py-1 text-[11px] font-semibold text-neutral-300 hover:bg-neutral-700"
                    >
                      {pct}%
                    </button>
                  ))
                : [20, 50, 100, 200, 500].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setMarginUsdt(String(amt))}
                      className="flex-1 rounded bg-neutral-800 py-1 text-[11px] font-semibold text-neutral-300 hover:bg-neutral-700"
                    >
                      ${amt}
                    </button>
                  ))}
            </div>
          </div>
        </div>

        {/* 지정가 선택 시 진입가 입력창 */}
        {orderType === "LIMIT" && (
          <div className="mt-3 rounded-xl border border-amber-800/50 bg-amber-950/15 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-amber-300">
                🎯 지정가 진입 가격 (USD) — 원화 약{" "}
                {fmtKrw(parseFloat(entryPrice) || 0, fxRate)}
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setEntryPrice(String(Number(pick.limitEntryPrice.toPrecision(6))))
                  }
                  className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-neutral-700"
                >
                  AI 눌림 추천가 (${Number(pick.limitEntryPrice.toPrecision(6))})
                </button>
                <button
                  type="button"
                  onClick={() => setEntryPrice(String(Number(lastPrice.toPrecision(6))))}
                  className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
                >
                  현재가 (${Number(lastPrice.toPrecision(6))})
                </button>
              </div>
            </div>
            <input
              type="number"
              step="any"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm font-bold text-white"
            />
          </div>
        )}

        {/* 3. TP / SL 동시 예약 주문 설정 */}
        <div className="mt-4 space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-950 p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold text-white">
              🛡️ 익절(TP) · 손절(SL/SP) 자동 예약 주문 (체결 시 조건부 마켓 주문 동시 등록)
            </span>
            <span className="text-[11px] text-neutral-400">
              기대 손익비 1 : {pick.rrRatio}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {/* 손절가 SL */}
            <div
              className={`rounded-lg border p-2.5 ${
                enableSl
                  ? "border-rose-800/70 bg-rose-950/20"
                  : "border-neutral-800 bg-neutral-900/40 opacity-50"
              }`}
            >
              <label className="flex cursor-pointer items-center justify-between text-xs font-bold text-rose-300">
                <span className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={enableSl}
                    onChange={(e) => setEnableSl(e.target.checked)}
                    className="accent-rose-500"
                  />
                  🛑 손절가 (SL)
                </span>
                <span className="text-[11px]">{pick.slPct.toFixed(2)}%</span>
              </label>
              <input
                type="number"
                step="any"
                disabled={!enableSl}
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                className="mt-1.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-xs font-bold text-white"
              />
              <div className="mt-1 flex items-center justify-between text-[11px]">
                <span className="text-neutral-400">
                  {fmtKrw(parseFloat(stopLoss) || 0, fxRate)}
                </span>
                {enableSl && (
                  <span className="font-bold text-rose-400">
                    예상 {fmtKrw(sim.slPnlUsdt, fxRate)} ({sim.slRoiPct.toFixed(1)}%)
                  </span>
                )}
              </div>
            </div>

            {/* 1차 익절 TP1 */}
            <div
              className={`rounded-lg border p-2.5 ${
                enableTp1
                  ? "border-emerald-800/70 bg-emerald-950/20"
                  : "border-neutral-800 bg-neutral-900/40 opacity-50"
              }`}
            >
              <label className="flex cursor-pointer items-center justify-between text-xs font-bold text-emerald-300">
                <span className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={enableTp1}
                    onChange={(e) => setEnableTp1(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  💰 1차 익절 ({enableTp2 ? `${tp1RatioPct}%` : "전량"})
                </span>
                <span className="text-[11px]">+{pick.tp1Pct.toFixed(2)}%</span>
              </label>
              <input
                type="number"
                step="any"
                disabled={!enableTp1}
                value={tp1}
                onChange={(e) => setTp1(e.target.value)}
                className="mt-1.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-xs font-bold text-white"
              />
              <div className="mt-1 flex items-center justify-between text-[11px]">
                <span className="text-neutral-400">
                  {fmtKrw(parseFloat(tp1) || 0, fxRate)}
                </span>
                {enableTp1 && (
                  <span className="font-bold text-emerald-400">
                    +{fmtKrw(sim.tp1PnlUsdt, fxRate)}
                  </span>
                )}
              </div>
            </div>

            {/* 2차 익절 TP2 */}
            <div
              className={`rounded-lg border p-2.5 ${
                enableTp2
                  ? "border-emerald-600/70 bg-emerald-950/30"
                  : "border-neutral-800 bg-neutral-900/40 opacity-50"
              }`}
            >
              <label className="flex cursor-pointer items-center justify-between text-xs font-bold text-emerald-200">
                <span className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={enableTp2}
                    onChange={(e) => setEnableTp2(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  🚀 2차 목표 (잔여 전량)
                </span>
                <span className="text-[11px]">+{pick.tp2Pct.toFixed(2)}%</span>
              </label>
              <input
                type="number"
                step="any"
                disabled={!enableTp2}
                value={tp2}
                onChange={(e) => setTp2(e.target.value)}
                className="mt-1.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-xs font-bold text-white"
              />
              <div className="mt-1 flex items-center justify-between text-[11px]">
                <span className="text-neutral-400">
                  {fmtKrw(parseFloat(tp2) || 0, fxRate)}
                </span>
                {enableTp2 && (
                  <span className="font-bold text-emerald-300">
                    +{fmtKrw(sim.tp2PnlUsdt, fxRate)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* TP1 분할 비율 조절 (TP1, TP2 모두 켜진 경우) */}
          {enableTp1 && enableTp2 && (
            <div className="flex items-center justify-between pt-1 text-[11px] text-neutral-400">
              <span>1차 익절(TP1) 물량 비중:</span>
              <div className="flex gap-1.5">
                {[30, 50, 70].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setTp1RatioPct(pct)}
                    className={`rounded px-2 py-0.5 font-bold ${
                      tp1RatioPct === pct
                        ? "bg-emerald-500 text-black"
                        : "bg-neutral-800 text-neutral-400"
                    }`}
                  >
                    TP1 {pct}% / TP2 {100 - pct}%
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 4. 주문 요약 시뮬레이션 박스 */}
        <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/90 p-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-neutral-400">총 포지션 규모 (Notional)</div>
              <div className="mt-0.5 text-sm font-black text-white">
                {fmtKrw(sim.actualNotional, fxRate)}
              </div>
              <div className="font-mono text-[11px] text-neutral-400">
                ${sim.actualNotional.toFixed(2)} USDT
              </div>
            </div>
            <div>
              <div className="text-neutral-400">자동 계산 주문 수량</div>
              <div className="mt-0.5 font-mono text-sm font-black text-amber-400">
                {sim.qty} {short(symbol)}
              </div>
              <div className="text-[11px] text-neutral-500">
                최소수량 {rule.minQty}
              </div>
            </div>
            <div>
              <div className="text-neutral-400">손절(SL) 시 예상 손실</div>
              <div className="mt-0.5 text-sm font-black text-rose-400">
                {enableSl ? fmtKrw(sim.slPnlUsdt, fxRate) : "미설정"}
              </div>
              {enableSl && (
                <div className="font-mono text-[11px] text-rose-300/80">
                  ${sim.slPnlUsdt.toFixed(2)} ({sim.slRoiPct.toFixed(1)}%)
                </div>
              )}
            </div>
            <div>
              <div className="text-neutral-400">익절(TP1+TP2) 예상 수익</div>
              <div className="mt-0.5 text-sm font-black text-emerald-400">
                {enableTp1 || enableTp2 ? `+${fmtKrw(sim.totalTpUsdt, fxRate)}` : "미설정"}
              </div>
              {(enableTp1 || enableTp2) && (
                <div className="font-mono text-[11px] text-emerald-300/80">
                  +${sim.totalTpUsdt.toFixed(2)} (+{sim.totalTpRoiPct.toFixed(1)}%)
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 에러 또는 주문 완료 로그 */}
        {submitErr && (
          <div className="mt-3 rounded-xl border border-rose-800 bg-rose-950/40 p-3 text-xs font-semibold text-rose-300">
            ❌ 주문 오류: {submitErr}
          </div>
        )}

        {resultLogs.length > 0 && (
          <div className="mt-3 space-y-1 rounded-xl border border-emerald-800 bg-emerald-950/30 p-3 text-xs text-emerald-200">
            {resultLogs.map((l, i) => (
              <div key={i} className="font-semibold">
                {l}
              </div>
            ))}
          </div>
        )}

        {/* 하단 실행 버튼 (2단계 안전 확인) */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-xs font-bold text-neutral-300 hover:bg-neutral-700"
          >
            취소
          </button>

          {!confirmStep ? (
            <button
              type="button"
              disabled={submitting || sim.qty < rule.minQty}
              onClick={() => setConfirmStep(true)}
              className={`rounded-xl px-5 py-2.5 text-xs font-black transition disabled:opacity-40 ${
                side === "LONG"
                  ? "bg-emerald-500 text-black hover:bg-emerald-400"
                  : "bg-rose-500 text-white hover:bg-rose-400"
              }`}
            >
              ⚡ {short(symbol)} {side} ({leverage}x) 주문 준비
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={submitOrder}
              className="animate-pulse rounded-xl bg-amber-500 px-6 py-2.5 text-xs font-black text-black hover:bg-amber-400 disabled:opacity-50"
            >
              {submitting
                ? "바이낸스 주문 전송 중…"
                : `🔥 최종 확인: ${sim.qty} ${short(symbol)} 실주문 전송하기`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
