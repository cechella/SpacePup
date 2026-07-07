import type { CandleData } from './types'

// PRNG determinístico — mesmos candles toda vez
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateDemoWeek(): CandleData[] {
  const rand = mulberry32(1337)
  const candles: CandleData[] = []

  // Segunda 6 jan 2025, 00:00 UTC
  const startTs = 1736121600
  let close = 1.03050

  // Perfil de drift por dia/hora para criar padrões RAFI claros
  const getDrift = (day: number, hour: number): number => {
    if (day === 1) {  // Segunda: leve alta matinal, cai à tarde
      if (hour >= 7 && hour < 12)  return  0.000012
      if (hour >= 12 && hour < 17) return -0.000005
      return 0.000002
    }
    if (day === 2) {  // Terça: TENDÊNCIA DE ALTA — breakout bullish
      if (hour >= 7 && hour < 10)  return  0.000020
      if (hour >= 10 && hour < 15) return  0.000018
      if (hour >= 15 && hour < 20) return  0.000008
      return 0.000003
    }
    if (day === 3) {  // Quarta: REVERSÃO — breakout bearish
      if (hour >= 7 && hour < 12)  return -0.000025
      if (hour >= 12 && hour < 17) return -0.000018
      if (hour >= 17 && hour < 22) return -0.000010
      return -0.000003
    }
    if (day === 4) {  // Quinta: recuperação parcial
      if (hour >= 8 && hour < 13)  return  0.000015
      if (hour >= 13 && hour < 18) return  0.000010
      return 0.000002
    }
    if (day === 5) {  // Sexta: consolidação
      if (hour >= 9 && hour < 14)  return -0.000008
      return 0.000001
    }
    return 0
  }

  // Volatilidade por sessão
  const getVol = (hour: number): number => {
    if (hour >= 7 && hour < 12)  return 0.00028  // London
    if (hour >= 12 && hour < 17) return 0.00024  // NY
    if (hour >= 17 && hour < 22) return 0.00018  // NY fechando
    return 0.00012                               // Ásia/madrugada
  }

  // 7 dias de calendário (seg–dom), pulamos fim de semana
  for (let d = 0; d < 5; d++) {
    const dayTs = startTs + d * 86400

    // 24h × 12 candles/h = 288 candles por dia
    for (let c = 0; c < 288; c++) {
      const time = dayTs + c * 300
      const date = new Date(time * 1000)
      const hour = date.getUTCHours()
      const dow  = date.getUTCDay()

      // Pula fim de semana (não deve ocorrer com startTs numa seg, mas por segurança)
      if (dow === 0 || dow === 6) continue

      const vol   = getVol(hour)
      const drift = getDrift(dow, hour)

      const open  = close
      const noise = (rand() - 0.5) * 2 * vol
      close = open + drift + noise

      const bodyHigh = Math.max(open, close)
      const bodyLow  = Math.min(open, close)
      const high = bodyHigh + rand() * vol * 0.6
      const low  = bodyLow  - rand() * vol * 0.6

      const volume = Math.floor(800 + rand() * 3500)

      candles.push({
        time,
        open:   Math.round(open  * 100000) / 100000,
        high:   Math.round(high  * 100000) / 100000,
        low:    Math.round(low   * 100000) / 100000,
        close:  Math.round(close * 100000) / 100000,
        volume,
      })
    }
  }

  return candles
}
