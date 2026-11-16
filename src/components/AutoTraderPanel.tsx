"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface BotConfig {
  id: string;
  enabled: boolean;
  paperMode: boolean;
  minConfidence: number;
  timeframe: string;
  marginUsdt: number;
  leverage: number;
  marginType: string;
  maxOpenPositions: number;
  cooldownMin: number;
  allowLong: boolean;
  allowShort: boolean;
}

interface AutoTradeRow {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  isPaper: boolean;
  timeframe: string;
  strategyName: string;
  confidence: number;
  reasons: string;
  rsiAtEntry: number;
  volSpikeAtEntry: number;
  marginUsdt: number;
  leverage: number;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rrRatio: number;
  status: "OPEN" | "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "CLOSED" | "ERROR";
  exitPrice: number | null;
  pnlUsdt: number;
  pnlRoiPct: number;
  orderId: string;
  logs: string;
  createdAt: string;
  closedAt: string | null;
}

interface CandidatePreview {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyName: string;
  confidence: number;
  entryPrice: number;
  rsi: number;
  volSpike: number;
}

const short = (s: string) => s.replace(/USDT$/, "");
const fmtPx = (n: number) =>
  n ? `$${Number(n.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 8 })}` : "-";

function fmtKrw(usd: number, rate: number): string {
  const won = usd * rate;
  if (!Number.isFinite(won)) return "-";
  const abs = Math.abs(won);
  const sign = won < 0 ? "-" : "";
  if (abs >= 100) return `${sign}₩${Math.round(abs).toLocaleString("ko-KR")}`;
  if (abs >= 1) return `${sign}₩${abs.toFixed(2)}`;
  return `${sign}₩${Number(abs.toPrecision(3))}`;
}

const STATUS_BADGE: Record<
  AutoTradeRow["status"],
  { label: string; cls: string }
> = {
  OPEN: {
    label: "🟢 진행중",
    cls: "bg-sky-500/20 text-sky-300 border border-sky-600/40",
  },
  TP1_HIT: {
    label: "💰 1차익절(반익)",
    cls: "bg-emerald-500/20 text-emerald-300 border border-emerald-600/40",
  },
  TP2_HIT: {
    label: "🚀 2차목표 완익",
    cls: "bg-emerald-500 text-black font-black",
  },
  SL_HIT: {
    label: "🛑 손절(SL) 도달",
    cls: "bg-rose-500/20 text-rose-300 border border-rose-600/40",
  },
  CLOSED: {
    label: "⏹️ 수동 종료",
    cls: "bg-neutral-700 text-neutral-200",
  },
  ERROR: {
    label: "❌ 주문 오류",
    cls: "bg-rose-900/50 text-rose-200",
  },
};

