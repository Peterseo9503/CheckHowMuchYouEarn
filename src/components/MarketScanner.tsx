"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import TradeOrderModal, { type OrderTargetItem } from "./TradeOrderModal";

interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number; // 24h USDT 거래대금
  count: number; // 24h 체결수
  rangePos: number; // 24h 저가~고가 내 현재가 위치 (0~100%)
}

export type DivType = "regular" | "hidden" | "forming";

export interface BullishDivergence {
  type: DivType; // regular: 가격 LL + RSI HL, hidden: 가격 HL + RSI LL, forming: 약한/형성중 괴리
  score: number; // 0 ~ 100 다이버전스 강도 수치
  price1: number; // 1차 스윙 저점 가격
  price2: number; // 2차(최근) 스윙 저점 가격
  priceDeltaPct: number; // 1차 대비 2차 저점 가격 변화율 (%)
  rsi1: number; // 1차 저점 RSI
  rsi2: number; // 2차 저점 RSI
  rsiDelta: number; // RSI 변화폭 (rsi2 - rsi1)
  barsBetween: number; // 두 저점 사이 캔들 수
  barsAgo: number; // 2차 저점이 현재로부터 몇 봉 전인지
  idx1: number; // 최근 25봉 내 상대 인덱스 (시각화용)
  idx2: number;
}

export interface TradeSignalPick {
  side: "LONG" | "SHORT";
  strategyName: string; // 예: "급락 과매도 + 상승 다이버 반등 롱", "급등 과매수 피로도 숏", "거래대금 폭발 눌림목 롱"
  confidence: number; // 0 ~ 100 종합 추천 점수
  entryPrice: number; // 현재가 기준 진입가
  limitEntryPrice: number; // 보수적 지정가(눌림/반등) 추천가
  stopLoss: number; // 손절가 (SL/SP)
  tp1: number; // 1차 익절가 (반익 추천)
  tp2: number; // 2차 최종 익절가
  slPct: number; // 진입가 대비 손절폭 (%)
  tp1Pct: number; // 진입가 대비 1차 익절폭 (%)
  tp2Pct: number; // 진입가 대비 2차 익절폭 (%)
  rrRatio: number; // 손익비 (TP2 기준 Risk:Reward)
  recLeverage: string; // ATR 변동성 기반 권장 레버리지
  reasons: string[]; // 선정 근거 태그 목록
}

interface RsiRow extends Ticker24h {
  rsi: number;
  atr: number; // ATR(14) 평균 진폭
  atrPct: number; // 현재가 대비 ATR 비율 (%)
  volSpike: number; // 최근 캔들 거래량 ÷ 이전 20봉 평균 거래량
  closes: number[]; // 미니 스파크라인용 최근 25봉 종가
  rsiHistory: number[]; // 최근 25봉 RSI 시리즈
  divergence: BullishDivergence | null;
  signalPick: TradeSignalPick | null;
}

type SubTab =
  | "picks"
  | "movers"
  | "volume"
  | "divergence"
  | "overbought"
  | "oversold"
  | "heatmap";
type RsiTf = "15m" | "1h" | "4h" | "1d";
type DivFilter = "all" | "regular" | "hidden";
type PickFilter = "all" | "LONG" | "SHORT";

const short = (s: string) => s.replace(/USDT$/, "");
const fmtPx = (n: number) =>
  n ? `$${Number(n.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 8 })}` : "-";

/** 코인 단가 크기에 맞춘 원화 현재가 포맷 (저가 코인도 0원으로 뭉개지지 않게 처리) */
function fmtKrwPx(usd: number, rate: number): string {
  const won = usd * rate;
  if (!won) return "-";
  if (won >= 100) return `₩${Math.round(won).toLocaleString("ko-KR")}`;
  if (won >= 1) return `₩${won.toFixed(2)}`;
  return `₩${Number(won.toPrecision(3))}`;
}

