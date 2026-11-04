import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET /api/trades?month=YYYY-MM (생략 시 전체) */
export async function GET(req: Request) {
  const month = new URL(req.url).searchParams.get("month");
  const trades = await prisma.trade.findMany({
    where: month ? { date: { startsWith: month } } : undefined,
    orderBy: { time: "desc" },
  });
  return NextResponse.json(trades);
}
