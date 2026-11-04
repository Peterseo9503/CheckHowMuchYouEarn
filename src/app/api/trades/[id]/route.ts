import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const { id } = await params;
  const trade = await prisma.trade.findUnique({ where: { id } });
  return trade ? NextResponse.json(trade) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** PATCH — 매매 근거(마크다운)와 태그 저장/수정 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? "").split(",");
  try {
    const trade = await prisma.trade.update({
      where: { id },
      data: {
        tradeReason: String(body.tradeReason ?? ""),
        tags: [...new Set(tags.map((t: string) => t.trim()).filter(Boolean))].join(","),
      },
    });
    return NextResponse.json(trade);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

/** DELETE — 거래 자체가 아닌 일지(메모/태그)만 초기화 */
export async function DELETE(_: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    await prisma.trade.update({ where: { id }, data: { tradeReason: "", tags: "" } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
