/**
 * GET /api/admin/broker-execution-quality
 * Calcula métricas reais de qualidade de execução por corretora via MetaAPI:
 * win rate, profit factor, slippage médio, tempo de execução, trades totais.
 * Fonte: history-deals + history-orders dos últimos N dias.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const MA_TOKEN = process.env.METAAPI_TOKEN ?? ''

const TIMEOUT = 8_000

async function maFetch(path: string) {
  const res = await fetch(`${MA_BASE}${path}`, {
    headers: { 'auth-token': MA_TOKEN },
    signal: AbortSignal.timeout(TIMEOUT),
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get('days') ?? '30')

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supaUrl || !supaKey) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })
  if (!MA_TOKEN)            return NextResponse.json({ error: 'METAAPI_TOKEN não configurado' }, { status: 500 })

  const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const { data: brokers, error } = await supa
    .from('rafi_brokers')
    .select('id, nome, metaapi_account_id')
    .eq('enabled', true)
    .not('metaapi_account_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const to   = new Date().toISOString()

  const results = await Promise.allSettled(
    (brokers ?? []).map(async (b: { id: string; nome: string; metaapi_account_id: string }) => {
      try {
        // Busca deals e ordens em paralelo
        const [deals, orders] = await Promise.all([
          maFetch(`/users/current/accounts/${b.metaapi_account_id}/history-deals/time/${from}/${to}`),
          maFetch(`/users/current/accounts/${b.metaapi_account_id}/history-orders/time/${from}/${to}`),
        ])

        if (!Array.isArray(deals)) return { brokerId: b.id, nome: b.nome, noData: true }

        // Filtra apenas deals de saída de posição (resultado real)
        const closingDeals: any[] = deals.filter((d: any) =>
          d.entryType === 'DEAL_ENTRY_OUT' &&
          (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL')
        )

        const totalTrades = closingDeals.length
        if (totalTrades === 0) return { brokerId: b.id, nome: b.nome, noData: true, totalTrades: 0 }

        // Win rate
        const winners = closingDeals.filter((d: any) => (d.profit ?? 0) > 0)
        const losers  = closingDeals.filter((d: any) => (d.profit ?? 0) < 0)
        const winRate = Math.round((winners.length / totalTrades) * 100)

        // Profit factor
        const grossProfit = winners.reduce((s: number, d: any) => s + d.profit, 0)
        const grossLoss   = Math.abs(losers.reduce((s: number, d: any) => s + d.profit, 0))
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0

        // P&L médio por trade
        const totalPnl = closingDeals.reduce((s: number, d: any) => s + (d.profit ?? 0), 0)
        const avgPnl   = totalPnl / totalTrades

        // Slippage: diferença entre openPrice do deal e currentPrice da ordem correspondente
        // (ordens a mercado no MT5 — o fill pode diferir do preço no momento do envio)
        let slippagePips = 0
        let slippageCount = 0
        if (Array.isArray(orders)) {
          // Mapeia ordens por positionId para correlacionar com deals
          const orderMap: Record<string, any> = {}
          for (const o of orders) {
            if (o.positionId) orderMap[o.positionId] = o
          }
          for (const d of closingDeals) {
            const o = orderMap[d.positionId]
            if (o && o.currentPrice != null && d.openPrice != null) {
              // Slippage em pips (EURUSD: 1 pip = 0.0001)
              const slip = Math.abs(d.openPrice - o.currentPrice) * 10000
              if (slip < 20) { // filtra outliers (gaps, etc.)
                slippagePips += slip
                slippageCount++
              }
            }
          }
        }
        const avgSlippagePips = slippageCount > 0 ? slippagePips / slippageCount : null

        // Tempo de execução: doneTime - openTime de ordens preenchidas
        let execTimeMs = 0
        let execCount  = 0
        if (Array.isArray(orders)) {
          for (const o of orders) {
            if (o.state === 'ORDER_STATE_FILLED' && o.openTime && o.doneTime) {
              const ms = new Date(o.doneTime).getTime() - new Date(o.openTime).getTime()
              if (ms >= 0 && ms < 30_000) { // exclui outliers
                execTimeMs += ms
                execCount++
              }
            }
          }
        }
        const avgExecMs = execCount > 0 ? Math.round(execTimeMs / execCount) : null

        return {
          brokerId:       b.id,
          nome:           b.nome,
          noData:         false,
          totalTrades,
          winRate,
          profitFactor:   Math.round(profitFactor * 100) / 100,
          totalPnl:       Math.round(totalPnl * 100) / 100,
          avgPnl:         Math.round(avgPnl * 100) / 100,
          avgSlippagePips: avgSlippagePips !== null ? Math.round(avgSlippagePips * 10) / 10 : null,
          avgExecMs,
          winners:        winners.length,
          losers:         losers.length,
        }
      } catch {
        return { brokerId: b.id, nome: b.nome, noData: true, error: true }
      }
    })
  )

  const data = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean)

  return NextResponse.json({ brokers: data, days, updatedAt: new Date().toISOString() })
}
