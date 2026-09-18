import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getTopBrokerAccountId } from '@/lib/top-broker'

const BASE        = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN       = process.env.METAAPI_TOKEN!
const ENV_ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 30

function periodToFrom(period: string): Date {
  const now = new Date()
  switch (period) {
    case 'today': {
      const d = new Date(now)
      d.setUTCHours(0, 0, 0, 0)
      return d
    }
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case '3m':  return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    case '7d':
    default:    return new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000)
  }
}

/** Resolve o accountId para um brokerId fornecido; cai para top broker se não informado. */
async function resolveAccountId(brokerId: string | null): Promise<string> {
  if (!brokerId) return getTopBrokerAccountId()
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return ENV_ACCOUNT
    const supa = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await supa
      .from('rafi_brokers')
      .select('metaapi_account_id')
      .eq('id', brokerId)
      .single()
    return data?.metaapi_account_id ?? ENV_ACCOUNT
  } catch {
    return ENV_ACCOUNT
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const period   = searchParams.get('period') ?? '7d'
    const brokerId = searchParams.get('broker') ?? null

    const accountId = await resolveAccountId(brokerId)
    const from      = periodToFrom(period).toISOString()
    const to        = new Date().toISOString()

    const res = await fetch(
      `${BASE}/users/current/accounts/${accountId}/history-deals/time/${from}/${to}`,
      { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(20_000), cache: 'no-store' },
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text, history: [] }, { status: res.status })
    }

    const deals: any[] = await res.json()

    // Mapeia DEAL_ENTRY_IN por positionId → preço de entrada
    const entryByPos: Record<string, number> = {}
    if (Array.isArray(deals)) {
      deals
        .filter(d => d.entryType === 'DEAL_ENTRY_IN' && d.price && d.positionId)
        .forEach(d => { entryByPos[d.positionId] = d.price })
    }

    const history = (Array.isArray(deals) ? deals : [])
      .filter(d =>
        d.entryType === 'DEAL_ENTRY_OUT' &&
        (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
      )
      .map(d => ({
        id:         d.id,
        symbol:     d.symbol,
        type:       d.type,
        direction:  d.type === 'DEAL_TYPE_SELL' ? 'buy' : 'sell',
        volume:     d.volume,
        price:      d.price,
        entryPrice: entryByPos[d.positionId] ?? null,
        profit:     d.profit ?? 0,
        time:       d.time,
        comment:    d.comment ?? '',
        positionId: d.positionId ?? null,
      }))
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

    return NextResponse.json({ history, period })
  } catch (e: any) {
    console.error('[MetaAPI history]', e.message)
    return NextResponse.json({ error: e.message, history: [] }, { status: 500 })
  }
}
