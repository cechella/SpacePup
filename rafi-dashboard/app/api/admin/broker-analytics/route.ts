/**
 * GET /api/admin/broker-analytics
 * Retorna dados de performance em tempo real de cada corretora:
 * latências recentes (sparkline), p90, uptime, breakdown por tipo de evento.
 * Fonte: tabela broker_api_events (eventos dos últimos 24h).
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.floor(sorted.length * p)
  return sorted[Math.min(idx, sorted.length - 1)]
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })

  const supa = createClient(url, key, { auth: { persistSession: false } })

  // Lista de brokers com MetaAPI configurado
  const { data: brokerList, error: bErr } = await supa
    .from('rafi_brokers')
    .select('id, nome')
    .not('metaapi_account_id', 'is', null)

  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const results = await Promise.allSettled(
    (brokerList ?? []).map(async (b: any) => {
      // Últimos 500 eventos nas 24h (posições a cada 5s = ~17.000/dia; limit para não explodir)
      const { data, error } = await supa
        .from('broker_api_events')
        .select('event_type, success, latency_ms, created_at')
        .eq('broker_id', b.id)
        .gte('created_at', since24h)
        .order('created_at', { ascending: false })
        .limit(500)

      if (error || !data) return { brokerId: b.id, nome: b.nome, error: error?.message }

      const events: { event_type: string; success: boolean; latency_ms: number; created_at: string }[] = data

      // Sparkline: últimas 20 leituras (qualquer tipo), da mais antiga para a mais recente
      const sparkline = events.slice(0, 20).map(e => e.latency_ms).reverse()

      // p90 e média globais (todos os tipos)
      const allLatencies = events.map(e => e.latency_ms).sort((a, b) => a - b)
      const p90 = percentile(allLatencies, 0.9)
      const avg = allLatencies.length
        ? Math.round(allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length)
        : 0

      // Uptime e totais
      const totalEvents  = events.length
      const failedEvents = events.filter(e => !e.success).length
      const uptimePct    = totalEvents ? Math.round((1 - failedEvents / totalEvents) * 100) : 100

      // Breakdown por tipo
      const types = ['positions', 'order', 'close', 'modify'] as const
      const byType: Record<string, { avg: number; count: number }> = {}
      for (const t of types) {
        const evs = events.filter(e => e.event_type === t)
        if (!evs.length) continue
        const lats = evs.map(e => e.latency_ms)
        byType[t] = {
          avg:   Math.round(lats.reduce((s, v) => s + v, 0) / lats.length),
          count: lats.length,
        }
      }

      return {
        brokerId:    b.id,
        nome:        b.nome as string,
        lastLatency: events[0]?.latency_ms ?? null,
        lastAt:      events[0]?.created_at ?? null,
        sparkline,
        p90:         Math.round(p90),
        avgLatency:  avg,
        uptimePct,
        totalEvents,
        failedEvents,
        byType,
      }
    })
  )

  const data = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean)

  return NextResponse.json({ brokers: data, updatedAt: new Date().toISOString() })
}
