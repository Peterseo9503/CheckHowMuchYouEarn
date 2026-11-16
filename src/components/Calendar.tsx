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
  count: number;
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
      if (!s) {
        s = { symbol: t.symbol, usd: 0, won: 0, count: 0 };
        d.symbols.push(s);
      }
      s.usd += netUsd(t);
      s.won += t.netKrw;
      s.count += 1;
      map.set(t.date, d);
    }
    for (const d of map.values()) {
      d.symbols.sort((a, b) => Math.abs(b.won) - Math.abs(a.won));
    }
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

  const monthTotal = useMemo(() => {
    const r = { usd: 0, won: 0, n: 0, win: 0, lose: 0, profitUsd: 0, profitWon: 0, lossUsd: 0, lossWon: 0 };
    for (const [date, d] of days) {
      if (!date.startsWith(month)) continue;
      r.n++;
      r.usd += d.usd;
      r.won += d.won;
      for (const t of d.trades) {
        if (t.pnlUsdt > 0) (r.win++, (r.profitUsd += t.pnlUsdt), (r.profitWon += t.pnlKrw));
        else if (t.pnlUsdt < 0) (r.lose++, (r.lossUsd += t.pnlUsdt), (r.lossWon += t.pnlKrw));
      }
    }
    return r;
  }, [days, month]);

  const sel = selected ? days.get(selected) : undefined;

  return (
    <section className="space-y-4">
      {/* 월 네비게이션 & 통계 카드 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => shift(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700 hover:text-white"
          >
            ◀
          </button>
          <h2 className="min-w-32 text-center text-xl font-extrabold tracking-tight text-white">
            {y}년 {m}월
          </h2>
          <button
            onClick={() => shift(1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700 hover:text-white"
          >
            ▶
          </button>
          <button
            onClick={() => {
              setMonth(kstToday().slice(0, 7));
              setSelected(null);
            }}
            className="ml-2 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition hover:bg-neutral-700 hover:text-white"
          >
            이번 달
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/90 p-4 shadow-sm">
          <p className="text-xs font-medium text-neutral-400">
            월간 총 순손익 <span className="text-neutral-500">({monthTotal.n}일 매매)</span>
          </p>
          <p className={`mt-1.5 text-3xl font-black tracking-tight ${tone(monthTotal.won)}`}>
            {krw(monthTotal.won)}
          </p>
          <p className="mt-0.5 text-xs font-medium text-neutral-400">{usdt(monthTotal.usd)} USDT</p>
        </div>

        <div className="rounded-xl border border-emerald-900/70 bg-gradient-to-br from-emerald-950/40 to-neutral-900/90 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-emerald-400">이익 합계</p>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
              {monthTotal.win}건
            </span>
          </div>
          <p className="mt-1.5 text-2xl font-black tracking-tight text-emerald-400">
            {krw(monthTotal.profitWon)}
          </p>
          <p className="mt-0.5 text-xs font-medium text-emerald-500/80">{usdt(monthTotal.profitUsd)} USDT</p>
        </div>

        <div className="rounded-xl border border-rose-900/70 bg-gradient-to-br from-rose-950/40 to-neutral-900/90 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-rose-400">손해 합계</p>
            <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">
              {monthTotal.lose}건
            </span>
          </div>
          <p className="mt-1.5 text-2xl font-black tracking-tight text-rose-400">
            {krw(monthTotal.lossWon)}
          </p>
          <p className="mt-0.5 text-xs font-medium text-rose-500/80">{usdt(monthTotal.lossUsd)} USDT</p>
        </div>
      </div>

      {/* 달력 컨테이너 (스크롤 방어 + 너비 확보) */}
      <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900 shadow-sm">
        <div className="min-w-[800px]">
          {/* 요일 헤더 */}
          <div className="grid grid-cols-7 border-b border-neutral-800 bg-neutral-950/80 text-xs font-semibold">
            {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
              <div
                key={w}
                className={`py-2.5 text-center ${
                  i === 0 ? "text-rose-400" : i === 6 ? "text-sky-400" : "text-neutral-400"
                }`}
              >
                {w}
              </div>
            ))}
          </div>

          {/* 달력 셀 그리드 */}
          <div className="grid grid-cols-7 gap-px bg-neutral-800">
            {cells.map((date, i) => {
              if (!date) {
                return <div key={`empty-${i}`} className="min-h-36 bg-neutral-950/60" />;
              }

              const d = days.get(date);
              const isToday = date === kstToday();
              const isSelected = date === selected;

              // 셀 배경 및 테두리 스타일
              const hasProfit = d && d.won > 0;
              const hasLoss = d && d.won < 0;

              return (
                <button
                  key={date}
                  disabled={!d}
                  onClick={() => setSelected(isSelected ? null : date)}
                  className={`group relative flex min-h-36 flex-col justify-start bg-neutral-950 p-2 text-left transition ${
                    d ? "cursor-pointer hover:bg-neutral-900" : "cursor-default opacity-85"
                  } ${
                    isSelected
                      ? "z-10 ring-2 ring-amber-400 ring-inset"
                      : ""
                  }`}
                >
                  {/* 상단 날짜 및 상태 */}
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        isToday
                          ? "bg-amber-500 text-black shadow-xs"
                          : i % 7 === 0
                          ? "text-rose-400"
                          : i % 7 === 6
                          ? "text-sky-400"
                          : "text-neutral-300"
                      }`}
                    >
                      {Number(date.slice(8))}
                    </span>
                    {d && (
                      <span className="text-[10px] font-medium text-neutral-400">
                        {d.trades.length}건
                      </span>
                    )}
                  </div>

                  {/* 일별 총 손익 하이라이트 배너 */}
                  {d ? (
                    <div
                      className={`mt-1.5 rounded-md px-1.5 py-1 text-center transition-all ${
                        hasProfit
                          ? "border border-emerald-500/40 bg-emerald-500/15 text-emerald-400 group-hover:bg-emerald-500/25"
                          : hasLoss
                          ? "border border-rose-500/40 bg-rose-500/15 text-rose-400 group-hover:bg-rose-500/25"
                          : "border border-neutral-700 bg-neutral-800/60 text-neutral-300"
                      }`}
                    >
                      <div className="text-sm font-black tracking-tight leading-tight">
                        {krw(d.won)}
                      </div>
                      <div className="mt-0.5 text-[10px] font-medium opacity-85">
                        {usdt(d.usd)} USDT
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-center text-[11px] text-neutral-700">-</div>
                  )}

                  {/* 종목별 리스트: 티커가 절대 짤리지 않도록 Flex row 및 축약 제거/보완 */}
                  {d && d.symbols.length > 0 && (
                    <ul className="mt-2 flex-1 space-y-1">
                      {d.symbols.map((s) => {
                        const ticker = short(s.symbol);
                        return (
                          <li
                            key={s.symbol}
                            title={`${s.symbol}: ${krw(s.won)} (${usdt(s.usd)} USDT)`}
                            className="flex items-center justify-between rounded bg-neutral-900/90 px-1.5 py-0.5 text-[11px] border border-neutral-800/80"
                          >
                            <span className="shrink-0 font-bold tracking-tight text-neutral-200">
                              {ticker}
                            </span>
                            <span
                              className={`shrink-0 text-right font-bold tracking-tight ${tone(
                                s.won
                              )}`}
                            >
                              {krw(s.won)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 선택한 날짜 상세 내역 */}
      {selected && sel && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-lg">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-extrabold text-white">{selected} 매매 상세</h3>
              <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                총 {sel.trades.length}건
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs text-neutral-400 mr-2">일일 총 순손익</span>
              <span className={`text-xl font-black ${tone(sel.won)}`}>{krw(sel.won)}</span>
              <span className="ml-2 text-xs font-semibold text-neutral-400">
                ({usdt(sel.usd)} USDT)
              </span>
            </div>
          </div>

          {/* 종목별 요약 칩 */}
          <div className="mb-4 flex flex-wrap gap-2">
            {sel.symbols.map((s) => (
              <div
                key={s.symbol}
                className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs"
              >
                <span className="font-bold text-neutral-200">{short(s.symbol)}</span>
                <span className={`font-bold ${tone(s.won)}`}>
                  {usdt(s.usd)} USDT ({krw(s.won)})
                </span>
                <span className="text-[10px] text-neutral-500">{s.count}회</span>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950/80 text-left text-neutral-400">
                <tr>
                  <th className="p-2.5">시각</th>
                  <th className="p-2.5">종목</th>
                  <th className="p-2.5">구분</th>
                  <th className="p-2.5">방식</th>
                  <th className="p-2.5 text-right">체결가</th>
                  <th className="p-2.5 text-right">수량</th>
                  <th className="p-2.5 text-right">PnL</th>
                  <th className="p-2.5 text-right">수수료+펀딩</th>
                  <th className="p-2.5 text-right">순손익 (KRW)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {[...sel.trades]
                  .sort((a, b) => a.time.localeCompare(b.time))
                  .map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => onSelect(t.id)}
                      className="cursor-pointer transition hover:bg-neutral-800/70"
                    >
                      <td className="p-2.5 whitespace-nowrap text-neutral-300">
                        {new Date(t.time).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}
                      </td>
                      <td className="p-2.5 font-semibold text-white">
                        {short(t.symbol)}
                        {t.kind === "FUNDING" && (
                          <span className="ml-1 text-xs text-neutral-400 font-normal">(펀딩)</span>
                        )}
                      </td>
                      <td
                        className={`p-2.5 whitespace-nowrap font-medium ${
                          t.side === "BUY"
                            ? "text-emerald-400"
                            : t.side === "SELL"
                            ? "text-rose-400"
                            : "text-neutral-400"
                        }`}
                      >
                        {t.side ? `${t.side === "BUY" ? "매수" : "매도"} · ` : ""}
                        {actionLabel(t)}
                      </td>
                      <td className="p-2.5 text-xs text-neutral-400">
                        {t.method ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] ${
                              (METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).cls
                            }`}
                          >
                            {(METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).text}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="p-2.5 text-right text-neutral-200">
                        {t.avgPrice ? Number(t.avgPrice.toPrecision(6)) : "-"}
                      </td>
                      <td className="p-2.5 text-right text-neutral-400">{t.qty || "-"}</td>
                      <td className={`p-2.5 text-right font-medium ${tone(t.pnlUsdt)}`}>
                        {t.pnlUsdt.toFixed(4)}
                      </td>
                      <td className="p-2.5 text-right text-neutral-400">
                        {(t.feeUsdt + t.fundingUsdt).toFixed(4)}
                      </td>
                      <td className={`p-2.5 text-right font-bold ${tone(t.netKrw)}`}>
                        {krw(t.netKrw)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2.5 text-xs text-neutral-500">
            💡 행을 클릭하면 우측 서랍(패널)에서 해당 거래의 진입/청산 매매 일지를 작성하고 수정할 수 있습니다.
          </p>
        </div>
      )}
    </section>
  );
}
