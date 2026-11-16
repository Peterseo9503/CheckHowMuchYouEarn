import { prisma } from "@/lib/prisma";
import {
  fetchDualSidePosition,
  fetchOpenPositions,
  fetchSymbolRule,
  placeConditionalOrder,
  roundToStep,
  setFuturesLeverage,
  setFuturesMarginType,
  signedPost,
} from "@/lib/binance";

const FAPI = "https://fapi.binance.com";

export interface ScannedCandidate {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
  rangePos: number;
  rsi: number;
  atr: number;
  volSpike: number;
  side: "LONG" | "SHORT";
  strategyName: string;
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rrRatio: number;
  reasons: string[];
}

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

function calcAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
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

function detectBullDiv(
  lows: number[],
  closes: number[],
  rsiSeries: (number | null)[]
): { type: "regular" | "hidden"; score: number } | null {
  const n = closes.length;
  if (n < 30) return null;
  const startIdx = Math.max(15, n - 25);
  const recentStart = Math.max(startIdx + 5, n - 7);
  let i2 = recentStart;
  for (let i = recentStart; i < n; i++) {
    if (lows[i] <= lows[i2]) i2 = i;
  }
  const r2 = rsiSeries[i2];
  if (r2 === null) return null;

  let best: { type: "regular" | "hidden"; score: number } | null = null;
  for (let i1 = startIdx; i1 <= i2 - 4; i1++) {
    const r1 = rsiSeries[i1];
    if (r1 === null) continue;
    const isLocalLow =
      (i1 === startIdx || lows[i1] <= lows[i1 - 1]) && lows[i1] <= lows[i1 + 1];
    if (!isLocalLow) continue;

    const p1 = lows[i1];
    const p2 = lows[i2];
    const priceDeltaPct = ((p2 - p1) / p1) * 100;
    const rsiDelta = r2 - r1;
    const barsAgo = n - 1 - i2;

    if (priceDeltaPct <= -0.15 && rsiDelta >= 1.2 && r1 <= 52) {
      const oversoldBonus = r1 < 30 ? 22 : r1 < 38 ? 14 : r1 < 45 ? 7 : 0;
      const rsiGainScore = Math.min(40, rsiDelta * 3.8);
      const priceDropScore = Math.min(22, Math.abs(priceDeltaPct) * 3.5);
      const recencyBonus = Math.max(0, 16 - barsAgo * 2.5);
      const score = Math.round(
        Math.min(99, Math.max(25, oversoldBonus + rsiGainScore + priceDropScore + recencyBonus))
      );
      if (!best || score > best.score) best = { type: "regular", score };
    } else if (priceDeltaPct >= 0.25 && rsiDelta <= -1.8 && r2 <= 46) {
      const oversoldBonus = r2 < 35 ? 18 : r2 < 42 ? 10 : 4;
      const rsiCoolScore = Math.min(35, Math.abs(rsiDelta) * 3.0);
      const priceHoldScore = Math.min(25, priceDeltaPct * 3.2);
      const recencyBonus = Math.max(0, 14 - barsAgo * 2.5);
      const score = Math.round(
        Math.min(95, Math.max(20, oversoldBonus + rsiCoolScore + priceHoldScore + recencyBonus))
      );
      if (!best || (best.type !== "regular" && score > best.score)) {
        best = { type: "hidden", score };
      }
    }
  }
  return best;
}

const fmtVol = (v: number) => {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  return `$${(v / 1_000).toFixed(0)}K`;
};