const fmtVol = (v: number) => {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

/** 24시간 거래대금 원화(조/억/만) 포맷 */
function fmtKrwVol(usdVol: number, rate: number): string {
  const won = usdVol * rate;
  if (won >= 1_000_000_000_000) return `₩${(won / 1_000_000_000_000).toFixed(2)}조`;
  if (won >= 100_000_000) {
    const eok = won / 100_000_000;
    return `₩${eok >= 100 ? Math.round(eok).toLocaleString("ko-KR") : eok.toFixed(1)}억`;
  }
  if (won >= 10_000) return `₩${Math.round(won / 10_000).toLocaleString("ko-KR")}만`;
  return `₩${Math.round(won).toLocaleString("ko-KR")}`;
}

/** Wilder's RSI(14) 전체 시계열 계산 */
function calcRsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** ATR(14) 평균 진폭 계산 (변동성 기반 TP/SL 산출용) */
function calcAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number {
  const n = closes.length;
  if (n < 2) return (closes[n - 1] || 1) * 0.015;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  const recent = trs.slice(-period);
  const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  return avg > 0 ? avg : closes[n - 1] * 0.015;
}

/**
 * 스윙 저점(Pivot Low) 기반 상승 다이버전스 탐지 및 강도 수치(0~100점) 산출
 */
function detectBullishDivergence(
  lows: number[],
  closes: number[],
  rsiSeries: (number | null)[]
): BullishDivergence | null {
  const n = closes.length;
  if (n < 30) return null;

  const windowSize = 25;
  const startIdx = Math.max(15, n - windowSize);

  const recentStart = Math.max(startIdx + 5, n - 7);
  let i2 = recentStart;
  for (let i = recentStart; i < n; i++) {
    if (lows[i] <= lows[i2]) i2 = i;
  }
  const r2 = rsiSeries[i2];
  if (r2 === null) return null;

  let best: BullishDivergence | null = null;

  for (let i1 = startIdx; i1 <= i2 - 4; i1++) {
    const r1 = rsiSeries[i1];
    if (r1 === null) continue;

    const isLocalLow =
      (i1 === startIdx || lows[i1] <= lows[i1 - 1]) &&
      lows[i1] <= lows[i1 + 1];
    if (!isLocalLow) continue;

    const p1 = lows[i1];
    const p2 = lows[i2];
    const priceDeltaPct = ((p2 - p1) / p1) * 100;
    const rsiDelta = r2 - r1;
    const barsBetween = i2 - i1;
    const barsAgo = n - 1 - i2;

    if (priceDeltaPct <= -0.15 && rsiDelta >= 1.2 && r1 <= 52) {
      const oversoldBonus = r1 < 30 ? 22 : r1 < 38 ? 14 : r1 < 45 ? 7 : 0;
      const rsiGainScore = Math.min(40, rsiDelta * 3.8);
      const priceDropScore = Math.min(22, Math.abs(priceDeltaPct) * 3.5);
      const recencyBonus = Math.max(0, 16 - barsAgo * 2.5);
      const score = Math.round(
        Math.min(99, Math.max(25, oversoldBonus + rsiGainScore + priceDropScore + recencyBonus))
      );

      if (!best || score > best.score) {
        best = {
          type: "regular",
          score,
          price1: p1,
          price2: p2,
          priceDeltaPct,
          rsi1: r1,
          rsi2: r2,
          rsiDelta,
          barsBetween,
          barsAgo,
          idx1: i1 - (n - windowSize),
          idx2: i2 - (n - windowSize),
        };
      }
    } else if (priceDeltaPct >= 0.25 && rsiDelta <= -1.8 && r2 <= 46) {
      const oversoldBonus = r2 < 35 ? 18 : r2 < 42 ? 10 : 4;
      const rsiCoolScore = Math.min(35, Math.abs(rsiDelta) * 3.0);
      const priceHoldScore = Math.min(25, priceDeltaPct * 3.2);
      const recencyBonus = Math.max(0, 14 - barsAgo * 2.5);
      const score = Math.round(
        Math.min(95, Math.max(20, oversoldBonus + rsiCoolScore + priceHoldScore + recencyBonus))
      );

      if (!best || (best.type !== "regular" && score > best.score)) {
        best = {
          type: "hidden",
          score,
          price1: p1,
          price2: p2,
          priceDeltaPct,
          rsi1: r1,
          rsi2: r2,
          rsiDelta,
          barsBetween,
          barsAgo,
          idx1: i1 - (n - windowSize),
          idx2: i2 - (n - windowSize),
        };
      }
    } else if (priceDeltaPct <= 0.2 && rsiDelta >= 1.0 && r2 <= 48) {
      const score = Math.round(
        Math.min(65, Math.max(15, rsiDelta * 3 + (48 - r2) * 0.8))
      );
      if (!best) {
        best = {
          type: "forming",
          score,
          price1: p1,
          price2: p2,
          priceDeltaPct,
          rsi1: r1,
          rsi2: r2,
          rsiDelta,
          barsBetween,
          barsAgo,
          idx1: i1 - (n - windowSize),
          idx2: i2 - (n - windowSize),
        };
      }
    }
  }

  return best;
}

/**
 * 급등/급락 + RSI + 다이버전스 + 거래대금/거래량배수 + ATR(14)을 종합하여
 * 추천 포지션(LONG/SHORT), 진입가, 손절가(SL/SP), 1·2차 익절가(TP1/TP2) 산출
 */
function buildTradeSignalPick(
  t: Ticker24h,
  rsi: number,
  atr: number,
  volSpike: number,
  highs: number[],
  lows: number[],
  divergence: BullishDivergence | null
): TradeSignalPick | null {
  const price = t.lastPrice;
  if (!price || !atr) return null;

  const recentLow = Math.min(...lows.slice(-12));
  const recentHigh = Math.max(...highs.slice(-12));
  const reasons: string[] = [];

  // 손절폭(%)에 따른 안전 권장 레버리지 가이드 (1회 손절 시 원금 손실 -8%~-12% 이내 기준)
  const calcLevGuide = (slAbsPct: number) => {
    if (slAbsPct >= 4.5) return "2x ~ 3x (고변동 저배율 권장)";
    if (slAbsPct >= 2.5) return "3x ~ 5x 권장";
    if (slAbsPct >= 1.5) return "5x ~ 7x 권장";
    return "5x ~ 10x 권장";
  };

  // [전략 1] 🟢 급락 과매도 / 상승 다이버전스 반등 LONG
  if (
    rsi <= 38 ||
    (divergence && divergence.type === "regular" && divergence.score >= 55) ||
    (t.priceChangePercent <= -6 && rsi <= 43)
  ) {
    let score = 45;
    if (rsi <= 25) {
      score += 24;
      reasons.push(`RSI ${rsi.toFixed(1)} 극침체 과매도`);
    } else if (rsi <= 35) {
      score += 16;
      reasons.push(`RSI ${rsi.toFixed(1)} 과매도 구간`);
    } else {
      reasons.push(`RSI ${rsi.toFixed(1)} 저점 반등권`);
    }

    if (divergence && divergence.type === "regular") {
      score += Math.round(divergence.score * 0.25);
      reasons.push(`일반 상승 다이버전스 (${divergence.score}점)`);
    } else if (divergence && divergence.type === "hidden") {
      score += 10;
      reasons.push(`히든 상승 다이버전스 (${divergence.score}점)`);
    }

    if (t.priceChangePercent <= -8) {
      score += 10;
      reasons.push(`24h ${t.priceChangePercent.toFixed(1)}% 급락 후 기술적 반등 노림`);
    }
    if (volSpike >= 1.5) {
      score += 9;
      reasons.push(`투매 받아내는 거래량 ${volSpike.toFixed(1)}x 유입`);
    }
    if (t.quoteVolume >= 50_000_000) {
      score += 6;
      reasons.push(`풍부한 거래대금 (${fmtVol(t.quoteVolume)})`);
    }

    const entryPrice = price;
    const limitEntryPrice = Math.max(recentLow, price - atr * 0.35);
    // 손절가: 최근 스윙 저점 살짝 아래 또는 1.5 ATR 아래 중 더 안전한 쪽 (단 최소 0.9% ~ 최대 6.5% 범위로 클램프)
    const rawSl = Math.min(recentLow - atr * 0.35, price - atr * 1.45);
    const slDist = Math.min(price * 0.065, Math.max(price * 0.009, price - rawSl));
    const stopLoss = price - slDist;
    const tp1 = price + slDist * 1.45;
    const tp2 = price + slDist * 2.4;

    const slPct = -((slDist / price) * 100);
    const tp1Pct = ((tp1 - price) / price) * 100;
    const tp2Pct = ((tp2 - price) / price) * 100;

    return {
      side: "LONG",
      strategyName:
        divergence && divergence.type === "regular"
          ? "상승 다이버전스 + 과매도 반등 롱"
          : "급락 과매도 기술적 반등 롱",
      confidence: Math.min(98, Math.max(52, score)),
      entryPrice,
      limitEntryPrice,
      stopLoss,
      tp1,
      tp2,
      slPct,
      tp1Pct,
      tp2Pct,
      rrRatio: Number((tp2Pct / Math.abs(slPct)).toFixed(2)),
      recLeverage: calcLevGuide(Math.abs(slPct)),
      reasons,
    };
  }

  // [전략 2] 🔴 급등 과열 + RSI 과매수 피로도 SHORT
  if (rsi >= 66 || (t.priceChangePercent >= 12 && rsi >= 62 && t.rangePos >= 82)) {
    let score = 46;
    if (rsi >= 76) {
      score += 24;
      reasons.push(`RSI ${rsi.toFixed(1)} 초과열 구간`);
    } else if (rsi >= 68) {
      score += 16;
      reasons.push(`RSI ${rsi.toFixed(1)} 과매수 진입`);
    } else {
      reasons.push(`RSI ${rsi.toFixed(1)} 단기 고점 피로도`);
    }

    if (t.priceChangePercent >= 15) {
      score += 14;
      reasons.push(`24h +${t.priceChangePercent.toFixed(1)}% 단기 과대 급등`);
    } else if (t.priceChangePercent >= 7) {
      score += 8;
      reasons.push(`24h +${t.priceChangePercent.toFixed(1)}% 급등 피로감`);
    }

    if (volSpike >= 1.8) {
      score += 9;
      reasons.push(`고점 대량 거래량 분출 (${volSpike.toFixed(1)}x)`);
    }
    if (t.rangePos >= 88) {
      score += 6;
      reasons.push(`24h 고가 상단(${t.rangePos.toFixed(0)}%) 저항 근접`);
    }

    const entryPrice = price;
    const limitEntryPrice = Math.min(recentHigh, price + atr * 0.35);
    const rawSl = Math.max(recentHigh + atr * 0.35, price + atr * 1.45);
    const slDist = Math.min(price * 0.065, Math.max(price * 0.009, rawSl - price));
    const stopLoss = price + slDist;
    const tp1 = price - slDist * 1.45;
    const tp2 = price - slDist * 2.35;

    const slPct = -((slDist / price) * 100);
    const tp1Pct = ((price - tp1) / price) * 100;
    const tp2Pct = ((price - tp2) / price) * 100;

    return {
      side: "SHORT",
      strategyName: "급등 과열 · RSI 과매수 되돌림 숏",
      confidence: Math.min(96, Math.max(52, score)),
      entryPrice,
      limitEntryPrice,
      stopLoss,
      tp1,
      tp2,
      slPct,
      tp1Pct,
      tp2Pct,
      rrRatio: Number((tp2Pct / Math.abs(slPct)).toFixed(2)),
      recLeverage: calcLevGuide(Math.abs(slPct)),
      reasons,
    };
  }

  // [전략 3] 🚀 거래대금 폭발 + 눌림목 추세 지속 LONG
  if (
    (volSpike >= 1.6 || (divergence && divergence.type === "hidden")) &&
    t.priceChangePercent >= 1.5 &&
    rsi >= 42 &&
    rsi <= 64
  ) {
    let score = 48;
    if (volSpike >= 2.2) {
      score += 18;
      reasons.push(`평소 대비 거래량 ${volSpike.toFixed(1)}x 폭발`);
    } else if (volSpike >= 1.6) {
      score += 12;
      reasons.push(`수급 유입 거래량 ${volSpike.toFixed(1)}x 증가`);
    }

    if (divergence && divergence.type === "hidden") {
      score += 16;
      reasons.push(`히든 상승 다이버전스 눌림목 (${divergence.score}점)`);
    }

    reasons.push(`24h +${t.priceChangePercent.toFixed(1)}% 상승 추세 유지`);
    reasons.push(`RSI ${rsi.toFixed(1)} 과열 해소 후 재상승 여력`);

    if (t.quoteVolume >= 80_000_000) {
      score += 8;
      reasons.push(`대형 거래대금 주도주 (${fmtVol(t.quoteVolume)})`);
    }

    const entryPrice = price;
    const limitEntryPrice = price - atr * 0.3;
    const slDist = Math.min(price * 0.06, Math.max(price * 0.009, atr * 1.4));
    const stopLoss = price - slDist;
    const tp1 = price + slDist * 1.5;
    const tp2 = price + slDist * 2.5;

    const slPct = -((slDist / price) * 100);
    const tp1Pct = ((tp1 - price) / price) * 100;
    const tp2Pct = ((tp2 - price) / price) * 100;

    return {
      side: "LONG",
      strategyName: "수급 폭발 주도주 눌림목 롱",
      confidence: Math.min(94, Math.max(50, score)),
      entryPrice,
      limitEntryPrice,
      stopLoss,
      tp1,
      tp2,
      slPct,
      tp1Pct,
      tp2Pct,
      rrRatio: Number((tp2Pct / Math.abs(slPct)).toFixed(2)),
      recLeverage: calcLevGuide(Math.abs(slPct)),
      reasons,
    };
  }

  return null;
}

/** 미니 스파크라인 SVG */
function Sparkline({ data, up }: { data: number[]; up: boolean }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 72;
  const h = 24;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="inline-block overflow-visible">
      <polyline
        fill="none"
        stroke={up ? "#34d399" : "#fb7185"}
        strokeWidth="1.5"
        points={pts}
      />
    </svg>
  );
}

