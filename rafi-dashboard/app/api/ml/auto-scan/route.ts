/**
 * GET /api/ml/auto-scan
 * Cron job da IA Autônoma — disparado pelo Vercel Cron (vercel.json).
 * Sessões: 02:00 UTC (Sydney/Tóquio) e 07:00 UTC (Tóquio/Londres).
 * Analisa velas M5 recentes, calcula RAFI e BB, e envia ordem se P(sucesso) ≥ 65%.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { calcRAFI, calcBollingerBands, autoScanBreakouts } from '@/lib/indicators'
import { getActiveBrokers } from '@/lib/top-broker'
import { logBrokerEvent } from '@/lib/broker-health'
import { predictXGBoost, type XGBoostModel } from '@/lib/ml/xgboost'
import { extractFeatures, featuresToArray } from '@/lib/ml/features'
import type { CandleData } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 10  // Vercel Hobby: máximo 10s por serverless function

const MARKET_DATA_BASE = process.env.METAAPI_MARKET_DATA_URL
  ?? 'https://mt-market-data-client-api-v1.london.agiliumtrade.ai'
const MT_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN    = process.env.METAAPI_TOKEN!
const BROKER_OFFSET = 3 * 3600  // Pepperstone UTC+3

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function saveScanLog(
  supa: ReturnType<typeof getServiceClient>,
  status: 'executed' | 'skipped' | 'error' | 'phantom',
  reason: string,
  log: string[],
  details: { direction?: string; lot?: number; probability?: number; sessao?: string } = {},
) {
  try {
    await supa.from('rafi_scan_logs').insert({
      time:        Math.floor(Date.now() / 1000),
      status,
      reason,
      direction:   details.direction   ?? null,
      lot:         details.lot         ?? null,
      probability: details.probability ?? null,
      sessao:      details.sessao      ?? null,
      log_lines:   log,
    })
  } catch { /* não bloqueia o scan */ }
}

function rafiBucket(rafi: number): 'forte' | 'moderado' | 'fraco' {
  if (rafi >= 2.5) return 'forte'
  if (rafi >= 1.0) return 'moderado'
  return 'fraco'
}

function sessionLabel(horaUtc: number): string {
  if (horaUtc >= 8  && horaUtc < 12) return 'Londres'
  if (horaUtc >= 13 && horaUtc < 17) return 'NY'
  if (horaUtc >= 23 || horaUtc < 3)  return 'Ásia'
  return 'Overlap'
}

// Soma do PnL de hoje da IA Autônoma
async function getTodayIAPnl(supa: ReturnType<typeof getServiceClient>): Promise<number> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)
  const { data } = await supa
    .from('rafi_trades')
    .select('pnl_usd')
    .eq('entry_type', 'ia_autonoma')
    .gte('time', Math.floor(startOfDay.getTime() / 1000))
  return (data ?? []).reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0)
}

// Soma do PnL desta semana da IA Autônoma (semana começa segunda-feira BRT)
async function getWeekIAPnl(supa: ReturnType<typeof getServiceClient>): Promise<number> {
  const nowBRT   = new Date(Date.now() - 3 * 60 * 60 * 1000)  // UTC-3 Brasília
  const jsDay    = nowBRT.getUTCDay()                          // 0=dom … 6=sab
  const daysMon  = jsDay === 0 ? 6 : jsDay - 1                // dias desde segunda
  const startOfWeek = new Date(nowBRT)
  startOfWeek.setUTCDate(nowBRT.getUTCDate() - daysMon)
  startOfWeek.setUTCHours(0, 0, 0, 0)                         // segunda 00:00 BRT = 03:00 UTC
  const { data } = await supa
    .from('rafi_trades')
    .select('pnl_usd')
    .eq('entry_type', 'ia_autonoma')
    .gte('time', Math.floor(startOfWeek.getTime() / 1000))
  return (data ?? []).reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0)
}

