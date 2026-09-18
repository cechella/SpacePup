import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const ESTADO_ORDER: Record<string, number> = {
  ACTIVE: 1, ACTIVE_REDUCED: 2, STANDBY: 3, QUARANTINED: 99,
}

const ESTADO_LABEL: Record<string, string> = {
  ACTIVE: 'Ativo', ACTIVE_REDUCED: 'Ativo Reduzido', STANDBY: 'Standby', QUARANTINED: 'Quarentena',
}

const SYMBOL_MAP: Record<string, string> = {
  exness: 'EURUSDz', pepperstone: 'EURUSD', tickmill: 'EURUSD',
}

const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const MA_TOKEN = process.env.METAAPI_TOKEN ?? ''

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })

  const supa = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await supa
    .from('rafi_brokers')
    .select(`
      id, nome, broker_priority, enabled, metaapi_account_id,
      broker_health_state ( estado, circuit_breaker, health_score )
    `)
    .eq('enabled', true)
    .not('metaapi_account_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const brokers = (data as any[]).map(b => {
    const h = Array.isArray(b.broker_health_state)
      ? b.broker_health_state[0]
      : b.broker_health_state

    const estado       = h?.estado ?? 'STANDBY'
    const estadoOrder  = ESTADO_ORDER[estado] ?? 3
    const cbClosed     = (h?.circuit_breaker ?? 'CLOSED') === 'CLOSED'
    const healthScore  = h?.health_score ?? 0
    const priority     = b.broker_priority ?? 99
    const eligible     = estadoOrder < 99 && cbClosed

    return {
      id:             b.id as string,
      nome:           b.nome as string,
      symbol:         SYMBOL_MAP[b.id] ?? 'EURUSD',
      accountId:      b.metaapi_account_id as string,
      estado,
      estadoLabel:    ESTADO_LABEL[estado] ?? estado,
      estadoOrder,
      circuitBreaker: h?.circuit_breaker ?? 'CLOSED',
      healthScore,
      priority,
      eligible,
    }
  })

  // Busca P&L do dia para corretoras elegíveis em paralelo
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const from = today.toISOString()
  const to   = new Date().toISOString()
  const pnlMap: Record<string, number> = {}

  if (MA_TOKEN) {
    await Promise.allSettled(
      brokers.filter(b => b.eligible).map(async b => {
        try {
          const res = await fetch(
            `${MA_BASE}/users/current/accounts/${b.accountId}/history-deals/time/${from}/${to}`,
            { headers: { 'auth-token': MA_TOKEN }, signal: AbortSignal.timeout(5_000), cache: 'no-store' },
          )
          if (res.ok) {
            const deals: any[] = await res.json()
            pnlMap[b.id] = Array.isArray(deals)
              ? deals
                  .filter(d =>
                    d.entryType === 'DEAL_ENTRY_OUT' &&
                    (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
                  )
                  .reduce((sum: number, d: any) => sum + (d.profit ?? 0), 0)
              : 0
          } else {
            pnlMap[b.id] = 0
          }
        } catch {
          pnlMap[b.id] = 0
        }
      }),
    )
  }

  // Ordena: 1º P&L do dia (maior lucro = melhor), 2º Estado, 3º HealthScore, 4º Prioridade
  const ranked = [...brokers].sort((a, b) => {
    if (!a.eligible && !b.eligible) return 0
    if (!a.eligible) return 1
    if (!b.eligible) return -1
    const pnlA = pnlMap[a.id] ?? 0
    const pnlB = pnlMap[b.id] ?? 0
    if (pnlB !== pnlA)                       return pnlB - pnlA
    if (a.estadoOrder !== b.estadoOrder)      return a.estadoOrder - b.estadoOrder
    if (b.healthScore  !== a.healthScore)     return b.healthScore  - a.healthScore
    return a.priority - b.priority
  })

  const result = ranked.map((b, i) => {
    const prev = ranked[i - 1]
    const pnlB = pnlMap[b.id] ?? null
    const pnlP = prev ? (pnlMap[prev.id] ?? null) : null

    let reason = ''
    if (i === 0) {
      if (pnlB !== null && pnlB !== 0) {
        reason = `P&L ${pnlB >= 0 ? '+' : ''}${pnlB.toFixed(2)} USD — melhor resultado do dia`
      } else {
        reason = 'Melhor combinação de estado, health score e prioridade'
      }
    } else if (!b.eligible) {
      reason = b.circuitBreaker !== 'CLOSED'
        ? 'Circuit Breaker ABERTO — excluída do ranking'
        : `Estado ${b.estadoLabel} — fora do ranking ativo`
    } else if (prev && pnlP !== null && pnlB !== null && pnlP > pnlB) {
      reason = `P&L ${pnlP >= 0 ? '+' : ''}${pnlP.toFixed(2)} > ${pnlB >= 0 ? '+' : ''}${pnlB.toFixed(2)} USD (${prev.nome} lucrou mais hoje)`
    } else if (prev && prev.estadoOrder < b.estadoOrder) {
      reason = `Estado ${prev.estadoLabel} > ${b.estadoLabel} (${prev.nome} tem estado superior)`
    } else if (prev && prev.healthScore > b.healthScore) {
      reason = `Health Score ${prev.healthScore} > ${b.healthScore} (${prev.nome} tem score maior)`
    } else if (prev) {
      reason = `Prioridade ${b.priority} > ${prev.priority} (${prev.nome} tem prioridade menor)`
    }

    return { ...b, accountId: undefined, rank: i + 1, reason, pnlHoje: pnlB ?? 0 }
  })

  return NextResponse.json({ brokers: result, updatedAt: new Date().toISOString() })
}
