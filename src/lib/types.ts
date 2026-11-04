export interface TradeDTO {
  id: string;
  uid: string;
  symbol: string;
  kind: string;
  time: string;
  date: string;
  method: string;
  side: string;
  positionSide: string;
  qty: number;
  avgPrice: number;
  pnlUsdt: number;
  feeUsdt: number;
  fundingUsdt: number;
  rate: number;
  pnlKrw: number;
  feeKrw: number;
  fundingKrw: number;
  netKrw: number;
  tradeReason: string;
  tags: string;
}

export interface TransferDTO {
  id: string;
  uid: string;
  type: "DEPOSIT" | "WITHDRAW" | "FUTURES_IN" | "FUTURES_OUT";
  coin: string;
  amount: number;
  fee: number;
  network: string;
  status: string;
  txId: string;
  time: string;
  date: string;
  priceUsdt: number | null;
  rate: number | null;
  amountKrw: number | null;
}

export const krw = (n: number) => `${n < 0 ? "-" : ""}₩${Math.round(Math.abs(n)).toLocaleString("ko-KR")}`;
export const tone = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "text-neutral-400");

/** 매수/매도 + 실현손익 유무로 롱/숏 진입·청산 라벨 생성 */
export function actionLabel(t: Pick<TradeDTO, "kind" | "side" | "positionSide" | "pnlUsdt">): string {
  if (t.kind === "FUNDING") return "펀딩";
  if (!t.side) return "-";
  const closing = t.pnlUsdt !== 0;
  const long = t.positionSide === "LONG" ? true : t.positionSide === "SHORT" ? false : (t.side === "BUY") !== closing;
  return `${long ? "롱" : "숏"} ${closing ? "청산" : "진입"}`;
}

export const METHOD_LABEL: Record<string, { text: string; cls: string }> = {
  MANUAL: { text: "직접", cls: "bg-sky-500/20 text-sky-300" },
  STOP: { text: "조건·스탑", cls: "bg-amber-500/20 text-amber-300" },
  TAKE_PROFIT: { text: "조건·익절", cls: "bg-amber-500/20 text-amber-300" },
  TRAILING: { text: "조건·트레일링", cls: "bg-amber-500/20 text-amber-300" },
  CONDITIONAL: { text: "조건주문", cls: "bg-amber-500/20 text-amber-300" },
  LIQUIDATION: { text: "강제청산", cls: "bg-rose-500/30 text-rose-300" },
  ADL: { text: "ADL", cls: "bg-rose-500/30 text-rose-300" },
  UNKNOWN: { text: "알 수 없음", cls: "bg-neutral-700 text-neutral-400" },
};
