import { NextResponse } from 'next/server'
import { getTopBroker, getActiveBrokers } from '@/lib/top-broker'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

function baseSymbol(s: string) { return s.replace(/z$/i, '').toUpperCase() }

export async function GET() {
  const { accountId } = await getTopBroker()
  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${accountId}/positions`,
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
  try {
    const { positionId, symbol, volume } = await req.json()
    if (!positionId) return NextResponse.json({ error: 'positionId obrigatório' }, { status: 400 })

    const brokers = await getActiveBrokers()

    const results = await Promise.allSettled(
      brokers.map(async (b, idx) => {
        let pidToClose = positionId

        // Corretoras secundárias: localiza a posição correspondente por símbolo + volume
        if (idx > 0 && symbol) {
          const posRes = await fetch(
            `${BASE}/users/current/accounts/${b.accountId}/positions`,
            { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
          )
          if (posRes.ok) {
            const raw = await posRes.json()
            const positions: any[] = Array.isArray(raw) ? raw : []
            const match = positions.find((p: any) =>
              baseSymbol(p.symbol) === baseSymbol(symbol) &&
              (volume === undefined || Math.abs(p.volume - volume) < 0.001)
            )
            if (!match) return { brokerId: b.brokerId, nome: b.nome, ok: false, detail: 'Posição não encontrada' }
            pidToClose = match.id
          }
        }

        const res = await fetch(
          `${BASE}/users/current/accounts/${b.accountId}/trade`,
          {
            method:  'POST',
            headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: pidToClose, comment: 'manual-close' }),
            signal:  AbortSignal.timeout(8_000),
          }
        )
        const text = await res.text()
        return { brokerId: b.brokerId, nome: b.nome, ok: res.ok, detail: text }
      })
    )

    const parsed = results.map(r =>
      r.status === 'fulfilled' ? r.value : { brokerId: '?', nome: '?', ok: false, detail: String((r as PromiseRejectedResult).reason) }
    )

    const anyOk = parsed.some(r => r.ok)
    return NextResponse.json({ ok: anyOk, replication: parsed })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
