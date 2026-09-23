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

// Soma do PnL desta semana da IA Autônoma
async function getWeekIAPnl(supa: ReturnType<typeof getServiceClient>): Promise<number> {
  const now = new Date()
  const day = now.getUTCDay()  // 0 = domingo
  const startOfWeek = new Date(now)
  startOfWeek.setUTCDate(now.getUTCDate() - day)
  startOfWeek.setUTCHours(0, 0, 0, 0)
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
  return { brokerId, ok: true, orderId: result?.orderId, positionId: result?.positionId }
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

  try {
    const supa = getServiceClient()

    // ── 1. Verifica se IA Autônoma está ativa ──────────────────────────
    const { data: config } = await supa
      .from('rafi_ia_config')
      .select('*')
      .eq('id', 'default')
      .single()

    if (!config?.ia_autonoma_ativa) {
      log.push('IA Autônoma desativada — abortando')
      return NextResponse.json({ skipped: true, reason: 'IA desativada', log })
    }

    // ── 2. Identifica sessão atual e verifica toggle ───────────────────
    const horaUtc = new Date().getUTCHours()
    const isSydneyTokyo  = horaUtc >= 23 || horaUtc < 4  // 23:00–04:00 UTC
    const isTokyoLondon  = horaUtc >= 4  && horaUtc < 9   // 04:00–09:00 UTC

    if (isSydneyTokyo && !config.sessao_sydney_tokyo) {
      log.push('Sessão Sydney/Tóquio desativada — abortando')
      return NextResponse.json({ skipped: true, reason: 'Sessão Sydney/Tóquio desativada', log })
    }
    if (isTokyoLondon && !config.sessao_tokyo_london) {
      log.push('Sessão Tóquio/Londres desativada — abortando')
      return NextResponse.json({ skipped: true, reason: 'Sessão Tóquio/Londres desativada', log })
    }

    const sessao = isSydneyTokyo ? 'Sydney/Tóquio' : 'Tóquio/Londres'
    log.push(`Sessão ativa: ${sessao}`)

    // ── 3. Verifica limites de risco ───────────────────────────────────
    const brokers = await getActiveBrokers()
    if (brokers.length === 0) {
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

    const pnlHoje    = await getTodayIAPnl(supa)
    const pnlSemana  = await getWeekIAPnl(supa)
    const posAbertas = await getOpenPositionCount(supa)

    log.push(`PnL hoje: $${pnlHoje.toFixed(2)} / meta $${metaDiariaUsd.toFixed(2)}`)
    log.push(`PnL semana: $${pnlSemana.toFixed(2)} / meta $${metaSemanaUsd.toFixed(2)}`)
    log.push(`Posições abertas: ${posAbertas}`)

    if (pnlHoje >= metaDiariaUsd) {
      log.push(`Meta diária atingida ($${pnlHoje.toFixed(2)} >= $${metaDiariaUsd.toFixed(2)}) — encerrando posições e parando`)
      await closeAllPositions(brokers, log)
      return NextResponse.json({ skipped: true, reason: 'Meta diária atingida', closed: true, log })
    }
    if (pnlSemana >= metaSemanaUsd) {
      log.push(`Meta semanal atingida ($${pnlSemana.toFixed(2)} >= $${metaSemanaUsd.toFixed(2)}) — encerrando posições e parando até segunda`)
      await closeAllPositions(brokers, log)
      return NextResponse.json({ skipped: true, reason: 'Meta semanal atingida', closed: true, log })
    }
    if (pnlHoje <= -(capital * 0.05)) {
      log.push('Perda máxima diária (5%) atingida — IA para hoje')
      return NextResponse.json({ skipped: true, reason: 'Perda máxima 5% diária', log })
    }
    if (posAbertas >= 2) {
      log.push('Máximo de 2 posições simultâneas atingido')
      return NextResponse.json({ skipped: true, reason: 'Máximo de posições atingido', log })
    }

    // ── 4. Conta trades rotulados para threshold mínimo ────────────────
    const { count: labeledCount } = await supa
      .from('rafi_trades')
      .select('id', { count: 'exact', head: true })
      .in('result', ['win', 'loss'])

    if ((labeledCount ?? 0) < 10) {
      log.push(`Poucos trades rotulados: ${labeledCount} (mínimo 10)`)
      return NextResponse.json({ skipped: true, reason: 'Poucos trades rotulados', log })
    }

    // ── 5. Busca candles e detecta rompimentos ─────────────────────────
    const { accountId, symbol } = brokers[0]
    const candles = await fetchCandles(accountId, symbol, 60)
    log.push(`Candles carregados: ${candles.length}`)

    if (candles.length < 30) {
      return NextResponse.json({ skipped: true, reason: 'Candles insuficientes', log })
    }

    const breakouts = autoScanBreakouts(candles)
    if (breakouts.length === 0) {
      log.push('Nenhum rompimento detectado')
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
      return NextResponse.json({ skipped: true, reason: 'Poucos trades similares', log })
    }

    const wins = grupo.filter(t => t.result === 'win').length
    const prob = wins / grupo.length
    log.push(`P(sucesso): ${Math.round(prob * 100)}% (${wins}/${grupo.length}) — threshold ${Math.round(threshold * 100)}%`)

    if (prob < threshold) {
      log.push('Probabilidade abaixo do threshold — sem ordem')
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
      comment: `AutoScan-IA | P${Math.round(prob * 100)}% | ${sessao}`,
    }

    log.push(`Enviando ordem: ${actionType} ${lot} lotes SL=${stopLoss} TP=${takeProfit}`)

    const results = await Promise.allSettled(
      brokers.map(b => sendOrder(b.accountId, b.brokerId, b.symbol, payload))
    )
    const parsed = results.map(r =>
      r.status === 'fulfilled' ? r.value : { brokerId: '?', ok: false, error: String((r as PromiseRejectedResult).reason) }
    )
    const anyOk = parsed.some(r => r.ok)

    if (!anyOk) {
      log.push('ERRO: nenhuma corretora executou a ordem')
      return NextResponse.json({ error: 'Nenhuma corretora executou a ordem', details: parsed, log }, { status: 500 })
    }

    // ── 8. Registra o trade no Supabase ───────────────────────────────
    // Extrai o positionId do primeiro broker que executou com sucesso
    // para que o reconcile-ia possa cruzar com o histórico de deals do MetaAPI
    const firstOk = parsed.find(r => r.ok) as { brokerId: string; ok: true; positionId?: string } | undefined
    const positionId = firstOk?.positionId ?? null

    const agora = Math.floor(Date.now() / 1000)
    const tradeRecord = {
      direction,
      entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      // Formato: 'AutoScan-IA|pos:{positionId}' — usado pelo reconcile-ia para cruzar deals
      label: positionId ? `AutoScan-IA|pos:${positionId}` : 'AutoScan-IA',
      time: agora,
      lot,
      result: null,  // preenchido pelo reconcile-ia quando fechar no MT5
      entry_type: 'ia_autonoma',
      rafi: rafiAbs,
      rafi_dir: rafiDir,
      bb_width: bbWidth ?? null,
    }

    const { error: insertErr } = await supa.from('rafi_trades').insert(tradeRecord)
    if (insertErr) log.push(`Aviso: erro ao registrar trade: ${insertErr.message}`)
    else log.push(`Trade registrado no Supabase (positionId: ${positionId ?? 'não retornado'})`)

    log.push(`Concluído: ordem enviada com sucesso para ${parsed.filter(r => r.ok).length}/${brokers.length} corretoras`)

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
    return NextResponse.json({ error: msg, log }, { status: 500 })
  }
}
