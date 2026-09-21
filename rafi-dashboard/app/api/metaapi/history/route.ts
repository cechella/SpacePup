import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getTopBrokerAccountId, getActiveBrokers } from '@/lib/top-broker'

const BASE        = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const PROV_BASE   = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'
const TOKEN       = process.env.METAAPI_TOKEN!
const ENV_ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

/** Dispara re-deploy de conta desconectada sem aguardar (fire-and-forget).
 *  O próximo poll de 60s do frontend vai pegar os deals após re-deploy completar (~15-30s). */
function triggerRedeploy(accountId: string): void {
  fetch(`${PROV_BASE}/users/current/accounts/${accountId}/deploy`, {
    method:  'POST',
    headers: { 'auth-token': TOKEN },
    signal:  AbortSignal.timeout(10_000),
  }).catch(() => { /* silencioso */ })
}

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

function parseDeals(deals: any[]) {
  const entryByPos: Record<string, number> = {}
  deals
    .filter(d => d.entryType === 'DEAL_ENTRY_IN' && d.price && d.positionId)
    .forEach(d => { entryByPos[d.positionId] = d.price })

  return deals
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
}

async function fetchDealsForAccount(
  accountId: string,
  from: string,
  to: string,
): Promise<{ deals: any[]; httpStatus?: number; fetchError?: string }> {
  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${accountId}/history-deals/time/${from}/${to}`,
      { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(20_000), cache: 'no-store' },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { deals: [], httpStatus: res.status, fetchError: body.slice(0, 200) }
    }
    const deals: any[] = await res.json()
    return { deals: Array.isArray(deals) ? deals : [] }
  } catch (e: any) {
    return { deals: [], fetchError: e?.message ?? 'timeout' }
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const period   = searchParams.get('period') ?? '7d'
    const brokerId = searchParams.get('broker') ?? null
    const allMode  = searchParams.get('all') === 'true'

    const from = periodToFrom(period).toISOString()
    const to   = new Date().toISOString()

    // Modo "todas as corretoras" — retorna grupos ordenados por ranking
    if (allMode && !brokerId) {
      const brokers = await getActiveBrokers()
      const results = await Promise.allSettled(
        brokers.map(async (b, idx) => {
          const { deals, httpStatus, fetchError } = await fetchDealsForAccount(b.accountId, from, to)
          // Conta desconectada (504) → dispara re-deploy em background; próximo poll vai pegar os deals
          if (httpStatus === 504) triggerRedeploy(b.accountId)
          return {
            rank:       idx + 1,
            brokerId:   b.brokerId,
            nome:       b.nome,
            trades:     parseDeals(deals),
            ...(fetchError  && { fetchError }),
            ...(httpStatus  && { httpStatus }),
          }
        })
      )
      const groups = results
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<any>).value)
      const history = groups.flatMap(g => g.trades)
      return NextResponse.json({ groups, history, period })
    }

    // Modo corretora única
    const accountId = await resolveAccountId(brokerId)
    const { deals, httpStatus, fetchError } = await fetchDealsForAccount(accountId, from, to)

    if (fetchError) {
      console.error(`[history] broker=${brokerId ?? 'top'} status=${httpStatus} err=${fetchError}`)
      return NextResponse.json({ history: [], period, fetchError, httpStatus })
    }

    if (!deals.length && !brokerId) {
      return NextResponse.json({ history: [], period })
    }

    const history = parseDeals(deals)
    return NextResponse.json({ history, period })
  } catch (e: any) {
    console.error('[MetaAPI history]', e.message)
    return NextResponse.json({ error: e.message, history: [] }, { status: 500 })
  }
}
