"use client";

import { useMemo, useState } from "react";
import { METHOD_LABEL, actionLabel, krw, tone, type TradeDTO } from "@/lib/types";

const usdt = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}`;
const short = (symbol: string) => symbol.replace(/USDT$|USDC$|BUSD$/, "");
const netUsd = (t: TradeDTO) => t.pnlUsdt + t.feeUsdt + t.fundingUsdt;

const kstToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

interface SymbolSum {
  symbol: string;
  usd: number;
  won: number;
}
interface DaySum {
  usd: number;
  won: number;
  symbols: SymbolSum[];
  trades: TradeDTO[];
}

export default function Calendar({ trades, onSelect }: { trades: TradeDTO[]; onSelect: (id: string) => void }) {
  const [month, setMonth] = useState(kstToday().slice(0, 7)); // YYYY-MM
  const [selected, setSelected] = useState<string | null>(null);

  // 날짜별 → 종목별 손익 집계
  const days = useMemo(() => {
    const map = new Map<string, DaySum>();
    for (const t of trades) {
      const d = map.get(t.date) ?? { usd: 0, won: 0, symbols: [], trades: [] };
      d.usd += netUsd(t);
      d.won += t.netKrw;
      d.trades.push(t);
      let s = d.symbols.find((x) => x.symbol === t.symbol);
      if (!s) d.symbols.push((s = { symbol: t.symbol, usd: 0, won: 0 }));
      s.usd += netUsd(t);
      s.won += t.netKrw;
      map.set(t.date, d);
    }
    for (const d of map.values()) d.symbols.sort((a, b) => Math.abs(b.won) - Math.abs(a.won));
    return map;
  }, [trades]);

  const [y, m] = month.split("-").map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(d.toISOString().slice(0, 7));
    setSelected(null);
  };

  const monthTotal = [...days.entries()]
    .filter(([date]) => date.startsWith(month))
    .reduce((a, [, d]) => ({ usd: a.usd + d.usd, won: a.won + d.won, n: a.n + 1 }), { usd: 0, won: 0, n: 0 });

  const sel = selected ? days.get(selected) : undefined;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700">◀</button>
          <h2 className="w-32 text-center text-lg font-bold">{y}년 {m}월</h2>
          <button onClick={() => shift(1)} className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700">▶</button>
          <button onClick={() => (setMonth(kstToday().slice(0, 7)), setSelected(null))} className="ml-2 rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700">
            이번 달
          </button>
        </div>
        <div className="text-right text-sm">
          <span className="text-neutral-400">월 합계 ({monthTotal.n}일 거래) </span>
          <span className={`ml-1 text-lg font-bold ${tone(monthTotal.won)}`}>{krw(monthTotal.won)}</span>
          <span className="ml-2 text-neutral-400">{usdt(monthTotal.usd)} USDT</span>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded border border-neutral-800 bg-neutral-800 text-xs">
        {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
          <div key={w} className={`bg-neutral-900 p-2 text-center ${i === 0 ? "text-rose-400" : i === 6 ? "text-sky-400" : "text-neutral-400"}`}>
            {w}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`e${i}`} className="min-h-28 bg-neutral-950" />;
          const d = days.get(date);
          const bg = !d ? "" : d.won > 0 ? "bg-emerald-950/40" : d.won < 0 ? "bg-rose-950/40" : "";
          return (
            <button
              key={date}
              disabled={!d}
              onClick={() => setSelected(date === selected ? null : date)}
              className={`min-h-28 bg-neutral-950 p-1.5 text-left align-top ${bg} ${d ? "cursor-pointer hover:bg-neutral-900" : "cursor-default"} ${date === selected ? "ring-2 ring-amber-500 ring-inset" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <span className={date === kstToday() ? "font-bold text-amber-400" : "text-neutral-400"}>{Number(date.slice(8))}</span>
                {d && <span className={`font-semibold ${tone(d.won)}`}>{krw(d.won)}</span>}
              </div>
              {d && (
                <ul className="mt-1 space-y-0.5">
                  {d.symbols.map((s) => (
                    <li key={s.symbol} className="flex justify-between gap-1">
                      <span className="truncate text-neutral-300">{short(s.symbol)}</span>
                      <span className={`whitespace-nowrap ${tone(s.won)}`}>
                        {usdt(s.usd)} <span className="text-neutral-500">({krw(s.won)})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>

      {selected && sel && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="font-bold">{selected} 상세</h3>
            <span className="text-sm">
              <span className={`font-bold ${tone(sel.won)}`}>{krw(sel.won)}</span>
              <span className="ml-2 text-neutral-400">{usdt(sel.usd)} USDT</span>
            </span>
          </div>
          <ul className="mb-4 space-y-0.5 text-sm">
            {sel.symbols.map((s) => (
              <li key={s.symbol}>
                - {short(s.symbol)} <span className={tone(s.won)}>{usdt(s.usd)}USDT({krw(s.won)})</span>
              </li>
            ))}
          </ul>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-400">
                <tr>
                  <th className="p-2">시각</th>
                  <th className="p-2">종목</th>
                  <th className="p-2">구분</th>
                  <th className="p-2">방식</th>
                  <th className="p-2 text-right">체결가</th>
                  <th className="p-2 text-right">수량</th>
                  <th className="p-2 text-right">PnL</th>
                  <th className="p-2 text-right">수수료+펀딩</th>
                  <th className="p-2 text-right">순손익 (KRW)</th>
                </tr>
              </thead>
              <tbody>
                {[...sel.trades]
                  .sort((a, b) => a.time.localeCompare(b.time))
                  .map((t) => (
                    <tr key={t.id} onClick={() => onSelect(t.id)} className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-800">
                      <td className="p-2 whitespace-nowrap">
                        {new Date(t.time).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}
                      </td>
                      <td className="p-2">{short(t.symbol)}{t.kind === "FUNDING" && " (펀딩)"}</td>
                      <td className={`p-2 whitespace-nowrap ${t.side === "BUY" ? "text-emerald-400" : t.side === "SELL" ? "text-rose-400" : "text-neutral-400"}`}>
                        {t.side ? `${t.side === "BUY" ? "매수" : "매도"} · ` : ""}{actionLabel(t)}
                      </td>
                      <td className="p-2 text-neutral-400">{t.method ? (METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).text : ""}</td>
                      <td className="p-2 text-right">{t.avgPrice ? Number(t.avgPrice.toPrecision(6)) : "-"}</td>
                      <td className="p-2 text-right text-neutral-400">{t.qty || "-"}</td>
                      <td className={`p-2 text-right ${tone(t.pnlUsdt)}`}>{t.pnlUsdt.toFixed(4)}</td>
                      <td className="p-2 text-right text-neutral-400">{(t.feeUsdt + t.fundingUsdt).toFixed(4)}</td>
                      <td className={`p-2 text-right font-medium ${tone(t.netKrw)}`}>{krw(t.netKrw)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-neutral-500">행을 클릭하면 우측 패널에서 매매 근거를 작성할 수 있습니다.</p>
        </div>
      )}
    </section>
  );
}
