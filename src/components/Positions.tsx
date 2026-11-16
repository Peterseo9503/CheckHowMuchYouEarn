"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { METHOD_LABEL, actionLabel, krw, tone, type TradeDTO } from "@/lib/types";
import { buildPositions, formatDuration, type Position } from "@/lib/positions";
import PositionChart from "./PositionChart";

interface LivePosition {
  symbol: string;
  dir: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  breakEvenPrice: number;
  markPrice: number;
  liquidationPrice: number;
  notional: number;
  margin: number;
  leverage: number | null;
  unrealizedUsdt: number;
  unrealizedKrw: number;
  roe: number | null;
}

const short = (s: string) => s.replace(/USDT$|USDC$|BUSD$/, "");
const px = (n: number) => (n ? Number(n.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "-");
const u = (n: number, d = 2) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
const pct = (n: number | null) => (n === null ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const dt = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const DirBadge = ({ dir }: { dir: "LONG" | "SHORT" }) => (
  <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${dir === "LONG" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}>
    {dir === "LONG" ? "롱" : "숏"}
  </span>
);

/** 포지션을 구성하는 개별 주문 목록 (펼침) */
function TradeRows({ trades, onSelect, colSpan }: { trades: TradeDTO[]; onSelect: (id: string) => void; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="bg-neutral-950 px-4 py-2">
        <table className="w-full text-xs">
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} onClick={() => onSelect(t.id)} className="cursor-pointer border-t border-neutral-900 text-neutral-300 hover:bg-neutral-900">
                <td className="py-1.5 pr-3 whitespace-nowrap text-neutral-400">{dt(t.time)}</td>
                <td className={`py-1.5 pr-3 ${t.kind === "FUNDING" ? "text-neutral-400" : t.side === "BUY" ? "text-emerald-400" : "text-rose-400"}`}>
                  {t.kind === "FUNDING" ? "펀딩" : `${t.side === "BUY" ? "매수" : "매도"} · ${actionLabel(t)}`}
                </td>
                <td className="py-1.5 pr-3 text-neutral-400">{t.method ? (METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).text : ""}</td>
                <td className="py-1.5 pr-3 text-right">{t.avgPrice ? px(t.avgPrice) : ""}</td>
                <td className="py-1.5 pr-3 text-right text-neutral-400">{t.qty || ""}</td>
                <td className={`py-1.5 pr-3 text-right ${tone(t.pnlUsdt)}`}>{t.pnlUsdt ? u(t.pnlUsdt, 4) : ""}</td>
                <td className="py-1.5 pr-3 text-right text-neutral-500">{(t.feeUsdt + t.fundingUsdt).toFixed(4)}</td>
                <td className={`py-1.5 text-right ${tone(t.netKrw)}`}>{krw(t.netKrw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-neutral-500">행을 클릭하면 매매 근거를 작성할 수 있습니다.</p>
      </td>
    </tr>
  );
}

export function OpenPositions({ trades, onSelect }: { trades: TradeDTO[]; onSelect: (id: string) => void }) {
  const [live, setLive] = useState<LivePosition[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const derived = useMemo(() => buildPositions(trades).open, [trades]);
  const tradesBySymbol = useMemo(() => {
    const map = new Map<string, TradeDTO[]>();
    for (const d of derived) map.set(d.symbol, d.trades);
    return map;
  }, [derived]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/positions");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setLive(json.positions);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const totalU = (live ?? []).reduce((a, p) => a + p.unrealizedUsdt, 0);
  const totalK = (live ?? []).reduce((a, p) => a + p.unrealizedKrw, 0);

  return (
    <div>
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 p-3 text-sm">
        <span className="text-neutral-400">
          미실현 손익 합계 <span className={`ml-2 text-lg font-bold ${tone(totalK)}`}>{krw(totalK)}</span>
          <span className="ml-2 text-neutral-400">{u(totalU)} USDT</span>
        </span>
        <button onClick={load} disabled={loading} className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50">
          {loading ? "불러오는 중…" : "새로고침"}
        </button>
      </div>
      {err && <p className="p-3 text-sm text-rose-400">{err}</p>}
      <table className="w-full text-sm">
        <thead className="bg-neutral-900 text-left text-neutral-400">
          <tr>
            <th className="p-3">종목</th>
            <th className="p-3">방향</th>
            <th className="p-3 text-right">수량</th>
            <th className="p-3 text-right">진입가</th>
            <th className="p-3 text-right">현재가(마크)</th>
            <th className="p-3 text-right">청산가</th>
            <th className="p-3 text-right">미실현 (USDT)</th>
            <th className="p-3 text-right">미실현 (KRW)</th>
            <th className="p-3 text-right">ROE</th>
            <th className="p-3 text-right">보유 시간</th>
          </tr>
        </thead>
        <tbody>
          {(live ?? []).map((p) => {
            const d = derived.find((x) => x.symbol === p.symbol && x.dir === p.dir);
            const key = `${p.symbol}-${p.dir}`;
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpanded(expanded === key ? null : key)} className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-900">
                  <td className="p-3 font-semibold">
                    {short(p.symbol)}
                    {p.leverage && <span className="ml-1 text-xs text-amber-400">{p.leverage}x</span>}
                  </td>
                  <td className="p-3"><DirBadge dir={p.dir} /></td>
                  <td className="p-3 text-right">{p.qty}</td>
                  <td className="p-3 text-right">{px(p.entryPrice)}</td>
                  <td className="p-3 text-right">{px(p.markPrice)}</td>
                  <td className="p-3 text-right text-amber-400/80">{px(p.liquidationPrice)}</td>
                  <td className={`p-3 text-right ${tone(p.unrealizedUsdt)}`}>{u(p.unrealizedUsdt)}</td>
                  <td className={`p-3 text-right font-bold ${tone(p.unrealizedKrw)}`}>{krw(p.unrealizedKrw)}</td>
                  <td className={`p-3 text-right ${tone(p.roe ?? 0)}`}>{pct(p.roe)}</td>
                  <td className="p-3 text-right text-neutral-400">{d ? formatDuration(d.openTime, null) : "-"}</td>
                </tr>
                {expanded === key && d && (
                  <>
                    <tr>
                      <td colSpan={10} className="bg-neutral-950 px-4 pt-3 text-xs text-neutral-400">
                        진입 {dt(d.openTime)} · 지금까지 부분청산 실현손익{" "}
                        <span className={tone(d.pnlUsdt)}>{u(d.pnlUsdt)} USDT</span> · 수수료+펀딩{" "}
                        {(d.feeUsdt + d.fundingUsdt).toFixed(2)} USDT
                      </td>
                    </tr>
                    <TradeRows trades={d.trades} onSelect={onSelect} colSpan={10} />
                  </>
                )}
              </Fragment>
            );
          })}
          {live && !live.length && (
            <tr>
              <td colSpan={10} className="p-8 text-center text-neutral-500">진행 중인 포지션이 없습니다.</td>
            </tr>
          )}
        </tbody>
      </table>
      {live && live.length > 0 && (
        <PositionChart positions={live} tradesBySymbol={tradesBySymbol} />
      )}
    </div>
  );
}

export function ClosedPositions({ trades, onSelect }: { trades: TradeDTO[]; onSelect: (id: string) => void }) {
  const closed = useMemo(() => buildPositions(trades).closed, [trades]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const wins = closed.filter((p) => p.netUsdt > 0).length;
  const total = closed.reduce((a, p) => a + p.netKrw, 0);

  return (
    <div>
      <div className="flex flex-wrap gap-6 border-b border-neutral-800 bg-neutral-900 p-3 text-sm text-neutral-400">
        <span>종료 포지션 <b className="text-neutral-100">{closed.length}</b>개</span>
        <span>승률 <b className="text-neutral-100">{closed.length ? ((wins / closed.length) * 100).toFixed(1) : "0"}%</b> ({wins}승 {closed.length - wins}패)</span>
        <span>순손익 합계 <b className={tone(total)}>{krw(total)}</b></span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-neutral-900 text-left text-neutral-400">
          <tr>
            <th className="p-3">종료 시각</th>
            <th className="p-3">종목</th>
            <th className="p-3">방향</th>
            <th className="p-3 text-right">최대 수량</th>
            <th className="p-3 text-right">평균 진입가</th>
            <th className="p-3 text-right">평균 청산가</th>
            <th className="p-3 text-right">실현 PnL</th>
            <th className="p-3 text-right">수수료+펀딩</th>
            <th className="p-3 text-right">순손익 (KRW)</th>
            <th className="p-3 text-right">수익률</th>
            <th className="p-3 text-right">보유 시간</th>
          </tr>
        </thead>
        <tbody>
          {closed.map((p: Position) => (
            <Fragment key={p.id}>
              <tr onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-900">
                <td className="p-3 whitespace-nowrap">{p.closeTime ? dt(p.closeTime) : "-"}</td>
                <td className="p-3 font-semibold">
                  {short(p.symbol)}
                  {p.partial && <span className="ml-1 text-[10px] text-neutral-500" title="동기화 시작일 이전에 진입해 진입 기록이 없습니다">진입기록 없음</span>}
                </td>
                <td className="p-3"><DirBadge dir={p.dir} /></td>
                <td className="p-3 text-right text-neutral-400">{Number(p.maxQty.toPrecision(8))}</td>
                <td className="p-3 text-right">{px(p.entryAvg)}</td>
                <td className="p-3 text-right">{px(p.exitAvg)}</td>
                <td className={`p-3 text-right ${tone(p.pnlUsdt)}`}>{u(p.pnlUsdt)}</td>
                <td className="p-3 text-right text-neutral-400">{(p.feeUsdt + p.fundingUsdt).toFixed(2)}</td>
                <td className={`p-3 text-right font-bold ${tone(p.netKrw)}`}>{krw(p.netKrw)}</td>
                <td className={`p-3 text-right ${tone(p.roi ?? 0)}`}>{pct(p.roi)}</td>
                <td className="p-3 text-right text-neutral-400">{p.partial ? "-" : formatDuration(p.openTime, p.closeTime)}</td>
              </tr>
              {expanded === p.id && <TradeRows trades={p.trades} onSelect={onSelect} colSpan={11} />}
            </Fragment>
          ))}
          {!closed.length && (
            <tr>
              <td colSpan={11} className="p-8 text-center text-neutral-500">종료된 포지션이 없습니다.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="p-3 text-xs text-neutral-500">
        수익률은 레버리지를 반영하지 않은 가격 기준(실현 PnL ÷ 진입 명목금액)입니다. 행을 클릭하면 구성 주문이 펼쳐집니다.
      </p>
    </div>
  );
}
