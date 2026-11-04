import { prisma } from "@/lib/prisma";
import Journal from "@/components/Journal";
import type { TransferDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Page() {
  const trades = await prisma.trade.findMany({ orderBy: { time: "desc" } });
  // Date 객체는 클라이언트 컴포넌트로 넘길 때 직렬화
  const initial = trades.map((t) => ({
    ...t,
    time: t.time.toISOString(),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
  const transfers = (await prisma.transfer.findMany({ orderBy: { time: "desc" } })).map((t) => ({
    ...t,
    time: t.time.toISOString(),
    createdAt: t.createdAt.toISOString(),
  }));
  return <Journal initialTrades={initial} initialTransfers={transfers as TransferDTO[]} />;
}
