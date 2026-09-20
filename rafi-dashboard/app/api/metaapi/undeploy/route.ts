import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Desliga (undeploy) todas as contas MetaAPI habilitadas — IDs lidos do Supabase
export const runtime = 'nodejs'

const TOKEN = process.env.METAAPI_TOKEN!
const BASE  = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'

async function getAccountIds(): Promise<string[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return []
  const supa = createClient(url, key, { auth: { persistSession: false } })
  const { data } = await supa
    .from('rafi_brokers')
    .select('metaapi_account_id')
    .eq('enabled', true)
    .not('metaapi_account_id', 'is', null)
  return (data ?? []).map((r: any) => r.metaapi_account_id as string).filter(Boolean)
}

export async function POST() {
  const ids = await getAccountIds()
  if (!ids.length) return NextResponse.json({ action: 'undeploy', results: [], warning: 'Nenhuma conta encontrada no Supabase' })

  const results = await Promise.allSettled(
    ids.map(id =>
      fetch(`${BASE}/users/current/accounts/${id}/undeploy`, {
        method: 'POST',
        headers: { 'auth-token': TOKEN },
      }).then(r => ({ id, httpStatus: r.status, ok: r.status < 300 }))
    )
  )

  const summary = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: ids[i], ok: false, erro: String((r as PromiseRejectedResult).reason) }
  )

  return NextResponse.json({ action: 'undeploy', results: summary })
}