function evaluateSignal(
  t: {
    symbol: string;
    lastPrice: number;
    priceChangePercent: number;
    quoteVolume: number;
    rangePos: number;
  },
  rsi: number,
  atr: number,
  volSpike: number,
  highs: number[],
  lows: number[],
  div: { type: "regular" | "hidden"; score: number } | null
): ScannedCandidate | null {
  const price = t.lastPrice;
  if (!price || !atr) return null;
  const recentLow = Math.min(...lows.slice(-12));
  const recentHigh = Math.max(...highs.slice(-12));
  const reasons: string[] = [];

  // 1) LONG: 급락 과매도 + 상승 다이버전스 반등
  if (
    rsi <= 38 ||
    (div && div.type === "regular" && div.score >= 55) ||
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
    if (div && div.type === "regular") {
      score += Math.round(div.score * 0.25);
      reasons.push(`일반 상승 다이버전스 (${div.score}점)`);
    } else if (div && div.type === "hidden") {
      score += 10;
      reasons.push(`히든 상승 다이버전스 (${div.score}점)`);
    }
    if (t.priceChangePercent <= -8) {
      score += 10;
      reasons.push(`24h ${t.priceChangePercent.toFixed(1)}% 급락 후 반등`);
    }
    if (volSpike >= 1.5) {
      score += 9;
      reasons.push(`거래량 ${volSpike.toFixed(1)}x 유입`);
    }
    if (t.quoteVolume >= 50_000_000) {
      score += 6;
      reasons.push(`거래대금 ${fmtVol(t.quoteVolume)}`);
    }

    const rawSl = Math.min(recentLow - atr * 0.35, price - atr * 1.45);
    const slDist = Math.min(price * 0.065, Math.max(price * 0.009, price - rawSl));
    const stopLoss = price - slDist;
    const tp1 = price + slDist * 1.45;
    const tp2 = price + slDist * 2.4;

    return {
      ...t,
      rsi,
      atr,
      volSpike,
      side: "LONG",
      strategyName:
        div && div.type === "regular"
          ? "상승 다이버전스 + 과매도 반등 롱"
          : "급락 과매도 기술적 반등 롱",
      confidence: Math.min(98, Math.max(52, score)),
      entryPrice: price,
      stopLoss,
      tp1,
      tp2,
      rrRatio: 2.4,
      reasons,
    };
  }

  // 2) SHORT: 급등 과열 + RSI 과매수 피로도
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
      reasons.push(`고점 대량 거래량 (${volSpike.toFixed(1)}x)`);
    }
    if (t.rangePos >= 88) {
      score += 6;
      reasons.push(`24h 고가 상단(${t.rangePos.toFixed(0)}%) 저항`);
    }

    const rawSl = Math.max(recentHigh + atr * 0.35, price + atr * 1.45);
    const slDist = Math.min(price * 0.065, Math.max(price * 0.009, rawSl - price));
    const stopLoss = price + slDist;
    const tp1 = price - slDist * 1.45;
    const tp2 = price - slDist * 2.35;

    return {
      ...t,
      rsi,
      atr,
      volSpike,
      side: "SHORT",
      strategyName: "급등 과열 · RSI 과매수 되돌림 숏",
      confidence: Math.min(98, Math.max(52, score)),
      entryPrice: price,
      stopLoss,
      tp1,
      tp2,
      rrRatio: 2.35,
      reasons,
    };
  }

  // 3) LONG: 거래량 폭발 + 눌림목 추세 지속
  if (
    (volSpike >= 1.6 || (div && div.type === "hidden")) &&
    t.priceChangePercent >= 1.5 &&
    rsi >= 42 &&
    rsi <= 64
  ) {
    let score = 48;
    if (volSpike >= 2.2) {
      score += 18;
      reasons.push(`거래량 ${volSpike.toFixed(1)}x 폭발`);
    } else if (volSpike >= 1.6) {
      score += 12;
      reasons.push(`거래량 ${volSpike.toFixed(1)}x 증가`);
    }
    if (div && div.type === "hidden") {
      score += 16;
      reasons.push(`히든 상승 다이버전스 (${div.score}점)`);
    }
    reasons.push(`24h +${t.priceChangePercent.toFixed(1)}% 상승 추세`);
    if (t.quoteVolume >= 80_000_000) {
      score += 8;
      reasons.push(`대형 거래대금 (${fmtVol(t.quoteVolume)})`);
    }

    const slDist = Math.min(price * 0.06, Math.max(price * 0.009, atr * 1.4));
    const stopLoss = price - slDist;
    const tp1 = price + slDist * 1.5;
    const tp2 = price + slDist * 2.5;

    return {
      ...t,
      rsi,
      atr,
      volSpike,
      side: "LONG",
      strategyName: "수급 폭발 주도주 눌림목 롱",
      confidence: Math.min(96, Math.max(50, score)),
      entryPrice: price,
      stopLoss,
      tp1,
      tp2,
      rrRatio: 2.5,
      reasons,
    };
  }

  return null;
}

/** 기본 설정 조회 (없으면 생성) */
export async function getOrCreateBotConfig() {
  return prisma.autoBotConfig.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      enabled: false,
      paperMode: true,
      minConfidence: 95,
      timeframe: "15m",
      marginUsdt: 30,
      leverage: 5,
      marginType: "ISOLATED",
      maxOpenPositions: 2,
      cooldownMin: 240,
      allowLong: true,
      allowShort: true,
    },
  });
}

