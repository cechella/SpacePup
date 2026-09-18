/**
 * GET /api/brokers/ranking
 *
 * Ranking 100% baseado em dados reais de execução (MetaAPI + Supabase).
 * Critérios (sem números manuais):
 *   1. P&L Líquido   — lucro real após comissão e swap (peso 25%)
 *   2. Win Rate       — % de trades lucrativos (peso 20%)
 *   3. Profit Factor  — soma lucros ÷ soma perdas (peso 20%)
 *   4. Comissão/lote  — menor taxa = melhor (peso 15%)
 *   5. Swap/deal      — menor custo overnight = melhor (peso 10%)
 *   6. Exec Score DB  — nota histórica de execução no Supabase (peso 7%)
 *   7. Velocidade     — ping ao vivo em ms, menor = melhor (peso 3%)
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const MA_TOKEN = process.env.METAAPI_TOKEN ?? ''

const SYMBOL_MAP: Record<string, string> = {
  exness: 'EURUSDz', pepperstone: 'EURUSD', tickmill: 'EURUSD', icmarkets: 'EURUSD',
}

// ── Normalização 0-100 relativa ao grupo (melhor = 100, pior = 0) ──────────
function normalizeGroup(values: number[], higherIsBetter: boolean): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return values.map(() => 100) // todos iguais = todos no máximo
  return values.map(v =>
    higherIsBetter ? ((v - min) / (max - min)) * 100 : ((max - v) / (max - min)) * 100,
  )
}

// ── Métricas calculadas dos deals ──────────────────────────────────────────
interface Metrics {
  pnlNet:        number  // P&L líquido (profit + commission + swap)
  pnlToday:      number  // P&L só do dia (para exibição)
  winRate:       number  // 0-100
  profitFactor:  number  // razão lucros/perdas
  commPerLot:    number  // comissão média por lote (abs)
  swapPerDeal:   number  // swap médio por deal (abs)
  totalDeals:    number
  execScore:     number  // 0-100 (do Supabase rafi_execution_quality)
  pingMs:        number  // latência média em ms
}

function calcMetrics(deals: any[], todayTs: number): Omit<Metrics, 'execScore' | 'pingMs'> {
  // Apenas deals de fechamento (DEAL_ENTRY_OUT) com tipo trade real
  const closing = deals.filter(d =>
    d.entryType === 'DEAL_ENTRY_OUT' &&
    (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
  )

  if (closing.length === 0) {
    return { pnlNet: 0, pnlToday: 0, winRate: 0, profitFactor: 0, commPerLot: 0, swapPerDeal: 0, totalDeals: 0 }
  }

  let grossProfit  = 0
  let grossLoss    = 0
  let totalComm    = 0
  let totalSwap    = 0
  let totalVolume  = 0
  let wins         = 0
  let pnlToday     = 0
  let swapDeals    = 0

  for (const d of closing) {
    const profit = d.profit ?? 0
    const comm   = d.commission ?? 0    // negativo
    const swap   = d.swap ?? 0          // negativo ou zero
    const vol    = d.volume ?? 0
    const ts     = new Date(d.time ?? d.brokerTime ?? 0).getTime()

    const net = profit + comm + swap

    if (profit > 0) { grossProfit += profit; wins++ }
    else if (profit < 0) { grossLoss += Math.abs(profit) }

    totalComm   += Math.abs(comm)
    if (swap !== 0) { totalSwap += Math.abs(swap); swapDeals++ }
    totalVolume += vol

    if (ts >= todayTs) pnlToday += net
  }

  const pnlNet       = closing.reduce((s, d) => s + (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0), 0)
  const winRate      = (wins / closing.length) * 100
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 1
  const commPerLot   = totalVolume > 0 ? totalComm / totalVolume : 0
  const swapPerDeal  = swapDeals > 0   ? totalSwap / swapDeals   : 0

  return { pnlNet, pnlToday, winRate, profitFactor, commPerLot, swapPerDeal, totalDeals: closing.length }
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase não configurado' }, { status: 500 })

  const supa = createClient(url, key, { auth: { persistSession: false } })

  // 1. Busca corretoras habilitadas + estado de saúde
  const { data, error } = await supa
    .from('rafi_brokers')
    .select(`id, nome, enabled, metaapi_account_id, broker_health_state ( estado, circuit_breaker )`)
    .eq('enabled', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 2. Busca exec score e ping do Supabase
  const { data: qualityRows } = await supa
    .from('rafi_execution_quality')
    .select('broker_id, exec_score, exec_time_ms, win_rate, profit_factor')
  const qualityMap: Record<string, { exec_score: number; exec_time_ms: number }> = {}
  for (const q of qualityRows ?? []) {
    qualityMap[q.broker_id] = { exec_score: q.exec_score ?? 50, exec_time_ms: q.exec_time_ms ?? 999 }
  }

  // 3. Busca ping ao vivo (última métrica de latência por broker)
  const { data: pingRows } = await supa
    .from('broker_health_metrics')
    .select('broker_id, latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  const pingMap: Record<string, number> = {}
  for (const p of pingRows ?? []) {
    if (!pingMap[p.broker_id] && p.latency_ms) pingMap[p.broker_id] = p.latency_ms
  }

  const brokers = (data as any[]).map(b => {
    const h          = Array.isArray(b.broker_health_state) ? b.broker_health_state[0] : b.broker_health_state
    const estado     = h?.estado ?? 'STANDBY'
    const cbClosed   = (h?.circuit_breaker ?? 'CLOSED') === 'CLOSED'
    const eligible   = estado !== 'QUARANTINED' && cbClosed
    return { id: b.id as string, nome: b.nome as string, symbol: SYMBOL_MAP[b.id] ?? 'EURUSD', accountId: b.metaapi_account_id as string, estado, circuitBreaker: h?.circuit_breaker ?? 'CLOSED', eligible }
  })

  // 4. Busca deals dos últimos 30 dias em paralelo
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const todayTs  = today.getTime()
  const from30d  = new Date(todayTs - 30 * 24 * 3600 * 1000).toISOString()
  const toNow    = new Date().toISOString()

  const metricsMap: Record<string, Metrics> = {}

  if (MA_TOKEN) {
    await Promise.allSettled(
      brokers.filter(b => b.eligible && b.accountId).map(async b => {
        try {
          const res = await fetch(
            `${MA_BASE}/users/current/accounts/${b.accountId}/history-deals/time/${from30d}/${toNow}`,
            { headers: { 'auth-token': MA_TOKEN }, signal: AbortSignal.timeout(6_000), cache: 'no-store' },
          )
          const deals: any[] = res.ok ? await res.json() : []

          // P&L flutuante (posições abertas agora)
          let floatingPnl = 0
          try {
            const pRes = await fetch(
              `${MA_BASE}/users/current/accounts/${b.accountId}/positions`,
              { headers: { 'auth-token': MA_TOKEN }, signal: AbortSignal.timeout(4_000) },
            )
            if (pRes.ok) {
              const pos: any[] = await pRes.json()
              floatingPnl = Array.isArray(pos) ? pos.reduce((s, p) => s + (p.profit ?? 0), 0) : 0
            }
          } catch { /* silencioso */ }

          const m = calcMetrics(Array.isArray(deals) ? deals : [], todayTs)
          metricsMap[b.id] = {
            ...m,
            pnlToday: m.pnlToday + floatingPnl,
            execScore: qualityMap[b.id]?.exec_score ?? 50,
            pingMs:    pingMap[b.id] ?? 999,
          }
        } catch {
          metricsMap[b.id] = { pnlNet: 0, pnlToday: 0, winRate: 0, profitFactor: 0, commPerLot: 0, swapPerDeal: 0, totalDeals: 0, execScore: 50, pingMs: 999 }
        }
      }),
    )
  }

  const eligible = brokers.filter(b => b.eligible)

  // 5. Calcula score composto 0-100 com 7 critérios reais
  const ids         = eligible.map(b => b.id)
  const pnlNets     = ids.map(id => metricsMap[id]?.pnlNet     ?? 0)
  const winRates    = ids.map(id => metricsMap[id]?.winRate     ?? 0)
  const pfs         = ids.map(id => Math.min(metricsMap[id]?.profitFactor ?? 1, 10)) // cap 10x
  const comms       = ids.map(id => metricsMap[id]?.commPerLot  ?? 0)
  const swaps       = ids.map(id => metricsMap[id]?.swapPerDeal ?? 0)
  const execScores  = ids.map(id => metricsMap[id]?.execScore   ?? 50)
  const pings       = ids.map(id => metricsMap[id]?.pingMs      ?? 999)

  const normPnl    = normalizeGroup(pnlNets,    true)   // maior P&L = melhor
  const normWR     = normalizeGroup(winRates,   true)   // maior WR = melhor
  const normPF     = normalizeGroup(pfs,        true)   // maior PF = melhor
  const normComm   = normalizeGroup(comms,      false)  // menor comissão = melhor
  const normSwap   = normalizeGroup(swaps,      false)  // menor swap = melhor
  const normExec   = normalizeGroup(execScores, true)   // maior exec score = melhor
  const normPing   = normalizeGroup(pings,      false)  // menor ping = melhor

  const scoreMap: Record<string, number> = {}
  ids.forEach((id, i) => {
    scoreMap[id] = Math.round(
      normPnl[i]  * 0.25 +
      normWR[i]   * 0.20 +
      normPF[i]   * 0.20 +
      normComm[i] * 0.15 +
      normSwap[i] * 0.10 +
      normExec[i] * 0.07 +
      normPing[i] * 0.03,
    )
  })

  // 6. Ordena: elegíveis por score DESC, inelegíveis no fim
  const ranked = [...brokers].sort((a, b) => {
    if (!a.eligible && !b.eligible) return 0
    if (!a.eligible) return 1
    if (!b.eligible) return -1
    return (scoreMap[b.id] ?? 0) - (scoreMap[a.id] ?? 0)
  })

  // 7. Gera texto explicativo do "por quê"
  function fmtPnl(v: number) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)} USD` }

  const result = ranked.map((b, i) => {
    const m    = metricsMap[b.id]
    const sc   = scoreMap[b.id] ?? 0
    const prev = ranked[i - 1]
    const mPrev = prev ? metricsMap[prev.id] : null

    let reason = ''

    if (!b.eligible) {
      reason = b.circuitBreaker !== 'CLOSED'
        ? 'Circuit Breaker ABERTO — excluída do ranking'
        : `Estado ${b.estado} — fora do ranking ativo`
    } else if (i === 0) {
      // Identifica qual critério foi decisivo para o #1
      const decisive: string[] = []
      if (m) {
        if (m.pnlNet    === Math.max(...ids.map(id => metricsMap[id]?.pnlNet ?? 0)))       decisive.push(`P&L líquido ${fmtPnl(m.pnlNet)} (melhor dos 30d)`)
        if (m.winRate   === Math.max(...ids.map(id => metricsMap[id]?.winRate ?? 0)))        decisive.push(`Win Rate ${m.winRate.toFixed(0)}% (maior)`)
        if (m.commPerLot === Math.min(...ids.map(id => metricsMap[id]?.commPerLot ?? 999))) decisive.push(`Comissão $${m.commPerLot.toFixed(2)}/lote (menor)`)
        if (m.pingMs    === Math.min(...ids.map(id => metricsMap[id]?.pingMs ?? 999)))       decisive.push(`Ping ${m.pingMs}ms (mais rápido)`)
      }
      reason = `Score ${sc}/100 — ${decisive.length ? decisive[0] + ' ← decisivo' : 'melhor combinação de critérios'}\nP&L hoje: ${fmtPnl(m?.pnlToday ?? 0)} · WR: ${(m?.winRate ?? 0).toFixed(0)}% · PF: ${(m?.profitFactor ?? 0).toFixed(2)} · Comm: $${(m?.commPerLot ?? 0).toFixed(2)}/lote · Deals: ${m?.totalDeals ?? 0}`
    } else {
      const diff = sc - (scoreMap[prev?.id] ?? 0)
      reason = `Score ${sc}/100 (${diff} pts abaixo de ${prev?.nome})\nP&L hoje: ${fmtPnl(m?.pnlToday ?? 0)} · WR: ${(m?.winRate ?? 0).toFixed(0)}% · PF: ${(m?.profitFactor ?? 0).toFixed(2)} · Comm: $${(m?.commPerLot ?? 0).toFixed(2)}/lote · Deals: ${m?.totalDeals ?? 0}`
    }

    return {
      id:             b.id,
      nome:           b.nome,
      symbol:         b.symbol,
      estado:         b.estado,
      estadoLabel:    b.estado === 'ACTIVE' ? 'Ativo' : b.estado === 'STANDBY' ? 'Standby' : b.estado,
      circuitBreaker: b.circuitBreaker,
      healthScore:    scoreMap[b.id] ?? 0,  // reutiliza healthScore para o score composto
      priority:       i + 1,                 // rank real
      eligible:       b.eligible,
      rank:           i + 1,
      reason,
      pnlHoje:        m?.pnlToday ?? 0,
      // Métricas detalhadas para o tooltip
      metrics: m ? {
        pnlNet:       m.pnlNet,
        winRate:      m.winRate,
        profitFactor: m.profitFactor,
        commPerLot:   m.commPerLot,
        swapPerDeal:  m.swapPerDeal,
        totalDeals:   m.totalDeals,
        execScore:    m.execScore,
        pingMs:       m.pingMs,
        score:        sc,
      } : null,
    }
  })

  return NextResponse.json({ brokers: result, updatedAt: new Date().toISOString() })
}
