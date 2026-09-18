import { NextResponse } from 'next/server'
import { getTopBrokerAccountId } from '@/lib/top-broker'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

export async function GET() {
  const ACCOUNT = await getTopBrokerAccountId()
  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/positions`,
      { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    const raw = await res.json()
    const positions = (Array.isArray(raw) ? raw : []).map((p: any) => ({
      id:           p.id,
      symbol:       p.symbol,
      type:         p.type,
      volume:       p.volume,
      openPrice:    p.openPrice,
      currentPrice: p.currentPrice,
      profit:       p.profit ?? 0,
      stopLoss:     p.stopLoss,
      takeProfit:   p.takeProfit,
      openTime:     p.time,
      comment:      p.comment,
    }))

    return NextResponse.json({ positions })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const ACCOUNT = await getTopBrokerAccountId()
  try {
    const { positionId } = await req.json()
    if (!positionId) return NextResponse.json({ error: 'positionId obrigatório' }, { status: 400 })

    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/trade`,
      {
        method:  'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId, comment: 'manual-close' }),
        signal:  AbortSignal.timeout(8_000),
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
