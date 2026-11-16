"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TradeDTO } from "@/lib/types";

export interface ChartPositionInfo {
  symbol: string;
  dir: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  breakEvenPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number | null;
  unrealizedUsdt: number;
  roe: number | null;
}

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

const INTERVALS = [
  { key: "1m", label: "1분", ms: 60_000 },
  { key: "5m", label: "5분", ms: 300_000 },
  { key: "15m", label: "15분", ms: 900_000 },
  { key: "1h", label: "1시간", ms: 3_600_000 },
  { key: "4h", label: "4시간", ms: 14_400_000 },
  { key: "1d", label: "1일", ms: 86_400_000 },
] as const;

type IntervalKey = (typeof INTERVALS)[number]["key"];

const short = (s: string) => s.replace(/USDT$|USDC$|BUSD$/, "");
const fmtPx = (n: number) =>
  n ? Number(n.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "-";

export default function PositionChart({
  positions,
  tradesBySymbol,
}: {
  positions: ChartPositionInfo[];
  tradesBySymbol: Map<string, TradeDTO[]>;
}) {
  const [selectedSymbol, setSelectedSymbol] = useState<string>(positions[0]?.symbol ?? "");
  const [interval, setIntervalState] = useState<IntervalKey>("15m");
  const [candleCount, setCandleCount] = useState<number>(90);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showLiqLine, setShowLiqLine] = useState(false);
  const [showFills, setShowFills] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (positions.length && !positions.some((p) => p.symbol === selectedSymbol)) {
      setSelectedSymbol(positions[0].symbol);
    }
  }, [positions, selectedSymbol]);

  const activePos = positions.find((p) => p.symbol === selectedSymbol) ?? positions[0];

  const fetchKlines = useCallback(async () => {
    if (!activePos) return;
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${activePos.symbol}&interval=${interval}&limit=${candleCount}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`차트 조회 실패 (${res.status})`);
      const raw = (await res.json()) as (string | number)[][];
      const parsed: Candle[] = raw.map((k) => ({
        openTime: Number(k[0]),
        open: parseFloat(String(k[1])),
        high: parseFloat(String(k[2])),
        low: parseFloat(String(k[3])),
        close: parseFloat(String(k[4])),
        volume: parseFloat(String(k[5])),
        closeTime: Number(k[6]),
      }));
      setCandles(parsed);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activePos, interval, candleCount]);

  useEffect(() => {
    fetchKlines();
  }, [fetchKlines]);

  // 15초마다 자동 갱신
  useEffect(() => {
    if (!autoRefresh || !activePos) return;
    const id = window.setInterval(fetchKlines, 15_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, activePos, fetchKlines]);

  // 해당 포지션의 체결 내역 (타점 마커용)
  const symbolTrades = useMemo(() => {
    if (!activePos) return [];
    return (tradesBySymbol.get(activePos.symbol) ?? []).filter(
      (t) => t.kind === "TRADE" && t.avgPrice > 0
    );
  }, [activePos, tradesBySymbol]);

  if (!activePos) return null;

  // 차트 좌표 계산
  const W = 960;
  const H = 400;
  const PAD_L = 12;
  const PAD_R = 92; // 우측 가격 축 & 라벨 배지 공간
  const PAD_T = 18;
  const PAD_B = 28;
  const VOL_H = 55;
  const CHART_W = W - PAD_L - PAD_R;
  const CHART_H = H - PAD_T - PAD_B;
  const PRICE_H = CHART_H - VOL_H - 10;

  let minP = Infinity;
  let maxP = -Infinity;
  let maxVol = 0;

  for (const c of candles) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
    if (c.volume > maxVol) maxVol = c.volume;
  }

  // 진입가·손익분기가도 항상 차트 Y축 범위에 포함시켜 선이 보이게 함
  if (activePos.entryPrice > 0) {
    minP = Math.min(minP, activePos.entryPrice);
    maxP = Math.max(maxP, activePos.entryPrice);
  }
  if (activePos.breakEvenPrice > 0) {
    minP = Math.min(minP, activePos.breakEvenPrice);
    maxP = Math.max(maxP, activePos.breakEvenPrice);
  }
  if (showLiqLine && activePos.liquidationPrice > 0) {
    minP = Math.min(minP, activePos.liquidationPrice);
    maxP = Math.max(maxP, activePos.liquidationPrice);
  }

  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
    minP = (activePos.markPrice || 1) * 0.98;
    maxP = (activePos.markPrice || 1) * 1.02;
  }

  const padRange = (maxP - minP) * 0.06;
  const yMin = minP - padRange;
  const yMax = maxP + padRange;

  const yOf = (price: number) =>
    PAD_T + ((yMax - price) / (yMax - yMin)) * PRICE_H;

  const stepX = candles.length > 0 ? CHART_W / candles.length : CHART_W;
  const xOf = (idx: number) => PAD_L + idx * stepX + stepX / 2;
  const bodyW = Math.max(2, Math.min(12, stepX * 0.68));

  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle?.close ?? activePos.markPrice;
  const hovered = hoverIdx !== null ? candles[hoverIdx] : lastCandle;

  // 체결 마커를 캔들 인덱스에 매칭
  const fillMarkers = showFills && candles.length > 0
    ? symbolTrades
        .map((t) => {
          const ms = new Date(t.time).getTime();
          if (ms < candles[0].openTime || ms > candles[candles.length - 1].closeTime) {
            return null;
          }
          const idx = candles.findIndex((c) => ms >= c.openTime && ms <= c.closeTime);
          if (idx === -1) return null;
          return {
            id: t.id,
            idx,
            side: t.side as "BUY" | "SELL",
            price: t.avgPrice,
            qty: t.qty,
            pnl: t.pnlUsdt,
            time: t.time,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : [];

  // Y축 눈금 5개
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);

  // 청산가까지 남은 거리(%)
  const liqDistPct =
    activePos.liquidationPrice > 0 && currentPrice > 0
      ? ((activePos.liquidationPrice - currentPrice) / currentPrice) * 100
      : null;

  // 진입가 대비 현재가 변동률(%)
  const entryDiffPct =
    activePos.entryPrice > 0 && currentPrice > 0
      ? ((currentPrice - activePos.entryPrice) / activePos.entryPrice) * 100
      : 0;

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 p-4">
      {/* 상단 컨트롤 바 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-neutral-400">📈 진입 티커 실시간 차트</span>
          {/* 포지션이 여러 개일 때 종목 선택 버튼 */}
          {positions.map((p) => (
            <button
              key={`${p.symbol}-${p.dir}`}
              onClick={() => setSelectedSymbol(p.symbol)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition ${
                p.symbol === activePos.symbol
                  ? "bg-amber-500 text-black"
                  : "border border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              <span>{short(p.symbol)}</span>
              <span
                className={`rounded px-1 py-0.2 text-[10px] ${
                  p.symbol === activePos.symbol
                    ? "bg-black/20 text-black"
                    : p.dir === "LONG"
                    ? "text-emerald-400"
                    : "text-rose-400"
                }`}
              >
                {p.dir === "LONG" ? "롱" : "숏"} {p.leverage ? `${p.leverage}x` : ""}
              </span>
            </button>
          ))}

          {/* 타임프레임 버튼 */}
          <div className="ml-2 flex overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 text-xs">
            {INTERVALS.map((iv) => (
              <button
                key={iv.key}
                onClick={() => setIntervalState(iv.key)}
                className={`px-2.5 py-1 font-semibold transition ${
                  interval === iv.key
                    ? "bg-neutral-200 text-black"
                    : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                }`}
              >
                {iv.label}
              </button>
            ))}
          </div>

          {/* 캔들 개수(줌) */}
          <div className="flex overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 text-xs">
            {[60, 90, 140].map((cnt) => (
              <button
                key={cnt}
                onClick={() => setCandleCount(cnt)}
                className={`px-2 py-1 text-[11px] ${
                  candleCount === cnt
                    ? "bg-neutral-700 font-bold text-white"
                    : "text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {cnt}봉
              </button>
            ))}
          </div>
        </div>

        {/* 우측 옵션 토글 */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-300">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showFills}
              onChange={(e) => setShowFills(e.target.checked)}
              className="h-3.5 w-3.5 accent-amber-500"
            />
            매수·매도 타점 표시
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showLiqLine}
              onChange={(e) => setShowLiqLine(e.target.checked)}
              className="h-3.5 w-3.5 accent-rose-500"
            />
            청산가 선 포함 ({fmtPx(activePos.liquidationPrice)}
            {liqDistPct !== null ? `, ${liqDistPct > 0 ? "+" : ""}${liqDistPct.toFixed(1)}%` : ""})
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            15초 자동갱신
          </label>
          <button
            onClick={fetchKlines}
            disabled={loading}
            className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? "갱신 중…" : "차트 새로고침"}
          </button>
        </div>
      </div>

      {/* 포지션 핵심 가격 요약 바 & 호버 캔들 정보 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800/90 bg-neutral-900/70 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            <span className="text-neutral-400">평균 진입가:</span>{" "}
            <b className="text-sky-400">{fmtPx(activePos.entryPrice)}</b>
          </span>
          <span>
            <span className="text-neutral-400">손익분기가:</span>{" "}
            <b className="text-amber-300">{fmtPx(activePos.breakEvenPrice)}</b>
          </span>
          <span>
            <span className="text-neutral-400">현재가:</span>{" "}
            <b className={currentPrice >= activePos.entryPrice ? "text-emerald-400" : "text-rose-400"}>
              {fmtPx(currentPrice)} ({entryDiffPct >= 0 ? "+" : ""}
              {entryDiffPct.toFixed(2)}%)
            </b>
          </span>
          <span>
            <span className="text-neutral-400">강제청산가:</span>{" "}
            <b className="text-rose-400">{fmtPx(activePos.liquidationPrice)}</b>
          </span>
        </div>

        {hovered && (
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-400">
            <span>
              {new Date(hovered.openTime).toLocaleString("ko-KR", {
                timeZone: "Asia/Seoul",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span>시 {fmtPx(hovered.open)}</span>
            <span>고 {fmtPx(hovered.high)}</span>
            <span>저 {fmtPx(hovered.low)}</span>
            <span className={hovered.close >= hovered.open ? "font-bold text-emerald-400" : "font-bold text-rose-400"}>
              종 {fmtPx(hovered.close)} (
              {(((hovered.close - hovered.open) / hovered.open) * 100).toFixed(2)}%)
            </span>
            <span>거래량 {Math.round(hovered.volume).toLocaleString("en-US")}</span>
          </div>
        )}
      </div>

      {err && <p className="mt-2 text-xs text-rose-400">{err}</p>}

      {/* 메인 SVG 캔들 차트 */}
      <div className="mt-2 overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-[380px] w-full min-w-[720px] select-none"
          onMouseMove={(e) => {
            if (!svgRef.current || !candles.length) return;
            const rect = svgRef.current.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / rect.width) * W - PAD_L;
            const idx = Math.floor(relX / stepX);
            if (idx >= 0 && idx < candles.length) setHoverIdx(idx);
            else setHoverIdx(null);
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* 수평 그리드 선 & 우측 가격 눈금 */}
          {yTicks.map((tick, i) => {
            const y = yOf(tick);
            return (
              <g key={i}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  stroke="#262626"
                  strokeDasharray="2 4"
                />
                <text
                  x={W - PAD_R + 6}
                  y={y + 4}
                  fill="#737373"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {fmtPx(tick)}
                </text>
              </g>
            );
          })}

          {/* 가격 영역과 거래량 영역 구분선 */}
          <line
            x1={PAD_L}
            y1={PAD_T + PRICE_H + 5}
            x2={W - PAD_R}
            y2={PAD_T + PRICE_H + 5}
            stroke="#262626"
          />

          {/* 캔들 & 거래량 바 */}
          {candles.map((c, idx) => {
            const x = xOf(idx);
            const up = c.close >= c.open;
            const color = up ? "#34d399" : "#fb7185";
            const yHigh = yOf(c.high);
            const yLow = yOf(c.low);
            const yOpen = yOf(c.open);
            const yClose = yOf(c.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));

            const volBarH = maxVol > 0 ? (c.volume / maxVol) * VOL_H : 0;
            const volY = PAD_T + CHART_H - volBarH;

            return (
              <g key={c.openTime}>
                {/* 캔들 심지(Wick) */}
                <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth={1.1} />
                {/* 캔들 몸통(Body) */}
                <rect
                  x={x - bodyW / 2}
                  y={bodyTop}
                  width={bodyW}
                  height={bodyHeight}
                  fill={color}
                  rx={0.5}
                />
                {/* 하단 거래량 바 */}
                <rect
                  x={x - bodyW / 2}
                  y={volY}
                  width={bodyW}
                  height={volBarH}
                  fill={up ? "rgba(52,211,153,0.28)" : "rgba(251,113,133,0.28)"}
                />
                {/* X축 시간 눈금 (15봉 간격) */}
                {idx % Math.max(1, Math.floor(candles.length / 6)) === 0 && (
                  <text
                    x={x}
                    y={H - 8}
                    fill="#737373"
                    fontSize="10"
                    textAnchor="middle"
                  >
                    {new Date(c.openTime).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </text>
                )}
              </g>
            );
          })}

          {/* 손익분기가(Break-Even) 수평선 */}
          {activePos.breakEvenPrice >= yMin && activePos.breakEvenPrice <= yMax && (
            <g>
              <line
                x1={PAD_L}
                y1={yOf(activePos.breakEvenPrice)}
                x2={W - PAD_R}
                y2={yOf(activePos.breakEvenPrice)}
                stroke="#f59e0b"
                strokeWidth={1.2}
                strokeDasharray="3 3"
              />
              <rect
                x={W - PAD_R + 2}
                y={yOf(activePos.breakEvenPrice) - 8}
                width={PAD_R - 4}
                height={16}
                rx={3}
                fill="#78350f"
              />
              <text
                x={W - PAD_R + 6}
                y={yOf(activePos.breakEvenPrice) + 3.5}
                fill="#fde68a"
                fontSize="9.5"
                fontWeight="bold"
              >
                본절 {fmtPx(activePos.breakEvenPrice)}
              </text>
            </g>
          )}

          {/* 평균 진입가(Entry Price) 수평선 */}
          {activePos.entryPrice >= yMin && activePos.entryPrice <= yMax && (
            <g>
              <line
                x1={PAD_L}
                y1={yOf(activePos.entryPrice)}
                x2={W - PAD_R}
                y2={yOf(activePos.entryPrice)}
                stroke="#38bdf8"
                strokeWidth={1.6}
                strokeDasharray="6 4"
              />
              <rect
                x={W - PAD_R + 2}
                y={yOf(activePos.entryPrice) - 9}
                width={PAD_R - 4}
                height={18}
                rx={3}
                fill="#0369a1"
              />
              <text
                x={W - PAD_R + 6}
                y={yOf(activePos.entryPrice) + 3.5}
                fill="#e0f2fe"
                fontSize="9.5"
                fontWeight="bold"
              >
                진입 {fmtPx(activePos.entryPrice)}
              </text>
            </g>
          )}

          {/* 강제청산가(Liquidation) 수평선 */}
          {showLiqLine &&
            activePos.liquidationPrice >= yMin &&
            activePos.liquidationPrice <= yMax && (
              <g>
                <line
                  x1={PAD_L}
                  y1={yOf(activePos.liquidationPrice)}
                  x2={W - PAD_R}
                  y2={yOf(activePos.liquidationPrice)}
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                />
                <rect
                  x={W - PAD_R + 2}
                  y={yOf(activePos.liquidationPrice) - 9}
                  width={PAD_R - 4}
                  height={18}
                  rx={3}
                  fill="#881337"
                />
                <text
                  x={W - PAD_R + 6}
                  y={yOf(activePos.liquidationPrice) + 3.5}
                  fill="#fecdd3"
                  fontSize="9.5"
                  fontWeight="bold"
                >
                  청산 {fmtPx(activePos.liquidationPrice)}
                </text>
              </g>
            )}

          {/* 현재가 수평선 & 배지 */}
          {currentPrice >= yMin && currentPrice <= yMax && (
            <g>
              <line
                x1={PAD_L}
                y1={yOf(currentPrice)}
                x2={W - PAD_R}
                y2={yOf(currentPrice)}
                stroke={currentPrice >= activePos.entryPrice ? "#10b981" : "#f43f5e"}
                strokeWidth={1}
                strokeDasharray="2 2"
              />
              <rect
                x={W - PAD_R + 2}
                y={yOf(currentPrice) - 9}
                width={PAD_R - 4}
                height={18}
                rx={3}
                fill={currentPrice >= activePos.entryPrice ? "#065f46" : "#9f1239"}
              />
              <text
                x={W - PAD_R + 6}
                y={yOf(currentPrice) + 3.5}
                fill="#ffffff"
                fontSize="9.5"
                fontWeight="bold"
              >
                현재 {fmtPx(currentPrice)}
              </text>
            </g>
          )}

          {/* 내 매수/매도 체결 타점 마커 (B / S) */}
          {fillMarkers.map((m) => {
            const x = xOf(m.idx);
            const y = yOf(m.price);
            const isBuy = m.side === "BUY";
            return (
              <g key={m.id}>
                <title>
                  {isBuy ? "매수" : "매도"} {m.qty} @ {fmtPx(m.price)}
                  {m.pnl ? ` (PnL: ${m.pnl.toFixed(2)} USDT)` : ""}
                </title>
                <circle
                  cx={x}
                  cy={y}
                  r={7}
                  fill={isBuy ? "#10b981" : "#f43f5e"}
                  stroke="#0a0a0a"
                  strokeWidth={1.5}
                />
                <text
                  x={x}
                  y={y + 3.5}
                  textAnchor="middle"
                  fill="#000000"
                  fontSize="9"
                  fontWeight="900"
                >
                  {isBuy ? "B" : "S"}
                </text>
              </g>
            );
          })}

          {/* 마우스 호버 크로스헤어 */}
          {hoverIdx !== null && candles[hoverIdx] && (
            <line
              x1={xOf(hoverIdx)}
              y1={PAD_T}
              x2={xOf(hoverIdx)}
              y2={H - PAD_B}
              stroke="#737373"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between text-[11px] text-neutral-500">
        <span>
          💡 파란 점선: <b>평균 진입가</b> · 주황 점선: <b>수수료 포함 손익분기가</b> · 초록/빨강 원(<b>B/S</b>): <b>내 실제 매수·매도 체결 타점</b>
        </span>
        <span>바이낸스 선물 실시간 캔들 데이터 (/fapi/v1/klines)</span>
      </div>
    </div>
  );
}
