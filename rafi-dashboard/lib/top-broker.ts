import { createClient } from '@supabase/supabase-js'

const ESTADO_ORDER: Record<string, number> = {
  ACTIVE:         1,
  ACTIVE_REDUCED: 2,
  STANDBY:        3,
  QUARANTINED:    99,
}

// Símbolo EURUSD varia por corretora (Exness usa EURUSDz)
const SYMBOL_MAP: Record<string, string> = {
  exness:      'EURUSDz',
  pepperstone: 'EURUSD',
  tickmill:    'EURUSD',
}

const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const MA_TOKEN = process.env.METAAPI_TOKEN ?? ''

// Cache em memória — evita query no Supabase a cada poll de preço (5s)
let cache: { accountId: string; brokerId: string; symbol: string; ts: number } | null = null
const CACHE_TTL_MS = 30_000 // 30 segundos

// Cache de P&L — reaproveitado por getTopBroker e getActiveBrokers
let pnlCache: { map: Record<string, number>; ts: number } | null = null
const PNL_CACHE_TTL_MS = 30_000

/**
 * Busca P&L do dia (UTC) para cada broker em paralelo via MetaAPI.
 * Resultado cacheado por 30 s para não sobrecarregar a API.
 */
async function fetchPnlMap(
  brokers: Array<{ accountId: string; brokerId: string }>,
): Promise<Record<string, number>> {
  if (pnlCache && Date.now() - pnlCache.ts < PNL_CACHE_TTL_MS) return pnlCache.map
  if (!MA_TOKEN) return {}

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const from = today.toISOString()
  const to   = new Date().toISOString()
  const map: Record<string, number> = {}

  await Promise.allSettled(
    brokers.map(async b => {
      try {
        const res = await fetch(
          `${MA_BASE}/users/current/accounts/${b.accountId}/history-deals/time/${from}/${to}`,
          { headers: { 'auth-token': MA_TOKEN }, signal: AbortSignal.timeout(5_000), cache: 'no-store' },
        )
        if (res.ok) {
          const deals: any[] = await res.json()
          map[b.brokerId] = Array.isArray(deals)
            ? deals
                .filter(d =>
                  d.entryType === 'DEAL_ENTRY_OUT' &&
                  (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
                )
                .reduce((sum: number, d: any) => sum + (d.profit ?? 0), 0)
            : 0
        } else {
          map[b.brokerId] = 0
        }
      } catch {
        map[b.brokerId] = 0
      }
    }),
  )

  pnlCache = { map, ts: Date.now() }
  return map
}

/**
 * Retorna { accountId, brokerId, symbol } da corretora #1 no ranking dinâmico:
 * 1º P&L do dia — maior lucro absoluto ganha
 * 2º Estado: ACTIVE > ACTIVE_REDUCED > STANDBY (QUARANTINED excluído)
 * 3º Health Score maior
 * 4º broker_priority menor
 *
 * Fallback: METAAPI_ACCOUNT_ID env var se Supabase indisponível
 */
export async function getTopBroker(): Promise<{ accountId: string; brokerId: string; symbol: string }> {
  const ENV_ID = process.env.METAAPI_ACCOUNT_ID ?? ''

  // Cache válido
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return { accountId: cache.accountId, brokerId: cache.brokerId, symbol: cache.symbol }
  }

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return { accountId: ENV_ID, brokerId: '', symbol: 'EURUSD' }

    const supa = createClient(url, key, { auth: { persistSession: false } })

    const { data, error } = await supa
      .from('rafi_brokers')
      .select(`
        id,
        metaapi_account_id,
        broker_priority,
        broker_health_state ( estado, circuit_breaker, health_score )
      `)
      .eq('enabled', true)
      .not('metaapi_account_id', 'is', null)

    if (error || !data?.length) return { accountId: ENV_ID, brokerId: '', symbol: 'EURUSD' }

    const eligible = (data as any[])
      .map(b => {
        const h = Array.isArray(b.broker_health_state)
          ? b.broker_health_state[0]
          : b.broker_health_state
        return {
          accountId:   b.metaapi_account_id as string,
          brokerId:    b.id as string,
          estadoOrder: ESTADO_ORDER[h?.estado ?? 'STANDBY'] ?? 3,
          cbClosed:    (h?.circuit_breaker ?? 'CLOSED') === 'CLOSED',
          healthScore: h?.health_score ?? 0,
          priority:    b.broker_priority ?? 99,
        }
      })
      .filter(b => b.estadoOrder < 99 && b.cbClosed)

    if (!eligible.length) return { accountId: ENV_ID, brokerId: '', symbol: 'EURUSD' }

    // P&L do dia como critério primário de ranking
    const pnlMap = await fetchPnlMap(eligible)

    const ranked = [...eligible].sort((a, b) => {
      const pnlA = pnlMap[a.brokerId] ?? 0
      const pnlB = pnlMap[b.brokerId] ?? 0
      if (pnlB !== pnlA)            return pnlB - pnlA          // 1º maior lucro
      if (a.estadoOrder !== b.estadoOrder) return a.estadoOrder - b.estadoOrder // 2º estado
      if (b.healthScore  !== a.healthScore) return b.healthScore  - a.healthScore // 3º health
      return a.priority - b.priority                              // 4º prioridade estática
    })

    const top = ranked[0]
    if (!top) return { accountId: ENV_ID, brokerId: '', symbol: 'EURUSD' }

    const symbol = SYMBOL_MAP[top.brokerId] ?? 'EURUSD'
    cache = { accountId: top.accountId, brokerId: top.brokerId, symbol, ts: Date.now() }
    return { accountId: top.accountId, brokerId: top.brokerId, symbol }
  } catch {
    return { accountId: ENV_ID, brokerId: '', symbol: 'EURUSD' }
  }
}

