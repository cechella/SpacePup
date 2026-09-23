/**
 * GET /api/ml/reconcile-ia
 * Cron horário — reconcilia trades IA Autônoma pendentes com o histórico do MetaAPI.
 * Para cada trade com result=null, busca o deal de fechamento no MT5 e atualiza
 * result='win'/'loss' e pnl_usd no Supabase, permitindo que o P(sucesso) aprenda.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getActiveBrokers } from '@/lib/top-broker'

export const runtime   = 'nodejs'
export const maxDuration = 10  // Vercel Hobby: máximo 10s

const MT_BASE = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// Busca deals fechados dos últimos N dias no MetaAPI
async function fetchClosedDeals(accountId: string, days = 7): Promise<{
  positionId: string
  profit:     number
  time:       string
  type:       string
}[]> {
  try {
    const startTime = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    const endTime   = new Date().toISOString()
    const url = `${MT_BASE}/users/current/accounts/${accountId}/history-deals/time/${startTime}/${endTime}`
    const res = await fetch(url, {
      headers: { 'auth-token': TOKEN },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    const arr  = Array.isArray(data) ? data : (data.deals ?? [])
    // Filtra apenas deals de saída (DEAL_TYPE_SELL para buy, DEAL_TYPE_BUY para sell)
    // Entry type OUT = fechamento de posição
    return arr
      .filter((d: any) => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT')
      .map((d: any) => ({
        positionId: String(d.positionId ?? d.id),
        profit:     Number(d.profit ?? 0),
        time:       String(d.time ?? ''),
        type:       String(d.type ?? ''),
      }))
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  // Valida CRON_SECRET
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const log: string[] = []
  log.push(`[reconcile-ia] iniciado: ${new Date().toISOString()}`)

  try {
    const supa = getServiceClient()

    // ── 1. Busca trades IA pendentes dos últimos 7 dias ──────────────────
    const cutoff = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000)
    const { data: pending, error: pendingErr } = await supa
      .from('rafi_trades')
      .select('id, direction, entry, time, lot, label')
      .eq('entry_type', 'ia_autonoma')
      .is('result', null)
      .gte('time', cutoff)

    if (pendingErr) throw pendingErr

    const pendingTrades = pending ?? []
    log.push(`Trades IA pendentes: ${pendingTrades.length}`)

    if (pendingTrades.length === 0) {
      return NextResponse.json({ reconciled: 0, log })
    }

    // ── 2. Busca deals fechados de todos os brokers ativos ───────────────
    const brokers = await getActiveBrokers()
    if (brokers.length === 0) {
      log.push('Nenhum broker ativo — abortando')
      return NextResponse.json({ reconciled: 0, log })
    }

    // Coleta todos os deals de fechamento de todos os brokers
    const allDealsArrays = await Promise.all(brokers.map(b => fetchClosedDeals(b.accountId)))
    // Agrupa por positionId somando o profit (pode haver múltiplos parciais)
    const dealMap = new Map<string, number>()
    for (const deals of allDealsArrays) {
      for (const d of deals) {
        const existing = dealMap.get(d.positionId) ?? 0
        dealMap.set(d.positionId, existing + d.profit)
      }
    }
    log.push(`Deals fechados encontrados: ${dealMap.size}`)

    // ── 3. Cruza trades pendentes com deals fechados ─────────────────────
    // O trade IA é salvo com id gerado localmente (UUID), não o positionId do MT5.
    // Estratégia: cruzar por janela de tempo (±5 min) e direção.
    // Quando o auto-scan salva o trade, usa Math.floor(Date.now()/1000) como time.
    // O deal de fechamento tem o time de saída — o time de entrada fica ~minutos antes.
    // Usamos os deals de fechamento agregados por profit e tentamos match temporal.

    // Abordagem alternativa mais robusta: o auto-scan vai passar a salvar o positionId
    // retornado pelo MetaAPI na coluna 'label'. Por ora, cruzamos por tempo ±10min.
    let reconciled = 0

    for (const trade of pendingTrades) {
      // Extrai o positionId salvo no campo label pelo auto-scan
      // Formato esperado: 'AutoScan-IA|pos:{positionId}'
      const labelStr = String((trade as any).label ?? '')
      const posMatch = labelStr.match(/\|pos:(\S+)/)
      const positionId = posMatch ? posMatch[1] : null

      if (!positionId) {
        log.push(`Trade ${trade.id}: sem positionId no label — aguardando`)
        continue
      }

      const profit = dealMap.get(positionId)

      if (profit !== undefined) {
        // Deal fechado encontrado — atualiza resultado
        const result: 'win' | 'loss' = profit > 0 ? 'win' : 'loss'
        const { error } = await supa
          .from('rafi_trades')
          .update({ result, pnl_usd: profit, updated_at: new Date().toISOString() })
          .eq('id', trade.id)
        if (!error) {
          reconciled++
          log.push(`Trade ${trade.id} (pos:${positionId}): ${result} $${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`)
        } else {
          log.push(`Erro ao atualizar trade ${trade.id}: ${error.message}`)
        }
      } else {
        log.push(`Trade ${trade.id} (pos:${positionId}): ainda aberto ou deals não encontrados`)
      }
    }

    log.push(`Reconciliados: ${reconciled}/${pendingTrades.length}`)
    return NextResponse.json({ reconciled, total: pendingTrades.length, log })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log.push(`ERRO: ${msg}`)
    return NextResponse.json({ error: msg, log }, { status: 500 })
  }
}
