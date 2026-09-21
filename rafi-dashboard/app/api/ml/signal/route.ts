/**
 * POST /api/ml/signal
 * Avalia condições atuais do mercado contra o histórico de trades rotulados.
 * Retorna sugestão de entrada quando P(sucesso) ≥ 65% e há ≥ 3 trades similares.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SL_PIPS = 3    // 0.0003 — stop 3 pips
const TP_PIPS = 10   // 0.0010 — alvo 10 pips → R:R 1:3.3

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

function calcLot(capital: number, slPips: number): number {
  // 1% do capital como risco máximo
  // valor por pip EURUSD lote 0.01 = ~$0.10 → $risco / (slPips * 10 * 10)
  const risco = capital * 0.01
  const lotCrudo = risco / (slPips * 10)
  // Arredonda para lotes padrão: 0.01, 0.02, 0.03, 0.05, 0.10, 0.20, ...
  const steps = [0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20, 0.30, 0.50]
  return steps.reduce((prev, cur) => Math.abs(cur - lotCrudo) < Math.abs(prev - lotCrudo) ? cur : prev)
}

interface SignalBody {
  rafi:          number
  bbWidth?:      number
  direction:     'buy' | 'sell'
  currentPrice:  number
  horaUtc:       number
  diaSemana?:    number
  capital?:      number
  checkinSono?:  string | null
  checkinEnergia?: string | null
  checkinMental?: string | null
  checkinHumor?:  string | null
  labeled_count:  number  // total de trades rotulados — ativa IA apenas com ≥ 10
}

export async function POST(req: NextRequest) {
  try {
    const body: SignalBody = await req.json()
    const {
      rafi, direction, currentPrice, horaUtc,
      capital = 100, labeled_count,
      checkinSono, checkinEnergia, checkinMental, checkinHumor,
    } = body

    // IA só ativa com ≥ 10 trades rotulados
    if (labeled_count < 10) {
      return NextResponse.json({ suggestion: false, reason: `Aguardando 10 trades (atual: ${labeled_count})` })
    }

    const supa = getServiceClient()

    // Busca todos os trades rotulados (win ou loss)
    const { data: rows, error } = await supa
      .from('rafi_trades')
      .select('rafi, bb_width, direction, result, time, checkin_sono, checkin_energia, checkin_mental, checkin_humor')
      .in('result', ['win', 'loss'])
    if (error) throw error

    const trades = rows ?? []
    const totalLabeled = trades.length
    if (totalLabeled < 10) {
      return NextResponse.json({ suggestion: false, reason: 'Poucos trades no banco' })
    }

    const meuBucket  = rafiBucket(rafi)
    const minhaSessao = sessionLabel(horaUtc)
    const bomEstado  = !checkinSono || (
      checkinSono    !== 'mal'    &&
      checkinMental  !== 'ruim'  &&
      checkinHumor   !== 'triste' &&
      checkinEnergia !== 'baixa'
    )

    // Similaridade em camadas — mais similar = mais peso
    // Camada 1: mesmo bucket RAFI + mesma direção (mandatório)
    // Camada 2: mesma sessão (opcional, adiciona relevância)
    // Camada 3: mesmo estado mental (opcional, quando há dados)
    const similar = trades.filter(t => {
      const tBucket = rafiBucket(Number(t.rafi ?? 0))
      return tBucket === meuBucket && t.direction === direction
    })

    const comSessao  = similar.filter(t => {
      const h = new Date(Number(t.time) * 1000).getUTCHours()
      return sessionLabel(h) === minhaSessao
    })

    // Usa grupo com sessão se tiver ≥ 3, senão usa grupo base
    const grupo = comSessao.length >= 3 ? comSessao : similar

    if (grupo.length < 3) {
      return NextResponse.json({
        suggestion: false,
        reason: `Apenas ${grupo.length} trades similares (mínimo 3)`,
        similar_count: grupo.length,
      })
    }

    const wins  = grupo.filter(t => t.result === 'win').length
    const total = grupo.length
    const prob  = wins / total

    // Limiar: 65% para disparo confiante, 55% com badge "modelo inicial"
    if (prob < 0.55) {
      return NextResponse.json({
        suggestion: false,
        reason: `P(sucesso)=${Math.round(prob * 100)}% abaixo do limiar`,
        probability: Math.round(prob * 100),
        similar_count: total,
      })
    }

    const p = (v: number) => Math.round(v * 100000) / 100000
    const slOff = SL_PIPS * 0.0001
    const tpOff = TP_PIPS * 0.0001

    const entry    = p(currentPrice)
    const stopLoss = direction === 'buy' ? p(currentPrice - slOff) : p(currentPrice + slOff)
    const takeProfit = direction === 'buy' ? p(currentPrice + tpOff) : p(currentPrice - tpOff)
    const lot = calcLot(capital, SL_PIPS)
    const rr  = (TP_PIPS / SL_PIPS).toFixed(1)

    // Motivo legível para o trader
    const usouSessao = comSessao.length >= 3
    const sessaoStr  = usouSessao ? ` · sessão ${minhaSessao}` : ''
    const estadoStr  = bomEstado ? '' : ' ⚠ estado mental afetará resultado'
    const motivo = `RAFI ${meuBucket} (${rafi.toFixed(2)})${sessaoStr} · ${wins}/${total} trades similares${estadoStr}`

    // Trades similares recentes para exibir na UI (máx 5, mais recentes primeiro)
    const recentes = [...grupo]
      .sort((a, b) => Number(b.time) - Number(a.time))
      .slice(0, 5)
      .map(t => ({
        result: t.result,
        rafi:   Number(t.rafi ?? 0).toFixed(2),
        hora:   new Date(Number(t.time) * 1000).toUTCString().slice(0, 16),
      }))

    return NextResponse.json({
      suggestion:    true,
      direction,
      entry,
      stopLoss,
      takeProfit,
      lot,
      rr,
      slPips:        SL_PIPS,
      tpPips:        TP_PIPS,
      probability:   Math.round(prob * 100),
      similar_count: total,
      wins,
      motivo,
      recentes,
      confiante:     prob >= 0.65,  // true = full confidence badge; false = "modelo inicial"
      capital,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
