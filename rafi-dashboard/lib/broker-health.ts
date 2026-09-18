/**
 * Engine de saúde das corretoras — dados REAIS de API.
 *
 * Métricas coletadas em cada chamada MetaAPI:
 *   latency_ms  → tempo de resposta da API (ms)
 *   success     → HTTP 2xx sem erro de negócio
 *   event_type  → order | close | modify | positions
 *
 * Fórmula do health score (0–100):
 *   40% latência p90  (0ms=100 · 2000ms=0)
 *   50% taxa de sucesso dos últimos 50 eventos
 *   10% recência (inativo > 2h perde 70 pontos)
 */
import { createClient } from '@supabase/supabase-js'

export type EventType = 'order' | 'close' | 'modify' | 'positions'

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!
  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * Grava um evento de API no Supabase.
 * Fire-and-forget — nunca bloqueia a rota principal.
 */
export function logBrokerEvent(
  brokerId:  string,
  eventType: EventType,
  success:   boolean,
  latencyMs: number,
  errorMsg?: string,
): void {
  if (!brokerId || brokerId === '?') return
  void supa()
    .from('broker_api_events')
    .insert({
      broker_id:  brokerId,
      event_type: eventType,
      success,
      latency_ms: Math.round(latencyMs),
      error_msg:  errorMsg ?? null,
    })
}

export interface HealthResult {
  brokerId:     string
  healthScore:  number
  estado:       string
  cb:           string
  motivo:       string
  totalEvents:  number
  avgLatencyMs: number
  p90LatencyMs: number
  successRate:  number
}

/**
 * Lê os últimos 100 eventos da corretora e retorna o health result calculado.
 * Sem efeitos colaterais — apenas leitura.
 */
export async function computeHealth(brokerId: string): Promise<HealthResult> {
  const { data } = await supa()
    .from('broker_api_events')
    .select('success, latency_ms, created_at')
    .eq('broker_id', brokerId)
    .order('created_at', { ascending: false })
    .limit(100)

  const events: { success: boolean; latency_ms: number; created_at: string }[] = data ?? []

  if (!events.length) {
    return {
      brokerId, healthScore: 50, estado: 'STANDBY', cb: 'CLOSED',
      motivo: 'Sem eventos registrados — aguardando primeiras operações',
      totalEvents: 0, avgLatencyMs: 0, p90LatencyMs: 0, successRate: 1,
    }
  }

  // Latência p90 dos últimos N eventos
  const latencies = events.map(e => e.latency_ms).sort((a, b) => a - b)
  const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? latencies[latencies.length - 1]
  const avgLatency = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)

  // Taxa de sucesso nos últimos 50 eventos
  const window50 = events.slice(0, 50)
  const successCount = window50.filter(e => e.success).length
  const successRate  = successCount / window50.length

  // Recência — penaliza corretora inativa por mais de 2h
  const ageMinutes = (Date.now() - new Date(events[0].created_at).getTime()) / 60_000
  const stale = ageMinutes > 120

  // Pontuação composta
  const latencyScore = Math.max(0, 100 - p90 / 20)      // 0ms→100, 2000ms→0
  const successScore = successRate * 100                  // 100% sucesso→100
  const recencyScore = stale ? 30 : 100
  const healthScore  = Math.round(
    latencyScore * 0.40 + successScore * 0.50 + recencyScore * 0.10,
  )

  // Circuit Breaker: abre automaticamente se os 3 últimos eventos falharam
  const last3     = events.slice(0, 3)
  const allFailed = last3.length === 3 && last3.every(e => !e.success)
  const cb = allFailed ? 'OPEN' : 'CLOSED'

  // Estado operacional
  let estado = 'STANDBY'
  if      (cb === 'OPEN')     estado = 'QUARANTINED'
  else if (healthScore >= 78) estado = 'ACTIVE'
  else if (healthScore >= 52) estado = 'ACTIVE_REDUCED'
  else if (healthScore >= 25) estado = 'STANDBY'
  else                        estado = 'QUARANTINED'

  // Motivo legível para o dashboard
  const motivos: string[] = []
  if (cb === 'OPEN')       motivos.push('3 falhas consecutivas → CB aberto')
  if (latencyScore < 60)   motivos.push(`latência p90 alta (${Math.round(p90)}ms)`)
  if (successRate < 0.9)   motivos.push(`${((1 - successRate) * 100).toFixed(0)}% de falhas`)
  if (stale)               motivos.push(`inativo há ${Math.round(ageMinutes)}min`)
  const motivo = motivos.length
    ? motivos.join(' · ')
    : `Operando normalmente · ${events.length} eventos · p90 ${Math.round(p90)}ms`

  return {
    brokerId, healthScore, estado, cb, motivo,
    totalEvents: events.length, avgLatencyMs: avgLatency, p90LatencyMs: Math.round(p90), successRate,
  }
}

/** Persiste o health result calculado na tabela broker_health_state */
export async function saveHealthResult(r: HealthResult): Promise<void> {
  await supa()
    .from('broker_health_state')
    .upsert(
      {
        broker_id:       r.brokerId,
        health_score:    r.healthScore,
        estado:          r.estado,
        circuit_breaker: r.cb,
        motivo_estado:   r.motivo,
        atualizado_em:   new Date().toISOString(),
      },
      { onConflict: 'broker_id' },
    )
}
