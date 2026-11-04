import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchDeposits, fetchIncome, fetchWithdrawals } from "@/lib/binance";
import { getCoinPriceUsdt, getRates, kstDate } from "@/lib/fx";

export const dynamic = "force-dynamic";

interface Row {
  uid: string;
  type: "DEPOSIT" | "WITHDRAW" | "FUTURES_IN" | "FUTURES_OUT";
  coin: string;
  amount: number;
  fee: number;
  network: string;
  status: string;
  txId: string;
  time: number;
}

/** POST /api/sync-transfers — 입금/출금 내역 + 선물 지갑 이체 저장 (멱등) */
export async function POST() {
  try {
    const startDate = process.env.SYNC_START_DATE ?? kstDate(Date.now() - 80 * 86_400_000);
    const start = new Date(`${startDate}T00:00:00+09:00`).getTime();
    const rows: Row[] = [];

    for (const d of await fetchDeposits(start)) {
      rows.push({
        uid: `DEPOSIT-${d.txId}-${d.coin}`,
        type: "DEPOSIT",
        coin: d.coin,
        amount: parseFloat(d.amount),
        fee: 0,
        network: d.network,
        status: d.status === 1 ? "SUCCESS" : `STATUS_${d.status}`,
        txId: d.txId,
        time: d.insertTime,
      });
    }

    for (const w of await fetchWithdrawals(start)) {
      rows.push({
        uid: `WITHDRAW-${w.id}`,
        type: "WITHDRAW",
        coin: w.coin,
        amount: parseFloat(w.amount),
        fee: parseFloat(w.transactionFee),
        network: w.network,
        status: w.status === 6 ? "COMPLETED" : `STATUS_${w.status}`,
        txId: w.txId,
        time: new Date(w.applyTime.replace(" ", "T") + "Z").getTime(), // 바이낸스는 UTC
      });
    }

    // 현물 ↔ 선물 지갑 이체 (선물 계정 기준 입금/출금)
    for (const i of await fetchIncome(start)) {
      if (i.incomeType !== "TRANSFER") continue;
      const amt = parseFloat(i.income);
      rows.push({
        uid: `TRANSFER-${i.tranId}`,
        type: amt >= 0 ? "FUTURES_IN" : "FUTURES_OUT",
        coin: i.asset,
        amount: Math.abs(amt),
        fee: 0,
        network: "",
        status: "SUCCESS",
        txId: "",
        time: i.time,
      });
    }

    const rates = await getRates(rows.map((r) => kstDate(r.time)));
    // 이미 환산된 건은 가격 재조회 생략
    const done = new Map(
      (await prisma.transfer.findMany({ where: { priceUsdt: { not: null } }, select: { uid: true, priceUsdt: true } })).map(
        (t) => [t.uid, t.priceUsdt as number],
      ),
    );

    for (const r of rows) {
      const date = kstDate(r.time);
      const rate = rates.get(date) ?? null;
      let priceUsdt = done.get(r.uid) ?? null;
      if (priceUsdt === null) {
        try {
          priceUsdt = await getCoinPriceUsdt(r.coin, r.time);
        } catch {
          priceUsdt = null;
        }
      }
      const data = {
        type: r.type,
        coin: r.coin,
        amount: r.amount,
        fee: r.fee,
        network: r.network,
        status: r.status,
        txId: r.txId,
        time: new Date(r.time),
        date,
        priceUsdt,
        rate,
        amountKrw: rate && priceUsdt ? r.amount * priceUsdt * rate : null,
      };
      await prisma.transfer.upsert({ where: { uid: r.uid }, update: data, create: { uid: r.uid, ...data } });
    }
    return NextResponse.json({ synced: rows.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