// Conta posições abertas da IA Autônoma hoje (sem label de resultado)
async function getOpenPositionCount(supa: ReturnType<typeof getServiceClient>): Promise<number> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)
  const { count } = await supa
    .from('rafi_trades')
    .select('id', { count: 'exact', head: true })
    .eq('entry_type', 'ia_autonoma')
    .is('result', null)
    .gte('time', Math.floor(startOfDay.getTime() / 1000))
  return count ?? 0
}

// Busca saldo real da conta no MetaAPI
async function fetchAccountBalance(accountId: string): Promise<number> {
  try {
    const url = `${MT_BASE}/users/current/accounts/${accountId}/account-information`
    const res = await fetch(url, {
      headers: { 'auth-token': TOKEN },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!res.ok) return 1000
    const data = await res.json()
    const bal = Number(data.balance ?? data.equity ?? 0)
    return bal > 0 ? bal : 1000
  } catch {
    return 1000  // fallback se MetaAPI não responder
  }
}

// Busca candles M5 do MetaAPI (padrão: últimos 60)
async function fetchCandles(accountId: string, symbol: string, limit = 60): Promise<CandleData[]> {
  const url = `${MARKET_DATA_BASE}/users/current/accounts/${accountId}/historical-market-data/symbols/${symbol}/timeframes/5m/candles?limit=${limit}`
  const res = await fetch(url, {
    headers: { 'auth-token': TOKEN },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`MetaAPI candles ${res.status}: ${await res.text()}`)
  const raw = await res.json()
  const arr = Array.isArray(raw) ? raw : (raw.candles ?? [])
  return arr
    .map((c: any) => ({
      time:   new Date(c.time).getTime() / 1000 + BROKER_OFFSET,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tickVolume ?? c.volume ?? 0,
    }))
    .sort((a: any, b: any) => a.time - b.time)
}

// Busca posições abertas de uma corretora
async function fetchOpenPositions(accountId: string): Promise<{ id: string; symbol: string }[]> {
  try {
    const res = await fetch(`${MT_BASE}/users/current/accounts/${accountId}/positions`, {
      headers: { 'auth-token': TOKEN },
      signal: AbortSignal.timeout(6_000),
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    const arr = Array.isArray(data) ? data : (data.positions ?? [])
    return arr.map((p: any) => ({ id: String(p.id), symbol: String(p.symbol) }))
  } catch {
    return []
  }
}

// Fecha todas as posições abertas em todos os brokers ativos
async function closeAllPositions(
  brokers: { accountId: string; brokerId: string; symbol: string }[],
  log: string[],
): Promise<void> {
  for (const broker of brokers) {
    const positions = await fetchOpenPositions(broker.accountId)
    if (positions.length === 0) {
      log.push(`[${broker.brokerId}] Nenhuma posição aberta`)
      continue
    }
    log.push(`[${broker.brokerId}] Fechando ${positions.length} posição(ões)...`)
    for (const pos of positions) {
      try {
        const res = await fetch(`${MT_BASE}/users/current/accounts/${broker.accountId}/trade`, {
          method: 'POST',
          headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: pos.id, symbol: pos.symbol }),
          signal: AbortSignal.timeout(8_000),
        })
        if (res.ok) {
          log.push(`[${broker.brokerId}] Posição ${pos.id} encerrada ✓`)
          logBrokerEvent(broker.brokerId, 'order', true, 0)
        } else {
          const txt = await res.text()
          log.push(`[${broker.brokerId}] Erro ao fechar posição ${pos.id}: ${txt.slice(0, 100)}`)
          logBrokerEvent(broker.brokerId, 'order', false, 0, txt.slice(0, 100))
        }
      } catch (e) {
        log.push(`[${broker.brokerId}] Timeout ao fechar posição ${pos.id}`)
      }
    }
  }
}

// Reconcilia trades IA pendentes com o histórico do MetaAPI
// Executado no início de cada auto-scan para manter P(sucesso) atualizado
async function reconcileIATrades(
  supa: ReturnType<typeof getServiceClient>,
  brokers: { accountId: string }[],
  log: string[],
): Promise<void> {
  try {
    // Cancela automaticamente pré-registros orphans (label='AutoScan-IA|pending') com >3 min
    // Esses surgem quando a função sofre timeout antes de enviar as ordens
    const orphanCutoff = Math.floor((Date.now() - 3 * 60 * 1000) / 1000)
    const { data: orphaned } = await supa
      .from('rafi_trades')
      .update({ result: 'cancelled' })
      .eq('label', 'AutoScan-IA|pending')
      .is('result', null)
      .lte('time', orphanCutoff)
      .select('id')
    if (orphaned && orphaned.length > 0) log.push(`[reconcile] ${orphaned.length} orphan(s) cancelados`)

    const cutoff = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000)
    const { data: pending } = await supa
      .from('rafi_trades')
      .select('id, label')
      .eq('entry_type', 'ia_autonoma')
      .is('result', null)
      .gte('time', cutoff)

    const pendingTrades = pending ?? []
    if (pendingTrades.length === 0) return

    log.push(`[reconcile] ${pendingTrades.length} trade(s) pendentes`)

    // Busca deals fechados em PARALELO (evita timeout de 10s do Vercel Hobby)
    const startTime = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const endTime   = new Date().toISOString()
    const dealMap   = new Map<string, number>()

    await Promise.allSettled(brokers.map(async (broker) => {
      try {
        const url = `${MT_BASE}/users/current/accounts/${broker.accountId}/history-deals/time/${startTime}/${endTime}`
        const res = await fetch(url, {
          headers: { 'auth-token': TOKEN },
          signal: AbortSignal.timeout(4_000),
          cache: 'no-store',
        })
        if (!res.ok) return
        const data = await res.json()
        const arr  = Array.isArray(data) ? data : (data.deals ?? [])
        for (const d of arr) {
          if (d.entryType !== 'DEAL_ENTRY_OUT' && d.entryType !== 'DEAL_ENTRY_INOUT') continue
          const pid = String(d.positionId ?? d.id)
          dealMap.set(pid, (dealMap.get(pid) ?? 0) + Number(d.profit ?? 0))
        }
      } catch { /* timeout ou broker offline — ignora */ }
    }))

    let reconciled = 0
    for (const trade of pendingTrades) {
      const labelStr  = String((trade as any).label ?? '')
      const posMatch  = labelStr.match(/\|pos:(\S+)/)
      if (!posMatch) continue
      // Soma lucros de TODOS os positionIds (multi-broker) — não apenas o primeiro
      const positionIds = posMatch[1].split(',').filter(Boolean)
      let totalProfit = 0
      let foundAny    = false
      for (const pid of positionIds) {
        const p = dealMap.get(pid)
        if (p !== undefined) { totalProfit += p; foundAny = true }
      }
      if (!foundAny) continue
      const result: 'win' | 'loss' = totalProfit > 0 ? 'win' : 'loss'
      const { error } = await supa
        .from('rafi_trades')
        .update({ result, pnl_usd: totalProfit, updated_at: new Date().toISOString() })
        .eq('id', trade.id)
      if (!error) reconciled++
    }

    if (reconciled > 0) log.push(`[reconcile] ${reconciled} trade(s) atualizados ✓`)
  } catch { /* não bloqueia o scan principal */ }
}

// Envia ordem para uma corretora
async function sendOrder(accountId: string, brokerId: string, symbol: string, payload: Record<string, unknown>) {
  const t0 = Date.now()
  const res = await fetch(`${MT_BASE}/users/current/accounts/${accountId}/trade`, {
    method: 'POST',
    headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, symbol }),
    signal: AbortSignal.timeout(8_000),
  })
  const latency = Date.now() - t0
  if (!res.ok) {
    const text = await res.text()
    logBrokerEvent(brokerId, 'order', false, latency, text.slice(0, 200))
    return { brokerId, ok: false, error: text }
  }
  const result = await res.json()
  logBrokerEvent(brokerId, 'order', true, latency)
  // MetaAPI retorna orderId mas não sempre positionId — para ordens a mercado são equivalentes
  return { brokerId, ok: true, orderId: result?.orderId, positionId: result?.positionId ?? result?.orderId }
}

