/**
 * GET /api/monitor/brokers
 * Retorna saldo real + status de cada corretora via MetaAPI.
 * Usado pelo monitor para exibir capital consolidado correto.
 */
import { NextResponse } from 'next/server'
import { getActiveBrokers } from '@/lib/top-broker'

export const runtime = 'nodejs'
export const maxDuration = 10

const MT_BASE = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN ?? ''

// IDs das contas MetaAPI por corretora (variáveis de ambiente ou fallback vazio)
const ACCOUNT_IDS: Record<string, string> = {
  icmarkets:   process.env.METAAPI_ACCOUNT_ICMARKETS   ?? '',
  exness:      process.env.METAAPI_ACCOUNT_EXNESS       ?? '',
  pepperstone: process.env.METAAPI_ACCOUNT_PEPPERSTONE  ?? '',
  tickmill:    process.env.METAAPI_ACCOUNT_TICKMILL      ?? '',
}

async function fetchBrokerInfo(accountId: string): Promise<{ balance: number; equity: number; online: boolean } | null> {
  if (!accountId || !TOKEN) return null
  try {
    const res = await fetch(
      `${MT_BASE}/users/current/accounts/${accountId}/account-information`,
      {
        headers: { 'auth-token': TOKEN },
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      },
    )
    if (!res.ok) return null
    const data = await res.json()
    const balance = Number(data.balance ?? 0)
    const equity  = Number(data.equity  ?? balance)
    return { balance, equity, online: balance > 0 }
  } catch {
    return null
  }
}

export async function GET() {
  try {
    // Busca accountIds dinâmicos do Supabase (rafi_brokers) em paralelo com env vars
    let dynamicIds: Record<string, string> = {}
    try {
      const brokers = await getActiveBrokers()
      brokers.forEach(b => {
        if (b.accountId) dynamicIds[b.brokerId] = b.accountId
      })
    } catch {
      // usa só env vars se Supabase falhar
    }

    // Mescla: env var tem prioridade, depois dinâmico
    const ids: Record<string, string> = { ...dynamicIds }
    for (const [k, v] of Object.entries(ACCOUNT_IDS)) {
      if (v) ids[k] = v
    }

    const brokerKeys = ['icmarkets', 'exness', 'pepperstone', 'tickmill']
    const results = await Promise.allSettled(
      brokerKeys.map(k => fetchBrokerInfo(ids[k] ?? ''))
    )

    const brokers: Record<string, { balance: number; equity: number; online: boolean } | null> = {}
    brokerKeys.forEach((k, i) => {
      const r = results[i]
      brokers[k] = r.status === 'fulfilled' ? r.value : null
    })

    const capitalTotal = Object.values(brokers)
      .reduce((s, b) => s + (b?.balance ?? 0), 0)

    return NextResponse.json({ brokers, capitalTotal })
  } catch (err) {
    return NextResponse.json({ brokers: {}, capitalTotal: 0, error: String(err) }, { status: 500 })
  }
}
