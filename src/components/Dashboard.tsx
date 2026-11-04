"use client";

import { useMemo, useState } from "react";
import { krw, tone, type TradeDTO, type TransferDTO } from "@/lib/types";

const kst = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const usdt = (n: number) => `${n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

function presets() {
  const today = kst(new Date());
  const ago = (days: number) => kst(new Date(Date.now() - days * 86_400_000));
  return [
    { label: "오늘", from: today, to: today },
    { label: "7일", from: ago(6), to: today },
    { label: "30일", from: ago(29), to: today },
    { label: "이번 달", from: today.slice(0, 8) + "01", to: today },
    { label: "전체", from: "", to: "" },
  ];
}

function Card({ title, usd, won, tint }: { title: string; usd: number; won: number; tint: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-sm text-neutral-400">{title}</p>
      <p className={`mt-2 text-2xl font-bold ${tint}`}>{krw(won)}</p>
      <p className="mt-1 text-sm text-neutral-400">{usdt(usd)}</p>
    </div>
  );
}

export default function Dashboard({ trades, transfers }: { trades: TradeDTO[]; transfers: TransferDTO[] }) {
  const [from, setFrom] = useState(() => kst(new Date()).slice(0, 8) + "01");
  const [to, setTo] = useState(() => kst(new Date()));

  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  const s = useMemo(() => {
    const r = { profitUsd: 0, profitKrw: 0, lossUsd: 0, lossKrw: 0, feeUsd: 0, feeKrw: 0, fundUsd: 0, fundKrw: 0, win: 0, lose: 0 };
    for (const t of trades) {
      if (!inRange(t.date)) continue;
      if (t.pnlUsdt > 0) (r.profitUsd += t.pnlUsdt, r.profitKrw += t.pnlKrw, r.win++);
      else if (t.pnlUsdt < 0) (r.lossUsd += t.pnlUsdt, r.lossKrw += t.pnlKrw, r.lose++);
      r.feeUsd += t.feeUsdt;
      r.feeKrw += t.feeKrw;
      r.fundUsd += t.fundingUsdt;
      r.fundKrw += t.fundingKrw;
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, from, to]);

  const net = {
    usd: s.profitUsd + s.lossUsd + s.feeUsd + s.fundUsd,
    krw: s.profitKrw + s.lossKrw + s.feeKrw + s.fundKrw,
  };

  // 입금/출금 (현물↔선물 내부 이체 제외). USDT 환산 = 수량 × 당시 USDT 가격
  const flow = (type: "DEPOSIT" | "WITHDRAW") => {
    const rows = transfers.filter((t) => t.type === type && inRange(t.date));
    return {
      rows,
      usd: rows.reduce((a, t) => a + (t.priceUsdt ? t.amount * t.priceUsdt : 0), 0),
      won: rows.reduce((a, t) => a + (t.amountKrw ?? 0), 0),
    };
  };
  const dep = flow("DEPOSIT");
  const wd = flow("WITHDRAW");

  const FlowPanel = ({ title, data, tint }: { title: string; data: typeof dep; tint: string }) => (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-neutral-400">
          {title} <span className="text-neutral-500">({data.rows.length}건)</span>
        </p>
        <div className="text-right">
          <p className={`text-xl font-bold ${tint}`}>{krw(data.won)}</p>
          <p className="text-xs text-neutral-400">{usdt(data.usd)}</p>
        </div>
      </div>
      <ul className="mt-3 max-h-56 divide-y divide-neutral-800 overflow-y-auto text-sm">
        {data.rows.map((t) => (
          <li key={t.id} className="flex justify-between py-1.5">
            <span className="text-neutral-400">
              {new Date(t.time).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} · {t.coin}
            </span>
            <span className="text-right">
              {t.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} {t.coin}
              <span className="ml-2 text-neutral-400">
                {t.priceUsdt ? usdt(t.amount * t.priceUsdt) : "-"} / {t.amountKrw ? krw(t.amountKrw) : "-"}
              </span>
            </span>
          </li>
        ))}
        {!data.rows.length && <li className="py-4 text-center text-neutral-500">내역 없음</li>}
      </ul>
    </div>
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1" />
        <span className="text-neutral-500">~</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1" />
        {presets().map((p) => (
          <button key={p.label} onClick={() => (setFrom(p.from), setTo(p.to))} className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700">
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card title={`이익 (${s.win}건)`} usd={s.profitUsd} won={s.profitKrw} tint="text-emerald-400" />
        <Card title={`손해 (${s.lose}건)`} usd={s.lossUsd} won={s.lossKrw} tint="text-rose-400" />
        <Card title="거래 수수료" usd={s.feeUsd} won={s.feeKrw} tint="text-neutral-200" />
        <Card title="펀딩피" usd={s.fundUsd} won={s.fundKrw} tint={tone(s.fundUsd)} />
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-900 p-4 text-sm">
        <span className="text-neutral-400">기간 순손익 (이익 + 손해 + 수수료 + 펀딩피) </span>
        <span className={`ml-2 text-lg font-bold ${tone(net.krw)}`}>{krw(net.krw)}</span>
        <span className="ml-2 text-neutral-400">{usdt(net.usd)}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <FlowPanel title="입금내역" data={dep} tint="text-emerald-400" />
        <FlowPanel title="출금내역" data={wd} tint="text-rose-400" />
      </div>
    </section>
  );
}