// Mantém compatibilidade com código que só quer o accountId
export async function getTopBrokerAccountId(): Promise<string> {
  return (await getTopBroker()).accountId
}

/**
 * Retorna TODAS as corretoras elegíveis (estado < QUARANTINED + CB CLOSED),
 * ordenadas pelo ranking. Usada para replicar ordens a todas as ativas.
 */
export async function getActiveBrokers(): Promise<Array<{ accountId: string; brokerId: string; nome: string; symbol: string }>> {
  const ENV_ID = process.env.METAAPI_ACCOUNT_ID ?? ''

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return [{ accountId: ENV_ID, brokerId: '', nome: 'Corretora', symbol: 'EURUSD' }]

    const supa = createClient(url, key, { auth: { persistSession: false } })

    const { data, error } = await supa
      .from('rafi_brokers')
      .select(`
        id,
        nome,
        metaapi_account_id,
        broker_priority,
        broker_health_state ( estado, circuit_breaker, health_score )
      `)
      .eq('enabled', true)
      .not('metaapi_account_id', 'is', null)

    if (error || !data?.length) return [{ accountId: ENV_ID, brokerId: '', nome: 'Corretora', symbol: 'EURUSD' }]

    const eligible = (data as any[])
      .map(b => {
        const h = Array.isArray(b.broker_health_state)
          ? b.broker_health_state[0]
          : b.broker_health_state
        return {
          accountId:   b.metaapi_account_id as string,
          brokerId:    b.id as string,
          nome:        b.nome as string,
          estadoOrder: ESTADO_ORDER[h?.estado ?? 'STANDBY'] ?? 3,
          cbClosed:    (h?.circuit_breaker ?? 'CLOSED') === 'CLOSED',
          healthScore: h?.health_score ?? 0,
          priority:    b.broker_priority ?? 99,
        }
      })
      .filter(b => b.estadoOrder < 99 && b.cbClosed)

    if (!eligible.length) return [{ accountId: ENV_ID, brokerId: '', nome: 'Corretora', symbol: 'EURUSD' }]

    const pnlMap = await fetchPnlMap(eligible)

    const ranked = [...eligible].sort((a, b) => {
      const pnlA = pnlMap[a.brokerId] ?? 0
      const pnlB = pnlMap[b.brokerId] ?? 0
      if (pnlB !== pnlA)            return pnlB - pnlA
      if (a.estadoOrder !== b.estadoOrder) return a.estadoOrder - b.estadoOrder
      if (b.healthScore  !== a.healthScore) return b.healthScore  - a.healthScore
      return a.priority - b.priority
    })

    return ranked.map(b => ({
      accountId: b.accountId,
      brokerId:  b.brokerId,
      nome:      b.nome,
      symbol:    SYMBOL_MAP[b.brokerId] ?? 'EURUSD',
    }))
  } catch {
    return [{ accountId: ENV_ID, brokerId: '', nome: 'Corretora', symbol: 'EURUSD' }]
  }
}
