import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyOrder, fetchAlgoOrders, fetchIncome, fetchOrders, fetchUserTrades, type AlgoOrder, type FuturesOrder, type UserTrade } from "@/lib/binance";
import { getRates, kstDate } from "@/lib/fx";

export const dynamic = "force-dynamic";

interface Group {
  uid: string;
  symbol: string;
  kind: "TRADE" | "FUNDING";
  time: number;
  pnl: number;
  fee: number;
  funding: number;
  method: string;
  side: string;
  positionSide: string;
  qty: number;
  notional: number;
  legacyUids: Set<string>; // 체결(tradeId) 단위로 저장되던 예전 uid
}

/** POST /api/sync — 바이낸스 income 수집 → 환율 적용 → upsert (메모 필드는 보존) */
export async function POST(req: Request) {
  let full = new URL(req.url).searchParams.get("full") === "1"; // 전체 재동기화 (SYNC_START_DATE부터)
  try {
    // 매수/매도 정보가 비어 있는 예전 거래가 있으면 자동으로 전체 재동기화
    if (!full && (await prisma.trade.count({ where: { kind: "TRADE", method: "" } })) > 0) full = true;

    // 마지막 저장일의 KST 0시부터 다시 받아 부분 그룹 방지 (upsert라 중복 안전)
    const last = await prisma.trade.findFirst({ orderBy: { time: "desc" }, select: { date: true } });
    const startDate = (!full && last?.date) || (process.env.SYNC_START_DATE ?? kstDate(Date.now() - 80 * 86_400_000));
    const start = new Date(`${startDate}T00:00:00+09:00`).getTime();

    const incomes = await fetchIncome(start);

    // 체결(tradeId) → 주문(orderId) 매핑: 한 주문이 여러 번 나뉘어 체결돼도 하나로 합치기 위함
    // 거래가 있었던 시점 주변(7일 창)만 조회해 API 호출 수를 줄인다.
    const fillOf = new Map<string, UserTrade>();
    const orderInfo = new Map<string, FuturesOrder>();
    const algoByOrder = new Map<string, AlgoOrder>(); // `${symbol}-${orderId 또는 clientId}`
    const timesBySymbol = new Map<string, number[]>();
    for (const i of incomes) {
      if (!i.tradeId || !i.symbol) continue;
      (timesBySymbol.get(i.symbol) ?? timesBySymbol.set(i.symbol, []).get(i.symbol)!).push(i.time);
    }
    const DAY = 86_400_000;
    for (const [symbol, times] of timesBySymbol) {
      times.sort((a, b) => a - b);
      // 각 손익 발생 시점의 앞 7일 ~ 뒤 1일을 합쳐 조회 (수수료 0원 진입 체결까지 잡기 위함)
      // 마지막 구간은 현재까지 연장 → 아직 청산 안 된 포지션의 진입 체결 포함
      const ranges: [number, number][] = [];
      for (const t of times) {
        const a = Math.max(start, t - 7 * DAY);
        const b = t + DAY;
        const lastR = ranges[ranges.length - 1];
        if (lastR && a <= lastR[1]) lastR[1] = Math.max(lastR[1], b);
        else ranges.push([a, b]);
      }
      ranges[ranges.length - 1][1] = Date.now();
      for (const [a, b] of ranges) {
        for (const f of await fetchUserTrades(symbol, a, Math.min(b, Date.now()))) {
          fillOf.set(`${symbol}-${f.id}`, f);
        }
      }
      const orderIds = [...fillOf.entries()].filter(([k]) => k.startsWith(`${symbol}-`)).map(([, f]) => f.orderId);
      if (orderIds.length) {
        for (const o of await fetchOrders(symbol, Math.min(...orderIds))) orderInfo.set(`${symbol}-${o.orderId}`, o);
        // 조건주문(Algo) 중 실제로 트리거된 것만 주문과 연결
        for (const a of await fetchAlgoOrders(symbol, Math.min(...times) - 30 * 86_400_000)) {
          if (a.actualOrderId) algoByOrder.set(`${symbol}-${a.actualOrderId}`, a);
          algoByOrder.set(`${symbol}-${a.clientAlgoId}`, a);
        }
      }
    }
    const groups = new Map<string, Group>();

    for (const i of incomes) {
      const amt = parseFloat(i.income);
      let uid: string, kind: Group["kind"], legacy: string | null = null, fill: UserTrade | undefined;
      if (i.incomeType === "REALIZED_PNL" || i.incomeType === "COMMISSION") {
        const fillId = `${i.symbol}-${i.tradeId || i.info}`;
        fill = fillOf.get(fillId);
        const orderId = fill?.orderId;
        uid = orderId ? `${i.symbol}-order-${orderId}` : fillId;
        legacy = fillId;
        kind = "TRADE";
      } else if (i.incomeType === "FUNDING_FEE") {
        uid = `FUNDING-${i.tranId}`;
        kind = "FUNDING";
      } else continue; // 이체, 리워드 등 제외

      const g =
        groups.get(uid) ?? { uid, symbol: i.symbol, kind, time: i.time, pnl: 0, fee: 0, funding: 0, method: "", side: "", positionSide: "", qty: 0, notional: 0, legacyUids: new Set<string>() };
      if (legacy && !g.legacyUids.has(legacy)) {
        // 같은 체결의 PnL/수수료 행이 둘 다 오므로 체결당 한 번만 수량 합산
        g.legacyUids.add(legacy);
        if (fill) {
          g.method = classifyOrder(...(() => {
            const o = orderInfo.get(`${i.symbol}-${fill.orderId}`);
            return [o, algoByOrder.get(`${i.symbol}-${fill.orderId}`) ?? (o && algoByOrder.get(`${i.symbol}-${o.clientOrderId}`))] as const;
          })());
          g.side = fill.side;
          g.positionSide = fill.positionSide;
          g.qty += parseFloat(fill.qty);
          g.notional += parseFloat(fill.qty) * parseFloat(fill.price);
        }
      }
      g.time = Math.max(g.time, i.time);
      if (i.incomeType === "REALIZED_PNL") g.pnl += amt;
      else if (i.incomeType === "COMMISSION") g.fee += amt;
      else g.funding += amt;
      groups.set(uid, g);
    }

    // income 기록이 없는 체결(수수료 0원 지정가 진입 등)도 포함해야 포지션 수량이 맞는다
    const referenced = new Set<string>();
    for (const g of groups.values()) g.legacyUids.forEach((k) => referenced.add(k));
    for (const [fillId, f] of fillOf) {
      if (referenced.has(fillId) || f.time < start) continue;
      const symbol = fillId.slice(0, fillId.lastIndexOf("-"));
      const uid = `${symbol}-order-${f.orderId}`;
      const g =
        groups.get(uid) ?? { uid, symbol, kind: "TRADE" as const, time: f.time, pnl: 0, fee: 0, funding: 0, method: "", side: "", positionSide: "", qty: 0, notional: 0, legacyUids: new Set<string>() };
      const o = orderInfo.get(`${symbol}-${f.orderId}`);
      g.method = classifyOrder(o, algoByOrder.get(`${symbol}-${f.orderId}`) ?? (o && algoByOrder.get(`${symbol}-${o.clientOrderId}`)));
      g.side = f.side;
      g.positionSide = f.positionSide;
      g.qty += parseFloat(f.qty);
      g.notional += parseFloat(f.qty) * parseFloat(f.price);
      g.pnl += parseFloat(f.realizedPnl);
      if (f.commissionAsset === "USDT" || f.commissionAsset === "USDC") g.fee -= parseFloat(f.commission);
      g.time = Math.max(g.time, f.time);
      g.legacyUids.add(fillId);
      groups.set(uid, g);
    }

    const rates = await getRates([...groups.values()].map((g) => kstDate(g.time)));

    let count = 0;
    for (const g of groups.values()) {
      const date = kstDate(g.time);
      const rate = rates.get(date)!;
      const data = {
        symbol: g.symbol,
        kind: g.kind,
        time: new Date(g.time),
        date,
        method: g.kind === "TRADE" ? g.method || "UNKNOWN" : "",
        side: g.side,
        positionSide: g.positionSide,
        qty: g.qty,
        avgPrice: g.qty ? g.notional / g.qty : 0,
        pnlUsdt: g.pnl,
        feeUsdt: g.fee,
        fundingUsdt: g.funding,
        rate,
        pnlKrw: g.pnl * rate,
        feeKrw: g.fee * rate,
        fundingKrw: g.funding * rate,
        netKrw: (g.pnl + g.fee + g.funding) * rate,
      };

      // 예전 체결 단위 행이 있으면 메모를 이어받고 삭제 (중복 방지)
      let memo = { tradeReason: "", tags: "" };
      if (g.legacyUids.size) {
        const old = await prisma.trade.findMany({ where: { uid: { in: [...g.legacyUids] } } });
        memo = {
          tradeReason: old.map((o) => o.tradeReason).find(Boolean) ?? "",
          tags: old.map((o) => o.tags).find(Boolean) ?? "",
        };
        if (old.length) await prisma.trade.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      }
      const existing = await prisma.trade.findUnique({ where: { uid: g.uid }, select: { id: true } });
      if (existing) await prisma.trade.update({ where: { uid: g.uid }, data });
      else await prisma.trade.create({ data: { uid: g.uid, ...data, ...memo } });
      count++;
    }
    return NextResponse.json({ synced: count });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