/**
 * 진행 중인(OPEN / TP1_HIT) 자동매매 내역들의 현재 시세 대조 & 익절/손절 도달 여부 자동 갱신
 */
export async function refreshOpenAutoTrades(priceMap?: Map<string, number>) {
  const openTrades = await prisma.autoTrade.findMany({
    where: { status: { in: ["OPEN", "TP1_HIT"] } },
  });
  if (!openTrades.length) return;

  let map = priceMap;
  if (!map) {
    map = new Map<string, number>();
    const res = await fetch(`${FAPI}/fapi/v1/ticker/price`, { cache: "no-store" });
    if (res.ok) {
      const rows = (await res.json()) as { symbol: string; price: string }[];
      for (const r of rows) map.set(r.symbol, parseFloat(r.price));
    }
  }

  for (const tr of openTrades) {
    const curPrice = map.get(tr.symbol);
    if (!curPrice) continue;
    const dir = tr.side === "LONG" ? 1 : -1;

    // 1) 손절가 도달 체크
    const slHit =
      (tr.side === "LONG" && curPrice <= tr.stopLoss) ||
      (tr.side === "SHORT" && curPrice >= tr.stopLoss);

    if (slHit) {
      // 이미 TP1(50% 반익) 도달 상태였다면 나머지 50%만 손절 처리
      const pnlUsdt =
        tr.status === "TP1_HIT"
          ? (tr.tp1 - tr.entryPrice) * dir * (tr.quantity * 0.5) +
            (tr.stopLoss - tr.entryPrice) * dir * (tr.quantity * 0.5)
          : (tr.stopLoss - tr.entryPrice) * dir * tr.quantity;
      const pnlRoiPct = tr.marginUsdt > 0 ? (pnlUsdt / tr.marginUsdt) * 100 : 0;
      await prisma.autoTrade.update({
        where: { id: tr.id },
        data: {
          status: "SL_HIT",
          exitPrice: tr.stopLoss,
          pnlUsdt,
          pnlRoiPct,
          closedAt: new Date(),
        },
      });
      continue;
    }

    // 2) 2차 목표가(TP2) 도달 체크
    const tp2Hit =
      (tr.side === "LONG" && curPrice >= tr.tp2) ||
      (tr.side === "SHORT" && curPrice <= tr.tp2);

    if (tp2Hit) {
      const pnlUsdt =
        (tr.tp1 - tr.entryPrice) * dir * (tr.quantity * 0.5) +
        (tr.tp2 - tr.entryPrice) * dir * (tr.quantity * 0.5);
      const pnlRoiPct = tr.marginUsdt > 0 ? (pnlUsdt / tr.marginUsdt) * 100 : 0;
      await prisma.autoTrade.update({
        where: { id: tr.id },
        data: {
          status: "TP2_HIT",
          exitPrice: tr.tp2,
          pnlUsdt,
          pnlRoiPct,
          closedAt: new Date(),
        },
      });
      continue;
    }

    // 3) 1차 목표가(TP1) 도달 체크
    const tp1Hit =
      (tr.side === "LONG" && curPrice >= tr.tp1) ||
      (tr.side === "SHORT" && curPrice <= tr.tp1);

    if (tp1Hit && tr.status === "OPEN") {
      const pnlUsdt =
        (tr.tp1 - tr.entryPrice) * dir * (tr.quantity * 0.5) +
        (curPrice - tr.entryPrice) * dir * (tr.quantity * 0.5);
      const pnlRoiPct = tr.marginUsdt > 0 ? (pnlUsdt / tr.marginUsdt) * 100 : 0;
      await prisma.autoTrade.update({
        where: { id: tr.id },
        data: {
          status: "TP1_HIT",
          pnlUsdt,
          pnlRoiPct,
        },
      });
      continue;
    }

    // 4) 진행 중 미실현 손익 업데이트
    const pnlUsdt =
      tr.status === "TP1_HIT"
        ? (tr.tp1 - tr.entryPrice) * dir * (tr.quantity * 0.5) +
          (curPrice - tr.entryPrice) * dir * (tr.quantity * 0.5)
        : (curPrice - tr.entryPrice) * dir * tr.quantity;
    const pnlRoiPct = tr.marginUsdt > 0 ? (pnlUsdt / tr.marginUsdt) * 100 : 0;
    await prisma.autoTrade.update({
      where: { id: tr.id },
      data: { pnlUsdt, pnlRoiPct },
    });
  }
}

