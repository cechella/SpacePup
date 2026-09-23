/**
 * POST /api/admin/rereconcile-ia
 * Corrige pnl_usd dos trades IA do Supabase usando os deals reais do MetaAPI.
 *
 * Modo padrão: tenta casar pelo positionId gravado no label.
 * Modo ?sum-today=1: soma TODOS os deals de hoje de todos os brokers e
 *   atribui ao(s) trade(s) IA do dia — usado quando o bug antigo gravou só
 *   1 positionId (1 broker) e as outras corretoras não aparecem no label.
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
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const url      = new URL(req.url)
  // ?sum-today=1  → soma todos os deals de hoje e imputa ao registro IA do dia
  const sumToday = url.searchParams.get('sum-today') === '1'

  const log: string[] = []
  const supa = getServiceClient()
  const brokers = await getActiveBrokers()

  if (sumToday) {
    // ─── MODO SUM-TODAY ────────────────────────────────────────────────────
    // Janela: meia-noite UTC até agora
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)
    const startTime = startOfDay.toISOString()
    const endTime   = new Date().toISOString()
    const cutoff    = Math.floor(startOfDay.getTime() / 1000)

    log.push(`Modo sum-today: deals de ${startTime} até ${endTime}`)

    // Soma todos os deals fechados hoje em todos os brokers
    let totalPnl = 0
    await Promise.allSettled(brokers.map(async (broker) => {
      try {
        const res = await fetch(
          `${MT_BASE}/users/current/accounts/${broker.accountId}/history-deals/time/${startTime}/${endTime}`,
          { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(4_000), cache: 'no-store' },
        )
        if (!res.ok) { log.push(`[${broker.brokerId}] HTTP ${res.status}`); return }
        const data = await res.json()
        const arr  = Array.isArray(data) ? data : (data.deals ?? [])
        let brokerPnl = 0
        for (const d of arr) {
          if (d.entryType !== 'DEAL_ENTRY_OUT' && d.entryType !== 'DEAL_ENTRY_INOUT') continue
          brokerPnl += Number(d.profit ?? 0)
        }
        totalPnl += brokerPnl
        log.push(`[${broker.brokerId}] P&L hoje: $${brokerPnl.toFixed(2)}`)
      } catch {
        log.push(`[${broker.brokerId}] timeout`)
      }
    }))

    log.push(`Total P&L MetaAPI hoje (todos os brokers): $${totalPnl.toFixed(2)}`)

    // Busca trades IA de hoje no Supabase
    const { data: todayTrades } = await supa
      .from('rafi_trades')
      .select('id, label, pnl_usd, result')
      .eq('entry_type', 'ia_autonoma')
      .gte('time', cutoff)
      .order('time', { ascending: true })

    const today = todayTrades ?? []
    log.push(`${today.length} trade(s) IA hoje no Supabase`)

    if (today.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, totalPnl, log })
    }

    // Imputa todo o P&L ao primeiro registro (ou o único)
    const target   = today[0]
    const oldPnl   = Number((target as any).pnl_usd ?? 0)
    const newResult: 'win' | 'loss' = totalPnl > 0 ? 'win' : 'loss'

    if (Math.abs(totalPnl - oldPnl) < 0.01) {
      log.push(`pnl_usd já correto ($${oldPnl.toFixed(2)}) — sem mudança`)
      return NextResponse.json({ ok: true, updated: 0, totalPnl, log })
    }

    const { error: upErr } = await supa
      .from('rafi_trades')
      .update({ result: newResult, pnl_usd: totalPnl, updated_at: new Date().toISOString() })
      .eq('id', target.id)

    if (upErr) {
      log.push(`Erro ao atualizar: ${upErr.message}`)
      return NextResponse.json({ ok: false, error: upErr.message, log }, { status: 500 })
    }

    log.push(`Corrigido: $${oldPnl.toFixed(2)} → $${totalPnl.toFixed(2)} ✓`)
    return NextResponse.json({ ok: true, updated: 1, oldPnl, newPnl: totalPnl, log })
  }

  // ─── MODO PADRÃO (positionId matching) ────────────────────────────────
  const cutoff    = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000)
  const startTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const endTime   = new Date().toISOString()

  const { data: iaTrades, error: tradeErr } = await supa
    .from('rafi_trades')
    .select('id, label, pnl_usd, result')
    .eq('entry_type', 'ia_autonoma')
    .gte('time', cutoff)

  if (tradeErr) return NextResponse.json({ error: tradeErr.message }, { status: 500 })

  const trades = iaTrades ?? []
  log.push(`${trades.length} trade(s) IA nas últimas 48h`)
  if (trades.length === 0) return NextResponse.json({ ok: true, log })

  const dealMap = new Map<string, number>()
  await Promise.allSettled(brokers.map(async (broker) => {
    try {
      const res = await fetch(
        `${MT_BASE}/users/current/accounts/${broker.accountId}/history-deals/time/${startTime}/${endTime}`,
        { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(4_000), cache: 'no-store' },
      )
      if (!res.ok) { log.push(`[${broker.brokerId}] HTTP ${res.status}`); return }
      const data = await res.json()
      const arr  = Array.isArray(data) ? data : (data.deals ?? [])
      let count  = 0
      for (const d of arr) {
        if (d.entryType !== 'DEAL_ENTRY_OUT' && d.entryType !== 'DEAL_ENTRY_INOUT') continue
        const pid = String(d.positionId ?? d.id)
        dealMap.set(pid, (dealMap.get(pid) ?? 0) + Number(d.profit ?? 0))
        count++
      }
      log.push(`[${broker.brokerId}] ${count} deal(s) encontrado(s)`)
    } catch { log.push(`[${broker.brokerId}] timeout`) }
  }))

  log.push(`Total de positionIds únicos: ${dealMap.size}`)

  let updated = 0
  for (const trade of trades) {
    const labelStr    = String((trade as any).label ?? '')
    const posMatch    = labelStr.match(/\|pos:(\S+)/)
    if (!posMatch) { log.push(`[${trade.id}] sem positionIds no label`); continue }

    const positionIds = posMatch[1].split(',').filter(Boolean)
    let totalProfit   = 0
    let foundAny      = false
    const foundPids: string[] = []
    for (const pid of positionIds) {
      const p = dealMap.get(pid)
      if (p !== undefined) { totalProfit += p; foundAny = true; foundPids.push(pid) }
    }
    if (!foundAny) { log.push(`[${trade.id}] nenhum positionId no MetaAPI`); continue }

    const oldPnl    = Number((trade as any).pnl_usd ?? 0)
    const newResult: 'win' | 'loss' = totalProfit > 0 ? 'win' : 'loss'
    if (Math.abs(totalProfit - oldPnl) < 0.01) {
      log.push(`[${trade.id}] pnl correto ($${oldPnl.toFixed(2)}) — sem mudança`)
      continue
    }

    const { error: upErr } = await supa
      .from('rafi_trades')
      .update({ result: newResult, pnl_usd: totalProfit, updated_at: new Date().toISOString() })
      .eq('id', trade.id)

    if (!upErr) {
      log.push(`[${trade.id}] corrigido: $${oldPnl.toFixed(2)} → $${totalProfit.toFixed(2)} (${foundPids.join(',')})`)
      updated++
    } else {
      log.push(`[${trade.id}] erro: ${upErr.message}`)
    }
  }

  log.push(`${updated} trade(s) corrigido(s)`)
  return NextResponse.json({ ok: true, updated, log })
}