export default function AutoTraderPanel({ fxRate = 1350 }: { fxRate?: number }) {
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [trades, setTrades] = useState<AutoTradeRow[]>([]);
  const [candidates, setCandidates] = useState<CandidatePreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [modeFilter, setModeFilter] = useState<"all" | "paper" | "live">("all");
  const [stateFilter, setStateFilter] = useState<"all" | "open" | "closed">("all");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auto-trade", { cache: "no-store" });
      const data = await res.json();
      if (data.config) setCfg(data.config);
      if (data.trades) setTrades(data.trades);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 봇 설정 변경 저장
  const updateConfig = async (patch: Partial<BotConfig>) => {
    if (!cfg) return;
    const optimistic = { ...cfg, ...patch };
    setCfg(optimistic);
    const res = await fetch("/api/auto-trade", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (data.config) setCfg(data.config);
  };

  // 즉시 스캔 & 조건 충족 시 자동매매 실행
  const runTick = useCallback(async (force = false) => {
    setScanning(true);
    setStatusMsg("전 종목 캔들 스캔 및 95점+ 타점 탐색 중…");
    try {
      const res = await fetch("/api/auto-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data.trades) setTrades(data.trades);
      if (data.candidates) setCandidates(data.candidates);
      if (data.executed?.length > 0) {
        setStatusMsg(
          `🎯 신규 자동 진입 ${data.executed.length}건 완료! (${data.executed
            .map((x: AutoTradeRow) => `${short(x.symbol)} ${x.side} ${x.confidence}점`)
            .join(", ")})`
        );
      } else if (data.skippedReason) {
        setStatusMsg(data.skippedReason);
      } else {
        setStatusMsg("스캔 완료");
      }
    } catch (e) {
      setStatusMsg(`오류: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  // 봇이 ON 상태이면 60초마다 자동 스캔 및 포지션 갱신
  useEffect(() => {
    if (!cfg?.enabled) return;
    runTick(false);
    const timer = window.setInterval(() => {
      runTick(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [cfg?.enabled, runTick]);

  const handleRowAction = async (id: string, action: "close" | "delete") => {
    const res = await fetch(`/api/auto-trade?id=${id}&action=${action}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (data.trades) setTrades(data.trades);
  };

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (modeFilter === "paper" && !t.isPaper) return false;
      if (modeFilter === "live" && t.isPaper) return false;
      if (stateFilter === "open" && t.status !== "OPEN" && t.status !== "TP1_HIT")
        return false;
      if (
        stateFilter === "closed" &&
        (t.status === "OPEN" || t.status === "TP1_HIT")
      )
        return false;
      return true;
    });
  }, [trades, modeFilter, stateFilter]);

  const stats = useMemo(() => {
    const valid = filteredTrades.filter((t) => t.status !== "ERROR");
    const openCnt = valid.filter(
      (t) => t.status === "OPEN" || t.status === "TP1_HIT"
    ).length;
    const wins = valid.filter(
      (t) =>
        t.status === "TP1_HIT" ||
        t.status === "TP2_HIT" ||
        (t.status === "CLOSED" && t.pnlUsdt > 0)
    ).length;
    const losses = valid.filter(
      (t) => t.status === "SL_HIT" || (t.status === "CLOSED" && t.pnlUsdt < 0)
    ).length;
    const settled = wins + losses;
    const winRate = settled > 0 ? (wins / settled) * 100 : 0;
    const totalPnlUsdt = valid.reduce((a, b) => a + b.pnlUsdt, 0);
    const avgScore =
      valid.length > 0
        ? valid.reduce((a, b) => a + b.confidence, 0) / valid.length
        : 0;
    return {
      total: valid.length,
      openCnt,
      wins,
      losses,
      winRate,
      totalPnlUsdt,
      avgScore,
    };
  }, [filteredTrades]);

  if (!cfg) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center text-sm text-neutral-400">
        자동매매 설정을 불러오는 중입니다…
      </div>
    );
  }

  return (
    <section className="space-y-5">
      {/* 1. 상단 자동매매 봇 컨트롤 센터 */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-black text-white">
                🤖 AI 타점 신뢰도 {cfg.minConfidence}점+ 자동매매 엔진
              </h2>
              <span
                className={`rounded-full px-3 py-0.5 text-xs font-black ${
                  cfg.enabled
                    ? "animate-pulse bg-emerald-500 text-black"
                    : "bg-neutral-800 text-neutral-400"
                }`}
              >
                {cfg.enabled ? "● AUTO RUNNING (1분 주기 감시중)" : "○ STOPPED"}
              </span>
              <span
                className={`rounded-md px-2.5 py-0.5 text-xs font-extrabold ${
                  cfg.paperMode
                    ? "border border-sky-700 bg-sky-950/60 text-sky-300"
                    : "border border-rose-700 bg-rose-950/60 text-rose-300"
                }`}
              >
                {cfg.paperMode ? "🧪 모의투자 모드 (가상체결)" : "🔥 실전투자 모드 (바이낸스 실주문)"}
              </span>
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              스캐너가 1분마다 급등·급락 상위 종목의 RSI·다이버전스·거래량·ATR을 분석해{" "}
              <strong className="text-amber-300">신뢰도 {cfg.minConfidence}점 이상</strong>인 타점만 자동으로 진입(TP1/TP2/SL 동시 설정)하고 전용 DB(`AutoTrade`)에 기록합니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* 모의투자 vs 실전투자 전환 */}
            <button
              type="button"
              onClick={() => updateConfig({ paperMode: !cfg.paperMode })}
              className={`rounded-xl border px-3.5 py-2 text-xs font-extrabold transition ${
                cfg.paperMode
                  ? "border-sky-700 bg-sky-950/40 text-sky-300 hover:bg-sky-900/50"
                  : "border-rose-700 bg-rose-950/40 text-rose-300 hover:bg-rose-900/50"
              }`}
            >
              {cfg.paperMode ? "🧪 현재: 모의투자 (클릭 시 실전 전환)" : "🔥 현재: 실전투자 (클릭 시 모의 전환)"}
            </button>

            {/* 즉시 1회 강제 스캔 & 실행 */}
            <button
              type="button"
              disabled={scanning}
              onClick={() => runTick(true)}
              className="rounded-xl border border-amber-600/70 bg-amber-500/15 px-3.5 py-2 text-xs font-extrabold text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
            >
              {scanning ? "스캔 중…" : "⚡ 지금 즉시 스캔 & 조건 충족 시 실행"}
            </button>

            {/* 자동매매 마스터 ON/OFF 버튼 */}
            <button
              type="button"
              onClick={() => updateConfig({ enabled: !cfg.enabled })}
              className={`rounded-xl px-5 py-2 text-xs font-black transition ${
                cfg.enabled
                  ? "bg-rose-600 text-white hover:bg-rose-500"
                  : "bg-emerald-500 text-black hover:bg-emerald-400"
              }`}
            >
              {cfg.enabled ? "⏹️ 자동매매 중지 (OFF)" : "▶️ 자동매매 시작 (ON)"}
            </button>
          </div>
        </div>

        {/* 세부 설정 그리드 */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {/* 1. 최소 신뢰도 점수 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="block text-[11px] font-bold text-neutral-400">
              최소 진입 점수 (기본 95점)
            </label>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                min={70}
                max={99}
                value={cfg.minConfidence}
                onChange={(e) =>
                  updateConfig({
                    minConfidence: Math.min(99, Math.max(70, Number(e.target.value))),
                  })
                }
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-sm font-black text-amber-400"
              />
              <span className="text-xs font-bold text-neutral-400">점+</span>
            </div>
          </div>

          {/* 2. 기준 분봉 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="block text-[11px] font-bold text-neutral-400">
              스캔 기준 타임프레임
            </label>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {["15m", "1h", "4h"].map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => updateConfig({ timeframe: tf })}
                  className={`rounded py-1 text-xs font-bold ${
                    cfg.timeframe === tf
                      ? "bg-amber-500 text-black"
                      : "bg-neutral-800 text-neutral-400"
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          {/* 3. 회당 투입 증거금 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex items-center justify-between text-[11px] font-bold text-neutral-400">
              <span>1회 증거금 (USDT)</span>
              <span className="text-emerald-400">
                {fmtKrw(cfg.marginUsdt, fxRate)}
              </span>
            </label>
            <input
              type="number"
              min={5}
              step="5"
              value={cfg.marginUsdt}
              onChange={(e) =>
                updateConfig({ marginUsdt: Math.max(5, Number(e.target.value)) })
              }
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-sm font-black text-white"
            />
          </div>

          {/* 4. 레버리지 & 마진모드 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex items-center justify-between text-[11px] font-bold text-neutral-400">
              <span>레버리지 배율</span>
              <button
                type="button"
                onClick={() =>
                  updateConfig({
                    marginType: cfg.marginType === "ISOLATED" ? "CROSSED" : "ISOLATED",
                  })
                }
                className="text-[10px] text-amber-300 underline"
              >
                {cfg.marginType === "ISOLATED" ? "격리(Isolated)" : "교차(Cross)"}
              </button>
            </label>
            <div className="mt-1 flex items-center gap-1">
              {[2, 3, 5, 7, 10].map((lv) => (
                <button
                  key={lv}
                  type="button"
                  onClick={() => updateConfig({ leverage: lv })}
                  className={`flex-1 rounded py-1 text-xs font-bold ${
                    cfg.leverage === lv
                      ? "bg-amber-500 text-black"
                      : "bg-neutral-800 text-neutral-400"
                  }`}
                >
                  {lv}x
                </button>
              ))}
            </div>
          </div>

          {/* 5. 동시 최대 포지션 수 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="block text-[11px] font-bold text-neutral-400">
              동시 최대 보유 종목
            </label>
            <div className="mt-1 flex items-center gap-1">
              {[1, 2, 3, 5].map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  onClick={() => updateConfig({ maxOpenPositions: cnt })}
                  className={`flex-1 rounded py-1 text-xs font-bold ${
                    cfg.maxOpenPositions === cnt
                      ? "bg-amber-500 text-black"
                      : "bg-neutral-800 text-neutral-400"
                  }`}
                >
                  {cnt}개
                </button>
              ))}
            </div>
          </div>

          {/* 6. 재진입 금지 쿨타임 & 방향 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex items-center justify-between text-[11px] font-bold text-neutral-400">
              <span>쿨타임(분)</span>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => updateConfig({ allowLong: !cfg.allowLong })}
                  className={cfg.allowLong ? "text-emerald-400" : "text-neutral-600"}
                >
                  L✓
                </button>
                <button
                  type="button"
                  onClick={() => updateConfig({ allowShort: !cfg.allowShort })}
                  className={cfg.allowShort ? "text-rose-400" : "text-neutral-600"}
                >
                  S✓
                </button>
              </span>
            </label>
            <input
              type="number"
              min={15}
              step={15}
              value={cfg.cooldownMin}
              onChange={(e) =>
                updateConfig({ cooldownMin: Math.max(15, Number(e.target.value)) })
              }
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 font-mono text-sm font-bold text-white"
            />
          </div>
        </div>

        {/* 스캔 상태 알림줄 & 현재 상위 점수 후보 미리보기 */}
        {statusMsg && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3.5 py-2 text-xs text-neutral-300">
            <span>📡 최근 스캔 상태: {statusMsg}</span>
            {candidates.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-neutral-500">현재 최고점 후보:</span>
                {candidates.slice(0, 4).map((c) => (
                  <span
                    key={c.symbol}
                    className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                      c.confidence >= cfg.minConfidence
                        ? "bg-emerald-500 text-black"
                        : "bg-neutral-800 text-neutral-300"
                    }`}
                  >
                    {short(c.symbol)} {c.side} {c.confidence}점
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. 자동매매 전용 성적표 KPI 카드 4개 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-xs text-neutral-400">자동매매 누적 실행 건수</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-white">{stats.total}건</span>
            <span className="text-xs font-bold text-sky-400">
              진행중 {stats.openCnt}건
            </span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">
            평균 진입 신뢰도: {stats.avgScore ? `${stats.avgScore.toFixed(1)}점` : "-"}
          </p>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-xs text-neutral-400">자동매매 승률 (익절 vs 손절)</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-amber-400">
              {stats.winRate.toFixed(1)}%
            </span>
            <span className="text-xs text-neutral-300">
              <strong className="text-emerald-400">{stats.wins}승</strong> /{" "}
              <strong className="text-rose-400">{stats.losses}패</strong>
            </span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">
            1차 익절(TP1) 이상 도달 시 승리 집계
          </p>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-xs text-neutral-400">자동매매 누적 순손익 (KRW / USD)</div>
          <div
            className={`mt-1 text-2xl font-black ${
              stats.totalPnlUsdt >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {stats.totalPnlUsdt >= 0 ? "+" : ""}
            {fmtKrw(stats.totalPnlUsdt, fxRate)}
          </div>
          <p className="mt-1 font-mono text-xs text-neutral-400">
            {stats.totalPnlUsdt >= 0 ? "+" : ""}${stats.totalPnlUsdt.toFixed(2)} USDT
          </p>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-xs text-neutral-400">1회 포지션 규모 (증거금 × 배율)</div>
          <div className="mt-1 text-xl font-black text-white">
            {fmtKrw(cfg.marginUsdt * cfg.leverage, fxRate)}
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            증거금 ${cfg.marginUsdt} × {cfg.leverage}x = $
            {(cfg.marginUsdt * cfg.leverage).toFixed(0)} USDT
          </p>
        </div>
      </div>

      {/* 3. 별도 저장된 AutoTrade 전용 데이터베이스 내역 표 */}
      <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
          <div>
            <h3 className="text-sm font-extrabold text-white">
              📂 자동매매 전용 데이터베이스 기록 (`AutoTrade` 테이블)
            </h3>
            <p className="text-xs text-neutral-400">
              일반 수동 매매와 분리되어 저장되며, 진입 당시 AI 신뢰도 점수와 근거, TP/SL 도달 여부가 실시간 추적됩니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
              {(
                [
                  ["all", "전체"],
                  ["paper", "🧪 모의투자만"],
                  ["live", "🔥 실전투자만"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setModeFilter(k)}
                  className={`px-2.5 py-1 font-bold ${
                    modeFilter === k
                      ? "bg-amber-500 text-black"
                      : "text-neutral-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
              {(
                [
                  ["all", "전체 상태"],
                  ["open", "진행중"],
                  ["closed", "종료됨"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setStateFilter(k)}
                  className={`px-2.5 py-1 font-bold ${
                    stateFilter === k
                      ? "bg-amber-500 text-black"
                      : "text-neutral-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={loadData}
              disabled={loading}
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1 font-semibold text-neutral-200 hover:bg-neutral-700"
            >
              {loading ? "갱신 중…" : "시세·상태 새로고침"}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-neutral-950/60 text-left text-neutral-400">
              <tr>
                <th className="p-3">진입 시각 (KST)</th>
                <th className="p-3">구분 / 종목</th>
                <th className="p-3">AI 점수 & 진입 근거</th>
                <th className="p-3 text-right">증거금 · 수량</th>
                <th className="p-3 text-right">진입가 (KRW / USD)</th>
                <th className="p-3 text-right">손절(SL) / 익절(TP1·TP2)</th>
                <th className="p-3 text-center">현재 상태</th>
                <th className="p-3 text-right">손익 (KRW / USD / ROI)</th>
                <th className="p-3 text-center">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {filteredTrades.map((t) => {
                let parsedReasons: string[] = [];
                try {
                  parsedReasons = JSON.parse(t.reasons);
                } catch {
                  parsedReasons = [t.reasons];
                }
                const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.OPEN;
                const isUp = t.pnlUsdt >= 0;

                return (
                  <tr key={t.id} className="hover:bg-neutral-800/40">
                    <td className="p-3 whitespace-nowrap text-neutral-400">
                      {new Date(t.createdAt).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      <div className="text-[10px] text-neutral-500">
                        {t.timeframe} 분봉 기준
                      </div>
                    </td>

                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            t.isPaper
                              ? "bg-sky-950 text-sky-300 border border-sky-700/50"
                              : "bg-rose-950 text-rose-300 border border-rose-700/50"
                          }`}
                        >
                          {t.isPaper ? "모의" : "실전"}
                        </span>
                        <span className="text-sm font-black text-white">
                          {short(t.symbol)}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                            t.side === "LONG"
                              ? "bg-emerald-500 text-black"
                              : "bg-rose-500 text-white"
                          }`}
                        >
                          {t.side} {t.leverage}x
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-400">
                        {t.strategyName}
                      </div>
                    </td>

                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-xs font-black text-amber-300">
                          ★ {t.confidence}점
                        </span>
                        <span className="text-[11px] text-neutral-400">
                          RSI {t.rsiAtEntry.toFixed(1)} · 거래량{" "}
                          {t.volSpikeAtEntry.toFixed(1)}x
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {parsedReasons.map((r, i) => (
                          <span
                            key={i}
                            className="rounded bg-neutral-950 px-1.5 py-0.5 text-[10px] text-neutral-400"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>

                    <td className="p-3 text-right">
                      <div className="font-bold text-neutral-200">
                        {fmtKrw(t.marginUsdt, fxRate)}{" "}
                        <span className="font-mono text-neutral-400">
                          (${t.marginUsdt})
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-amber-300">
                        수량: {t.quantity} {short(t.symbol)}
                      </div>
                    </td>

                    <td className="p-3 text-right">
                      <div className="font-bold text-white">
                        {fmtKrw(t.entryPrice, fxRate)}
                      </div>
                      <div className="font-mono text-[11px] text-neutral-400">
                        {fmtPx(t.entryPrice)}
                      </div>
                    </td>

                    <td className="p-3 text-right font-mono text-[11px]">
                      <div className="text-rose-400">SL: {fmtPx(t.stopLoss)}</div>
                      <div className="text-emerald-400">TP1: {fmtPx(t.tp1)}</div>
                      <div className="text-emerald-300">TP2: {fmtPx(t.tp2)}</div>
                    </td>

                    <td className="p-3 text-center">
                      <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </td>

                    <td className="p-3 text-right">
                      <div
                        className={`text-sm font-black ${
                          isUp ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {isUp ? "+" : ""}
                        {fmtKrw(t.pnlUsdt, fxRate)}
                      </div>
                      <div
                        className={`font-mono text-[11px] ${
                          isUp ? "text-emerald-300/80" : "text-rose-300/80"
                        }`}
                      >
                        {isUp ? "+" : ""}${t.pnlUsdt.toFixed(2)} (
                        {isUp ? "+" : ""}
                        {t.pnlRoiPct.toFixed(1)}%)
                      </div>
                    </td>

                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {(t.status === "OPEN" || t.status === "TP1_HIT") && (
                          <button
                            type="button"
                            onClick={() => handleRowAction(t.id, "close")}
                            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                          >
                            종료처리
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRowAction(t.id, "delete")}
                          className="rounded border border-rose-900/60 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-900/50"
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredTrades.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-10 text-center text-neutral-500">
                    아직 기록된 자동매매 내역이 없습니다. 상단에서{" "}
                    <strong className="text-amber-300">
                      &apos;⚡ 지금 즉시 스캔 &amp; 조건 충족 시 실행&apos;
                    </strong>{" "}
                    또는 <strong className="text-emerald-400">&apos;▶️ 자동매매 시작 (ON)&apos;</strong>을 눌러보세요! (테스트 시에는 최소 진입 점수를 85~90점으로 낮춰 테스트해 볼 수도 있습니다.)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
