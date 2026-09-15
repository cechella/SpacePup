import { NextResponse } from 'next/server'

const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime = 'edge'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { symbol = 'EURUSD', actionType, volume, stopLoss, takeProfit, comment = 'RAFI-Dashboard' } = body

    if (!actionType || !volume || !stopLoss) {
      return NextResponse.json({ error: 'actionType, volume e stopLoss são obrigatórios' }, { status: 400 })
    }

    if (actionType !== 'ORDER_TYPE_BUY' && actionType !== 'ORDER_TYPE_SELL') {
      return NextResponse.json({ error: `actionType inválido: ${actionType}` }, { status: 400 })
    }

    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/trade`,
      {
        method:  'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ actionType, symbol, volume, stopLoss, takeProfit, comment }),
        signal:  AbortSignal.timeout(8_000),
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    const result = await res.json()

    return NextResponse.json({
      orderId:    result?.orderId,
      positionId: result?.positionId,
      direction:  actionType === 'ORDER_TYPE_BUY' ? 'buy' : 'sell',
      symbol,
      volume,
      stopLoss,
      takeProfit,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
