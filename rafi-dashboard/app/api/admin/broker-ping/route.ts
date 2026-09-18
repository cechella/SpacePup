/**
 * GET /api/admin/broker-ping
 * Mede a latência de cada corretora ao vivo via MetaAPI.
 * Não depende do bot Python — funciona sempre que MetaAPI estiver online.
 * Endpoint leve: GET accountInformation de cada conta.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const MA_TOKEN = process.env.METAAPI_TOKEN ?? ''

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })
  if (!MA_TOKEN)    return NextResponse.json({ error: 'METAAPI_TOKEN não configurado' }, { status: 500 })

  const supa = createClient(url, key, { auth: { persistSession: false } })

  const { data: brokers, error } = await supa
    .from('rafi_brokers')
    .select('id, nome, metaapi_account_id')
    .eq('enabled', true)
    .not('metaapi_account_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const pings = await Promise.allSettled(
    (brokers ?? []).map(async (b: { id: string; nome: string; metaapi_account_id: string }) => {
      const t0 = Date.now()
      try {
        const res = await fetch(
          `${MA_BASE}/users/current/accounts/${b.metaapi_account_id}/accountInformation`,
          {
            headers: { 'auth-token': MA_TOKEN },
            signal:  AbortSignal.timeout(6_000),
            cache:   'no-store',
          },
        )
        const latencyMs = Date.now() - t0
        const ok = res.status === 200 || res.status === 404  // 404 = conta existe mas terminal offline
        return {
          brokerId:  b.id,
          nome:      b.nome,
          latencyMs: ok ? latencyMs : null,
          success:   ok,
          status:    res.status,
        }
      } catch {
        return {
          brokerId:  b.id,
          nome:      b.nome,
          latencyMs: null,
          success:   false,
          status:    0,
        }
      }
    }),
  )

  const result = pings
    .map(p => p.status === 'fulfilled' ? p.value : null)
    .filter(Boolean)

  return NextResponse.json({ pings: result, measuredAt: new Date().toISOString() })
}