export async function GET(req: NextRequest) {
  // Valida CRON_SECRET — proteção contra disparos externos
  const auth = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const log: string[] = []
  const timestamp = new Date().toISOString()
  log.push(`[auto-scan] iniciado: ${timestamp}`)

  const supa = getServiceClient()

  try {
    // ── 0. Reconcilia trades IA pendentes (manter P(sucesso) atualizado) ─
    const brokersForReconcile = await getActiveBrokers()
    await reconcileIATrades(supa, brokersForReconcile, log)

    // ── 1. Verifica se IA Autônoma está ativa ──────────────────────────
    const { data: config } = await supa
      .from('rafi_ia_config')
      .select('*')
      .eq('id', 'default')
      .single()

    if (!config?.ia_autonoma_ativa) {
      log.push('IA Autônoma desativada — abortando')
      await saveScanLog(supa, 'skipped', 'IA desativada', log)
      return NextResponse.json({ skipped: true, reason: 'IA desativada', log })
    }

    // ── 2. Identifica sessão atual e verifica toggle ───────────────────
    const horaUtc = new Date().getUTCHours()
    const isSydneyTokyo    = horaUtc >= 23 || horaUtc < 7  // 23:00–07:00 UTC
    const isLondonMorning  = horaUtc >= 7  && horaUtc < 12 // 07:00–12:00 UTC = 04:00–09:00 BRT
    const isLondonNY       = horaUtc >= 12 && horaUtc < 16 // 12:00–16:00 UTC = 09:00–13:00 BRT

    if (isSydneyTokyo && !config.sessao_sydney_tokyo) {
      log.push('Sessão Sydney/Tóquio desativada — abortando')
      await saveScanLog(supa, 'skipped', 'Sessão Sydney/Tóquio desativada', log)
      return NextResponse.json({ skipped: true, reason: 'Sessão Sydney/Tóquio desativada', log })
    }
    if (isLondonMorning && !(config as any).sessao_london_morning) {
      log.push('Sessão Londres manhã desativada — abortando')
      await saveScanLog(supa, 'skipped', 'Sessão Londres manhã desativada', log)
      return NextResponse.json({ skipped: true, reason: 'Sessão Londres manhã desativada', log })
    }
    if (isLondonNY && !(config as any).sessao_london_ny) {
      log.push('Sessão Londres/NY desativada — abortando')
      await saveScanLog(supa, 'skipped', 'Sessão Londres/NY desativada', log)
      return NextResponse.json({ skipped: true, reason: 'Sessão Londres/NY desativada', log })
    }

    const sessao = isSydneyTokyo ? 'Sydney/Tóquio' : isLondonMorning ? 'Londres manhã' : isLondonNY ? 'Londres/NY' : 'fora de sessão'
    log.push(`Sessão ativa: ${sessao}`)

    // ── 3. Verifica limites de risco ───────────────────────────────────
    const brokers = await getActiveBrokers()
    if (brokers.length === 0) {
      await saveScanLog(supa, 'skipped', 'Nenhuma corretora ativa', log)
      return NextResponse.json({ skipped: true, reason: 'Nenhuma corretora ativa', log })
    }

    // Busca saldo real consolidado de todas as contas ativas
    const balances = await Promise.all(brokers.map(b => fetchAccountBalance(b.accountId)))
    const capital = balances.reduce((s, b) => s + b, 0)
    log.push(`Capital consolidado: $${capital.toFixed(2)}`)

    // Meta diária: 7% do capital
    const metaDiariaPct  = Number(config.meta_diaria_pct ?? 7)
    const metaSemanaPct  = Number(config.meta_semanal_pct ?? 25)
    const metaDiariaUsd  = capital * (metaDiariaPct / 100)
    const metaSemanaUsd  = capital * (metaSemanaPct / 100)
    const threshold      = Number(config.threshold_confianca ?? 0.65)
    const xgbMode        = (config.xgboost_mode as string) ?? 'off'

    const pnlHoje    = await getTodayIAPnl(supa)
    const pnlSemana  = await getWeekIAPnl(supa)
    const posAbertas = await getOpenPositionCount(supa)

    log.push(`PnL hoje: $${pnlHoje.toFixed(2)} / meta $${metaDiariaUsd.toFixed(2)}`)
    log.push(`PnL semana: $${pnlSemana.toFixed(2)} / meta $${metaSemanaUsd.toFixed(2)}`)
    log.push(`Posições abertas: ${posAbertas}`)

    if (pnlHoje >= metaDiariaUsd) {
      log.push(`Meta diária atingida ($${pnlHoje.toFixed(2)} >= $${metaDiariaUsd.toFixed(2)}) — encerrando posições e parando`)
      await closeAllPositions(brokers, log)
      await saveScanLog(supa, 'skipped', 'Meta diária atingida', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Meta diária atingida', closed: true, log })
    }
    if (pnlSemana >= metaSemanaUsd) {
      log.push(`Meta semanal atingida ($${pnlSemana.toFixed(2)} >= $${metaSemanaUsd.toFixed(2)}) — encerrando posições e parando até segunda`)
      await closeAllPositions(brokers, log)
      await saveScanLog(supa, 'skipped', 'Meta semanal atingida', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Meta semanal atingida', closed: true, log })
    }
    if (pnlHoje <= -(capital * 0.05)) {
      log.push('Perda máxima diária (5%) atingida — IA para hoje')
      await saveScanLog(supa, 'skipped', 'Perda máxima 5% diária', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Perda máxima 5% diária', log })
    }
    if (posAbertas >= 2) {
      log.push('Máximo de 2 posições simultâneas atingido')
      await saveScanLog(supa, 'skipped', 'Máximo de posições atingido', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Máximo de posições atingido', log })
    }

    // ── 4. Conta trades rotulados para threshold mínimo ────────────────
    const { count: labeledCount } = await supa
      .from('rafi_trades')
      .select('id', { count: 'exact', head: true })
      .in('result', ['win', 'loss'])

    if ((labeledCount ?? 0) < 10) {
      log.push(`Poucos trades rotulados: ${labeledCount} (mínimo 10)`)
      await saveScanLog(supa, 'skipped', 'Poucos trades rotulados', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Poucos trades rotulados', log })
    }

    // ── 5. Busca candles e detecta rompimentos ─────────────────────────
    const { accountId, symbol } = brokers[0]
    const candles = await fetchCandles(accountId, symbol, 60)
    log.push(`Candles carregados: ${candles.length}`)

    if (candles.length < 30) {
      await saveScanLog(supa, 'skipped', 'Candles insuficientes', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Candles insuficientes', log })
    }

    const breakouts = autoScanBreakouts(candles)
    if (breakouts.length === 0) {
      log.push('Nenhum rompimento detectado')
      await saveScanLog(supa, 'skipped', 'Sem rompimentos detectados', log, { sessao })
      return NextResponse.json({ skipped: true, reason: 'Sem rompimentos detectados', log })
    }

    // Pega o rompimento mais recente
    const latest = breakouts[breakouts.length - 1]
    const { direction, entry, stopLoss, takeProfit, rafi, rafiDir, bbWidth } = latest
    const rafiAbs = Math.abs(rafi)
    log.push(`Rompimento: ${direction} entry=${entry} rafi=${rafiAbs.toFixed(2)} dir=${rafiDir}`)

    // ── 6. Calcula probabilidade de sucesso (mesmo algoritmo do /api/ml/signal) ──
    const { data: tradeRows } = await supa
      .from('rafi_trades')
      .select('rafi, direction, result, time')
      .in('result', ['win', 'loss'])

    const trades = tradeRows ?? []
    const meuBucket = rafiBucket(rafiAbs)
    const minhaSessao = sessionLabel(horaUtc)

    const similar = trades.filter(t => {
      const tBucket = rafiBucket(Number(t.rafi ?? 0))
      return tBucket === meuBucket && t.direction === direction
    })

    const comSessao = similar.filter(t => {
      const h = new Date(Number(t.time) * 1000).getUTCHours()
      return sessionLabel(h) === minhaSessao
    })

    const grupo = comSessao.length >= 3 ? comSessao : similar

    if (grupo.length < 3) {
      log.push(`Trades similares insuficientes: ${grupo.length}`)
      await saveScanLog(supa, 'skipped', 'Poucos trades similares', log, { sessao, direction })
      return NextResponse.json({ skipped: true, reason: 'Poucos trades similares', log })
    }

    const wins    = grupo.filter(t => t.result === 'win').length
    const simProb = wins / grupo.length
    log.push(`P(similaridade): ${Math.round(simProb * 100)}% (${wins}/${grupo.length}) — threshold ${Math.round(threshold * 100)}%`)

    // ── XGBoost (quando modo não é 'off') ─────────────────────────────
    let xgbProb: number | null = null
    let xgbOk = false

    if (xgbMode !== 'off' && (labeledCount ?? 0) >= 50) {
      const { data: modelRow } = await supa
        .from('rafi_ml_models')
        .select('model_json')
        .eq('name', 'xgboost_ts')
        .single()

      if (modelRow?.model_json) {
        const model = modelRow.model_json as XGBoostModel
        const feats = featuresToArray(extractFeatures({
          rafi: rafiAbs, direction,
          time: Math.floor(Date.now() / 1000),
          bb_width: bbWidth ?? null,
        }))
        xgbProb = predictXGBoost(model, feats)
        xgbOk   = xgbProb >= threshold
        log.push(`P(XGBoost): ${Math.round(xgbProb * 100)}% — modo ${xgbMode}`)
      } else {
        log.push('Modelo XGBoost não encontrado — usando similaridade')
      }
    }

    // Decisão por modo
    let proceed = false
    if (xgbMode === 'off' || xgbMode === 'shadow') {
      proceed = simProb >= threshold
    } else if (xgbMode === 'and') {
      proceed = simProb >= threshold && xgbOk
    } else if (xgbMode === 'xgboost') {
      proceed = xgbProb != null ? xgbOk : simProb >= threshold
    }

    const prob = xgbMode === 'xgboost' && xgbProb != null ? xgbProb : simProb

    if (!proceed) {
      log.push('Probabilidade abaixo do threshold — sem ordem')
      await saveScanLog(supa, 'skipped', `P(sucesso)=${Math.round(prob * 100)}% < ${Math.round(threshold * 100)}%`, log, { sessao, direction, probability: Math.round(prob * 100) })
      return NextResponse.json({ skipped: true, reason: `P(sucesso)=${Math.round(prob * 100)}% < ${Math.round(threshold * 100)}%`, log })
    }

    // ── 7. Calcula lote e envia ordens ────────────────────────────────
    const LOT_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]
    const COMM_PER  = 0.35
    const dailyGoal = capital * (metaDiariaPct / 100)
    const perBroker = dailyGoal / brokers.length
    let lot = 0.10
    for (const l of LOT_STEPS) {
      const p = (perBroker + COMM_PER) / (l * 10)
      if (p >= 4 && p <= 80) { lot = l; break }
    }

    const actionType = direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL'
    const payload = {
      actionType,
      volume: lot,
      stopLoss,
      takeProfit,
      comment: `IA|P${Math.round(prob * 100)}%|${sessao.replace('Sydney/', 'Syd/').replace('Tóquio/', 'Tok/').replace('/Londres', '/Lon')}`.slice(0, 31),
    }

    log.push(`Enviando ordem: ${actionType} ${lot} lotes SL=${stopLoss} TP=${takeProfit}`)

    // ── 8a. Registra o trade ANTES de enviar ordens ───────────────────
    // Garante que mesmo em timeout o registro existe para reconcile futuro.
    // O label é atualizado com os positionIds após as ordens serem executadas.
    const tradeId = crypto.randomUUID()
    const agora   = Math.floor(Date.now() / 1000)
    const preRecord = {
      id: tradeId,
      direction,
      entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      label: 'AutoScan-IA|pending',  // atualizado abaixo com positionIds reais
      time: agora,
      lot,
      result: null,
      entry_type: 'ia_autonoma',
      rafi: rafiAbs,
      rafi_dir: rafiDir,
      bb_width: bbWidth ?? null,
    }
    const { error: preErr } = await supa.from('rafi_trades').insert(preRecord)
    if (preErr) log.push(`Aviso: erro ao pré-registrar trade: ${preErr.message}`)
    else log.push('Trade pré-registrado no Supabase')

    // ── 8b. Envia ordens para todas as corretoras ─────────────────────
    const results = await Promise.allSettled(
      brokers.map(b => sendOrder(b.accountId, b.brokerId, b.symbol, payload))
    )
    const parsed = results.map(r =>
      r.status === 'fulfilled' ? r.value : { brokerId: '?', ok: false, error: String((r as PromiseRejectedResult).reason) }
    )
    const anyOk = parsed.some(r => r.ok)

    if (!anyOk) {
      // Nenhuma corretora executou — remove o pré-registro para não poluir o histórico
      await supa.from('rafi_trades').delete().eq('id', tradeId)
      log.push('ERRO: nenhuma corretora executou a ordem — pré-registro removido')
      await saveScanLog(supa, 'error', 'Nenhuma corretora executou a ordem', log, { sessao, direction, lot, probability: Math.round(prob * 100) })
      return NextResponse.json({ error: 'Nenhuma corretora executou a ordem', details: parsed, log }, { status: 500 })
    }

    // ── 8c. Atualiza label com positionIds reais (multi-broker) ───────
    // Formato: 'AutoScan-IA|pos:id1,id2,id3,id4' — usado pelo reconcile
    const allPositionIds = (parsed as Array<{ ok: boolean; positionId?: string }>)
      .filter(r => r.ok && r.positionId)
      .map(r => r.positionId!)
    const positionId = allPositionIds[0] ?? null
    const finalLabel = allPositionIds.length > 0 ? `AutoScan-IA|pos:${allPositionIds.join(',')}` : 'AutoScan-IA|sem-positionId'

    // Se nenhum broker retornou positionId, a posição não abriu — cancela o registro
    if (allPositionIds.length === 0) {
      await supa.from('rafi_trades').update({ result: 'cancelled', label: finalLabel }).eq('id', tradeId)
      log.push('Aviso: ordens enviadas mas sem positionIds — trade marcado como cancelled')
      await saveScanLog(supa, 'phantom', 'Ordens enviadas mas sem positionIds retornados', log, { sessao, direction, lot, probability: Math.round(prob * 100) })
    } else {
      const { error: updateErr } = await supa.from('rafi_trades').update({ label: finalLabel }).eq('id', tradeId)
      if (updateErr) log.push(`Aviso: erro ao atualizar positionIds: ${updateErr.message}`)
      else log.push(`Label atualizado: ${finalLabel}`)
      await saveScanLog(supa, 'executed', `Ordem ${direction.toUpperCase()} executada em ${parsed.filter(r => r.ok).length}/${brokers.length} corretoras`, log, { sessao, direction, lot, probability: Math.round(prob * 100) })
    }

    log.push(`Concluído: ${parsed.filter(r => r.ok).length}/${brokers.length} corretoras executaram · positionIds: ${allPositionIds.join(', ') || 'nenhum'}`)

    return NextResponse.json({
      executed: true,
      direction,
      entry,
      stopLoss,
      takeProfit,
      lot,
      probability: Math.round(prob * 100),
      sessao,
      replication: parsed,
      log,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log.push(`ERRO FATAL: ${msg}`)
    await saveScanLog(supa, 'error', `Erro fatal: ${msg.slice(0, 120)}`, log)
    return NextResponse.json({ error: msg, log }, { status: 500 })
  }
}
