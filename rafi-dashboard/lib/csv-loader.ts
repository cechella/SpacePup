import type { CandleData } from './types'

export interface LoadResult {
  candles:   CandleData[]
  filename:  string
  dateFrom:  string
  dateTo:    string
  timeframe: string
  count:     number
}

// DD.MM.YYYY HH:MM:SS.mmm (Dukascopy)
function parseDukascopyTime(s: string): number {
  const [datePart, timePart] = s.trim().split(' ')
  const [dd, mm, yyyy]       = datePart.split('.')
  const [hh, min, sec]       = timePart.split(':')
  return Math.floor(
    new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${Math.floor(parseFloat(sec)).toString().padStart(2,'0')}Z`).getTime() / 1000
  )
}

// YYYY.MM.DD  HH:MM  (MT5 export)
function parseMT5Time(date: string, time: string): number {
  const [yyyy, mm, dd] = date.trim().split('.')
  const [hh, min]      = time.trim().split(':')
  return Math.floor(new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`).getTime() / 1000)
}

function detectTimeframe(candles: CandleData[]): string {
  if (candles.length < 2) return 'M5'
  const avg = (candles[candles.length - 1].time - candles[0].time) / (candles.length - 1)
  if (avg <=   70) return 'M1'
  if (avg <=  330) return 'M5'
  if (avg <=  970) return 'M15'
  if (avg <= 3700) return 'H1'
  if (avg <= 15000) return 'H4'
  return 'D1'
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

export function parseCSV(text: string, filename: string): LoadResult {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  if (lines.length < 2) throw new Error('Arquivo vazio ou inválido')

  const header = lines[0].toLowerCase()
  const candles: CandleData[] = []

  // ── Dukascopy ──────────────────────────────────────────────────────────────
  if (header.includes('gmt time') || (header.includes('open') && header.includes('high') && header.split(',').length >= 5)) {
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',')
      if (c.length < 5) continue
      try {
        const time  = parseDukascopyTime(c[0])
        const open  = parseFloat(c[1])
        const high  = parseFloat(c[2])
        const low   = parseFloat(c[3])
        const close = parseFloat(c[4])
        const vol   = c[5] ? parseFloat(c[5]) : undefined
        if (!isFinite(time) || !isFinite(open)) continue
        candles.push({ time, open, high, low, close, volume: vol })
      } catch { /* ignora linha inválida */ }
    }
  }

  // ── MT5 (tab-separado) ─────────────────────────────────────────────────────
  else if (header.includes('<date>') || header.includes('date') && header.includes('time') && lines[0].includes('\t')) {
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t')
      if (c.length < 6) continue
      try {
        const time  = parseMT5Time(c[0], c[1])
        const open  = parseFloat(c[2])
        const high  = parseFloat(c[3])
        const low   = parseFloat(c[4])
        const close = parseFloat(c[5])
        const vol   = c[6] ? parseFloat(c[6]) : undefined
        if (!isFinite(time) || !isFinite(open)) continue
        candles.push({ time, open, high, low, close, volume: vol })
      } catch { /* ignora linha inválida */ }
    }
  }

  // ── Genérico: tenta auto-detectar ─────────────────────────────────────────
  else {
    const sep = lines[0].includes('\t') ? '\t' : ','
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(sep)
      if (c.length < 5) continue
      try {
        const ts = Date.parse(c[0].trim())
        if (!isFinite(ts)) continue
        const time  = Math.floor(ts / 1000)
        const open  = parseFloat(c[1])
        const high  = parseFloat(c[2])
        const low   = parseFloat(c[3])
        const close = parseFloat(c[4])
        if (!isFinite(open)) continue
        candles.push({ time, open, high, low, close })
      } catch { /* ignora */ }
    }
  }

  if (candles.length === 0) throw new Error('Nenhum candle válido encontrado. Verifique o formato do arquivo.')

  candles.sort((a, b) => a.time - b.time)

  return {
    candles,
    filename,
    dateFrom:  fmtDate(candles[0].time),
    dateTo:    fmtDate(candles[candles.length - 1].time),
    timeframe: detectTimeframe(candles),
    count:     candles.length,
  }
}
