import { NextResponse } from 'next/server'

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { direction, symbol = 'EURUSD', lot, stopLossPips, takeProfitPips, comment = 'RAFI-Dashboard' } = body

    // Busca preço atual
    const priceRes = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/symbols/${symbol}/current-price?keepSubscription=false`,
      { headers: { 'auth-token': TOKEN } }
    )
    if (!priceRes.ok) throw new Error('Não foi possível obter preço atual')
    const price = await priceRes.json()

    const isBuy = direction === 'buy'
    const entry = isBuy ? price.ask : price.bid
    const pipSize = 0.0001

    const sl = isBuy
      ? +(entry - stopLossPips * pipSize).toFixed(5)
      : +(entry + stopLossPips * pipSize).toFixed(5)

    const tp = isBuy
      ? +(entry + takeProfitPips * pipSize).toFixed(5)
      : +(entry - takeProfitPips * pipSize).toFixed(5)

    // Validação crítica: nunca sem stop-loss
    if (!sl || sl <= 0) {
      return NextResponse.json({ error: 'Stop-loss obrigatório' }, { status: 400 })
    }

    const orderPayload = {
      actionType: 'ORDER_TYPE_BUY' === (isBuy ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL')
        ? 'ORDER_TYPE_BUY'
        : 'ORDER_TYPE_SELL',
      symbol,
      volume: lot,
      stopLoss: sl,
      takeProfit: tp,
      comment,
    }

    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/trade`,
      {
        method: 'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      }
    )

    const result = await res.json()
    if (!res.ok) return NextResponse.json({ error: result }, { status: res.status })

    return NextResponse.json({
      orderId: result.orderId,
      entry,
      sl,
      tp,
      direction,
      lot,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
