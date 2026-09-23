/**
 * POST /api/admin/rereconcile-ia
 * Re-reconcilia trades IA que já foram marcados como win/loss mas com pnl_usd errado
 * (acontece quando o reconcile original teve bug de timeout ou só salvou 1 broker).
 * Busca TODOS os deals do MetaAPI das últimas 48h e recalcula pnl_usd corretamente.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getActiveBrokers } from '@/lib/top-broker'

export const runtime = 'nodejs'
export const maxDuration = 10

const MT_BASE = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(req: NextRequest) {
  // Valida CRON_SECRET para proteger o endpoint
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const log: string[] = []
  const supa = getServiceClient()

  // Janela das últimas 48h (para pegar ontem e hoje)
  const cutoff    = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000)
  const startTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const endTime   = new Date().toISOString()

  // 1. Busca TODOS os trades IA das últimas 48h (incluindo já reconciliados)
  const { data: iaTrades, error: tradeErr } = await supa
    .from('rafi_trades')
    .select('id, label, pnl_usd, result')
    .eq('entry_type', 'ia_autonoma')
    .gte('time', cutoff)

  if (tradeErr) return NextResponse.json({ error: tradeErr.message }, { status: 500 })

  const trades = iaTrades ?? []
  log.push(`${trades.length} trade(s) IA nas últimas 48h`)
  if (trades.length === 0) return NextResponse.json({ ok: true, log })

  // 2. Busca deals fechados de TODOS os brokers em paralelo
  const brokers   = await getActiveBrokers()
  const dealMap   = new Map<string, number>()

  await Promise.allSettled(brokers.map(async (broker) => {
    try {
      const url = `${MT_BASE}/users/current/accounts/${broker.accountId}/history-deals/time/${startTime}/${endTime}`
      const res = await fetch(url, {
        headers: { 'auth-token': TOKEN },
        signal: AbortSignal.timeout(4_000),
        cache: 'no-store',
      })
      if (!res.ok) {
        log.push(`[${broker.brokerId}] deals: HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      const arr  = Array.isArray(data) ? data : (data.deals ?? [])
      let count  = 0
      for (const d of arr) {
        if (d.entryType !== 'DEAL_ENTRY_OUT' && d.entryType !== 'DEAL_ENTRY_INOUT') continue
        const pid = String(d.positionId ?? d.id)
        dealMap.set(pid, (dealMap.get(pid) ?? 0) + Number(d.profit ?? 0))
        count++
      }
      log.push(`[${broker.brokerId}] ${count} deal(s) fechado(s) encontrado(s)`)
    } catch {
      log.push(`[${broker.brokerId}] timeout ao buscar deals`)
    }
  }))

  log.push(`Total de positionIds únicos no MetaAPI: ${dealMap.size}`)

  // 3. Para cada trade IA, recalcula pnl somando todos os positionIds do label
  let updated = 0
  for (const trade of trades) {
    const labelStr   = String((trade as any).label ?? '')
    const posMatch   = labelStr.match(/\|pos:(\S+)/)
    if (!posMatch) {
      log.push(`[trade ${trade.id}] sem positionIds no label — ignorado`)
      continue
    }

    const positionIds = posMatch[1].split(',').filter(Boolean)
    let totalProfit   = 0
    let foundAny      = false
    const foundPids: string[] = []

    for (const pid of positionIds) {
      const p = dealMap.get(pid)
      if (p !== undefined) {
        totalProfit += p
        foundAny    = true
        foundPids.push(pid)
      }
    }

    if (!foundAny) {
      log.push(`[trade ${trade.id}] nenhum positionId encontrado no MetaAPI`)
      continue
    }

    const oldPnl    = Number((trade as any).pnl_usd ?? 0)
    const newResult: 'win' | 'loss' = totalProfit > 0 ? 'win' : 'loss'

    if (Math.abs(totalProfit - oldPnl) < 0.01) {
      log.push(`[trade ${trade.id}] pnl correto (${oldPnl.toFixed(2)}) — sem mudança`)
      continue
    }

    const { error: upErr } = await supa
      .from('rafi_trades')
      .update({ result: newResult, pnl_usd: totalProfit, updated_at: new Date().toISOString() })
      .eq('id', trade.id)

    if (upErr) {
      log.push(`[trade ${trade.id}] erro ao atualizar: ${upErr.message}`)
    } else {
      log.push(`[trade ${trade.id}] corrigido: $${oldPnl.toFixed(2)} → $${totalProfit.toFixed(2)} (${foundPids.join(',')})`)
      updated++
    }
  }

  log.push(`${updated} trade(s) corrigido(s)`)
  return NextResponse.json({ ok: true, updated, log })
}
