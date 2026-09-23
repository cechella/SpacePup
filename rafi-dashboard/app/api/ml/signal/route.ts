/**
 * POST /api/ml/signal
 * Avalia condições atuais do mercado.
 * Modos XGBoost: off (similaridade), shadow (similaridade + log XGB), and (ambos devem concordar), xgboost (só XGB).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { predictXGBoost, type XGBoostModel } from '@/lib/ml/xgboost'
import { extractFeatures, featuresToArray } from '@/lib/ml/features'

const LOT_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00]
const COMM_PER  = 0.35

function calcLotFromMeta(capital: number, brokerCount: number, dailyTargetPct: number) {
  const n         = Math.max(brokerCount, 1)
  const dailyGoal = capital * (dailyTargetPct / 100)
  const perBroker = dailyGoal / n

  let lot = 0.10
  for (const l of LOT_STEPS) {
    const p = (perBroker + COMM_PER) / (l * 10)
    if (p >= 4 && p <= 80) { lot = l; break }
  }

  const tpPips = Math.max(Math.round((perBroker + COMM_PER) / (lot * 10)), 4)
  const slPips = Math.max(Math.round(tpPips / 1.5), 3)
  return { lot, tpPips, slPips, perBroker }
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase não configurado')
  return createClient(url, key, { auth: { persistSession: false } })
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

interface SignalBody {
  rafi:            number
  bbWidth?:        number
  direction:       'buy' | 'sell'
  currentPrice:    number
  horaUtc:         number
  diaSemana?:      number
  capital?:        number
  brokerCount?:    number
  dailyTargetPct?: number
  checkinSono?:    string | null
  checkinEnergia?: string | null
  checkinMental?:  string | null
  checkinHumor?:   string | null
  labeled_count:   number
}

export async function POST(req: NextRequest) {
  try {
    const body: SignalBody = await req.json()
    const {
      rafi, direction, currentPrice, horaUtc,
      capital = 100, brokerCount = 1, dailyTargetPct = 7,
      labeled_count,
      checkinSono, checkinEnergia, checkinMental, checkinHumor,
      bbWidth,
    } = body

    if (labeled_count < 10) {
      return NextResponse.json({ suggestion: false, reason: `Aguardando 10 trades (atual: ${labeled_count})` })
    }

    const supa = getServiceClient()

    // Lê config para obter o modo XGBoost ativo
    const { data: iaConfig } = await supa
      .from('rafi_ia_config')
      .select('xgboost_mode, threshold_confianca')
      .eq('id', 'default')
      .single()

    const xgbMode  = (iaConfig?.xgboost_mode as string) ?? 'off'
    const threshold = Number(iaConfig?.threshold_confianca ?? 0.65)

    // Busca trades rotulados
    const { data: rows, error } = await supa
      .from('rafi_trades')
      .select('rafi, bb_width, direction, result, time, checkin_sono, checkin_energia, checkin_mental, checkin_humor')
      .in('result', ['win', 'loss'])
    if (error) throw error

    const trades      = rows ?? []
    const totalLabeled = trades.length
    if (totalLabeled < 10) {
      return NextResponse.json({ suggestion: false, reason: 'Poucos trades no banco' })
    }

    // ── Similaridade estatística (sempre calculada) ─────────────────────
    const meuBucket   = rafiBucket(rafi)
    const minhaSessao = sessionLabel(horaUtc)
    const bomEstado   = !checkinSono || (
      checkinSono    !== 'mal'   &&
      checkinMental  !== 'ruim'  &&
      checkinHumor   !== 'triste' &&
      checkinEnergia !== 'baixa'
    )

    const similar = trades.filter(t => {
      const tBucket = rafiBucket(Number(t.rafi ?? 0))
      return tBucket === meuBucket && t.direction === direction
    })

    const comSessao = similar.filter(t => {
      const h = new Date(Number(t.time) * 1000).getUTCHours()
      return sessionLabel(h) === minhaSessao
    })

    const grupo = comSessao.length >= 3 ? comSessao : similar
    const similarityOk = grupo.length >= 3
    const wins  = similarityOk ? grupo.filter(t => t.result === 'win').length : 0
    const total = grupo.length
    const simProb = similarityOk ? wins / total : 0

    // ── XGBoost (quando modo não é 'off') ─────────────────────────────
    let xgbProb: number | null = null
    let xgbOk = false

    if (xgbMode !== 'off' && totalLabeled >= 50) {
      const { data: modelRow } = await supa
        .from('rafi_ml_models')
        .select('model_json')
        .eq('name', 'xgboost_ts')
        .single()

      if (modelRow?.model_json) {
        const model = modelRow.model_json as XGBoostModel
        const feats = featuresToArray(extractFeatures({
          rafi,
          direction,
          time: Math.floor(Date.now() / 1000),
          bb_width: bbWidth,
          checkin_sono:    checkinSono    ?? null,
          checkin_energia: checkinEnergia ?? null,
          checkin_mental:  checkinMental  ?? null,
          checkin_humor:   checkinHumor   ?? null,
        }))
        xgbProb = predictXGBoost(model, feats)
        xgbOk   = xgbProb >= threshold
      }
    }

    // ── Decisão por modo ──────────────────────────────────────────────
    let suggest = false
    let activeProb = simProb
    let modoUsado = 'similaridade'

    if (xgbMode === 'off') {
      suggest    = similarityOk && simProb >= (simProb >= 0.65 ? 0.65 : 0.55)
      activeProb = simProb
      modoUsado  = 'similaridade'
    } else if (xgbMode === 'shadow') {
      // Executa pela similaridade; XGBoost apenas observa
      suggest    = similarityOk && simProb >= (simProb >= 0.65 ? 0.65 : 0.55)
      activeProb = simProb
      modoUsado  = 'similaridade (sombra)'
    } else if (xgbMode === 'and') {
      // Ambos precisam concordar
      const simPass = similarityOk && simProb >= threshold
      suggest    = simPass && xgbOk
      activeProb = xgbProb ?? simProb
      modoUsado  = 'AND (similaridade + XGBoost)'
    } else if (xgbMode === 'xgboost') {
      if (xgbProb === null) {
        return NextResponse.json({ suggestion: false, reason: 'Modelo XGBoost não encontrado — treine primeiro' })
      }
      suggest    = xgbOk
      activeProb = xgbProb
      modoUsado  = 'XGBoost'
    }

    if (!suggest) {
      const reasonMap: Record<string, string> = {
        off:       `P(sucesso)=${Math.round(simProb * 100)}% abaixo do limiar · ${total} similares`,
        shadow:    `P(sucesso)=${Math.round(simProb * 100)}% abaixo do limiar · ${total} similares`,
        and:       `AND não satisfeito · similaridade=${Math.round(simProb * 100)}% · XGB=${xgbProb != null ? Math.round(xgbProb * 100) : 'N/A'}%`,
        xgboost:   `P(XGBoost)=${xgbProb != null ? Math.round(xgbProb * 100) : 'N/A'}% abaixo de ${Math.round(threshold * 100)}%`,
      }
      if (!similarityOk && (xgbMode === 'off' || xgbMode === 'shadow')) {
        return NextResponse.json({
          suggestion: false,
          reason: `Apenas ${total} trades similares (mínimo 3)`,
          similar_count: total,
        })
      }
      return NextResponse.json({
        suggestion:     false,
        reason:         reasonMap[xgbMode] ?? 'Limiar não atingido',
        probability:    Math.round(activeProb * 100),
        xgb_prob:       xgbProb != null ? Math.round(xgbProb * 100) : null,
        similar_count:  total,
        xgboost_mode:   xgbMode,
      })
    }

    // ── Calcula lote e gera sugestão ──────────────────────────────────
    const { lot, tpPips, slPips, perBroker } = calcLotFromMeta(capital, brokerCount, dailyTargetPct)
    const p    = (v: number) => Math.round(v * 100000) / 100000
    const slOff = slPips * 0.0001
    const tpOff = tpPips * 0.0001

    const entry      = p(currentPrice)
    const stopLoss   = direction === 'buy' ? p(currentPrice - slOff) : p(currentPrice + slOff)
    const takeProfit = direction === 'buy' ? p(currentPrice + tpOff) : p(currentPrice - tpOff)
    const rr         = (tpPips / slPips).toFixed(1)

    const usouSessao = comSessao.length >= 3
    const sessaoStr  = usouSessao ? ` · sessão ${minhaSessao}` : ''
    const estadoStr  = bomEstado ? '' : ' ⚠ estado mental afetará resultado'
    const metaStr    = `meta +$${perBroker.toFixed(2)}/corretora`
    const xgbStr     = xgbProb != null ? ` · XGB ${Math.round(xgbProb * 100)}%` : ''
    const motivo     = `RAFI ${meuBucket} (${rafi.toFixed(2)})${sessaoStr}${xgbStr} · ${wins}/${total} similares · ${metaStr}${estadoStr}`

    const recentes = [...grupo]
      .sort((a, b) => Number(b.time) - Number(a.time))
      .slice(0, 5)
      .map(t => ({
        result: t.result,
        rafi:   Number(t.rafi ?? 0).toFixed(2),
        hora:   new Date(Number(t.time) * 1000).toUTCString().slice(0, 16),
      }))

    // Log do modo sombra no Supabase — fire-and-forget, não bloqueia a resposta
    if (xgbMode === 'shadow' && xgbProb != null) {
      void supa.from('rafi_xgb_shadow').insert({
        similarity_prob:     Math.round(simProb * 100) / 100,
        xgb_prob:            Math.round(xgbProb * 100) / 100,
        similarity_decision: suggest,
        xgb_decision:        xgbOk,
        agreed:              suggest === xgbOk,
        direction,
        rafi,
        sessao:              minhaSessao,
      })
    }

    return NextResponse.json({
      suggestion:    true,
      direction,
      entry,
      stopLoss,
      takeProfit,
      lot,
      rr,
      slPips,
      tpPips,
      perBroker,
      probability:   Math.round(activeProb * 100),
      xgb_prob:      xgbProb != null ? Math.round(xgbProb * 100) : null,
      similar_count: total,
      wins,
      motivo,
      recentes,
      confiante:     activeProb >= 0.65,
      capital,
      brokerCount,
      dailyTargetPct,
      xgboost_mode:  xgbMode,
      modo_usado:    modoUsado,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
