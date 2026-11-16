"use client";

import { useEffect, useMemo, useState } from "react";
import { krw, tone, type TradeDTO, type TransferDTO } from "@/lib/types";

const short = (s: string) => s.replace(/USDT$|USDC$|BUSD$/, "");
const kstToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

const MILESTONES = [
  { amount: 1_000_000, icon: "🌱", title: "첫 타격", desc: "100만 원 격파" },
  { amount: 5_000_000, icon: "⚔️", title: "몸풀기 완료", desc: "500만 원 격파" },
  { amount: 10_000_000, icon: "🛡️", title: "앞자리 파괴", desc: "1,000만 원 격파" },
  { amount: 20_000_000, icon: "🔥", title: "가속도 붙음", desc: "2,000만 원 격파" },
  { amount: 35_000_000, icon: "👑", title: "반환점 돌파", desc: "3,500만 원 격파" },
  { amount: 50_000_000, icon: "💎", title: "승기 잡음", desc: "5,000만 원 격파" },
  { amount: 70_000_000, icon: "🎉", title: "무차입 자유인", desc: "전액 청산 완료!" },
];

const STORAGE_KEY = "trading-journal-debt-quest-v1";

export default function DebtQuest({
  trades,
  transfers,
}: {
  trades: TradeDTO[];
  transfers: TransferDTO[];
}) {
  // 사용자 설정 상태 (localStorage 연동)
  const [totalDebt, setTotalDebt] = useState(70_000_000);
  const [targetDays, setTargetDays] = useState(365);
  const [monthlyExtra, setMonthlyExtra] = useState(0); // 월급 등 본업 추가 상환액(원/월)
  const [extraRepaid, setExtraRepaid] = useState(0); // 트레이딩 외 이미 갚은 원금(원)
  const [basis, setBasis] = useState<"pnl" | "withdraw">("pnl");
  const [paceMode, setPaceMode] = useState<"active" | "calendar">("active");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.totalDebt === "number") setTotalDebt(parsed.totalDebt);
        if (typeof parsed.targetDays === "number") setTargetDays(parsed.targetDays);
        if (typeof parsed.monthlyExtra === "number") setMonthlyExtra(parsed.monthlyExtra);
        if (typeof parsed.extraRepaid === "number") setExtraRepaid(parsed.extraRepaid);
        if (parsed.basis === "pnl" || parsed.basis === "withdraw") setBasis(parsed.basis);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ totalDebt, targetDays, monthlyExtra, extraRepaid, basis })
      );
    } catch {
      // ignore
    }
  }, [totalDebt, targetDays, monthlyExtra, extraRepaid, basis]);

  // 전체 매매 & 입출금 통계 계산
  const stats = useMemo(() => {
    const today = kstToday();
    let totalNetKrw = 0;
    let totalPnlKrw = 0;
    let totalFeeKrw = 0;
    let totalFundingKrw = 0;
    let todayNetKrw = 0;
    let rateSum = 0;

    const byDate = new Map<string, number>();
    const bySymbol = new Map<
      string,
      { symbol: string; netKrw: number; pnlKrw: number; costKrw: number; count: number }
    >();

    let winCount = 0;
    let lossCount = 0;
    let winSumKrw = 0;
    let lossSumKrw = 0;

    for (const t of trades) {
      totalNetKrw += t.netKrw;
      totalPnlKrw += t.pnlKrw;
      totalFeeKrw += t.feeKrw;
      totalFundingKrw += t.fundingKrw;
      rateSum += t.rate;
      if (t.date === today) todayNetKrw += t.netKrw;

      byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.netKrw);

      const sym = bySymbol.get(t.symbol) ?? {
        symbol: t.symbol,
        netKrw: 0,
        pnlKrw: 0,
        costKrw: 0,
        count: 0,
      };
      sym.netKrw += t.netKrw;
      sym.pnlKrw += t.pnlKrw;
      sym.costKrw += t.feeKrw + t.fundingKrw;
      if (t.kind === "TRADE") sym.count += 1;
      bySymbol.set(t.symbol, sym);

      if (t.kind === "TRADE" && t.pnlKrw !== 0) {
        if (t.pnlKrw > 0) {
          winCount++;
          winSumKrw += t.pnlKrw;
        } else {
          lossCount++;
          lossSumKrw += t.pnlKrw;
        }
      }
    }

    const dates = [...byDate.keys()].sort();
    const activeDays = Math.max(1, dates.length);
    const firstDate = dates[0] ?? today;
    const calendarDays = Math.max(
      1,
      Math.round((new Date(today).getTime() - new Date(firstDate).getTime()) / 86_400_000) + 1
    );

    const winDays = [...byDate.values()].filter((v) => v > 0).length;
    const lossDays = [...byDate.values()].filter((v) => v < 0).length;

    const avgRate = trades.length ? rateSum / trades.length : 1350;

    // 실제 출금액 합계
    const withdrawKrw = transfers
      .filter((t) => t.type === "WITHDRAW")
      .reduce((acc, t) => acc + (t.amountKrw ?? 0), 0);
    const withdrawCount = transfers.filter((t) => t.type === "WITHDRAW").length;

    // 종목 정렬
    const symbols = [...bySymbol.values()].sort((a, b) => b.netKrw - a.netKrw);
    const bestSymbols = symbols.filter((s) => s.netKrw > 0).slice(0, 3);
    const worstSymbols = [...symbols]
      .filter((s) => s.netKrw < 0)
      .sort((a, b) => a.netKrw - b.netKrw)
      .slice(0, 3);
    const worstLossSum = worstSymbols.reduce((a, s) => a + Math.abs(s.netKrw), 0);

    // 수수료+펀딩비가 가장 많이 나간 종목
    const topCostSymbol = [...bySymbol.values()].sort((a, b) => a.costKrw - b.costKrw)[0] ?? null;

    const avgWin = winCount ? winSumKrw / winCount : 0;
    const avgLoss = lossCount ? Math.abs(lossSumKrw / lossCount) : 0;
    const winRate = winCount + lossCount > 0 ? (winCount / (winCount + lossCount)) * 100 : 0;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
    const closedCount = winCount + lossCount;
    const expectancyKrw = closedCount > 0 ? totalNetKrw / closedCount : 0;

    return {
      totalNetKrw,
      totalPnlKrw,
      totalFeeKrw,
      totalFundingKrw,
      totalCostKrw: totalFeeKrw + totalFundingKrw,
      todayNetKrw,
      activeDays,
      calendarDays,
      firstDate,
      winDays,
      lossDays,
      avgActiveDailyKrw: totalNetKrw / activeDays,
      avgCalendarDailyKrw: totalNetKrw / calendarDays,
      avgRate,
      withdrawKrw,
      withdrawCount,
      bestSymbols,
      worstSymbols,
      worstLossSum,
      topCostSymbol,
      winCount,
      lossCount,
      avgWin,
      avgLoss,
      winRate,
      payoffRatio,
      expectancyKrw,
    };
  }, [trades, transfers]);

  // 현재 선택한 기준에 따른 갚은 금액 & 남은 빚
  const tradingRepaid = basis === "pnl" ? Math.max(0, stats.totalNetKrw) : stats.withdrawKrw;
  const totalRepaid = tradingRepaid + extraRepaid;
  const remainingDebt = Math.max(0, totalDebt - totalRepaid);
  const progressPct = totalDebt > 0 ? Math.min(100, (totalRepaid / totalDebt) * 100) : 0;

  // 미출금 수익 (순수익 - 실제 출금액)
  const unwithdrawnKrw = Math.max(0, stats.totalNetKrw - stats.withdrawKrw);

  // 기간 내 월 고정 추가 상환액 총합을 뺀 뒤 트레이딩으로 벌어야 할 금액
  const dailyExtraFromSalary = (monthlyExtra * 12) / 365;
  const requiredTotalDailyKrw = targetDays > 0 ? remainingDebt / targetDays : 0;
  const requiredTradingDailyKrw = Math.max(0, requiredTotalDailyKrw - dailyExtraFromSalary);
  const requiredTradingDailyUsdt = requiredTradingDailyKrw / stats.avgRate;

  // 현재 내 페이스 기준 예상 소요 일수
  const myDailyTradingKrw =
    paceMode === "active" ? stats.avgActiveDailyKrw : stats.avgCalendarDailyKrw;
  const myTotalDailyKrw = myDailyTradingKrw + dailyExtraFromSalary;
  const estDaysAtCurrentPace =
    myTotalDailyKrw > 0 ? Math.ceil(remainingDebt / myTotalDailyKrw) : null;

  const estPayoffDate = useMemo(() => {
    if (!estDaysAtCurrentPace || estDaysAtCurrentPace > 36500) return null;
    const d = new Date(Date.now() + estDaysAtCurrentPace * 86_400_000);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  }, [estDaysAtCurrentPace]);

  const targetDateStr = useMemo(() => {
    const d = new Date(Date.now() + targetDays * 86_400_000);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  }, [targetDays]);

  // 오늘의 일일 퀘스트 달성률
  const todayQuestPct =
    requiredTradingDailyKrw > 0
      ? Math.min(200, Math.max(-100, (stats.todayNetKrw / requiredTradingDailyKrw) * 100))
      : 0;

  // 비주력 손실 종목 안 건드렸을 때 단축되는 일수
  const daysSavedIfNoWorst =
    myTotalDailyKrw > 0 ? Math.round(stats.worstLossSum / myTotalDailyKrw) : 0;

  // 수수료 치킨 환산 (1마리 25,000원 기준)
  const chickenCount = Math.abs(stats.totalCostKrw) / 25_000;

  return (
    <section className="space-y-6">
      {/* ① 상단: 보스 몬스터 체력바 (부채 현황 & 마일스톤) */}
      <div className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-br from-neutral-900 via-neutral-900 to-amber-950/20 p-6 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-rose-500/20 px-2.5 py-0.5 text-xs font-extrabold text-rose-400 border border-rose-500/30">
                BOSS RAID
              </span>
              <span className="text-xs text-neutral-400">
                데이터 집계 시작일: {stats.firstDate} ({stats.activeDays}일 매매 / 총 {stats.calendarDays}일 경과)
              </span>
            </div>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-white">
              🐉 부채 드래곤 토벌 작전
            </h2>
            <p className="mt-0.5 text-sm text-neutral-400">
              꾸준한 수익 확정과 출금으로 보스의 체력(원금)을 0으로 만드세요!
            </p>
          </div>

          {/* 차감 기준 토글 */}
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-[11px] text-neutral-400">데미지(상환액) 반영 기준</span>
            <div className="flex overflow-hidden rounded-lg border border-neutral-700 text-xs">
              <button
                onClick={() => setBasis("pnl")}
                className={`px-3 py-1.5 font-semibold transition ${
                  basis === "pnl"
                    ? "bg-amber-500 text-black"
                    : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                순수익 기준 ({krw(stats.totalNetKrw)})
              </button>
              <button
                onClick={() => setBasis("withdraw")}
                className={`px-3 py-1.5 font-semibold transition ${
                  basis === "withdraw"
                    ? "bg-amber-500 text-black"
                    : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                실제 출금 기준 ({krw(stats.withdrawKrw)})
              </button>
            </div>
          </div>
        </div>

        {/* 체력바 수치 요약 */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/70 p-4">
            <span className="text-xs text-neutral-400">남은 보스 체력 (잔여 부채)</span>
            <p className="mt-1 text-2xl font-black text-rose-400">{krw(remainingDebt)}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              총 부채 {krw(totalDebt)} 중 {(100 - progressPct).toFixed(2)}% 남음
            </p>
          </div>

          <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-4">
            <span className="text-xs text-emerald-300/90">누적 타격 데미지 (총 갚은 금액)</span>
            <p className="mt-1 text-2xl font-black text-emerald-400">{krw(totalRepaid)}</p>
            <p className="mt-0.5 text-xs text-neutral-400">
              트레이딩 {krw(tradingRepaid)} + 외부상환 {krw(extraRepaid)}
            </p>
          </div>

          <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
            <span className="text-xs text-amber-300/90">아직 출금 안 한 수익 (거래소 대기)</span>
            <p className="mt-1 text-2xl font-black text-amber-400">{krw(unwithdrawnKrw)}</p>
            <p className="mt-0.5 text-xs text-neutral-400">
              업비트 출금 완료: {stats.withdrawCount}회 (총 {krw(stats.withdrawKrw)})
            </p>
          </div>
        </div>

        {/* 보스 HP 게이지 바 */}
        <div className="mt-5">
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="font-bold text-rose-400">
              ❤️ BOSS HP: { (100 - progressPct).toFixed(2) }%
            </span>
            <span className="font-extrabold text-amber-400">
              격파 진행률 {progressPct.toFixed(2)}% 달성!
            </span>
          </div>
          <div className="relative h-6 w-full overflow-hidden rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-amber-500 transition-all duration-500"
              style={{ width: `${Math.max(1.5, progressPct)}%` }}
            />
          </div>
        </div>

        {/* 마일스톤 칭호 트랙 */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-7">
          {MILESTONES.map((m) => {
            const cleared = totalRepaid >= m.amount;
            const ratio = Math.min(100, (totalRepaid / m.amount) * 100);
            return (
              <div
                key={m.amount}
                className={`rounded-xl border p-2.5 text-center transition ${
                  cleared
                    ? "border-amber-400/70 bg-amber-500/15 text-amber-200 shadow-sm"
                    : "border-neutral-800 bg-neutral-950/60 text-neutral-500"
                }`}
              >
                <div className="text-lg">{cleared ? "✅" : m.icon}</div>
                <div className="mt-0.5 text-xs font-extrabold text-neutral-200">{m.title}</div>
                <div className="text-[10px] text-neutral-400">{m.desc}</div>
                {!cleared && (
                  <div className="mt-1 text-[10px] font-semibold text-amber-400/80">
                    {ratio.toFixed(0)}%
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ② 중단: 기간 설정 슬라이더 & 일일 목표 시뮬레이터 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* 왼쪽: 설정 컨트롤 패널 */}
        <div className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-5 lg:col-span-5">
          <h3 className="text-base font-extrabold text-white">⚙️ 목표 기간 & 상환 조건 설정</h3>

          {/* 총 부채 & 이미 갚은 외부 금액 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400">총 부채 원금 (원)</label>
              <input
                type="number"
                step={1_000_000}
                value={totalDebt}
                onChange={(e) => setTotalDebt(Math.max(0, Number(e.target.value)))}
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-bold text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-400">외부 기상환액 (월급 등)</label>
              <input
                type="number"
                step={500_000}
                value={extraRepaid}
                onChange={(e) => setExtraRepaid(Math.max(0, Number(e.target.value)))}
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-bold text-emerald-400"
              />
            </div>
          </div>

          {/* 목표 기간 슬라이더 */}
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-neutral-400">목표 완납 기간</label>
              <span className="text-sm font-extrabold text-amber-400">
                {targetDays}일 ({(targetDays / 30.4).toFixed(1)}개월 · {targetDateStr}까지)
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={1460}
              step={5}
              value={targetDays}
              onChange={(e) => setTargetDays(Number(e.target.value))}
              className="mt-2 w-full accent-amber-500"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                { label: "6개월", days: 180 },
                { label: "1년", days: 365 },
                { label: "1.5년", days: 548 },
                { label: "2년", days: 730 },
                { label: "3년", days: 1095 },
              ].map((p) => (
                <button
                  key={p.days}
                  onClick={() => setTargetDays(p.days)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    targetDays === p.days
                      ? "bg-amber-500 text-black"
                      : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 월 고정 추가 상환액 (본업/부수입) */}
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-neutral-400">
                매월 본업/월급 추가 상환액 (트레이딩 부담 경감)
              </label>
              <span className="text-xs font-bold text-sky-400">{krw(monthlyExtra)} / 월</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                step={100_000}
                value={monthlyExtra}
                onChange={(e) => setMonthlyExtra(Math.max(0, Number(e.target.value)))}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm font-semibold text-white"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {[0, 500_000, 1_000_000, 1_500_000, 2_000_000].map((v) => (
                <button
                  key={v}
                  onClick={() => setMonthlyExtra(v)}
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    monthlyExtra === v
                      ? "bg-sky-500 font-bold text-black"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                  }`}
                >
                  {v === 0 ? "없음(트레이딩만)" : `+${v / 10000}만/월`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 오른쪽: 일일 할당량 & 현재 페이스 비교 */}
        <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-extrabold text-white">
              📌 {targetDays}일 완납을 위한 필수 할당량
            </h3>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-neutral-400">내 평균 계산 기준:</span>
              <button
                onClick={() => setPaceMode("active")}
                className={`rounded px-2 py-0.5 ${
                  paceMode === "active" ? "bg-neutral-200 font-bold text-black" : "bg-neutral-800 text-neutral-400"
                }`}
              >
                실매매일({stats.activeDays}일)
              </button>
              <button
                onClick={() => setPaceMode("calendar")}
                className={`rounded px-2 py-0.5 ${
                  paceMode === "calendar" ? "bg-neutral-200 font-bold text-black" : "bg-neutral-800 text-neutral-400"
                }`}
              >
                달력전체({stats.calendarDays}일)
              </button>
            </div>
          </div>

          {/* 일일 / 주간 / 월간 목표 카드 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
              <span className="text-xs font-semibold text-amber-300">하루 목표 수익 (일일 퀘스트)</span>
              <p className="mt-1 text-2xl font-black text-amber-400">
                {krw(requiredTradingDailyKrw)}
              </p>
              <p className="mt-0.5 text-xs font-semibold text-amber-200/80">
                약 {requiredTradingDailyUsdt.toFixed(1)} USDT / 일
              </p>
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
              <span className="text-xs text-neutral-400">주간 목표 수익 (7일)</span>
              <p className="mt-1 text-xl font-extrabold text-white">
                {krw(requiredTradingDailyKrw * 7)}
              </p>
              <p className="mt-0.5 text-xs text-neutral-400">
                약 {(requiredTradingDailyUsdt * 7).toFixed(0)} USDT / 주
              </p>
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
              <span className="text-xs text-neutral-400">월간 목표 수익 (30일)</span>
              <p className="mt-1 text-xl font-extrabold text-white">
                {krw(requiredTradingDailyKrw * 30)}
              </p>
              <p className="mt-0.5 text-xs text-neutral-400">
                약 {(requiredTradingDailyUsdt * 30).toFixed(0)} USDT / 월
              </p>
            </div>
          </div>

          {/* 내 현재 페이스 vs 목표 비교 박스 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/90 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs text-neutral-400">현재 내 일평균 순수익 페이스</span>
                <p className={`text-xl font-black ${tone(myDailyTradingKrw)}`}>
                  {krw(myDailyTradingKrw)} / 일{" "}
                  <span className="text-xs font-normal text-neutral-400">
                    (약 {(myDailyTradingKrw / stats.avgRate).toFixed(1)} USDT · 승 {stats.winDays}일 / 패 {stats.lossDays}일)
                  </span>
                </p>
              </div>
              <div className="text-right">
                <span className="text-xs text-neutral-400">현재 페이스 유지 시 예상 졸업일</span>
                <p className="text-lg font-extrabold text-sky-400">
                  {estPayoffDate ? (
                    <>
                      {estPayoffDate}{" "}
                      <span className="text-xs font-normal text-neutral-400">
                        (약 {estDaysAtCurrentPace}일 · {(estDaysAtCurrentPace! / 365).toFixed(1)}년)
                      </span>
                    </>
                  ) : (
                    "수익 전환 필요"
                  )}
                </p>
              </div>
            </div>

            <div className="mt-3 border-t border-neutral-800 pt-2.5 text-xs">
              {myDailyTradingKrw >= requiredTradingDailyKrw ? (
                <p className="font-semibold text-emerald-400">
                  🚀 현재 페이스({krw(myDailyTradingKrw)}/일)가 목표 할당량({krw(requiredTradingDailyKrw)}/일)을 앞서고 있습니다! 무리해서 레버리지를 높이지 말고 지금 리듬만 지키세요.
                </p>
              ) : (
                <p className="text-neutral-300">
                  💡 설정한 <b>{targetDays}일</b> 안에 끝내려면 지금보다 하루{" "}
                  <b className="text-amber-400">
                    {krw(requiredTradingDailyKrw - myDailyTradingKrw)}
                  </b>{" "}
                  더 벌거나, 목표 기간을{" "}
                  <button
                    onClick={() =>
                      estDaysAtCurrentPace &&
                      setTargetDays(Math.min(1460, Math.max(30, estDaysAtCurrentPace)))
                    }
                    className="underline font-bold text-sky-400 hover:text-sky-300"
                  >
                    현재 페이스({estDaysAtCurrentPace ?? "-"}일)로 맞추기
                  </button>
                  를 눌러 현실적인 목표일로 조정해 보세요.
                </p>
              )}
            </div>
          </div>

          {/* 오늘의 일일 퀘스트 달성 게이지 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-neutral-200">
                🔥 오늘({kstToday()}) 일일 퀘스트 현황
              </span>
              <span className={`font-extrabold ${tone(stats.todayNetKrw)}`}>
                오늘 {krw(stats.todayNetKrw)} / 목표 {krw(requiredTradingDailyKrw)} (
                {todayQuestPct.toFixed(0)}%)
              </span>
            </div>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full transition-all ${
                  stats.todayNetKrw >= requiredTradingDailyKrw
                    ? "bg-emerald-400"
                    : stats.todayNetKrw > 0
                    ? "bg-amber-400"
                    : "bg-rose-500"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, todayQuestPct))}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-neutral-400">
              {stats.todayNetKrw >= requiredTradingDailyKrw
                ? "🎉 오늘 일일 할당량을 이미 달성했습니다! 뇌동매매로 수익을 반납하지 않도록 주의하세요."
                : stats.todayNetKrw >= 0
                ? `오늘 할당량까지 ${krw(Math.max(0, requiredTradingDailyKrw - stats.todayNetKrw))} 남았습니다. 조급해하지 말고 확실한 자리만 노리세요.`
                : "⚠️ 오늘 손실 중입니다. 본전 생각에 베팅 크기를 키우면 보스 체력만 회복시켜 줍니다!"}
            </p>
          </div>
        </div>
      </div>

      {/* ③ 하단: 내 매매 데이터 기반 실시간 AI 코치 & 진단 리포트 */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-extrabold text-white">
              🧠 현재 매매 데이터 기반 맞춤형 탈출 조언
            </h3>
            <p className="text-xs text-neutral-400">
              지금까지 기록된 {trades.length}건의 거래·펀딩 및 {transfers.length}건의 입출금 데이터를 분석한 결과입니다.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 조언 1: 종목 선택 (효자 vs 계좌 파괴범) */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400">
                1. 주력 종목 집중 & 잡코인 손절 효과
              </span>
              {daysSavedIfNoWorst > 0 && (
                <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
                  완납일 {daysSavedIfNoWorst}일 단축 가능
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2.5">
                <p className="font-semibold text-emerald-300">🏆 효자 종목 TOP 3</p>
                <ul className="mt-1.5 space-y-1">
                  {stats.bestSymbols.map((s) => (
                    <li key={s.symbol} className="flex justify-between">
                      <span className="font-bold text-neutral-200">{short(s.symbol)}</span>
                      <span className="font-semibold text-emerald-400">+{krw(s.netKrw)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 p-2.5">
                <p className="font-semibold text-rose-300">💣 손실 종목 TOP 3</p>
                <ul className="mt-1.5 space-y-1">
                  {stats.worstSymbols.map((s) => (
                    <li key={s.symbol} className="flex justify-between">
                      <span className="font-bold text-neutral-200">{short(s.symbol)}</span>
                      <span className="font-semibold text-rose-400">{krw(s.netKrw)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-neutral-300">
              손실 상위 3종목에서만 <b className="text-rose-400">-{krw(stats.worstLossSum)}</b>이 까였습니다. 익숙하지 않은 단발성 코인 진입만 멈추고 주력 종목에만 집중했어도 현재 페이스 기준{" "}
              <b className="text-amber-400">약 {daysSavedIfNoWorst}일</b> 더 빨리 빚을 갚을 수 있었습니다.
            </p>
          </div>

          {/* 조언 2: 승률 · 손익비 · 1회 매매 기대값 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-sky-400">
                2. 승률 · 손익비 & 1회 매매당 기대수익
              </span>
              <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[11px] font-bold text-sky-300">
                손익비 {stats.payoffRatio.toFixed(2)} : 1
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg bg-neutral-900 p-2.5">
                <span className="text-neutral-400">청산 승률</span>
                <p className="mt-1 text-base font-black text-white">{stats.winRate.toFixed(1)}%</p>
                <span className="text-[10px] text-neutral-500">
                  {stats.winCount}승 {stats.lossCount}패
                </span>
              </div>
              <div className="rounded-lg bg-neutral-900 p-2.5">
                <span className="text-neutral-400">평균 익절 / 손절</span>
                <p className="mt-1 text-xs font-bold text-emerald-400">+{krw(stats.avgWin)}</p>
                <p className="text-xs font-bold text-rose-400">-{krw(stats.avgLoss)}</p>
              </div>
              <div className="rounded-lg bg-neutral-900 p-2.5">
                <span className="text-neutral-400">청산 1회당 기대값</span>
                <p className={`mt-1 text-base font-black ${tone(stats.expectancyKrw)}`}>
                  {krw(stats.expectancyKrw)}
                </p>
                <span className="text-[10px] text-neutral-500">순수익 ÷ 청산수</span>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-neutral-300">
              청산 1건당 평균 <b className="text-emerald-400">{krw(stats.expectancyKrw)}</b>의 기대수익이 나고 있습니다. 승률({stats.winRate.toFixed(0)}%)과 손익비({stats.payoffRatio.toFixed(2)}:1) 모두 양호하므로, <b>한 번의 큰 손절(물타기 후 강제/패닉 청산)</b>만 막으면 우상향하는 구조입니다.
            </p>
          </div>

          {/* 조언 3: 수수료 & 펀딩비 누수 점검 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-400">
                3. 수수료 & 펀딩비 누수 관리
              </span>
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-300">
                🍗 치킨 약 {chickenCount.toFixed(1)}마리 값
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-neutral-900 p-3 text-xs">
              <div>
                <span className="text-neutral-400">누적 수수료 + 펀딩비</span>
                <p className="mt-0.5 text-base font-extrabold text-rose-400">
                  {krw(stats.totalCostKrw)}
                </p>
              </div>
              <div className="text-right">
                <span className="text-neutral-400">가장 많이 나간 종목</span>
                <p className="mt-0.5 font-bold text-neutral-200">
                  {stats.topCostSymbol
                    ? `${short(stats.topCostSymbol.symbol)} (${krw(stats.topCostSymbol.costKrw)})`
                    : "-"}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-neutral-300">
              수수료(`{krw(stats.totalFeeKrw)}`)와 펀딩비(`{krw(stats.totalFundingKrw)}`)로 총 실현수익의{" "}
              <b>{stats.totalPnlKrw > 0 ? ((Math.abs(stats.totalCostKrw) / stats.totalPnlKrw) * 100).toFixed(1) : 0}%</b>가 빠졌습니다. 특히 포지션을 장기 보유하며 잦은 물타기/분할매매를 할 때 펀딩비가 누적되니 펀딩 시각(01시·09시·17시)을 체크하세요.
            </p>
          </div>

          {/* 조언 4: 출금 확정 전략 (원금 상환 습관) */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-purple-400">
                4. 수익 출금 & 원금 상환 확정률
              </span>
              <span className="rounded bg-purple-500/20 px-2 py-0.5 text-[11px] font-bold text-purple-300">
                수익 대비 출금률{" "}
                {stats.totalNetKrw > 0
                  ? ((stats.withdrawKrw / stats.totalNetKrw) * 100).toFixed(0)
                  : 0}
                %
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-neutral-900 p-3 text-xs">
              <div>
                <span className="text-neutral-400">실제 업비트(TRX) 출금액</span>
                <p className="mt-0.5 text-base font-extrabold text-emerald-400">
                  {krw(stats.withdrawKrw)} ({stats.withdrawCount}회)
                </p>
              </div>
              <div className="text-right">
                <span className="text-neutral-400">미출금 잔여 수익</span>
                <p className="mt-0.5 text-base font-extrabold text-amber-400">
                  {krw(unwithdrawnKrw)}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-neutral-300">
              빚을 갚는 트레이딩에서 가장 위험한 함정은 <b>&ldquo;시드를 불려서 한 방에 갚겠다&rdquo;</b>는 생각입니다. 현재 미출금 수익이 <b className="text-amber-400">{krw(unwithdrawnKrw)}</b> 있습니다. 목표 금액(예: 30~50만 원)이 모일 때마다 바로 출금해 부채 원금을 먼저 깎으세요!
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
