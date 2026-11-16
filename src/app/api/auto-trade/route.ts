import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getOrCreateBotConfig,
  refreshOpenAutoTrades,
  runAutoTradeTick,
} from "@/lib/autoTrader";

export async function GET() {
  try {
    await refreshOpenAutoTrades().catch(() => {});
    const [config, trades] = await Promise.all([
      getOrCreateBotConfig(),
      prisma.autoTrade.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    return NextResponse.json({ config, trades });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    await getOrCreateBotConfig();
    const updated = await prisma.autoBotConfig.update({
      where: { id: "default" },
      data: {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        paperMode: typeof body.paperMode === "boolean" ? body.paperMode : undefined,
        minConfidence:
          typeof body.minConfidence === "number" ? body.minConfidence : undefined,
        timeframe: typeof body.timeframe === "string" ? body.timeframe : undefined,
        marginUsdt:
          typeof body.marginUsdt === "number" ? body.marginUsdt : undefined,
        leverage: typeof body.leverage === "number" ? body.leverage : undefined,
        marginType:
          typeof body.marginType === "string" ? body.marginType : undefined,
        maxOpenPositions:
          typeof body.maxOpenPositions === "number"
            ? body.maxOpenPositions
            : undefined,
        cooldownMin:
          typeof body.cooldownMin === "number" ? body.cooldownMin : undefined,
        allowLong:
          typeof body.allowLong === "boolean" ? body.allowLong : undefined,
        allowShort:
          typeof body.allowShort === "boolean" ? body.allowShort : undefined,
      },
    });
    return NextResponse.json({ config: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = Boolean(body.force);
    const tickRes = await runAutoTradeTick(force);
    const [config, trades] = await Promise.all([
      getOrCreateBotConfig(),
      prisma.autoTrade.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    return NextResponse.json({
      ...tickRes,
      config,
      trades,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    const action = req.nextUrl.searchParams.get("action") || "delete";
    if (!id) {
      return NextResponse.json({ error: "id 파라미터가 필요합니다." }, { status: 400 });
    }

    if (action === "close") {
      const tr = await prisma.autoTrade.findUnique({ where: { id } });
      if (!tr) {
        return NextResponse.json({ error: "내역을 찾을 수 없습니다." }, { status: 404 });
      }
      await prisma.autoTrade.update({
        where: { id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
        },
      });
    } else {
      await prisma.autoTrade.delete({ where: { id } });
    }

    const trades = await prisma.autoTrade.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return NextResponse.json({ ok: true, trades });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
