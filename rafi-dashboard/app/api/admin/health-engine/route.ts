/**
 * POST /api/admin/health-engine
 *
 * Recalcula o health score de todas as corretoras com dados reais
 * (latência p90, taxa de sucesso, recência) e persiste no Supabase.
 *
 * Chamado pelo dashboard a cada 60s — leve: lê ~100 linhas por corretora
 * e faz upsert em broker_health_state.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { computeHealth, saveHealthResult } from '@/lib/broker-health'

export const runtime = 'nodejs'

export async function POST() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })

  const supa = createClient(url, key, { auth: { persistSession: false } })

  // Busca todos os brokers com MetaAPI configurado
  const { data, error } = await supa
    .from('rafi_brokers')
    .select('id')
    .not('metaapi_account_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const brokerIds = (data ?? []).map((b: any) => b.id as string)

  // Calcula e salva em paralelo (uma query por broker, ~100 linhas cada)
  const results = await Promise.allSettled(
    brokerIds.map(async (id) => {
      const result = await computeHealth(id)
      await saveHealthResult(result)
      return result
    })
  )

  const parsed = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean)

  return NextResponse.json({ ok: true, results: parsed, updatedAt: new Date().toISOString() })
}