/** 가격 저점 추세선 vs RSI 저점 추세선 비교 미니 차트 */
function DivergenceMiniChart({
  closes,
  rsiHistory,
  div,
}: {
  closes: number[];
  rsiHistory: number[];
  div: BullishDivergence;
}) {
  if (closes.length < 2 || rsiHistory.length < 2) return null;
  const w = 112;
  const h = 38;
  const n = closes.length;
  const pMin = Math.min(...closes);
  const pMax = Math.max(...closes);
  const pRange = pMax - pMin || 1;

  const rMin = Math.min(...rsiHistory);
  const rMax = Math.max(...rsiHistory);
  const rRange = rMax - rMin || 1;

  const i1 = Math.max(0, Math.min(n - 1, div.idx1));
  const i2 = Math.max(0, Math.min(n - 1, div.idx2));

  const xOf = (idx: number) => (idx / (n - 1)) * w;
  const yPrice = (v: number) => 16 - ((v - pMin) / pRange) * 13;
  const yRsi = (v: number) => 36 - ((v - rMin) / rRange) * 13;

  const pricePts = closes.map((v, i) => `${xOf(i).toFixed(1)},${yPrice(v).toFixed(1)}`).join(" ");
  const rsiPts = rsiHistory.map((v, i) => `${xOf(i).toFixed(1)},${yRsi(v).toFixed(1)}`).join(" ");

  return (
    <svg width={w} height={h} className="inline-block overflow-visible">
      <polyline fill="none" stroke="#737373" strokeWidth="1.2" points={pricePts} />
      <line
        x1={xOf(i1)}
        y1={yPrice(closes[i1])}
        x2={xOf(i2)}
        y2={yPrice(closes[i2])}
        stroke="#fb7185"
        strokeWidth="1.6"
        strokeDasharray="2,1"
      />
      <circle cx={xOf(i1)} cy={yPrice(closes[i1])} r="2.2" fill="#fb7185" />
      <circle cx={xOf(i2)} cy={yPrice(closes[i2])} r="2.2" fill="#fb7185" />

      <polyline fill="none" stroke="#38bdf8" strokeWidth="1.2" opacity="0.65" points={rsiPts} />
      <line
        x1={xOf(i1)}
        y1={yRsi(rsiHistory[i1])}
        x2={xOf(i2)}
        y2={yRsi(rsiHistory[i2])}
        stroke="#34d399"
        strokeWidth="1.8"
      />
      <circle cx={xOf(i1)} cy={yRsi(rsiHistory[i1])} r="2.2" fill="#34d399" />
      <circle cx={xOf(i2)} cy={yRsi(rsiHistory[i2])} r="2.2" fill="#34d399" />
    </svg>
  );
}

