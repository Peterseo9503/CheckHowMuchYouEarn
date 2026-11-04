"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { METHOD_LABEL, actionLabel, krw, tone, type TradeDTO, type TransferDTO } from "@/lib/types";
import TradeDrawer from "./TradeDrawer";
import Dashboard from "./Dashboard";
import Calendar from "./Calendar";

type View = "dashboard" | "calendar" | "trades" | "daily" | "monthly" | "transfers";

const TYPE_LABEL: Record<TransferDTO["type"], string> = {
  DEPOSIT: "입금",
  WITHDRAW: "출금",
  FUTURES_IN: "선물 지갑 이체(입)",
  FUTURES_OUT: "선물 지갑 이체(출)",
};

export default function Journal({
  initialTrades,
  initialTransfers,
}: {
  initialTrades: TradeDTO[];
  initialTransfers: TransferDTO[];
}) {
  const router = useRouter();
  const [trades, setTrades] = useState(initialTrades);
  const [transfers, setTransfers] = useState(initialTransfers);
  const [hideInternal, setHideInternal] = useState(true);
  const [excludeFee, setExcludeFee] = useState(false);
  const [excludeFunding, setExcludeFunding] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");

  // 수수료/펀딩비 제외 옵션을 반영한 거래 목록 (집계·테이블 공용)
  const adj = useMemo(
    () =>
      trades
        .filter((t) => !(excludeFunding && t.kind === "FUNDING"))
        .map((t) => {
          const fee = excludeFee ? 0 : t.feeKrw;
          const funding = excludeFunding ? 0 : t.fundingKrw;
          return {
            ...t,
            feeUsdt: excludeFee ? 0 : t.feeUsdt,
            fundingUsdt: excludeFunding ? 0 : t.fundingUsdt,
            netKrw: t.pnlKrw + fee + funding,
          };
        }),
    [trades, excludeFee, excludeFunding],
  );

  // 일별 / 월별 집계 (오래된 순으로 누적)
  const { daily, monthly, total } = useMemo(() => {
    const d = new Map<string, { net: number; count: number }>();
    const m = new Map<string, { net: number; count: number }>();
    for (const t of adj) {
      for (const [map, key] of [[d, t.date], [m, t.date.slice(0, 7)]] as const) {
        const v = map.get(key) ?? { net: 0, count: 0 };
        v.net += t.netKrw;
        v.count++;
        map.set(key, v);
      }
    }
    const withCum = (map: typeof d) => {
      let cum = 0;
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => ({ key, ...v, cum: (cum += v.net) }))
        .reverse();
    };
    return { daily: withCum(d), monthly: withCum(m), total: adj.reduce((s, t) => s + t.netKrw, 0) };
  }, [adj]);

  async function sync(full = false) {
    setSyncing(true);
    setMsg("");
    try {
      const res = await fetch(full ? "/api/sync?full=1" : "/api/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setTrades(await (await fetch("/api/trades")).json());

      const res2 = await fetch("/api/sync-transfers", { method: "POST" });
      const json2 = await res2.json();
      if (!res2.ok) throw new Error(`거래는 동기화됨. 입출금 실패: ${json2.error}`);
      setTransfers(await (await fetch("/api/transfers")).json());
      setMsg(`거래 ${json.synced}건, 입출금 ${json2.synced}건 동기화 완료`);
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const visibleTransfers = hideInternal
    ? transfers.filter((t) => t.type === "DEPOSIT" || t.type === "WITHDRAW")
    : transfers;

  const selected = trades.find((t) => t.id === selectedId) ?? null;
  const onSaved = (u: TradeDTO) => setTrades((p) => p.map((t) => (t.id === u.id ? u : t)));

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Trading Journal</h1>
          <p className="mt-1 text-sm text-neutral-400">
            누적 순손익 <span className={`font-semibold ${tone(total)}`}>{krw(total)}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {msg && <span className="text-sm text-neutral-400">{msg}</span>}
          <button
            onClick={() => sync(true)}
            disabled={syncing}
            title="저장된 거래를 전부 다시 받아 덮어씁니다 (메모는 유지)"
            className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 disabled:opacity-50"
          >
            전체 재동기화
          </button>
          <button
            onClick={() => sync()}
            disabled={syncing}
            className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
          >
            {syncing ? "동기화 중…" : "바이낸스 동기화"}
          </button>
        </div>
      </header>

      <nav className="mb-4 flex gap-2">
        {(["dashboard", "calendar", "trades", "daily", "monthly", "transfers"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded px-3 py-1.5 text-sm ${view === v ? "bg-neutral-100 text-black" : "bg-neutral-800"}`}
          >
            {{ dashboard: "대시보드", calendar: "달력", trades: "거래 내역", daily: "일별", monthly: "월별", transfers: "입출금" }[v]}
          </button>
        ))}
      </nav>

      {(view === "calendar" || view === "trades" || view === "daily" || view === "monthly") && (
        <div className="mb-3 flex gap-5 text-sm text-neutral-300">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={excludeFee} onChange={(e) => setExcludeFee(e.target.checked)} className="h-4 w-4 accent-amber-500" />
            거래 수수료 제외
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={excludeFunding} onChange={(e) => setExcludeFunding(e.target.checked)} className="h-4 w-4 accent-amber-500" />
            펀딩비 제외
          </label>
        </div>
      )}

      {view === "transfers" && (
        <label className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={hideInternal}
            onChange={(e) => setHideInternal(e.target.checked)}
            className="h-4 w-4 accent-amber-500"
          />
          내부 지갑 이동 제외 (현물 ↔ 선물)
        </label>
      )}

      {view === "dashboard" && <Dashboard trades={trades} transfers={transfers} />}

      {view === "calendar" && <Calendar trades={adj} onSelect={setSelectedId} />}

      {view !== "dashboard" && view !== "calendar" && (
      <div className="overflow-x-auto rounded border border-neutral-800">
        {view === "transfers" ? (
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="p-3">시각 (KST)</th>
                <th className="p-3">구분</th>
                <th className="p-3">코인</th>
                <th className="p-3 text-right">수량</th>
                <th className="p-3 text-right">수수료</th>
                <th className="p-3 text-right">원화 환산</th>
                <th className="p-3">네트워크</th>
                <th className="p-3">상태</th>
              </tr>
            </thead>
            <tbody>
              {visibleTransfers.map((t) => {
                const inflow = t.type === "DEPOSIT" || t.type === "FUTURES_IN";
                return (
                  <tr key={t.id} className="border-t border-neutral-800" title={t.txId}>
                    <td className="p-3 whitespace-nowrap">
                      {new Date(t.time).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                    </td>
                    <td className="p-3">{TYPE_LABEL[t.type]}</td>
                    <td className="p-3">{t.coin}</td>
                    <td className={`p-3 text-right ${inflow ? "text-emerald-400" : "text-rose-400"}`}>
                      {inflow ? "+" : "-"}
                      {t.amount.toLocaleString("en-US", { maximumFractionDigits: 8 })}
                    </td>
                    <td className="p-3 text-right text-neutral-400">{t.fee || "-"}</td>
                    <td
                      className="p-3 text-right text-neutral-400"
                      title={t.priceUsdt ? `${t.coin} ${t.priceUsdt} USDT × ${t.rate?.toFixed(1)} KRW` : undefined}
                    >
                      {t.amountKrw ? krw(t.amountKrw) : "-"}
                    </td>
                    <td className="p-3 text-neutral-400">{t.network || "-"}</td>
                    <td className="p-3 text-neutral-400">{t.status}</td>
                  </tr>
                );
              })}
              {!visibleTransfers.length && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-neutral-500">
                    입출금 내역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : view === "trades" ? (
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="p-3">시각 (KST)</th>
                <th className="p-3">종목</th>
                <th className="p-3">구분</th>
                <th className="p-3">방식</th>
                <th className="p-3 text-right">체결가</th>
                <th className="p-3 text-right">수량</th>
                <th className="p-3 text-right">PnL (USDT)</th>
                <th className="p-3 text-right">수수료 (USDT)</th>
                <th className="p-3 text-right">환율</th>
                <th className="p-3 text-right">순손익 (KRW)</th>
                <th className="p-3">태그</th>
              </tr>
            </thead>
            <tbody>
              {adj.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={`cursor-pointer border-t border-neutral-800 hover:bg-neutral-900 ${t.id === selectedId ? "bg-neutral-900" : ""}`}
                >
                  <td className="p-3 whitespace-nowrap">
                    {new Date(t.time).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                  </td>
                  <td className="p-3">
                    {t.kind === "FUNDING" ? `${t.symbol} (펀딩)` : t.symbol}
                    {t.tradeReason && <span className="ml-1" title="메모 있음">📝</span>}
                  </td>
                  <td className={`p-3 whitespace-nowrap ${t.side === "BUY" ? "text-emerald-400" : t.side === "SELL" ? "text-rose-400" : "text-neutral-400"}`}>
                    {t.side ? `${t.side === "BUY" ? "매수" : "매도"} · ` : ""}
                    {actionLabel(t)}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {t.method && (
                      <span className={`rounded px-2 py-0.5 text-xs ${(METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).cls}`}>
                        {(METHOD_LABEL[t.method] ?? METHOD_LABEL.UNKNOWN).text}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">{t.avgPrice ? Number(t.avgPrice.toPrecision(6)) : "-"}</td>
                  <td className="p-3 text-right text-neutral-400">{t.qty || "-"}</td>
                  <td className={`p-3 text-right ${tone(t.pnlUsdt)}`}>{t.pnlUsdt.toFixed(4)}</td>
                  <td className="p-3 text-right text-neutral-400">{(t.feeUsdt + t.fundingUsdt).toFixed(4)}</td>
                  <td className="p-3 text-right text-neutral-400">{t.rate.toFixed(1)}</td>
                  <td className={`p-3 text-right font-medium ${tone(t.netKrw)}`}>{krw(t.netKrw)}</td>
                  <td className="p-3 text-neutral-400">{t.tags}</td>
                </tr>
              ))}
              {!adj.length && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-neutral-500">
                    데이터가 없습니다. 우측 상단의 &quot;바이낸스 동기화&quot;를 눌러주세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="p-3">{view === "daily" ? "일자" : "월"}</th>
                <th className="p-3 text-right">거래 수</th>
                <th className="p-3 text-right">순손익 (KRW)</th>
                <th className="p-3 text-right">누적 (KRW)</th>
              </tr>
            </thead>
            <tbody>
              {(view === "daily" ? daily : monthly).map((r) => (
                <tr key={r.key} className="border-t border-neutral-800">
                  <td className="p-3">{r.key}</td>
                  <td className="p-3 text-right">{r.count}</td>
                  <td className={`p-3 text-right ${tone(r.net)}`}>{krw(r.net)}</td>
                  <td className={`p-3 text-right ${tone(r.cum)}`}>{krw(r.cum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}

      {selected && <TradeDrawer key={selected.id} trade={selected} onClose={() => setSelectedId(null)} onSaved={onSaved} />}
    </main>
  );
}
