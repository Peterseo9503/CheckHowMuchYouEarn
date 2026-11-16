import { NextResponse } from "next/server";
import { fetchOpenPositions } from "@/lib/binance";
import { getRates, kstDate } from "@/lib/fx";

export const dynamic = "force-dynamic";

/** GET /api/positions — 바이낸스에서 현재 진행 중인 포지션을 실시간 조회 (DB 저장 안 함) */
export async function GET() {
  try {
    const today = kstDate(Date.now());
    const [rows, rates] = await Promise.all([fetchOpenPositions(), getRates([today])]);
    const rate = rates.get(today) ?? 0;

    const positions = rows.map((p) => {
      const amt = parseFloat(p.positionAmt);
      const upnl = parseFloat(p.unRealizedProfit);
      const margin = parseFloat(p.initialMargin);
      const notional = Math.abs(parseFloat(p.notional));
      return {
        symbol: p.symbol,
        positionSide: p.positionSide,
        dir: amt > 0 ? "LONG" : "SHORT",
        qty: Math.abs(amt),
        entryPrice: parseFloat(p.entryPrice),
        breakEvenPrice: parseFloat(p.breakEvenPrice),
        markPrice: parseFloat(p.markPrice),
        liquidationPrice: parseFloat(p.liquidationPrice),
        notional,
        margin,
        leverage: margin ? Math.round(notional / margin) : null,
        unrealizedUsdt: upnl,
        unrealizedKrw: upnl * rate,
        roe: margin ? (upnl / margin) * 100 : null, // 증거금 대비 수익률
        updateTime: p.updateTime,
      };
    });
    return NextResponse.json({ rate, positions });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
