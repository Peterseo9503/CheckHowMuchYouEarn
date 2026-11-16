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
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
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

export interface PositionRisk {
  symbol: string;
  positionSide: string; // BOTH | LONG | SHORT
  positionAmt: string; // 양수 = 롱, 음수 = 숏
  entryPrice: string;
  breakEvenPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  notional: string;
  initialMargin: string;
  marginType?: string;
  updateTime: number;
}

/** /fapi/v3/positionRisk — 현재 보유 중인 포지션 (수량 0 제외) */
export async function fetchOpenPositions(): Promise<PositionRisk[]> {
  const rows = await signedGet<PositionRisk[]>("/fapi/v3/positionRisk", {}, FAPI, 5);
  return rows.filter((p) => parseFloat(p.positionAmt) !== 0);
}

/** 서명된 POST 요청 (선물 주문 / 레버리지 / 마진모드 변경용) */
export async function signedPost<T>(
  path: string,
  params: Record<string, string | number | boolean>,
  base = FAPI,
  weight = 1
): Promise<T> {
  await throttle(weight);
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
    method: "POST",
    headers: { "X-MBX-APIKEY": key },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface FuturesBalanceRow {
  asset: string;
  balance: string;
  availableBalance: string;
  crossUnPnl: string;
}

/** 선물 계좌 USDT 잔고 및 주문 가능(availableBalance) 조회 */
export async function fetchFuturesUsdtBalance(): Promise<{
  balance: number;
  availableBalance: number;
}> {
  const rows = await signedGet<FuturesBalanceRow[]>("/fapi/v2/balance", {}, FAPI, 5);
  const usdt = rows.find((r) => r.asset === "USDT");
  return {
    balance: usdt ? parseFloat(usdt.balance) : 0,
    availableBalance: usdt ? parseFloat(usdt.availableBalance) : 0,
  };
}

/** 양방향(Hedge) 모드 여부 조회 (true = LONG/SHORT 분리, false = 단방향 BOTH) */
export async function fetchDualSidePosition(): Promise<boolean> {
  const res = await signedGet<{ dualSidePosition: boolean }>(
    "/fapi/v1/positionSide/dual",
    {},
    FAPI,
    30
  );
  return Boolean(res.dualSidePosition);
}

export interface SymbolPrecisionRule {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

let cachedRulesMap: Map<string, SymbolPrecisionRule> | null = null;
let cachedRulesAt = 0;

/** /fapi/v1/exchangeInfo 기반 심볼별 호가단위(tickSize) 및 수량단위(stepSize) 조회 (10분 캐시) */
export async function fetchSymbolRule(symbol: string): Promise<SymbolPrecisionRule> {
  const now = Date.now();
  if (!cachedRulesMap || now - cachedRulesAt > 600_000) {
    const res = await fetch(`${FAPI}/fapi/v1/exchangeInfo`, { cache: "no-store" });
    if (!res.ok) throw new Error(`exchangeInfo 조회 실패 (${res.status})`);
    const data = (await res.json()) as {
      symbols: {
        symbol: string;
        pricePrecision: number;
        quantityPrecision: number;
        filters: Record<string, string>[];
      }[];
    };
    const map = new Map<string, SymbolPrecisionRule>();
    for (const s of data.symbols) {
      const pf = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lf = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const mf = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
      map.set(s.symbol, {
        symbol: s.symbol,
        tickSize: pf ? parseFloat(pf.tickSize) : 0.0001,
        stepSize: lf ? parseFloat(lf.stepSize) : 0.001,
        minQty: lf ? parseFloat(lf.minQty) : 0.001,
        minNotional: mf ? parseFloat(mf.notional) : 5,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      });
    }
    cachedRulesMap = map;
    cachedRulesAt = now;
  }
  return (
    cachedRulesMap.get(symbol) ?? {
      symbol,
      tickSize: 0.0001,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5,
      pricePrecision: 4,
      quantityPrecision: 3,
    }
  );
}

/** stepSize / tickSize 단위에 맞춰 안전하게 숫자 문자열 포맷 */
export function roundToStep(value: number, step: number, mode: "floor" | "round" = "round"): string {
  if (!step || step <= 0) return String(value);
  const inv = Math.round(1 / step);
  const scaled = value * inv;
  const snapped = (mode === "floor" ? Math.floor(scaled + 1e-9) : Math.round(scaled)) / inv;
  const stepStr = step.toFixed(10).replace(/0+$/, "");
  const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  return snapped.toFixed(decimals);
}

/** 마진 모드 변경 (ISOLATED | CROSSED). 이미 해당 모드인 경우(-4046) 무시 */
export async function setFuturesMarginType(
  symbol: string,
  marginType: "ISOLATED" | "CROSSED"
): Promise<void> {
  try {
    await signedPost("/fapi/v1/marginType", { symbol, marginType });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("-4046")) return; // "No need to change margin type."
    throw e;
  }
}

/** 레버리지 변경 (1 ~ 125) */
export async function setFuturesLeverage(symbol: string, leverage: number): Promise<void> {
  await signedPost("/fapi/v1/leverage", { symbol, leverage });
}

/** 조건부 익절/손절(STOP_MARKET / TAKE_PROFIT_MARKET) 등록 — 일반 엔드포인트 실패 시 Algo 엔드포인트 자동 폴백 */
export async function placeConditionalOrder(params: {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "BOTH" | "LONG" | "SHORT";
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  stopPrice: string;
  quantity?: string;
  closePosition?: boolean;
}): Promise<Record<string, unknown>> {
  const baseParams: Record<string, string | number | boolean> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    stopPrice: params.stopPrice,
    workingType: "MARK_PRICE",
  };
  if (params.closePosition) {
    baseParams.closePosition = "true";
  } else if (params.quantity) {
    baseParams.quantity = params.quantity;
    if (params.positionSide === "BOTH") {
      baseParams.reduceOnly = "true";
    }
  }

  try {
    return await signedPost<Record<string, unknown>>("/fapi/v1/order", baseParams);
  } catch (e) {
    const msg = (e as Error).message;
    // 계정이 Algo Order 서비스 전용으로 라우팅되는 경우 /fapi/v1/algoOrder 로 폴백
    if (msg.includes("-4120") || msg.includes("algoOrder") || msg.includes("Algo")) {
      const algoParams: Record<string, string | number | boolean> = {
        algoType: "CONDITIONAL",
        symbol: params.symbol,
        side: params.side,
        positionSide: params.positionSide,
        type: params.type,
        triggerPrice: params.stopPrice,
        workingType: "MARK_PRICE",
      };
      if (params.closePosition) {
        algoParams.closePosition = "true";
      } else if (params.quantity) {
        algoParams.quantity = params.quantity;
        if (params.positionSide === "BOTH") {
          algoParams.reduceOnly = "true";
        }
      }
      return await signedPost<Record<string, unknown>>("/fapi/v1/algoOrder", algoParams);
    }
    throw e;
  }
}