export default function MarketScanner({ fxRate = 1350 }: { fxRate?: number }) {
  const [tab, setTab] = useState<SubTab>("picks");
  const [tickers, setTickers] = useState<Ticker24h[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [minVolM, setMinVolM] = useState(5); // 최소 24h 거래대금 (백만 USDT)
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  // RSI & 다이버전스 & AI 타점 스캔 상태
  const [rsiTf, setRsiTf] = useState<RsiTf>("15m");
  const [rsiRows, setRsiRows] = useState<RsiRow[]>([]);
  const [rsiLoading, setRsiLoading] = useState(false);
  const [rsiProgress, setRsiProgress] = useState({ done: 0, total: 0 });
  const [divFilter, setDivFilter] = useState<DivFilter>("all");
  const [pickFilter, setPickFilter] = useState<PickFilter>("all");
  const [orderTarget, setOrderTarget] = useState<OrderTargetItem | null>(null);

  // 1) 전 종목 24h 시세 한 번에 가져오기 (API weight: 40, 공개 API)
  const loadTickers = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`시세 조회 실패 (${res.status})`);
      const raw = (await res.json()) as Record<string, string>[];
      const now = Date.now();
      const parsed: Ticker24h[] = [];
      for (const r of raw) {
        const sym = r.symbol ?? "";
        if (!sym.endsWith("USDT")) continue;
        if (now - Number(r.closeTime) > 3_600_000) continue;
        const lastPrice = parseFloat(r.lastPrice);
        const highPrice = parseFloat(r.highPrice);
        const lowPrice = parseFloat(r.lowPrice);
        const quoteVolume = parseFloat(r.quoteVolume);
        if (!lastPrice || quoteVolume <= 0) continue;
        const span = highPrice - lowPrice;
        parsed.push({
          symbol: sym,
          lastPrice,
          priceChangePercent: parseFloat(r.priceChangePercent),
          highPrice,
          lowPrice,
          quoteVolume,
          count: Number(r.count),
          rangePos: span > 0 ? ((lastPrice - lowPrice) / span) * 100 : 50,
        });
      }
      setTickers(parsed);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTickers();
  }, [loadTickers]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(loadTickers, 15_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadTickers]);

  // 필터링된 종목
  const filtered = useMemo(() => {
    const minV = minVolM * 1_000_000;
    const q = search.trim().toUpperCase();
    return tickers.filter(
      (t) => t.quoteVolume >= minV && (!q || t.symbol.includes(q))
    );
  }, [tickers, minVolM, search]);

  // 2) 주요 종목(급등락 상위 + 거래대금 상위) Klines 병렬 조회 → RSI(14), ATR(14), 다이버전스, AI 진입/TP/SL 산출
  const scanRsi = useCallback(async () => {
    if (!tickers.length) return;
    setRsiLoading(true);
    try {
      const active = tickers.filter((t) => t.quoteVolume >= 5_000_000);
      const byMove = [...active]
        .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
        .slice(0, 40);
      const byVol = [...active]
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, 40);

      const targetMap = new Map<string, Ticker24h>();
      for (const t of [...byMove, ...byVol]) targetMap.set(t.symbol, t);
      const targets = [...targetMap.values()].slice(0, 60);

      setRsiProgress({ done: 0, total: targets.length });
      const results: RsiRow[] = [];
      const batchSize = 10;

      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        const batchRes = await Promise.all(
          batch.map(async (t) => {
            try {
              const r = await fetch(
                `https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=${rsiTf}&limit=60`,
                { cache: "no-store" }
              );
              if (!r.ok) return null;
              const klines = (await r.json()) as (string | number)[][];
              if (klines.length < 30) return null;
              const highs = klines.map((k) => parseFloat(String(k[2])));
              const lows = klines.map((k) => parseFloat(String(k[3])));
              const closes = klines.map((k) => parseFloat(String(k[4])));
              const vols = klines.map((k) => parseFloat(String(k[7])));
              const rsiSeries = calcRsiSeries(closes, 14);
              const rsi = rsiSeries[rsiSeries.length - 1];
              if (rsi === null) return null;

              const atr = calcAtr(highs, lows, closes, 14);
              const atrPct = (atr / t.lastPrice) * 100;

              const prevVols = vols.slice(-22, -2);
              const avgVol =
                prevVols.reduce((a, b) => a + b, 0) / Math.max(1, prevVols.length);
              const curVol = Math.max(vols[vols.length - 1], vols[vols.length - 2] ?? 0);
              const volSpike = avgVol > 0 ? curVol / avgVol : 1;

              const divergence = detectBullishDivergence(lows, closes, rsiSeries);
              const signalPick = buildTradeSignalPick(
                t,
                rsi,
                atr,
                volSpike,
                highs,
                lows,
                divergence
              );
              const rsiHistory = rsiSeries
                .slice(-25)
                .map((v) => (v === null ? 50 : v));

              return {
                ...t,
                rsi,
                atr,
                atrPct,
                volSpike,
                closes: closes.slice(-25),
                rsiHistory,
                divergence,
                signalPick,
              };
            } catch {
              return null;
            }
          })
        );
        for (const item of batchRes) if (item) results.push(item);
        setRsiProgress({ done: Math.min(targets.length, i + batchSize), total: targets.length });
      }
      setRsiRows(results);
    } finally {
      setRsiLoading(false);
    }
  }, [tickers, rsiTf]);

  useEffect(() => {
    if (
      (tab === "picks" ||
        tab === "overbought" ||
        tab === "oversold" ||
        tab === "volume" ||
        tab === "divergence") &&
      tickers.length > 0 &&
      rsiRows.length === 0 &&
      !rsiLoading
    ) {
      scanRsi();
    }
  }, [tab, tickers.length, rsiRows.length, rsiLoading, scanRsi]);

  useEffect(() => {
    if (
      tab === "picks" ||
      tab === "overbought" ||
      tab === "oversold" ||
      tab === "divergence"
    ) {
      scanRsi();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsiTf]);

  // 시장 전체 요약 지표
  const marketSummary = useMemo(() => {
    const up = filtered.filter((t) => t.priceChangePercent > 0).length;
    const down = filtered.filter((t) => t.priceChangePercent < 0).length;
    const gainers = [...filtered].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
    const losers = [...filtered].sort((a, b) => a.priceChangePercent - b.priceChangePercent);
    const byVol = [...filtered].sort((a, b) => b.quoteVolume - a.quoteVolume);
    return {
      up,
      down,
      upPct: filtered.length ? (up / filtered.length) * 100 : 50,
      gainers: gainers.slice(0, 20),
      losers: losers.slice(0, 20),
      byVol: byVol.slice(0, 30),
      topGainer: gainers[0],
      topLoser: losers[0],
      topVol: byVol[0],
    };
  }, [filtered]);

  const overboughtList = useMemo(
    () => [...rsiRows].filter((r) => r.rsi >= 65).sort((a, b) => b.rsi - a.rsi),
    [rsiRows]
  );

  const oversoldList = useMemo(
    () => [...rsiRows].filter((r) => r.rsi <= 35).sort((a, b) => a.rsi - b.rsi),
    [rsiRows]
  );

  const divergenceList = useMemo(() => {
    const q = search.trim().toUpperCase();
    return [...rsiRows]
      .filter((r) => {
        if (!r.divergence) return false;
        if (q && !r.symbol.includes(q)) return false;
        if (divFilter === "regular") return r.divergence.type === "regular";
        if (divFilter === "hidden") return r.divergence.type === "hidden";
        return true;
      })
      .sort((a, b) => (b.divergence?.score ?? 0) - (a.divergence?.score ?? 0));
  }, [rsiRows, divFilter, search]);

  const pickList = useMemo(() => {
    const q = search.trim().toUpperCase();
    const minV = minVolM * 1_000_000;
    return [...rsiRows]
      .filter((r) => {
        if (!r.signalPick) return false;
        if (r.quoteVolume < minV) return false;
        if (q && !r.symbol.includes(q)) return false;
        if (pickFilter !== "all" && r.signalPick.side !== pickFilter) return false;
        return true;
      })
      .sort((a, b) => (b.signalPick?.confidence ?? 0) - (a.signalPick?.confidence ?? 0));
  }, [rsiRows, pickFilter, search, minVolM]);

  return (
    <section className="space-y-5">
      {/* 상단 시장 온도계 요약 카드 4개 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>시장 상승 vs 하락 비중</span>
            <span>총 {filtered.length}종목</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between text-sm font-bold">
            <span className="text-emerald-400">상승 {marketSummary.up}</span>
            <span className="text-rose-400">하락 {marketSummary.down}</span>
          </div>
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-rose-500/80">
            <div
              className="h-full bg-emerald-400 transition-all"
              style={{ width: `${marketSummary.upPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-neutral-500">
            적용 환율: 1 USDT ≈ ₩{fxRate.toFixed(1)}
          </p>
        </div>

        <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-4">
          <span className="text-xs text-emerald-300">🚀 24h 최고 급등</span>
          {marketSummary.topGainer ? (
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-xl font-black text-white">
                {short(marketSummary.topGainer.symbol)}
              </span>
              <span className="text-xl font-black text-emerald-400">
                +{marketSummary.topGainer.priceChangePercent.toFixed(2)}%
              </span>
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">-</p>
          )}
          <p className="mt-1 text-xs text-neutral-300">
            {marketSummary.topGainer ? (
              <>
                <span className="font-semibold text-white">
                  {fmtKrwPx(marketSummary.topGainer.lastPrice, fxRate)}
                </span>{" "}
                <span className="text-neutral-400">
                  ({fmtPx(marketSummary.topGainer.lastPrice)})
                </span>
              </>
            ) : (
              "-"
            )}
          </p>
        </div>

        <div className="rounded-xl border border-rose-900/60 bg-rose-950/20 p-4">
          <span className="text-xs text-rose-300">🩸 24h 최대 급락</span>
          {marketSummary.topLoser ? (
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-xl font-black text-white">
                {short(marketSummary.topLoser.symbol)}
              </span>
              <span className="text-xl font-black text-rose-400">
                {marketSummary.topLoser.priceChangePercent.toFixed(2)}%
              </span>
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">-</p>
          )}
          <p className="mt-1 text-xs text-neutral-300">
            {marketSummary.topLoser ? (
              <>
                <span className="font-semibold text-white">
                  {fmtKrwPx(marketSummary.topLoser.lastPrice, fxRate)}
                </span>{" "}
                <span className="text-neutral-400">
                  ({fmtPx(marketSummary.topLoser.lastPrice)})
                </span>
              </>
            ) : (
              "-"
            )}
          </p>
        </div>

        <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4">
          <span className="text-xs text-amber-300">🔥 24h 거래대금 1위</span>
          {marketSummary.topVol ? (
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-xl font-black text-white">
                {short(marketSummary.topVol.symbol)}
              </span>
              <span className="text-lg font-black text-amber-400">
                {fmtKrwVol(marketSummary.topVol.quoteVolume, fxRate)}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">-</p>
          )}
          <p className="mt-1 text-xs text-neutral-400">
            {marketSummary.topVol
              ? `${fmtVol(marketSummary.topVol.quoteVolume)} · 등락 ${
                  marketSummary.topVol.priceChangePercent >= 0 ? "+" : ""
                }${marketSummary.topVol.priceChangePercent.toFixed(2)}%`
              : "-"}
          </p>
        </div>
      </div>

      {/* 하위 탭 & 필터 바 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["picks", "🎯 AI 타점 추천 (TP/SL)"],
              ["movers", "🚀 급등 · 🩸 급락 (24h)"],
              ["volume", "🔥 거래량 폭발"],
              ["divergence", "📈 상승 다이버전스"],
              ["overbought", "🔴 과매수 (RSI ≥ 65)"],
              ["oversold", "🔵 과매도 (RSI ≤ 35)"],
              ["heatmap", "🗺️ 마켓 히트맵"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
                tab === k
                  ? "bg-amber-500 text-black"
                  : "border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="티커 검색 (예: BTC, SOXL)"
            className="w-40 rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-white"
          />
          <select
            value={minVolM}
            onChange={(e) => setMinVolM(Number(e.target.value))}
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200"
          >
            <option value={0}>전체 거래대금</option>
            <option value={5}>24h 거래대금 $5M 이상</option>
            <option value={20}>24h 거래대금 $20M 이상</option>
            <option value={50}>24h 거래대금 $50M 이상</option>
            <option value={100}>24h 거래대금 $100M 이상</option>
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-neutral-300">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 accent-amber-500"
            />
            15초 자동갱신
          </label>
          <button
            onClick={loadTickers}
            disabled={loading}
            className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
          >
            {loading ? "갱신 중…" : "새로고침"}
          </button>
        </div>
      </div>

      {err && <p className="text-sm text-rose-400">{err}</p>}

      {/* 탭 0: 🎯 AI 타점 추천 (진입가 · TP / SL 추천) */}
      {tab === "picks" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-800/50 bg-neutral-900 px-4 py-3">
            <div>
              <h3 className="text-sm font-extrabold text-amber-400">
                🎯 급등·급락 × RSI × 거래대금 기반 진입가 · 익절(TP) · 손절(SL) 타점 추천
              </h3>
              <p className="mt-0.5 text-xs text-neutral-400">
                거래대금 상위 및 24h 급등·급락 종목 중 <strong className="text-neutral-200">RSI 과매수·과매도, 상승 다이버전스, 거래량 급증 배수, ATR(14) 변동성</strong>을 분석해 손익비(1:2.0 이상)가 나오는 타점만 엄선합니다.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {/* 포지션 방향 필터 */}
              <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
                {(
                  [
                    ["all", "전체 추천"],
                    ["LONG", "🟢 LONG 추천만"],
                    ["SHORT", "🔴 SHORT 추천만"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setPickFilter(k)}
                    className={`px-2.5 py-1 font-bold ${
                      pickFilter === k
                        ? "bg-amber-500 text-black"
                        : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 기준 분봉 선택 */}
              <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
                {(["15m", "1h", "4h", "1d"] as RsiTf[]).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setRsiTf(tf)}
                    className={`px-2.5 py-1 font-bold ${
                      rsiTf === tf
                        ? "bg-amber-500 text-black"
                        : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              <button
                onClick={scanRsi}
                disabled={rsiLoading}
                className="rounded-lg bg-amber-500 px-3 py-1.5 font-extrabold text-black hover:bg-amber-400 disabled:opacity-50"
              >
                {rsiLoading
                  ? `분석 중 (${rsiProgress.done}/${rsiProgress.total})`
                  : "타점 새로 스캔"}
              </button>
            </div>
          </div>

          {rsiLoading && pickList.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-10 text-center text-sm text-neutral-400">
              실시간 캔들(RSI · 다이버전스 · ATR 변동성 · 거래량 배수)을 계산해 최적의 진입가와 TP/SL을 산출하고 있습니다… ({rsiProgress.done}/{rsiProgress.total})
            </div>
          ) : pickList.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-10 text-center text-sm text-neutral-400">
              현재 {rsiTf} 기준 조건을 만족하는 타점 후보가 없습니다. 상단 분봉(`15m` / `1h` / `4h`)을 바꾸거나 `타점 새로 스캔`을 눌러보세요.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {pickList.slice(0, 12).map((r, idx) => {
                const p = r.signalPick!;
                const isLong = p.side === "LONG";
                return (
                  <div
                    key={r.symbol}
                    className={`flex flex-col justify-between rounded-xl border p-4 transition ${
                      isLong
                        ? "border-emerald-800/60 bg-gradient-to-br from-emerald-950/25 via-neutral-900 to-neutral-900"
                        : "border-rose-800/60 bg-gradient-to-br from-rose-950/25 via-neutral-900 to-neutral-900"
                    }`}
                  >
                    {/* 카드 헤더: 순위 + 티커 + LONG/SHORT + 추천점수 */}
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-xs font-black text-amber-400">
                            {idx + 1}
                          </span>
                          <span className="text-lg font-black text-white">
                            {short(r.symbol)}
                          </span>
                          <span
                            className={`rounded-md px-2 py-0.5 text-xs font-black ${
                              isLong
                                ? "bg-emerald-500 text-black"
                                : "bg-rose-500 text-white"
                            }`}
                          >
                            {isLong ? "🟢 LONG 추천" : "🔴 SHORT 추천"}
                          </span>
                          <span className="rounded border border-neutral-700 bg-neutral-800/80 px-2 py-0.5 text-[11px] font-bold text-neutral-200">
                            {p.strategyName}
                          </span>
                        </div>

                        <div className="text-right">
                          <span className="text-[11px] text-neutral-400">타점 신뢰도</span>
                          <div className="text-base font-black text-amber-400">
                            {p.confidence}점{" "}
                            <span className="text-xs font-normal text-neutral-400">
                              / 100
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 종목 기초 지표 바 */}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-300">
                        <span>
                          24h 등락:{" "}
                          <strong
                            className={
                              r.priceChangePercent >= 0
                                ? "text-emerald-400"
                                : "text-rose-400"
                            }
                          >
                            {r.priceChangePercent >= 0 ? "+" : ""}
                            {r.priceChangePercent.toFixed(2)}%
                          </strong>
                        </span>
                        <span>
                          RSI({rsiTf}):{" "}
                          <strong
                            className={
                              r.rsi <= 35
                                ? "text-sky-400"
                                : r.rsi >= 65
                                ? "text-rose-400"
                                : "text-white"
                            }
                          >
                            {r.rsi.toFixed(1)}
                          </strong>
                        </span>
                        <span>
                          거래량 배수:{" "}
                          <strong className="text-amber-300">
                            {r.volSpike.toFixed(1)}x
                          </strong>
                        </span>
                        <span>
                          24h 거래대금:{" "}
                          <strong className="text-neutral-100">
                            {fmtKrwVol(r.quoteVolume, fxRate)}
                          </strong>{" "}
                          <span className="text-neutral-500">
                            ({fmtVol(r.quoteVolume)})
                          </span>
                        </span>
                      </div>

                      {/* 선정 근거 태그 */}
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {p.reasons.map((reason, i) => (
                          <span
                            key={i}
                            className="rounded-md border border-neutral-700/80 bg-neutral-950/70 px-2 py-0.5 text-[11px] text-neutral-300"
                          >
                            ✓ {reason}
                          </span>
                        ))}
                      </div>

                      {/* 핵심: 진입가 / 손절가(SL) / 익절가(TP1, TP2) 그리드 */}
                      <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {/* 1. 진입가 */}
                        <div className="rounded-lg border border-neutral-700/80 bg-neutral-950/90 p-2.5">
                          <div className="text-[11px] font-bold text-neutral-400">
                            🎯 추천 진입가 (Entry)
                          </div>
                          <div className="mt-1 text-sm font-black text-white">
                            {fmtKrwPx(p.entryPrice, fxRate)}
                          </div>
                          <div className="font-mono text-[11px] text-neutral-300">
                            {fmtPx(p.entryPrice)}
                          </div>
                          <div className="mt-1 text-[10px] text-amber-300/90">
                            눌림 지정가: {fmtPx(p.limitEntryPrice)}
                          </div>
                        </div>

                        {/* 2. 손절가 (SL / SP) */}
                        <div className="rounded-lg border border-rose-900/70 bg-rose-950/25 p-2.5">
                          <div className="flex items-center justify-between text-[11px] font-bold text-rose-300">
                            <span>🛑 손절가 (SL/SP)</span>
                            <span>{p.slPct.toFixed(2)}%</span>
                          </div>
                          <div className="mt-1 text-sm font-black text-rose-400">
                            {fmtKrwPx(p.stopLoss, fxRate)}
                          </div>
                          <div className="font-mono text-[11px] text-rose-200/80">
                            {fmtPx(p.stopLoss)}
                          </div>
                          <div className="mt-1 text-[10px] text-neutral-400">
                            이탈 시 즉시 손절
                          </div>
                        </div>

                        {/* 3. 1차 익절가 (TP1) */}
                        <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-2.5">
                          <div className="flex items-center justify-between text-[11px] font-bold text-emerald-300">
                            <span>💰 1차 익절 (TP1)</span>
                            <span>+{p.tp1Pct.toFixed(2)}%</span>
                          </div>
                          <div className="mt-1 text-sm font-black text-emerald-400">
                            {fmtKrwPx(p.tp1, fxRate)}
                          </div>
                          <div className="font-mono text-[11px] text-emerald-200/80">
                            {fmtPx(p.tp1)}
                          </div>
                          <div className="mt-1 text-[10px] text-neutral-400">
                            50% 분할 익절 + 본절로스
                          </div>
                        </div>

                        {/* 4. 2차 익절가 (TP2) */}
                        <div className="rounded-lg border border-emerald-700/70 bg-emerald-950/35 p-2.5">
                          <div className="flex items-center justify-between text-[11px] font-bold text-emerald-200">
                            <span>🚀 2차 목표 (TP2)</span>
                            <span>+{p.tp2Pct.toFixed(2)}%</span>
                          </div>
                          <div className="mt-1 text-sm font-black text-emerald-300">
                            {fmtKrwPx(p.tp2, fxRate)}
                          </div>
                          <div className="font-mono text-[11px] text-emerald-100/90">
                            {fmtPx(p.tp2)}
                          </div>
                          <div className="mt-1 text-[10px] text-emerald-300/80">
                            전량 익절 목표가
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 하단 손익비 & 권장 레버리지 가이드 & 즉시 주문 버튼 */}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800/80 pt-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-neutral-400">
                          기대 손익비(R:R):{" "}
                          <strong className="text-amber-400">1 : {p.rrRatio}</strong>
                        </span>
                        <span className="text-neutral-400">
                          권장 레버리지:{" "}
                          <strong className="text-neutral-200">{p.recLeverage}</strong>
                        </span>
                        <Sparkline data={r.closes} up={isLong} />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setOrderTarget({
                            symbol: r.symbol,
                            lastPrice: r.lastPrice,
                            pick: p,
                          })
                        }
                        className={`rounded-lg px-3.5 py-1.5 text-xs font-black shadow transition ${
                          isLong
                            ? "bg-emerald-500 text-black hover:bg-emerald-400"
                            : "bg-rose-500 text-white hover:bg-rose-400"
                        }`}
                      >
                        ⚡ 이 타점으로 주문하기
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[11px] text-neutral-500">
            ※ 본 타점 추천은 바이낸스 실시간 캔들의 RSI(14), 다이버전스, 거래량 배수, ATR(14) 변동성을 기반으로 자동 계산된 기술적 참고 지표이며, 진입 시에는 반드시 분할 진입과 손절가(SL) 주문을 함께 걸어두시기 바랍니다.
          </p>
        </div>
      )}

      {/* 탭 1: 24h 급등 / 급락 */}
      {tab === "movers" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* 급등 TOP 20 */}
          <div className="overflow-hidden rounded-xl border border-emerald-900/50 bg-neutral-900">
            <div className="border-b border-neutral-800 bg-emerald-950/30 px-4 py-3">
              <h3 className="text-sm font-extrabold text-emerald-400">
                🚀 24시간 급등 TOP 20 (상승률 순)
              </h3>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-neutral-950/60 text-left text-neutral-400">
                <tr>
                  <th className="p-2.5">#</th>
                  <th className="p-2.5">티커</th>
                  <th className="p-2.5 text-right">현재가 (KRW / USD)</th>
                  <th className="p-2.5 text-right">24h 등락률</th>
                  <th className="p-2.5 text-right">24h 거래대금</th>
                  <th className="p-2.5">24h 고저 위치</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/80">
                {marketSummary.gainers.map((t, i) => (
                  <tr key={t.symbol} className="hover:bg-neutral-800/50">
                    <td className="p-2.5 text-neutral-500">{i + 1}</td>
                    <td className="p-2.5 font-bold text-white">{short(t.symbol)}</td>
                    <td className="p-2.5 text-right">
                      <div className="font-bold text-neutral-100">
                        {fmtKrwPx(t.lastPrice, fxRate)}
                      </div>
                      <div className="font-mono text-[11px] text-neutral-400">
                        {fmtPx(t.lastPrice)}
                      </div>
                    </td>
                    <td className="p-2.5 text-right font-extrabold text-emerald-400">
                      +{t.priceChangePercent.toFixed(2)}%
                    </td>
                    <td className="p-2.5 text-right">
                      <div className="font-semibold text-neutral-200">
                        {fmtKrwVol(t.quoteVolume, fxRate)}
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        {fmtVol(t.quoteVolume)}
                      </div>
                    </td>
                    <td className="p-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className="h-full bg-emerald-400"
                            style={{ width: `${t.rangePos}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-neutral-400">
                          {t.rangePos.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 급락 TOP 20 */}
          <div className="overflow-hidden rounded-xl border border-rose-900/50 bg-neutral-900">
            <div className="border-b border-neutral-800 bg-rose-950/30 px-4 py-3">
              <h3 className="text-sm font-extrabold text-rose-400">
                🩸 24시간 급락 TOP 20 (하락률 순)
              </h3>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-neutral-950/60 text-left text-neutral-400">
                <tr>
                  <th className="p-2.5">#</th>
                  <th className="p-2.5">티커</th>
                  <th className="p-2.5 text-right">현재가 (KRW / USD)</th>
                  <th className="p-2.5 text-right">24h 등락률</th>
                  <th className="p-2.5 text-right">24h 거래대금</th>
                  <th className="p-2.5">24h 고저 위치</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/80">
                {marketSummary.losers.map((t, i) => (
                  <tr key={t.symbol} className="hover:bg-neutral-800/50">
                    <td className="p-2.5 text-neutral-500">{i + 1}</td>
                    <td className="p-2.5 font-bold text-white">{short(t.symbol)}</td>
                    <td className="p-2.5 text-right">
                      <div className="font-bold text-neutral-100">
                        {fmtKrwPx(t.lastPrice, fxRate)}
                      </div>
                      <div className="font-mono text-[11px] text-neutral-400">
                        {fmtPx(t.lastPrice)}
                      </div>
                    </td>
                    <td className="p-2.5 text-right font-extrabold text-rose-400">
                      {t.priceChangePercent.toFixed(2)}%
                    </td>
                    <td className="p-2.5 text-right">
                      <div className="font-semibold text-neutral-200">
                        {fmtKrwVol(t.quoteVolume, fxRate)}
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        {fmtVol(t.quoteVolume)}
                      </div>
                    </td>
                    <td className="p-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className="h-full bg-rose-400"
                            style={{ width: `${t.rangePos}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-neutral-400">
                          {t.rangePos.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 탭 2: 거래량 폭발 */}
      {tab === "volume" && (
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between border-b border-neutral-800 px-4 py-3">
            <div>
              <h3 className="text-sm font-extrabold text-amber-400">
                🔥 24시간 거래대금 상위 & 단기 거래량 급증(Spike) 종목
              </h3>
              <p className="text-xs text-neutral-400">
                수급이 몰리는 주도주 목록입니다. 원화·달러 거래대금과 평소 대비 거래량 급증 배수를 함께 보여줍니다.
              </p>
            </div>
            <button
              onClick={scanRsi}
              disabled={rsiLoading}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50"
            >
              {rsiLoading
                ? `스캔 중 (${rsiProgress.done}/${rsiProgress.total})`
                : "거래량 배수·RSI 갱신"}
            </button>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-neutral-950/60 text-left text-neutral-400">
              <tr>
                <th className="p-3">순위</th>
                <th className="p-3">티커</th>
                <th className="p-3 text-right">현재가 (KRW / USD)</th>
                <th className="p-3 text-right">24h 등락률</th>
                <th className="p-3 text-right">24h 거래대금 (KRW / USD)</th>
                <th className="p-3 text-right">24h 체결수</th>
                <th className="p-3 text-right">평소 대비 거래량 배수</th>
                <th className="p-3 text-right">RSI ({rsiTf})</th>
                <th className="p-3 text-center">최근 추세</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {marketSummary.byVol.map((t, i) => {
                const r = rsiRows.find((x) => x.symbol === t.symbol);
                const up = t.priceChangePercent >= 0;
                return (
                  <tr key={t.symbol} className="hover:bg-neutral-800/50">
                    <td className="p-3 text-neutral-500">{i + 1}</td>
                    <td className="p-3 font-extrabold text-white">{short(t.symbol)}</td>
                    <td className="p-3 text-right">
                      <span className="font-bold text-neutral-100">
                        {fmtKrwPx(t.lastPrice, fxRate)}
                      </span>
                      <span className="ml-1.5 font-mono text-neutral-400">
                        ({fmtPx(t.lastPrice)})
                      </span>
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${
                        up ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {up ? "+" : ""}
                      {t.priceChangePercent.toFixed(2)}%
                    </td>
                    <td className="p-3 text-right">
                      <span className="font-bold text-amber-300">
                        {fmtKrwVol(t.quoteVolume, fxRate)}
                      </span>
                      <span className="ml-1.5 text-neutral-400">
                        ({fmtVol(t.quoteVolume)})
                      </span>
                    </td>
                    <td className="p-3 text-right text-neutral-400">
                      {t.count.toLocaleString("en-US")}회
                    </td>
                    <td className="p-3 text-right">
                      {r ? (
                        <span
                          className={`rounded px-1.5 py-0.5 font-bold ${
                            r.volSpike >= 2
                              ? "bg-amber-500/20 text-amber-300"
                              : "text-neutral-400"
                          }`}
                        >
                          {r.volSpike.toFixed(1)}x
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="p-3 text-right">
                      {r ? (
                        <span
                          className={`font-bold ${
                            r.rsi >= 70
                              ? "text-rose-400"
                              : r.rsi <= 30
                              ? "text-sky-400"
                              : "text-neutral-300"
                          }`}
                        >
                          {r.rsi.toFixed(1)}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {r ? <Sparkline data={r.closes} up={up} /> : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 탭 3: 상승 다이버전스 스캐너 */}
      {tab === "divergence" && (
        <div className="overflow-hidden rounded-xl border border-emerald-900/50 bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 bg-emerald-950/20 px-4 py-3">
            <div>
              <h3 className="text-sm font-extrabold text-emerald-400">
                📈 RSI 상승 다이버전스(Bullish Divergence) 스캐너 & 강도 수치
              </h3>
              <p className="mt-0.5 text-xs text-neutral-400">
                가격 저점은 낮아졌는데(Lower Low) RSI 저점은 높아진{" "}
                <strong className="text-emerald-300">일반 상승 다이버전스(반전)</strong>와, 가격 저점은 지지하면서 RSI만 과매도로 식힌{" "}
                <strong className="text-sky-300">히든 상승 다이버전스(눌림목)</strong>를 수치화(0~100점)합니다.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
                {(
                  [
                    ["all", "전체 시그널"],
                    ["regular", "일반 상승 (반전)"],
                    ["hidden", "히든 상승 (눌림목)"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setDivFilter(k)}
                    className={`px-2.5 py-1 font-bold ${
                      divFilter === k
                        ? "bg-emerald-500 text-black"
                        : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
                {(["15m", "1h", "4h", "1d"] as RsiTf[]).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setRsiTf(tf)}
                    className={`px-2.5 py-1 font-bold ${
                      rsiTf === tf
                        ? "bg-amber-500 text-black"
                        : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              <button
                onClick={scanRsi}
                disabled={rsiLoading}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {rsiLoading
                  ? `스캔 중 (${rsiProgress.done}/${rsiProgress.total})`
                  : "다이버전스 재스캔"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-neutral-950/60 text-left text-neutral-400">
                <tr>
                  <th className="p-3">티커 / 시그널</th>
                  <th className="p-3">다이버전스 강도 수치</th>
                  <th className="p-3 text-right">현재가 (KRW / USD)</th>
                  <th className="p-3 text-right">1차 → 2차 저점 가격 변화</th>
                  <th className="p-3 text-right">1차 → 2차 저점 RSI 수치</th>
                  <th className="p-3 text-right">현재 RSI ({rsiTf})</th>
                  <th className="p-3 text-right">거래량 배수</th>
                  <th className="p-3 text-center">가격(위) vs RSI(아래) 괴리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {divergenceList.map((r) => {
                  const d = r.divergence!;
                  const badge =
                    d.type === "regular"
                      ? {
                          label: "일반 상승 다이버",
                          cls: "bg-emerald-500/20 text-emerald-300 border border-emerald-600/40",
                        }
                      : d.type === "hidden"
                      ? {
                          label: "히든 상승 (눌림)",
                          cls: "bg-sky-500/20 text-sky-300 border border-sky-600/40",
                        }
                      : {
                          label: "쌍바닥 · 수렴중",
                          cls: "bg-amber-500/20 text-amber-300 border border-amber-600/40",
                        };

                  return (
                    <tr key={r.symbol} className="hover:bg-neutral-800/50">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-extrabold text-white">
                            {short(r.symbol)}
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-neutral-400">
                          {d.barsBetween}봉 간격 ·{" "}
                          {d.barsAgo === 0 ? "현재 봉 저점" : `${d.barsAgo}봉 전 저점 확인`}
                        </div>
                      </td>

                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-sm font-black ${
                              d.score >= 70
                                ? "text-emerald-400"
                                : d.score >= 50
                                ? "text-amber-300"
                                : "text-neutral-300"
                            }`}
                          >
                            {d.score}점
                          </span>
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-neutral-800">
                            <div
                              className={`h-full ${
                                d.score >= 70
                                  ? "bg-emerald-400"
                                  : d.score >= 50
                                  ? "bg-amber-400"
                                  : "bg-neutral-500"
                              }`}
                              style={{ width: `${d.score}%` }}
                            />
                          </div>
                        </div>
                        <div className="mt-0.5 text-[10px] text-neutral-500">
                          {d.score >= 70
                            ? "강력 반전 시그널"
                            : d.score >= 50
                            ? "유효 다이버전스"
                            : "초기 형성 단계"}
                        </div>
                      </td>

                      <td className="p-3 text-right">
                        <div className="font-bold text-neutral-100">
                          {fmtKrwPx(r.lastPrice, fxRate)}
                        </div>
                        <div className="font-mono text-[11px] text-neutral-400">
                          {fmtPx(r.lastPrice)} ({r.priceChangePercent >= 0 ? "+" : ""}
                          {r.priceChangePercent.toFixed(2)}%)
                        </div>
                      </td>

                      <td className="p-3 text-right">
                        <div
                          className={`font-extrabold ${
                            d.priceDeltaPct <= 0 ? "text-rose-400" : "text-emerald-400"
                          }`}
                        >
                          {d.priceDeltaPct >= 0 ? "+" : ""}
                          {d.priceDeltaPct.toFixed(2)}%{" "}
                          <span className="text-[10px] font-normal text-neutral-400">
                            ({d.priceDeltaPct <= 0 ? "저점 낮아짐" : "저점 높아짐"})
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-neutral-400">
                          {fmtPx(d.price1)} → {fmtPx(d.price2)}
                        </div>
                      </td>

                      <td className="p-3 text-right">
                        <div
                          className={`font-extrabold ${
                            d.rsiDelta >= 0 ? "text-emerald-400" : "text-sky-400"
                          }`}
                        >
                          {d.rsiDelta >= 0 ? "+" : ""}
                          {d.rsiDelta.toFixed(1)}p{" "}
                          <span className="text-[10px] font-normal text-neutral-400">
                            ({d.rsiDelta >= 0 ? "RSI 저점 상승" : "RSI 과매도 리셋"})
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-neutral-300">
                          RSI {d.rsi1.toFixed(1)} → {d.rsi2.toFixed(1)}
                        </div>
                      </td>

                      <td className="p-3 text-right">
                        <span
                          className={`text-sm font-black ${
                            r.rsi <= 35
                              ? "text-sky-400"
                              : r.rsi >= 65
                              ? "text-rose-400"
                              : "text-neutral-200"
                          }`}
                        >
                          {r.rsi.toFixed(1)}
                        </span>
                      </td>

                      <td className="p-3 text-right">
                        <span
                          className={
                            r.volSpike >= 1.8
                              ? "rounded bg-amber-500/20 px-1.5 py-0.5 font-bold text-amber-300"
                              : "text-neutral-400"
                          }
                        >
                          {r.volSpike.toFixed(1)}x
                        </span>
                        <div className="mt-0.5 text-[10px] text-neutral-500">
                          {fmtKrwVol(r.quoteVolume, fxRate)}
                        </div>
                      </td>

                      <td className="p-3 text-center">
                        <DivergenceMiniChart
                          closes={r.closes}
                          rsiHistory={r.rsiHistory}
                          div={d}
                        />
                      </td>
                    </tr>
                  );
                })}

                {!rsiLoading && divergenceList.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-neutral-500">
                      현재 {rsiTf} 타임프레임에서 감지된 상승 다이버전스 종목이 없습니다. 상단의 다른 분봉(15m / 1h / 4h / 1d)이나 &apos;전체 시그널&apos;을 선택해 보세요.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 탭 4 & 5: 과매수 / 과매도 (RSI 스캐너) */}
      {(tab === "overbought" || tab === "oversold") && (
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
            <div>
              <h3 className="text-sm font-extrabold text-white">
                {tab === "overbought"
                  ? "🔴 과매수 코인 스캐너 (RSI 65 이상 · 단기 과열 / 숏 후보)"
                  : "🔵 과매도 코인 스캐너 (RSI 35 이하 · 단기 투매 / 기술적 반등 후보)"}
              </h3>
              <p className="text-xs text-neutral-400">
                주요 거래대금·변동성 상위 60개 종목의 캔들을 분석해 Wilder&apos;s RSI(14)를 실시간 계산합니다.
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
                {(["15m", "1h", "4h", "1d"] as RsiTf[]).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setRsiTf(tf)}
                    className={`px-2.5 py-1 font-bold ${
                      rsiTf === tf
                        ? "bg-amber-500 text-black"
                        : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <button
                onClick={scanRsi}
                disabled={rsiLoading}
                className="rounded-lg bg-neutral-800 px-3 py-1.5 font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
              >
                {rsiLoading
                  ? `스캔 중 (${rsiProgress.done}/${rsiProgress.total})`
                  : "RSI 다시 스캔"}
              </button>
            </div>
          </div>

          <table className="w-full text-xs">
            <thead className="bg-neutral-950/60 text-left text-neutral-400">
              <tr>
                <th className="p-3">티커</th>
                <th className="p-3 text-right">현재가 (KRW / USD)</th>
                <th className="p-3 text-right">24h 등락률</th>
                <th className="p-3 text-right">RSI (14, {rsiTf})</th>
                <th className="p-3">과열/침체 게이지</th>
                <th className="p-3 text-right">거래량 급증 배수</th>
                <th className="p-3 text-right">24h 거래대금 (KRW / USD)</th>
                <th className="p-3 text-center">최근 25봉 추이</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {(tab === "overbought" ? overboughtList : oversoldList).map((r) => {
                const up = r.priceChangePercent >= 0;
                const extreme = tab === "overbought" ? r.rsi >= 75 : r.rsi <= 25;
                return (
                  <tr key={r.symbol} className="hover:bg-neutral-800/50">
                    <td className="p-3 font-extrabold text-white">
                      {short(r.symbol)}
                      {extreme && (
                        <span
                          className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            tab === "overbought"
                              ? "bg-rose-500/20 text-rose-300"
                              : "bg-sky-500/20 text-sky-300"
                          }`}
                        >
                          {tab === "overbought" ? "초과열" : "극침체"}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <span className="font-bold text-neutral-100">
                        {fmtKrwPx(r.lastPrice, fxRate)}
                      </span>
                      <span className="ml-1.5 font-mono text-neutral-400">
                        ({fmtPx(r.lastPrice)})
                      </span>
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${
                        up ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {up ? "+" : ""}
                      {r.priceChangePercent.toFixed(2)}%
                    </td>
                    <td
                      className={`p-3 text-right text-sm font-black ${
                        tab === "overbought" ? "text-rose-400" : "text-sky-400"
                      }`}
                    >
                      {r.rsi.toFixed(1)}
                    </td>
                    <td className="p-3">
                      <div className="h-2 w-28 overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className={`h-full ${
                            tab === "overbought" ? "bg-rose-500" : "bg-sky-400"
                          }`}
                          style={{ width: `${Math.min(100, Math.max(0, r.rsi))}%` }}
                        />
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <span
                        className={
                          r.volSpike >= 2 ? "font-bold text-amber-300" : "text-neutral-400"
                        }
                      >
                        {r.volSpike.toFixed(1)}x
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <span className="font-semibold text-neutral-200">
                        {fmtKrwVol(r.quoteVolume, fxRate)}
                      </span>
                      <span className="ml-1.5 text-neutral-400">
                        ({fmtVol(r.quoteVolume)})
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <Sparkline data={r.closes} up={up} />
                    </td>
                  </tr>
                );
              })}
              {!rsiLoading &&
                (tab === "overbought" ? overboughtList : oversoldList).length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-neutral-500">
                      현재 {rsiTf} 기준 해당 조건({tab === "overbought" ? "RSI ≥ 65" : "RSI ≤ 35"})에 맞는 종목이 없습니다. 다른 분봉(15m / 1h / 4h)을 선택해 보세요.
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>
      )}

      {/* 탭 6: 한눈에 보는 마켓 히트맵 */}
      {tab === "heatmap" && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <p className="mb-3 text-xs text-neutral-400">
            거래대금 상위 48개 선물 종목의 24시간 등락률과 현재가(원화/달러)를 한눈에 보여줍니다.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {marketSummary.byVol.slice(0, 48).map((t) => {
              const p = t.priceChangePercent;
              const bg =
                p >= 10
                  ? "bg-emerald-600 text-white"
                  : p >= 3
                  ? "bg-emerald-800/80 text-emerald-100"
                  : p > 0
                  ? "bg-emerald-950/80 text-emerald-300 border border-emerald-800/50"
                  : p <= -10
                  ? "bg-rose-600 text-white"
                  : p <= -3
                  ? "bg-rose-800/80 text-rose-100"
                  : "bg-rose-950/80 text-rose-300 border border-rose-800/50";
              return (
                <div
                  key={t.symbol}
                  title={`${t.symbol}: ${fmtKrwPx(t.lastPrice, fxRate)} (${fmtPx(
                    t.lastPrice
                  )}) · 거래대금 ${fmtKrwVol(t.quoteVolume, fxRate)} (${fmtVol(
                    t.quoteVolume
                  )})`}
                  className={`flex flex-col items-center justify-center rounded-lg p-2.5 text-center transition hover:scale-105 ${bg}`}
                >
                  <span className="text-xs font-extrabold">{short(t.symbol)}</span>
                  <span className="mt-0.5 text-sm font-black">
                    {p >= 0 ? "+" : ""}
                    {p.toFixed(2)}%
                  </span>
                  <span className="mt-0.5 text-[10px] font-semibold opacity-90">
                    {fmtKrwPx(t.lastPrice, fxRate)}
                  </span>
                  <span className="text-[9.5px] opacity-75">{fmtPx(t.lastPrice)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {orderTarget && (
        <TradeOrderModal
          item={orderTarget}
          fxRate={fxRate}
          onClose={() => setOrderTarget(null)}
        />
      )}
    </section>
  );
}
