import { NextResponse } from 'next/server'
import { getActiveBrokers } from '@/lib/top-broker'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

// Normaliza símbolo para comparação entre corretoras (EURUSDz → EURUSD)
function baseSymbol(s: string) { return s.replace(/z$/i, '').toUpperCase() }

async function fetchPositions(accountId: string): Promise<any[]> {
  const res = await fetch(
    `${BASE}/users/current/accounts/${accountId}/positions`,
    { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000) }
  )
  if (!res.ok) return []
  const raw = await res.json()
  return Array.isArray(raw) ? raw : []
}

async function modifyPosition(accountId: string, positionId: string, stopLoss: number, takeProfit: number) {
  const res = await fetch(
    `${BASE}/users/current/accounts/${accountId}/trade`,
    {
      method:  'POST',
      headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ actionType: 'POSITION_MODIFY', positionId, stopLoss, takeProfit }),
      signal:  AbortSignal.timeout(15_000),
    }
  )
  const text = await res.text()
  return { ok: res.ok, detail: text }
}

export async function PATCH(req: Request) {
  try {
    const { positionId, symbol, volume, stopLoss, takeProfit } = await req.json()

    if (!positionId || (stopLoss === undefined && takeProfit === undefined)) {
      return NextResponse.json(
        { error: 'positionId e ao menos stopLoss ou takeProfit são obrigatórios' },
        { status: 400 },
      )
    }

    const brokers = await getActiveBrokers()

    // Aplica em paralelo a todas as corretoras ativas
    const results = await Promise.allSettled(
      brokers.map(async (b, idx) => {
        // Corretora principal: usa o positionId fornecido diretamente
        if (idx === 0) {
          const r = await modifyPosition(b.accountId, positionId, stopLoss, takeProfit)
          return { brokerId: b.brokerId, nome: b.nome, positionId, ...r }
        }

        // Corretoras secundárias: busca posição correspondente por símbolo + volume
        const positions = await fetchPositions(b.accountId)
        const base = symbol ? baseSymbol(symbol) : ''
        const match = positions.find((p: any) =>
          baseSymbol(p.symbol) === base &&
          (volume === undefined || Math.abs(p.volume - volume) < 0.001)
        )

        if (!match) {
          return { brokerId: b.brokerId, nome: b.nome, positionId: null, ok: false, detail: 'Posição não encontrada' }
        }

        const r = await modifyPosition(b.accountId, match.id, stopLoss, takeProfit)
        return { brokerId: b.brokerId, nome: b.nome, positionId: match.id, ...r }
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
