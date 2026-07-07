import type { CandleData } from './types'

export interface BBBands {
  upper:  Array<{ time: number; value: number }>
  middle: Array<{ time: number; value: number }>
  lower:  Array<{ time: number; value: number }>
}

export interface ColoredCandle extends CandleData {
  color?:       string
  borderColor?: string
  wickColor?:   string
}

export interface RAFIPoint {
  time:  number
  value: number   // sempre positivo (0–5): magnitude da força, não direção
  color: string
  dir:   'bull' | 'bear'
}

export interface SRLevel {
  price: number
  type: 'resistance' | 'support'
  time: number
  strength: number  // number of touches/confirmations
}

function calcATR(candles: CandleData[], period = 14): number[] {
  const tr: number[] = [0]
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    tr.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close),
    ))
  }
  const atr = new Array<number>(candles.length).fill(0)
  let sum = 0
  for (let i = 1; i <= period && i < candles.length; i++) sum += tr[i]
  if (period < candles.length) atr[period] = sum / period
  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
  }
  return atr
}

/**
 * Aproximação do indicador RAFI (índice de força).
 * Valor SEMPRE positivo (0–5): mede MAGNITUDE da força, não direção.
 * A direção (alta/baixa) é determinada pela direção do candle (dir).
 * Qualquer RAFI > 0 num rompimento válido é sinal de entrada.
 * Força forte: RAFI ≥ 2.5.
 */
export function calcRAFI(candles: CandleData[], period = 3): RAFIPoint[] {
  const atr   = calcATR(candles)
  const start = Math.max(period, 14)
  const result: RAFIPoint[] = []

  for (let i = start; i < candles.length; i++) {
    const c    = candles[i]
    const prev = candles[i - period]
    const dir: 'bull' | 'bear' = c.close >= c.open ? 'bull' : 'bear'
    const mom   = Math.abs((c.close - prev.close) / prev.close) * 100
    const body  = Math.abs(c.close - c.open)
    const amp   = atr[i] > 0 ? body / atr[i] : 0
    // magnitude pura: sem sinal negativo
    const value = Math.min(5, mom * 25 + amp * 3)

    // Verde = alta forte, vermelho = baixa forte; saturado se >= 2.5
    const color =
      value >= 2.5
        ? (dir === 'bull' ? '#22c55e' : '#ef4444')
        : value > 0
          ? (dir === 'bull' ? '#22c55e88' : '#ef444488')
          : '#484f5866'

    result.push({ time: c.time, value, color, dir })
  }
  return result
}

/**
 * Detecta topos e fundos locais (swing highs/lows) e os agrupa em
 * zonas de suporte/resistência.  Retorna os `max` níveis mais recentes.
 */
export function calcSRLevels(
  candles:  CandleData[],
  lookback  = 8,
  max       = 12,
): SRLevel[] {
  const raw: SRLevel[] = []

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let hi = true, lo = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) hi = false
      if (candles[j].low  <= c.low)  lo = false
    }
    if (hi) raw.push({ price: c.high, type: 'resistance', time: c.time, strength: 1 })
    if (lo) raw.push({ price: c.low,  type: 'support',    time: c.time, strength: 1 })
  }

  // Agrupa níveis dentro de 5 pips (0.0005)
  const merged: SRLevel[] = []
  for (const lvl of raw) {
    const existing = merged.find(
      m => m.type === lvl.type && Math.abs(m.price - lvl.price) < 0.0005,
    )
    if (existing) {
      existing.strength++
      if (lvl.time > existing.time) {
        existing.price = lvl.price
        existing.time  = lvl.time
      }
    } else {
      merged.push({ ...lvl })
    }
  }

  return merged
    .sort((a, b) => b.time - a.time)
    .slice(0, max)
}

/**
 * Bandas de Bollinger: média móvel simples ± N desvios padrão.
 * Configuração padrão: 20 períodos, 2 desvios (igual ao PDF RAFI).
 */
export function calcBollingerBands(
  candles:  CandleData[],
  period    = 8,   // RAFI Módulo 2: 8 períodos, 2 desvios padrão
  stdMult   = 2,
): BBBands {
  const upper:  Array<{ time: number; value: number }> = []
  const middle: Array<{ time: number; value: number }> = []
  const lower:  Array<{ time: number; value: number }> = []

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
    const mean = sum / period
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) variance += (candles[j].close - mean) ** 2
    const std = Math.sqrt(variance / period)
    const t = candles[i].time
    upper.push({ time: t, value: mean + stdMult * std })
    middle.push({ time: t, value: mean })
    lower.push({ time: t, value: mean - stdMult * std })
  }

  return { upper, middle, lower }
}

/**
 * Colore cada vela de acordo com o RAFI (magnitude) + direção do candle:
 *   Verde   = RAFI ≥ 2.5 + candle de alta  (força forte subindo)
 *   Vermelho = RAFI ≥ 2.5 + candle de baixa (força forte caindo)
 *   Amarelo = exaustão (RAFI forte no anterior, queda abrupta agora < 1.0)
 *   Cinza   = consolidação (RAFI < 2.5)
 */
export function applyRAFICandleColors(
  candles:    CandleData[],
  rafiPoints: RAFIPoint[],
): ColoredCandle[] {
  const rafiMap = new Map<number, RAFIPoint>()
  for (const p of rafiPoints) rafiMap.set(p.time, p)

  return candles.map((c, i) => {
    const pt = rafiMap.get(c.time)
    if (!pt) return { ...c }

    const prevTime = i > 0 ? candles[i - 1].time : undefined
    const prevPt   = prevTime !== undefined ? rafiMap.get(prevTime) : undefined

    // Exaustão: força forte anterior com colapso brusco
    const exhaustion = prevPt !== undefined && prevPt.value >= 2.5 && pt.value < 1.0

    const [color, wickColor] = exhaustion
      ? ['#f59e0b', '#d97706']                                   // amarelo — exaustão
      : pt.value >= 2.5
        ? pt.dir === 'bull'
          ? ['#22c55e', '#16a34a']   // verde — alta forte
          : ['#ef4444', '#dc2626']   // vermelho — baixa forte
        : ['#d1d5db', '#94a3b8']     // cinza — consolidação

    return { ...c, color, borderColor: color, wickColor }
  })
}
