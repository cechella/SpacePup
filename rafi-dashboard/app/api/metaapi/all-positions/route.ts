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
      // Busca posições e saldo em paralelo para validação equity vs balance
      const [posRes, accRes] = await Promise.allSettled([
        fetch(
          `${BASE}/users/current/accounts/${b.accountId}/positions`,
          { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
        ),
        fetch(
          `${BASE}/users/current/accounts/${b.accountId}/accountInformation`,
          { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
        ),
      ])

      const res = posRes.status === 'fulfilled' ? posRes.value : null
      logBrokerEvent(b.brokerId, 'positions', !!res?.ok, Date.now() - t0, res?.ok ? undefined : String(res?.status ?? 'error'))

      if (!res?.ok) {
        const errBody = await res?.text().catch(() => '') ?? ''
        return { rank: idx + 1, brokerId: b.brokerId, nome: b.nome, symbol: b.symbol, positions: [], totalPnl: 0, error: res?.status ?? 'error', errorDetail: errBody.slice(0, 200) }
      }

      const raw = await res.json()
      let positions = (Array.isArray(raw) ? raw : []).map((p: any) => ({
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

      // Valida equity vs saldo: se iguais (< $0.50 de diferença) não há posição real aberta
      let balance: number | undefined
      let equity:  number | undefined
      if (accRes.status === 'fulfilled' && accRes.value.ok) {
        const acc = await accRes.value.json().catch(() => null)
        if (acc) {
          balance = acc.balance
          equity  = acc.equity
          if (balance !== undefined && equity !== undefined && Math.abs(equity - balance) < 0.50) {
            positions = []  // equity ≈ saldo: sem posições reais (MetaAPI ainda com cache antigo)
          }
        }
      }

      const totalPnl = positions.reduce((s: number, p: any) => s + (p.profit ?? 0), 0)

      return { rank: idx + 1, brokerId: b.brokerId, nome: b.nome, symbol: b.symbol, positions, totalPnl, balance, equity }
    })
  )

  const data = results.map((r, idx) =>
    r.status === 'fulfilled'
      ? r.value
      : { rank: idx + 1, brokerId: brokers[idx]?.brokerId ?? '?', nome: brokers[idx]?.nome ?? '?', symbol: brokers[idx]?.symbol ?? 'EURUSD', positions: [], totalPnl: 0, error: 'timeout' }
  )

  return NextResponse.json({ brokers: data, updatedAt: new Date().toISOString() })
}
