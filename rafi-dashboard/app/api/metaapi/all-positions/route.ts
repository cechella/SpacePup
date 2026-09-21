import { NextResponse } from 'next/server'
import { getActiveBrokers } from '@/lib/top-broker'
import { logBrokerEvent } from '@/lib/broker-health'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

export async function GET() {
  const brokers = await getActiveBrokers()

  const results = await Promise.allSettled(
    brokers.map(async (b, idx) => {
      const t0  = Date.now()
      const res = await fetch(
        `${BASE}/users/current/accounts/${b.accountId}/positions`,
        { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
      )
      logBrokerEvent(b.brokerId, 'positions', res.ok, Date.now() - t0, res.ok ? undefined : String(res.status))

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        return { rank: idx + 1, brokerId: b.brokerId, nome: b.nome, symbol: b.symbol, positions: [], totalPnl: 0, error: res.status, errorDetail: errBody.slice(0, 200) }
      }

      const raw = await res.json()
      const positions = (Array.isArray(raw) ? raw : []).map((p: any) => ({
        id:           p.id,
        symbol:       p.symbol,
        type:         p.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
        volume:       p.volume,
        openPrice:    p.openPrice,
        currentPrice: p.currentPrice,
        profit:       p.profit ?? 0,
        commission:   p.commission ?? 0,
        swap:         p.swap ?? 0,
        stopLoss:     p.stopLoss,
        takeProfit:   p.takeProfit,
        openTime:     p.time,
      }))

      const totalPnl = positions.reduce((s: number, p: any) => s + (p.profit ?? 0), 0)

      return { rank: idx + 1, brokerId: b.brokerId, nome: b.nome, symbol: b.symbol, positions, totalPnl }
    })
  )

  const data = results.map((r, idx) =>
    r.status === 'fulfilled'
      ? r.value
      : { rank: idx + 1, brokerId: brokers[idx]?.brokerId ?? '?', nome: brokers[idx]?.nome ?? '?', symbol: brokers[idx]?.symbol ?? 'EURUSD', positions: [], totalPnl: 0, error: 'timeout' }
  )

  return NextResponse.json({ brokers: data, updatedAt: new Date().toISOString() })
}
