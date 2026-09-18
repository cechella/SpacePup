import { NextResponse } from 'next/server'
import { getTopBroker } from '@/lib/top-broker'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { accountId, brokerId, symbol: brokerSymbol } = await getTopBroker()
  try {
    const body = await req.json()
    const { symbol = brokerSymbol, actionType, volume, stopLoss, takeProfit, comment = 'RAFI-Dashboard' } = body

    if (!actionType || !volume || !stopLoss) {
      return NextResponse.json({ error: 'actionType, volume e stopLoss são obrigatórios' }, { status: 400 })
    }

    if (actionType !== 'ORDER_TYPE_BUY' && actionType !== 'ORDER_TYPE_SELL') {
      return NextResponse.json({ error: `actionType inválido: ${actionType}` }, { status: 400 })
    }

    const res = await fetch(
      `${BASE}/users/current/accounts/${accountId}/trade`,
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
      broker:     brokerId, // informa qual corretora executou
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
