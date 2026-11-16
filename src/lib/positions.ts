import type { TradeDTO } from "./types";

/** 체결(주문) 행들을 진입 → 청산 단위의 "포지션"으로 묶은 결과 */
export interface Position {
  id: string; // 첫 거래 id
  symbol: string;
  dir: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  partial: boolean; // 동기화 시작일 이전에 진입해 진입 기록이 없는 포지션
  openTime: string;
  closeTime: string | null;
  maxQty: number; // 최대 보유 수량
  qty: number; // 현재 남은 수량 (OPEN일 때)
  entryAvg: number; // 평균 진입가
  exitAvg: number; // 평균 청산가
  pnlUsdt: number;
  feeUsdt: number;
  fundingUsdt: number;
  netUsdt: number;
  netKrw: number;
  roi: number | null; // 명목 금액 대비 수익률(%) — 레버리지 미반영
  trades: TradeDTO[];
}

interface Work extends Position {
  entryCost: number;
  entryQty: number;
  exitCost: number;
  exitQty: number;
}

const newWork = (t: TradeDTO, dir: Position["dir"], partial: boolean): Work => ({
  id: t.id,
  symbol: t.symbol,
  dir,
  status: "OPEN",
  partial,
  openTime: t.time,
  closeTime: null,
  maxQty: 0,
  qty: 0,
  entryAvg: 0,
  exitAvg: 0,
  pnlUsdt: 0,
  feeUsdt: 0,
  fundingUsdt: 0,
  netUsdt: 0,
  netKrw: 0,
  roi: null,
  trades: [],
  entryCost: 0,
  entryQty: 0,
  exitCost: 0,
  exitQty: 0,
});

function addMoney(w: Work, t: TradeDTO) {
  w.pnlUsdt += t.pnlUsdt;
  w.feeUsdt += t.feeUsdt;
  w.fundingUsdt += t.fundingUsdt;
  w.netKrw += t.netKrw;
  w.trades.push(t);
}

function finalize(w: Work): Position {
  const { entryCost, entryQty, exitCost, exitQty, ...p } = w;
  p.entryAvg = entryQty ? entryCost / entryQty : 0;
  p.exitAvg = exitQty ? exitCost / exitQty : 0;
  p.netUsdt = p.pnlUsdt + p.feeUsdt + p.fundingUsdt;
  const basis = p.entryAvg * p.maxQty;
  p.roi = basis && !p.partial ? (p.pnlUsdt / basis) * 100 : null;
  return p;
}

/**
 * 한 종목의 거래를 시간순으로 따라가며 보유 수량을 계산한다.
 * - 수량이 0에서 시작하면 새 포지션, 다시 0이 되면 종료
 * - 반대 방향으로 더 많이 체결되면(스위칭) 남은 수량으로 반대 포지션 시작
 * - 펀딩비는 그 시점에 열려 있던 포지션에 귀속
 */
export function buildPositions(trades: TradeDTO[]): { open: Position[]; closed: Position[] } {
  const bySymbol = new Map<string, TradeDTO[]>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.positionSide === "SHORT" || t.positionSide === "LONG" ? t.positionSide : "BOTH"}`;
    (bySymbol.get(key) ?? bySymbol.set(key, []).get(key)!).push(t);
  }

  const open: Position[] = [];
  const closed: Position[] = [];

  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.time.localeCompare(b.time));
    let cur: Work | null = null;
    let lastPartial: Work | null = null; // 진입 기록 없는 청산 체결이 이어질 때 하나로 합치기용

    for (const t of list) {
      if (t.kind === "FUNDING") {
        if (cur) addMoney(cur, t);
        continue;
      }
      if (!t.side || !t.qty) continue;

      const sign = t.side === "BUY" ? 1 : -1;
      const tradeDir: Position["dir"] = sign > 0 ? "LONG" : "SHORT";
      const eps = 1e-9 * Math.max(1, t.qty);

      if (!cur) {
        if (t.pnlUsdt !== 0) {
          // 진입 기록이 없는데 실현손익이 있음 → 동기화 이전에 열린 포지션의 청산
          const dir: Position["dir"] = sign > 0 ? "SHORT" : "LONG";
          if (!lastPartial || lastPartial.dir !== dir) {
            lastPartial = newWork(t, dir, true);
            closed.push(lastPartial as unknown as Position);
          }
          lastPartial.exitCost += t.qty * t.avgPrice;
          lastPartial.exitQty += t.qty;
          lastPartial.maxQty += t.qty;
          lastPartial.status = "CLOSED";
          lastPartial.closeTime = t.time;
          addMoney(lastPartial, t);
          continue;
        }
        lastPartial = null;
        cur = newWork(t, tradeDir, false);
      }

      if (tradeDir === cur.dir) {
        // 진입 / 추가 진입
        cur.entryCost += t.qty * t.avgPrice;
        cur.entryQty += t.qty;
        cur.qty += t.qty;
        cur.maxQty = Math.max(cur.maxQty, cur.qty);
        addMoney(cur, t);
        continue;
      }

      // 청산 (부분 또는 전체)
      const closeQty = Math.min(t.qty, cur.qty);
      cur.exitCost += closeQty * t.avgPrice;
      cur.exitQty += closeQty;
      cur.qty -= closeQty;
      addMoney(cur, t);

      if (cur.qty <= eps) {
        cur.qty = 0;
        cur.status = "CLOSED";
        cur.closeTime = t.time;
        closed.push(finalize(cur));
        cur = null;

        const rest = t.qty - closeQty;
        if (rest > eps) {
          // 반대 방향으로 스위칭: 남은 수량으로 새 포지션 (손익/수수료는 이전 포지션에 귀속)
          cur = newWork(t, tradeDir, false);
          cur.entryCost = rest * t.avgPrice;
          cur.entryQty = rest;
          cur.qty = rest;
          cur.maxQty = rest;
        }
      }
    }
    if (cur) open.push(finalize(cur));
  }

  // partial 포지션은 push 시점에 finalize되지 않았으므로 여기서 정리
  const done = closed.map((p) => ("entryCost" in p ? finalize(p as Work) : p));
  done.sort((a, b) => (b.closeTime ?? "").localeCompare(a.closeTime ?? ""));
  open.sort((a, b) => b.openTime.localeCompare(a.openTime));
  return { open, closed: done };
}

export function formatDuration(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}
