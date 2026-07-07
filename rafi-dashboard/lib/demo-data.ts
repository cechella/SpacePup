import type { CandleData } from './types'

export type Timeframe = 'M5' | 'M15' | 'H1'

// PRNG determinístico — mesmos candles toda vez
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateDemoData(tf: Timeframe = 'M5'): CandleData[] {
  const rand = mulberry32(1337)
  const candles: CandleData[] = []

  const intervalSec   = tf === 'M5' ? 300 : tf === 'M15' ? 900 : 3600
  const mult          = intervalSec / 300   // escala drift e vol vs M5
  const candlesPerDay = Math.round(86400 / intervalSec)

  // Segunda 6 jan 2025, 00:00 UTC
  const startTs = 1736121600
  let close = 1.03050

  // Perfil de drift por dia/hora (base M5, multiplicado por mult)
  const getDrift = (dow: number, hour: number): number => {
    let base = 0
    if (dow === 1) {
      if (hour >= 7 && hour < 12)  base =  0.000012
      else if (hour >= 12 && hour < 17) base = -0.000005
      else base = 0.000002
    } else if (dow === 2) {
      if (hour >= 7 && hour < 10)  base =  0.000020
      else if (hour >= 10 && hour < 15) base =  0.000018
      else if (hour >= 15 && hour < 20) base =  0.000008
      else base = 0.000003
    } else if (dow === 3) {
      if (hour >= 7 && hour < 12)  base = -0.000025
      else if (hour >= 12 && hour < 17) base = -0.000018
      else if (hour >= 17 && hour < 22) base = -0.000010
      else base = -0.000003
    } else if (dow === 4) {
      if (hour >= 8 && hour < 13)  base =  0.000015
      else if (hour >= 13 && hour < 18) base =  0.000010
      else base = 0.000002
    } else if (dow === 5) {
      if (hour >= 9 && hour < 14)  base = -0.000008
      else base = 0.000001
    }
    return base * mult
  }

  // Volatilidade por sessão (escala com √mult — lei de raiz do tempo)
  const getVol = (hour: number): number => {
    let base = 0.00012
    if (hour >= 7 && hour < 12)  base = 0.00028
    else if (hour >= 12 && hour < 17) base = 0.00024
    else if (hour >= 17 && hour < 22) base = 0.00018
    return base * Math.sqrt(mult)
  }

  for (let d = 0; d < 5; d++) {
    const dayTs = startTs + d * 86400

    for (let c = 0; c < candlesPerDay; c++) {
      const time = dayTs + c * intervalSec
      const date = new Date(time * 1000)
      const hour = date.getUTCHours()
      const dow  = date.getUTCDay()

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

// compatibilidade com código existente
export const generateDemoWeek = () => generateDemoData('M5')
