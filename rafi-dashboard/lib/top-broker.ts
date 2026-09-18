import { createClient } from '@supabase/supabase-js'

const ESTADO_ORDER: Record<string, number> = {
  ACTIVE:         1,
  ACTIVE_REDUCED: 2,
  STANDBY:        3,
  QUARANTINED:    99,
}

// Cache em memória — evita query no Supabase a cada poll de preço (5s)
let cache: { accountId: string; brokerId: string; ts: number } | null = null
const CACHE_TTL_MS = 30_000 // 30 segundos

/**
 * Retorna { accountId, brokerId } da corretora #1 no ranking dinâmico:
 * 1º Estado: ACTIVE > ACTIVE_REDUCED > STANDBY (QUARANTINED excluído)
 * 2º Circuit Breaker CLOSED
 * 3º Health Score maior
 * 4º broker_priority menor
 *
 * Fallback: METAAPI_ACCOUNT_ID env var se Supabase indisponível
 */
export async function getTopBroker(): Promise<{ accountId: string; brokerId: string }> {
  const ENV_ID = process.env.METAAPI_ACCOUNT_ID ?? ''

  // Cache válido
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return { accountId: cache.accountId, brokerId: cache.brokerId }
  }

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return { accountId: ENV_ID, brokerId: '' }

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

    if (error || !data?.length) return { accountId: ENV_ID, brokerId: '' }

    const ranked = (data as any[])
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
      .sort((a, b) =>
        a.estadoOrder !== b.estadoOrder ? a.estadoOrder - b.estadoOrder :
        b.healthScore  !== a.healthScore ? b.healthScore  - a.healthScore :
        a.priority - b.priority
      )

    const top = ranked[0]
    if (!top) return { accountId: ENV_ID, brokerId: '' }

    cache = { accountId: top.accountId, brokerId: top.brokerId, ts: Date.now() }
    return { accountId: top.accountId, brokerId: top.brokerId }
  } catch {
    return { accountId: ENV_ID, brokerId: '' }
  }
}

// Mantém compatibilidade com código que só quer o accountId
export async function getTopBrokerAccountId(): Promise<string> {
  return (await getTopBroker()).accountId
}
