import crypto from "node:crypto";

const FAPI = "https://fapi.binance.com";
const SAPI = "https://api.binance.com";
const DAY = 86_400_000;

export interface Income {
  symbol: string;
  incomeType: string; // REALIZED_PNL | COMMISSION | FUNDING_FEE ...
  income: string;
  asset: string;
  time: number;
  info: string; // 체결 건은 tradeId
  tranId: number;
  tradeId: string;
}

// 바이낸스 선물 IP 한도: 분당 2400 weight. 여유를 두고 1800에서 스스로 대기한다.
const WEIGHT_BUDGET = 1800;
const spent: { t: number; w: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(weight: number) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].t > 60_000) spent.shift();
    const used = spent.reduce((a, b) => a + b.w, 0);
    if (used + weight <= WEIGHT_BUDGET) break;
    await sleep(Math.max(500, 60_000 - (now - spent[0].t)));
  }
  spent.push({ t: Date.now(), w: weight });
}

async function signedGet<T>(path: string, params: Record<string, string | number>, base = FAPI, weight = 1): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttle(weight);
    try {
      return await signedGetOnce<T>(path, params, base);
    } catch (e) {
      const m = (e as Error).message;
      // 429(한도 초과)면 잠시 쉬었다가 재시도
      if (m.startsWith("Binance 429") && attempt < 4) {
        await sleep(15_000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

async function signedGetOnce<T>(path: string, params: Record<string, string | number>, base = FAPI): Promise<T> {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET 미설정");

  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: "10000",
  }).toString();
  const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");

  const res = await fetch(`${base}${path}?${qs}&signature=${sig}`, {
    headers: { "X-MBX-APIKEY": key },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** /fapi/v1/income — 7일 윈도우 + limit(1000) 페이지네이션 */
export async function fetchIncome(startTime: number, endTime = Date.now()): Promise<Income[]> {
  const out: Income[] = [];
  for (let ws = startTime; ws < endTime; ws += 7 * DAY) {
    const we = Math.min(ws + 7 * DAY - 1, endTime);
    let cursor = ws;
    for (;;) {
      const page = await signedGet<Income[]>("/fapi/v1/income", {
        startTime: cursor,
        endTime: we,
        limit: 1000,
      }, FAPI, 30);
      out.push(...page);
      if (page.length < 1000) break;
      cursor = page[page.length - 1].time + 1;
    }
  }
  return out;
}

const D90 = 90 * DAY;

export interface Deposit {
  id?: string;
  amount: string;
  coin: string;
  network: string;
  status: number; // 1 = 성공
  txId: string;
  insertTime: number;
}

export interface Withdrawal {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  network: string;
  status: number; // 6 = 완료
  txId: string;
  applyTime: string; // "YYYY-MM-DD HH:mm:ss" (UTC)
}

/** /sapi/v1/capital/deposit/hisrec — 요청당 최대 90일 */
export async function fetchDeposits(startTime: number, endTime = Date.now()): Promise<Deposit[]> {
  const out: Deposit[] = [];
  for (let ws = startTime; ws < endTime; ws += D90) {
    out.push(
      ...(await signedGet<Deposit[]>(
        "/sapi/v1/capital/deposit/hisrec",
        { startTime: ws, endTime: Math.min(ws + D90 - 1, endTime), limit: 1000 },
        SAPI,
      )),
    );
  }
  return out;
}

/** /sapi/v1/capital/withdraw/history — 요청당 최대 90일 */
export async function fetchWithdrawals(startTime: number, endTime = Date.now()): Promise<Withdrawal[]> {
  const out: Withdrawal[] = [];
  for (let ws = startTime; ws < endTime; ws += D90) {
    out.push(
      ...(await signedGet<Withdrawal[]>(
        "/sapi/v1/capital/withdraw/history",
        { startTime: ws, endTime: Math.min(ws + D90 - 1, endTime), limit: 1000 },
        SAPI,
      )),
    );
  }
  return out;
}

export interface UserTrade {
  id: number; // tradeId (income.tradeId와 동일)
  orderId: number;
  time: number;
  side: "BUY" | "SELL";
  positionSide: string;
  price: string;
  qty: string;
}

/** /fapi/v1/userTrades — 종목 필수, 7일 윈도우. tradeId → orderId 매핑용 */
export async function fetchUserTrades(symbol: string, startTime: number, endTime = Date.now()): Promise<UserTrade[]> {
  const out: UserTrade[] = [];
  for (let ws = startTime; ws < endTime; ws += 7 * DAY) {
    const we = Math.min(ws + 7 * DAY - 1, endTime);
    let cursor = ws;
    for (;;) {
      const page = await signedGet<UserTrade[]>("/fapi/v1/userTrades", {
        symbol,
        startTime: cursor,
        endTime: we,
        limit: 1000,
      }, FAPI, 5);
      out.push(...page);
      if (page.length < 1000) break;
      cursor = page[page.length - 1].time + 1;
    }
  }
  return out;
}

export interface FuturesOrder {
  orderId: number;
  type: string;
  origType: string; // 사용자가 처음 낸 주문 유형 (STOP_MARKET 등)
  clientOrderId: string;
  time: number;
}

/**
 * /fapi/v1/allOrders — orderId 이상의 주문을 조회 (시간 창 불필요 → 호출 수 최소화).
 * 지정가는 체결 시각보다 훨씬 전에 생성될 수 있어 시간 기준 대신 orderId 기준으로 읽는다.
 */
export async function fetchOrders(symbol: string, fromOrderId: number): Promise<FuturesOrder[]> {
  const out: FuturesOrder[] = [];
  let cursor = fromOrderId;
  for (;;) {
    const page = await signedGet<FuturesOrder[]>("/fapi/v1/allOrders", { symbol, orderId: cursor, limit: 1000 }, FAPI, 5);
    out.push(...page);
    if (page.length < 1000) break;
    cursor = page[page.length - 1].orderId + 1;
  }
  return out;
}

export interface AlgoOrder {
  algoId: number;
  clientAlgoId: string;
  orderType: string; // STOP_MARKET | TAKE_PROFIT_MARKET | TAKE_PROFIT | TRAILING_STOP_MARKET ...
  algoStatus: string; // NEW | FINISHED | CANCELED | EXPIRED ...
  actualOrderId: string; // 트리거돼 실제 주문이 생성된 경우 그 주문 ID
  createTime: number;
}

/**
 * /fapi/v1/allAlgoOrders — 조건주문(스탑/익절/트레일링)은 일반 주문과 별도 "Algo" 서비스에 저장된다.
 * 최신순으로 반환되므로 sinceMs보다 오래된 페이지가 나오면 중단.
 */
export async function fetchAlgoOrders(symbol: string, sinceMs: number): Promise<AlgoOrder[]> {
  const out: AlgoOrder[] = [];
  const limit = 100;
  for (let page = 1; page <= 20; page++) {
    const rows = await signedGet<AlgoOrder[]>("/fapi/v1/allAlgoOrders", { symbol, page, limit }, FAPI, 5);
    out.push(...rows);
    if (rows.length < limit || rows[rows.length - 1].createTime < sinceMs) break;
  }
  return out;
}

const ALGO_METHOD: Record<string, string> = {
  STOP: "STOP",
  STOP_MARKET: "STOP",
  TAKE_PROFIT: "TAKE_PROFIT",
  TAKE_PROFIT_MARKET: "TAKE_PROFIT",
  TRAILING_STOP_MARKET: "TRAILING",
};

/** 주문 방식 분류: MANUAL | STOP | TAKE_PROFIT | TRAILING | CONDITIONAL | LIQUIDATION | ADL | UNKNOWN */
export function classifyOrder(o?: FuturesOrder, algo?: AlgoOrder): string {
  if (!o) return "UNKNOWN";
  const id = o.clientOrderId ?? "";
  if (id.startsWith("autoclose-") || id.startsWith("settlement_autoclose-")) return "LIQUIDATION";
  if (id.startsWith("adl_autoclose")) return "ADL";
  if (algo) return ALGO_METHOD[algo.orderType] ?? "CONDITIONAL";
  if (id.startsWith("stToAg_")) return "CONDITIONAL"; // 조건주문이 트리거돼 생성된 주문의 접두사
  const t = o.origType || o.type;
  if (t in ALGO_METHOD) return ALGO_METHOD[t];
  return "MANUAL";
}
