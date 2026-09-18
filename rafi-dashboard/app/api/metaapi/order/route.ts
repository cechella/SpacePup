import { NextResponse } from 'next/server'
import { getActiveBrokers } from '@/lib/top-broker'
import { logBrokerEvent } from '@/lib/broker-health'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

async function sendOrder(
  accountId: string,
  brokerId: string,
  symbol: string,
  payload: Record<string, unknown>,
) {
  const t0  = Date.now()
  const res = await fetch(
    `${BASE}/users/current/accounts/${accountId}/trade`,
    {
      method:  'POST',
      headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...payload, symbol }),
      signal:  AbortSignal.timeout(8_000),
    }
  )
  const latency = Date.now() - t0

  if (!res.ok) {
    const text = await res.text()
    logBrokerEvent(brokerId, 'order', false, latency, text.slice(0, 200))
    return { brokerId, symbol, ok: false, error: text }
  }

  const result = await res.json()
  logBrokerEvent(brokerId, 'order', true, latency)
  return { brokerId, symbol, ok: true, orderId: result?.orderId, positionId: result?.positionId }
}

export async function POST(req: Request) {
  const brokers = await getActiveBrokers()

  try {
    const body = await req.json()
    const { actionType, volume, stopLoss, takeProfit, comment = 'RAFI-Dashboard' } = body

    if (!actionType || !volume || !stopLoss) {
      return NextResponse.json({ error: 'actionType, volume e stopLoss são obrigatórios' }, { status: 400 })
    }

    if (actionType !== 'ORDER_TYPE_BUY' && actionType !== 'ORDER_TYPE_SELL') {
      return NextResponse.json({ error: `actionType inválido: ${actionType}` }, { status: 400 })
    }

    const payload = { actionType, volume, stopLoss, takeProfit, comment }

    // Envia para todas as corretoras ativas em paralelo
    const results = await Promise.allSettled(
      brokers.map(b => sendOrder(b.accountId, b.brokerId, b.symbol, payload))
    )

    const parsed = results.map(r =>
      r.status === 'fulfilled' ? r.value : { brokerId: '?', symbol: '?', ok: false, error: String((r as PromiseRejectedResult).reason) }
    )

    const primary   = parsed[0]
    const allOk     = parsed.every(r => r.ok)
    const anyOk     = parsed.some(r => r.ok)

    if (!anyOk) {
      return NextResponse.json({ error: 'Nenhuma corretora executou a ordem', details: parsed }, { status: 500 })
    }

    return NextResponse.json({
      direction:  actionType === 'ORDER_TYPE_BUY' ? 'buy' : 'sell',
      volume,
      stopLoss,
      takeProfit,
      // corretora principal (rank #1)
      broker:     primary.ok ? primary.brokerId : parsed.find(r => r.ok)?.brokerId,
      orderId:    primary.ok ? (primary as any).orderId    : undefined,
      positionId: primary.ok ? (primary as any).positionId : undefined,
      // resultado de todas as corretoras
      replication: parsed,
      allReplicated: allOk,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
