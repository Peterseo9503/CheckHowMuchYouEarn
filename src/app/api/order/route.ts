import { NextRequest, NextResponse } from "next/server";
import {
  fetchDualSidePosition,
  fetchFuturesUsdtBalance,
  fetchSymbolRule,
  placeConditionalOrder,
  roundToStep,
  setFuturesLeverage,
  setFuturesMarginType,
  signedPost,
} from "@/lib/binance";

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol") || "BTCUSDT";
    const [bal, rule, dualSide] = await Promise.all([
      fetchFuturesUsdtBalance(),
      fetchSymbolRule(symbol),
      fetchDualSidePosition().catch(() => false),
    ]);
    return NextResponse.json({
      symbol,
      balance: bal.balance,
      availableBalance: bal.availableBalance,
      dualSidePosition: dualSide,
      rule,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

interface OrderBody {
  symbol: string;
  side: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT";
  leverage: number;
  marginType: "ISOLATED" | "CROSSED";
  marginUsdt: number; // 투입 증거금 (USDT)
  entryPrice: number; // 시장가일 때는 수량 계산 기준가, 지정가일 때는 실제 주문가
  enableSl: boolean;
  stopLoss?: number;
  enableTp1: boolean;
  tp1?: number;
  tp1RatioPct?: number; // 기본 50% 분할 익절 (TP2 미사용 시 100%)
  enableTp2: boolean;
  tp2?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OrderBody;
    const {
      symbol,
      side,
      orderType,
      leverage,
      marginType,
      marginUsdt,
      entryPrice,
      enableSl,
      stopLoss,
      enableTp1,
      tp1,
      tp1RatioPct = 50,
      enableTp2,
      tp2,
    } = body;

    if (!symbol || !side || !entryPrice || marginUsdt <= 0) {
      return NextResponse.json(
        { error: "필수 주문 파라미터(종목, 방향, 진입가, 증거금)가 누락되었습니다." },
        { status: 400 }
      );
    }

    // 1) 심볼 정밀도(stepSize / tickSize) 및 양방향(Hedge) 모드 조회
    const [rule, dualSide] = await Promise.all([
      fetchSymbolRule(symbol),
      fetchDualSidePosition().catch(() => false),
    ]);

    const notional = marginUsdt * leverage;
    const rawQty = notional / entryPrice;
    const qtyStr = roundToStep(rawQty, rule.stepSize, "floor");
    const qtyNum = parseFloat(qtyStr);

    if (qtyNum < rule.minQty || qtyNum * entryPrice < rule.minNotional) {
      return NextResponse.json(
        {
          error: `최소 주문 수량 미달: 계산된 수량 ${qtyStr} (최소 수량 ${rule.minQty}, 최소 주문금액 $${rule.minNotional} USDT 이상 필요)`,
        },
        { status: 400 }
      );
    }

    // 2) 마진 모드 & 레버리지 설정
    await setFuturesMarginType(symbol, marginType);
    await setFuturesLeverage(symbol, leverage);

    const entryOrderSide: "BUY" | "SELL" = side === "LONG" ? "BUY" : "SELL";
    const exitOrderSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
    const positionSide: "BOTH" | "LONG" | "SHORT" = dualSide ? side : "BOTH";

    // 3) 본 진입 주문 전송 (MARKET 또는 LIMIT)
    const entryParams: Record<string, string | number> = {
      symbol,
      side: entryOrderSide,
      positionSide,
      type: orderType,
      quantity: qtyStr,
    };

    if (orderType === "LIMIT") {
      entryParams.price = roundToStep(entryPrice, rule.tickSize, "round");
      entryParams.timeInForce = "GTC";
    }

    const entryResult = await signedPost<Record<string, unknown>>(
      "/fapi/v1/order",
      entryParams
    );

    const logs: string[] = [
      `✅ [${symbol}] ${side} ${orderType} 진입 주문 완료 (수량: ${qtyStr}, 레버리지: ${leverage}x)`,
    ];

    // 4) 손절 주문 (SL - STOP_MARKET, 전량 청산 closePosition=true)
    if (enableSl && stopLoss && stopLoss > 0) {
      const slPriceStr = roundToStep(stopLoss, rule.tickSize, "round");
      try {
        await placeConditionalOrder({
          symbol,
          side: exitOrderSide,
          positionSide,
          type: "STOP_MARKET",
          stopPrice: slPriceStr,
          closePosition: true,
        });
        logs.push(`🛑 손절(SL) 예약 완료: $${slPriceStr} (전량 청산)`);
      } catch (slErr) {
        logs.push(`⚠️ 손절(SL) 등록 실패: ${(slErr as Error).message}`);
      }
    }

    // 5) 1차 익절 주문 (TP1)
    if (enableTp1 && tp1 && tp1 > 0) {
      const tp1PriceStr = roundToStep(tp1, rule.tickSize, "round");
      // TP2도 함께 켜져 있으면 분할 수량(예: 50%), TP1만 켜져 있으면 전량 청산
      if (enableTp2 && tp2 && tp2 > 0) {
        const halfQtyStr = roundToStep(
          qtyNum * (tp1RatioPct / 100),
          rule.stepSize,
          "floor"
        );
        const halfQtyNum = parseFloat(halfQtyStr);
        if (halfQtyNum >= rule.minQty) {
          try {
            await placeConditionalOrder({
              symbol,
              side: exitOrderSide,
              positionSide,
              type: "TAKE_PROFIT_MARKET",
              stopPrice: tp1PriceStr,
              quantity: halfQtyStr,
              closePosition: false,
            });
            logs.push(
              `💰 1차 익절(TP1) 예약 완료: $${tp1PriceStr} (수량 ${halfQtyStr}, ${tp1RatioPct}% 분할익절)`
            );
          } catch (tp1Err) {
            logs.push(`⚠️ 1차 익절(TP1) 등록 실패: ${(tp1Err as Error).message}`);
          }
        } else {
          logs.push(
            `ℹ️ 주문 수량(${qtyStr})이 작아 TP1 분할 수량이 최소단위 미만이므로 TP2 전량 익절만 등록합니다.`
          );
        }
      } else {
        try {
          await placeConditionalOrder({
            symbol,
            side: exitOrderSide,
            positionSide,
            type: "TAKE_PROFIT_MARKET",
            stopPrice: tp1PriceStr,
            closePosition: true,
          });
          logs.push(`💰 익절(TP1) 예약 완료: $${tp1PriceStr} (전량 익절)`);
        } catch (tp1Err) {
          logs.push(`⚠️ 익절(TP1) 등록 실패: ${(tp1Err as Error).message}`);
        }
      }
    }

    // 6) 2차 최종 익절 주문 (TP2 - 잔여 전량 청산 closePosition=true)
    if (enableTp2 && tp2 && tp2 > 0) {
      const tp2PriceStr = roundToStep(tp2, rule.tickSize, "round");
      try {
        await placeConditionalOrder({
          symbol,
          side: exitOrderSide,
          positionSide,
          type: "TAKE_PROFIT_MARKET",
          stopPrice: tp2PriceStr,
          closePosition: true,
        });
        logs.push(`🚀 2차 목표(TP2) 예약 완료: $${tp2PriceStr} (잔여 전량 익절)`);
      } catch (tp2Err) {
        logs.push(`⚠️ 2차 익절(TP2) 등록 실패: ${(tp2Err as Error).message}`);
      }
    }

    return NextResponse.json({
      ok: true,
      orderId: entryResult.orderId,
      quantity: qtyStr,
      logs,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
