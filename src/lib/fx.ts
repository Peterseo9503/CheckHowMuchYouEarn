import { prisma } from "./prisma";

export const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * Yahoo Finance(KRW=X) 일봉 종가로 USD/KRW 확보 후 DB 캐시.
 * 주말/휴일 등 데이터 없는 날은 직전 영업일 환율 사용.
 * (한국수출입은행 API를 쓰려면 이 함수만 교체하면 됨)
 */
export async function getRates(dates: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const unique = [...new Set(dates)].sort();
  if (!unique.length) return result;

  const cached = await prisma.exchangeRate.findMany({ where: { date: { in: unique } } });
  cached.forEach((c) => result.set(c.date, c.rate));
  const missing = unique.filter((d) => !result.has(d));

  if (missing.length) {
    const p1 = Math.floor(new Date(missing[0]).getTime() / 1000) - 7 * 86400; // 직전 영업일 확보용 여유
    const p2 = Math.floor(Date.now() / 1000) + 86400;
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?period1=${p1}&period2=${p2}&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`환율 조회 실패: ${res.status}`);
    const json = await res.json();
    const r = json.chart.result[0];
    const closes: (number | null)[] = r.indicators.quote[0].close;
    const series = new Map<string, number>();
    (r.timestamp as number[]).forEach((t, i) => {
      if (closes[i]) series.set(new Date(t * 1000).toISOString().slice(0, 10), closes[i]!);
    });
    const days = [...series.keys()].sort();

    for (const d of missing) {
      const prev = days.filter((x) => x <= d).pop() ?? days[0];
      const rate = series.get(prev)!;
      result.set(d, rate);
      await prisma.exchangeRate.upsert({ where: { date: d }, update: { rate }, create: { date: d, rate } });
    }
  }
  return result;
}

const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD"]);

/**
 * 특정 시각의 코인 USDT 가격 (바이낸스 현물 1분봉 시가, 공개 API).
 * 스테이블코인은 1, 상장 페어가 없으면 null.
 */
export async function getCoinPriceUsdt(coin: string, timeMs: number): Promise<number | null> {
  if (STABLE.has(coin)) return 1;
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&startTime=${timeMs}&limit=1`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  const k = (await res.json()) as string[][];
  return k.length ? parseFloat(k[0][1]) : null;
}