/**
 * 마켓 전체 스캔 후 minConfidence(기본 95점) 이상 시그널을 찾아 안전장치 통과 시 자동 진입 & DB 저장
 */
export async function runAutoTradeTick(forceRunEvenIfDisabled = false) {
  const cfg = await getOrCreateBotConfig();

  // 1) 24h 전 종목 시세 조회
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`, { cache: "no-store" });
  if (!res.ok) throw new Error(`24hr 시세 조회 실패 (${res.status})`);
  const raw = (await res.json()) as Record<string, string>[];
  const now = Date.now();

  const priceMap = new Map<string, number>();
  const activeTickers: {
    symbol: string;
    lastPrice: number;
    priceChangePercent: number;
    quoteVolume: number;
    rangePos: number;
  }[] = [];

  for (const r of raw) {
    const sym = r.symbol ?? "";
    if (!sym.endsWith("USDT")) continue;
    const lastPrice = parseFloat(r.lastPrice);
    if (lastPrice > 0) priceMap.set(sym, lastPrice);
    if (now - Number(r.closeTime) > 3_600_000) continue;
    const quoteVolume = parseFloat(r.quoteVolume);
    if (!lastPrice || quoteVolume < 5_000_000) continue;
    const highPrice = parseFloat(r.highPrice);
    const lowPrice = parseFloat(r.lowPrice);
    const span = highPrice - lowPrice;
    activeTickers.push({
      symbol: sym,
      lastPrice,
      priceChangePercent: parseFloat(r.priceChangePercent),
      quoteVolume,
      rangePos: span > 0 ? ((lastPrice - lowPrice) / span) * 100 : 50,
    });
  }

  // 기존 OPEN 자동매매 포지션들의 현재 손익 및 TP/SL 도달 여부 갱신
  await refreshOpenAutoTrades(priceMap);

  if (!cfg.enabled && !forceRunEvenIfDisabled) {
    return {
      executed: [],
      candidates: [],
      skippedReason: "자동매매 봇이 비활성화(OFF) 상태입니다.",
    };
  }

  // 2) 급등락 상위 35 + 거래대금 상위 35 종목 추려서 Klines 스캔
  const byMove = [...activeTickers]
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
    .slice(0, 35);
  const byVol = [...activeTickers]
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 35);

  const targetMap = new Map<string, (typeof activeTickers)[0]>();
  for (const t of [...byMove, ...byVol]) targetMap.set(t.symbol, t);
  const targets = [...targetMap.values()].slice(0, 50);

  const candidates: ScannedCandidate[] = [];
  const batchSize = 10;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const batchRes = await Promise.all(
      batch.map(async (t) => {
        try {
          const kr = await fetch(
            `${FAPI}/fapi/v1/klines?symbol=${t.symbol}&interval=${cfg.timeframe}&limit=60`,
            { cache: "no-store" }
          );
          if (!kr.ok) return null;
          const klines = (await kr.json()) as (string | number)[][];
          if (klines.length < 30) return null;
          const highs = klines.map((k) => parseFloat(String(k[2])));
          const lows = klines.map((k) => parseFloat(String(k[3])));
          const closes = klines.map((k) => parseFloat(String(k[4])));
          const vols = klines.map((k) => parseFloat(String(k[7])));

          const rsiSeries = calcRsiSeries(closes, 14);
          const rsi = rsiSeries[rsiSeries.length - 1];
          if (rsi === null) return null;

          const atr = calcAtr(highs, lows, closes, 14);
          const prevVols = vols.slice(-22, -2);
          const avgVol =
            prevVols.reduce((a, b) => a + b, 0) / Math.max(1, prevVols.length);
          const curVol = Math.max(vols[vols.length - 1], vols[vols.length - 2] ?? 0);
          const volSpike = avgVol > 0 ? curVol / avgVol : 1;

          const div = detectBullDiv(lows, closes, rsiSeries);
          return evaluateSignal(t, rsi, atr, volSpike, highs, lows, div);
        } catch {
          return null;
        }
      })
    );
    for (const item of batchRes) {
      if (item) candidates.push(item);
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  // 3) 설정된 최소 신뢰도(예: 95점) 이상 필터
  const qualified = candidates.filter((c) => {
    if (c.confidence < cfg.minConfidence) return false;
    if (c.side === "LONG" && !cfg.allowLong) return false;
    if (c.side === "SHORT" && !cfg.allowShort) return false;
    return true;
  });

  if (!qualified.length) {
    return {
      executed: [],
      candidates: candidates.slice(0, 10),
      skippedReason: `현재 ${cfg.minConfidence}점 이상 조건을 만족하는 종목이 없습니다. (최고 점수: ${
        candidates[0]?.confidence ?? 0
      }점 ${candidates[0]?.symbol ?? "-"})`,
    };
  }

  // 4) 5대 안전장치 확인 (현재 열린 자동매매 포지션 수 & 쿨타임 & 실전 포지션 중복)
  const openAutoTrades = await prisma.autoTrade.findMany({
    where: { status: { in: ["OPEN", "TP1_HIT"] } },
  });

  let openCount = openAutoTrades.length;
  const openSymbolSet = new Set(openAutoTrades.map((t) => t.symbol));

  if (!cfg.paperMode) {
    try {
      const livePositions = await fetchOpenPositions();
      for (const lp of livePositions) openSymbolSet.add(lp.symbol);
      openCount = Math.max(openCount, livePositions.length);
    } catch {
      // 읽기 실패 시 DB 기준으로 폴백
    }
  }

  if (openCount >= cfg.maxOpenPositions) {
    return {
      executed: [],
      candidates: candidates.slice(0, 10),
      skippedReason: `동시 최대 보유 포지션 한도(${cfg.maxOpenPositions}개)에 도달해 신규 진입을 건너뛰었습니다.`,
    };
  }

  const cooldownCutoff = new Date(Date.now() - cfg.cooldownMin * 60_000);
  const recentTrades = await prisma.autoTrade.findMany({
    where: { createdAt: { gte: cooldownCutoff } },
    select: { symbol: true },
  });
  const recentSymbolSet = new Set(recentTrades.map((r) => r.symbol));

  const executed = [];

  for (const cand of qualified) {
    if (openCount >= cfg.maxOpenPositions) break;
    if (openSymbolSet.has(cand.symbol) || recentSymbolSet.has(cand.symbol)) {
      continue;
    }

    const rule = await fetchSymbolRule(cand.symbol);
    const notional = cfg.marginUsdt * cfg.leverage;
    const rawQty = notional / cand.entryPrice;
    const qtyStr = roundToStep(rawQty, rule.stepSize, "floor");
    const qtyNum = parseFloat(qtyStr);

    if (qtyNum < rule.minQty || qtyNum * cand.entryPrice < rule.minNotional) {
      continue;
    }

    // A) 모의투자(Paper) 모드인 경우: 가상 체결 후 AutoTrade 테이블에 기록
    if (cfg.paperMode) {
      const created = await prisma.autoTrade.create({
        data: {
          symbol: cand.symbol,
          side: cand.side,
          isPaper: true,
          timeframe: cfg.timeframe,
          strategyName: cand.strategyName,
          confidence: cand.confidence,
          reasons: JSON.stringify(cand.reasons),
          rsiAtEntry: cand.rsi,
          volSpikeAtEntry: cand.volSpike,
          marginUsdt: cfg.marginUsdt,
          leverage: cfg.leverage,
          quantity: qtyNum,
          entryPrice: cand.entryPrice,
          stopLoss: Number(roundToStep(cand.stopLoss, rule.tickSize, "round")),
          tp1: Number(roundToStep(cand.tp1, rule.tickSize, "round")),
          tp2: Number(roundToStep(cand.tp2, rule.tickSize, "round")),
          rrRatio: cand.rrRatio,
          status: "OPEN",
          orderId: `PAPER-${Date.now()}`,
          logs: `🧪 [모의투자 자동진입] 신뢰도 ${cand.confidence}점 달성 (${cand.strategyName})`,
        },
      });
      executed.push(created);
      openCount++;
      openSymbolSet.add(cand.symbol);
      continue;
    }

    // B) 실전투자(Live) 모드인 경우: 바이낸스 선물 주문 + SL + TP1/TP2 동시 실행 후 DB 저장
    try {
      const dualSide = await fetchDualSidePosition().catch(() => false);
      await setFuturesMarginType(
        cand.symbol,
        cfg.marginType === "CROSSED" ? "CROSSED" : "ISOLATED"
      );
      await setFuturesLeverage(cand.symbol, cfg.leverage);

      const entryOrderSide: "BUY" | "SELL" = cand.side === "LONG" ? "BUY" : "SELL";
      const exitOrderSide: "BUY" | "SELL" = cand.side === "LONG" ? "SELL" : "BUY";
      const positionSide: "BOTH" | "LONG" | "SHORT" = dualSide ? cand.side : "BOTH";

      const orderRes = await signedPost<Record<string, unknown>>("/fapi/v1/order", {
        symbol: cand.symbol,
        side: entryOrderSide,
        positionSide,
        type: "MARKET",
        quantity: qtyStr,
      });

      const slPriceStr = roundToStep(cand.stopLoss, rule.tickSize, "round");
      const tp1PriceStr = roundToStep(cand.tp1, rule.tickSize, "round");
      const tp2PriceStr = roundToStep(cand.tp2, rule.tickSize, "round");

      const logLines = [
        `🔥 [실전 자동진입] ${cand.symbol} ${cand.side} ${qtyStr} (${cfg.leverage}x)`,
      ];

      // SL 등록
      try {
        await placeConditionalOrder({
          symbol: cand.symbol,
          side: exitOrderSide,
          positionSide,
          type: "STOP_MARKET",
          stopPrice: slPriceStr,
          closePosition: true,
        });
        logLines.push(`🛑 SL 예약 완료 ($${slPriceStr})`);
      } catch (e) {
        logLines.push(`⚠️ SL 등록 실패: ${(e as Error).message}`);
      }

      // TP1 (50%) & TP2 (잔여 전량) 등록
      const halfQtyStr = roundToStep(qtyNum * 0.5, rule.stepSize, "floor");
      if (parseFloat(halfQtyStr) >= rule.minQty) {
        try {
          await placeConditionalOrder({
            symbol: cand.symbol,
            side: exitOrderSide,
            positionSide,
            type: "TAKE_PROFIT_MARKET",
            stopPrice: tp1PriceStr,
            quantity: halfQtyStr,
            closePosition: false,
          });
          logLines.push(`💰 TP1 50% 예약 완료 ($${tp1PriceStr})`);
        } catch (e) {
          logLines.push(`⚠️ TP1 실패: ${(e as Error).message}`);
        }
      }

      try {
        await placeConditionalOrder({
          symbol: cand.symbol,
          side: exitOrderSide,
          positionSide,
          type: "TAKE_PROFIT_MARKET",
          stopPrice: tp2PriceStr,
          closePosition: true,
        });
        logLines.push(`🚀 TP2 전량 예약 완료 ($${tp2PriceStr})`);
      } catch (e) {
        logLines.push(`⚠️ TP2 실패: ${(e as Error).message}`);
      }

      const created = await prisma.autoTrade.create({
        data: {
          symbol: cand.symbol,
          side: cand.side,
          isPaper: false,
          timeframe: cfg.timeframe,
          strategyName: cand.strategyName,
          confidence: cand.confidence,
          reasons: JSON.stringify(cand.reasons),
          rsiAtEntry: cand.rsi,
          volSpikeAtEntry: cand.volSpike,
          marginUsdt: cfg.marginUsdt,
          leverage: cfg.leverage,
          quantity: qtyNum,
          entryPrice: cand.entryPrice,
          stopLoss: parseFloat(slPriceStr),
          tp1: parseFloat(tp1PriceStr),
          tp2: parseFloat(tp2PriceStr),
          rrRatio: cand.rrRatio,
          status: "OPEN",
          orderId: String(orderRes.orderId ?? ""),
          logs: logLines.join(" | "),
        },
      });

      executed.push(created);
      openCount++;
      openSymbolSet.add(cand.symbol);
    } catch (err) {
      const created = await prisma.autoTrade.create({
        data: {
          symbol: cand.symbol,
          side: cand.side,
          isPaper: false,
          timeframe: cfg.timeframe,
          strategyName: cand.strategyName,
          confidence: cand.confidence,
          reasons: JSON.stringify(cand.reasons),
          rsiAtEntry: cand.rsi,
          volSpikeAtEntry: cand.volSpike,
          marginUsdt: cfg.marginUsdt,
          leverage: cfg.leverage,
          quantity: qtyNum,
          entryPrice: cand.entryPrice,
          stopLoss: cand.stopLoss,
          tp1: cand.tp1,
          tp2: cand.tp2,
          rrRatio: cand.rrRatio,
          status: "ERROR",
          logs: `❌ 주문 실패: ${(err as Error).message}`,
        },
      });
      executed.push(created);
    }
  }

  return {
    executed,
    candidates: candidates.slice(0, 10),
    skippedReason: executed.length
      ? null
      : "조건 충족 종목이 이미 보유 중이거나 쿨타임 이내입니다.",
  };
}
