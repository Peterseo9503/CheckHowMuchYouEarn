"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { METHOD_LABEL, actionLabel, krw, tone, type TradeDTO } from "@/lib/types";

interface Props {
  trade: TradeDTO;
  onClose: () => void;
  onSaved: (t: TradeDTO) => void;
}

export default function TradeDrawer({ trade, onClose, onSaved }: Props) {
  const [reason, setReason] = useState(trade.tradeReason);
  const [tags, setTags] = useState(trade.tags);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const res = await fetch(`/api/trades/${trade.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeReason: reason, tags }),
    });
    setBusy(false);
    if (res.ok) onSaved(await res.json());
    else alert("저장 실패");
  }

  async function clearNote() {
    if (!confirm("이 거래의 일지를 삭제할까요?")) return;
    const res = await fetch(`/api/trades/${trade.id}`, { method: "DELETE" });
    if (res.ok) {
      setReason("");
      setTags("");
      onSaved({ ...trade, tradeReason: "", tags: "" });
    }
  }

  const Row = ({ k, v, cls = "" }: { k: string; v: string; cls?: string }) => (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-neutral-400">{k}</span>
      <span className={cls}>{v}</span>
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <aside className="fixed top-0 right-0 flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">{trade.symbol}</h2>
            <p className="text-xs text-neutral-400">
              {new Date(trade.time).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            </p>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white">✕</button>
        </div>

        <section className="rounded border border-neutral-800 p-3">
          {trade.side && (
            <Row k="구분" v={`${trade.side === "BUY" ? "매수" : "매도"} · ${actionLabel(trade)}`} />
          )}
          {trade.method && <Row k="주문 방식" v={(METHOD_LABEL[trade.method] ?? METHOD_LABEL.UNKNOWN).text} />}
          {trade.avgPrice > 0 && <Row k="평균 체결가 / 수량" v={`${trade.avgPrice} / ${trade.qty}`} />}
          <Row k="Realized PnL" v={`${trade.pnlUsdt.toFixed(4)} USDT (${krw(trade.pnlKrw)})`} cls={tone(trade.pnlUsdt)} />
          <Row k="수수료" v={`${trade.feeUsdt.toFixed(4)} USDT (${krw(trade.feeKrw)})`} />
          {trade.kind === "FUNDING" && (
            <Row k="펀딩비" v={`${trade.fundingUsdt.toFixed(4)} USDT (${krw(trade.fundingKrw)})`} />
          )}
          <Row k={`적용 환율 (${trade.date})`} v={`${trade.rate.toFixed(2)} KRW/USD`} />
          <Row k="순손익" v={krw(trade.netKrw)} cls={`font-semibold ${tone(trade.netKrw)}`} />
        </section>

        <section className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold">진입/청산 근거 (Markdown)</label>
            <button onClick={() => setPreview(!preview)} className="text-xs text-amber-400">
              {preview ? "편집" : "미리보기"}
            </button>
          </div>
          {preview ? (
            <div className="prose prose-invert prose-sm min-h-60 max-w-none rounded border border-neutral-800 p-3">
              <ReactMarkdown>{reason || "*내용 없음*"}</ReactMarkdown>
            </div>
          ) : (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={"## 진입 근거\n- \n## 청산 근거\n- "}
              className="min-h-60 flex-1 rounded border border-neutral-700 bg-neutral-950 p-3 font-mono text-sm"
            />
          )}

          <label className="text-sm font-semibold">전략 태그 (콤마 구분)</label>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="breakout, scalping"
            className="rounded border border-neutral-700 bg-neutral-950 p-2 text-sm"
          />
        </section>

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="flex-1 rounded bg-amber-500 py-2 text-sm font-semibold text-black disabled:opacity-50"
          >
            {busy ? "저장 중…" : "저장"}
          </button>
          <button onClick={clearNote} className="rounded border border-rose-500 px-4 text-sm text-rose-400">
            일지 삭제
          </button>
        </div>
      </aside>
    </>
  );
}
