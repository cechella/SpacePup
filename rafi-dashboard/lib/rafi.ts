import type {
  CandleData, TradeSignal, RAFIConfig, BacktestResult,
  LinePoint, EquityPoint, BacktestStats,
} from './types'

// ── Indicadores ───────────────────────────────────────────────────────────────

function sma(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    return sum / period
  })
}

function swingHigh(candles: CandleData[], upTo: number, lookback: number): number {
  let max = -Infinity
  const from = Math.max(0, upTo - lookback)
  for (let i = from; i < upTo; i++) {
    if (candles[i].high > max) max = candles[i].high
  }
  return max === -Infinity ? candles[upTo].high : max
}

function swingLow(candles: CandleData[], upTo: number, lookback: number): number {
  let min = Infinity
  const from = Math.max(0, upTo - lookback)
  for (let i = from; i < upTo; i++) {
    if (candles[i].low < min) min = candles[i].low
  }
  return min === Infinity ? candles[upTo].low : min
}

// ── Motor RAFI ────────────────────────────────────────────────────────────────

export function runRAFI(candles: CandleData[], cfg: Partial<RAFIConfig> = {}): BacktestResult {
  const config: RAFIConfig = {
    srLookback:        cfg.srLookback        ?? 50,
    swingStopLookback: cfg.swingStopLookback ?? 150,
    maFast:            cfg.maFast            ?? 20,
    maSlow:            cfg.maSlow            ?? 50,
    maThreshold:       cfg.maThreshold       ?? 0.0003,
    rrRatio:           cfg.rrRatio           ?? 2.0,
    spreadPips:        cfg.spreadPips        ?? 1.3,
    riskPct:           cfg.riskPct           ?? 0.02,
    capital:           cfg.capital           ?? 100,
  }

  const pip = 0.0001
  const spread = config.spreadPips * pip

  const closes = candles.map(c => c.close)
  const ma20Arr = sma(closes, config.maFast)
  const ma50Arr = sma(closes, config.maSlow)

  const ma20: LinePoint[] = []
  const ma50: LinePoint[] = []
  for (let i = 0; i < candles.length; i++) {
    if (!isNaN(ma20Arr[i])) ma20.push({ time: candles[i].time, value: ma20Arr[i] })
    if (!isNaN(ma50Arr[i])) ma50.push({ time: candles[i].time, value: ma50Arr[i] })
  }

  const signals: TradeSignal[] = []
  const equityCurve: EquityPoint[] = [{ time: candles[0].time, value: config.capital }]
  let capital = config.capital
  let inTrade = false
  let idCounter = 0

  for (let i = config.maSlow; i < candles.length; i++) {
    const c = candles[i]

    // ── Gestão de posição aberta ──────────────────────────────────────────────
    if (inTrade) {
      const sig = signals[signals.length - 1]
      if (sig.outcome !== 'open') { inTrade = false; continue }

      let closed = false
      if (sig.direction === 'buy') {
        if (c.low <= sig.stopLoss) {
          sig.outcome = 'loss'
          sig.exitTime = c.time
          sig.exitPrice = sig.stopLoss
          sig.pnlPips = Math.round((sig.stopLoss - sig.entry) / pip * 10) / 10
          closed = true
        } else if (c.high >= sig.takeProfit) {
          sig.outcome = 'win'
          sig.exitTime = c.time
          sig.exitPrice = sig.takeProfit
          sig.pnlPips = Math.round((sig.takeProfit - sig.entry) / pip * 10) / 10
          closed = true
        }
      } else {
        if (c.high >= sig.stopLoss) {
          sig.outcome = 'loss'
          sig.exitTime = c.time
          sig.exitPrice = sig.stopLoss
          sig.pnlPips = Math.round((sig.entry - sig.stopLoss) / pip * 10) / 10
          closed = true
        } else if (c.low <= sig.takeProfit) {
          sig.outcome = 'win'
          sig.exitTime = c.time
          sig.exitPrice = sig.takeProfit
          sig.pnlPips = Math.round((sig.entry - sig.takeProfit) / pip * 10) / 10
          closed = true
        }
      }

      if (closed) {
        // Kelly sizing: lote = capital × riskPct / (riskPips × pipValue)
        const pipValue = 10  // USD/pip por lote padrão EURUSD
        const lot = (capital * config.riskPct) / (sig.riskPips * pipValue)
        sig.lot = Math.round(lot * 100) / 100
        sig.pnlUsd = Math.round(sig.pnlPips * sig.lot * pipValue * 100) / 100
        capital = Math.round((capital + sig.pnlUsd) * 100) / 100
        equityCurve.push({ time: c.time, value: capital })
        inTrade = false
      }
      continue
    }

    // ── Detecção de sinal ─────────────────────────────────────────────────────
    const ma20v = ma20Arr[i]
    const ma50v = ma50Arr[i]
    if (isNaN(ma20v) || isNaN(ma50v)) continue

    const bullish = ma20v - ma50v > config.maThreshold
    const bearish = ma50v - ma20v > config.maThreshold
    if (!bullish && !bearish) continue

    const resistance = swingHigh(candles, i, config.srLookback)
    const support    = swingLow(candles, i, config.srLookback)

    if (bullish && c.close > resistance && c.close > c.open) {
      const entry     = c.close + spread
      const sl        = swingLow(candles, i, Math.min(config.swingStopLookback, i))
      const riskPips  = Math.round((entry - sl) / pip)
      if (riskPips < 3 || riskPips > 200) continue
      const tp = entry + riskPips * config.rrRatio * pip

      signals.push({
        id: `s${++idCounter}`,
        time: c.time, direction: 'buy', entry, stopLoss: sl,
        takeProfit: tp, riskPips, outcome: 'open', pnlPips: 0,
      })
      inTrade = true

    } else if (bearish && c.close < support && c.close < c.open) {
      const entry     = c.close - spread
      const sl        = swingHigh(candles, i, Math.min(config.swingStopLookback, i))
      const riskPips  = Math.round((sl - entry) / pip)
      if (riskPips < 3 || riskPips > 200) continue
      const tp = entry - riskPips * config.rrRatio * pip

      signals.push({
        id: `s${++idCounter}`,
        time: c.time, direction: 'sell', entry, stopLoss: sl,
        takeProfit: tp, riskPips, outcome: 'open', pnlPips: 0,
      })
      inTrade = true
    }
  }

  const stats = calcStats(signals, config.capital, capital)
  return { signals, ma20, ma50, equityCurve, stats }
}

// ── Estatísticas ──────────────────────────────────────────────────────────────

function calcStats(signals: TradeSignal[], capitalInit: number, capitalFinal: number): BacktestStats {
  const closed = signals.filter(s => s.outcome !== 'open')
  const wins   = closed.filter(s => s.outcome === 'win')
  const losses = closed.filter(s => s.outcome === 'loss')

  const totalWinPips  = wins.reduce((a, s) => a + s.pnlPips, 0)
  const totalLossPips = losses.reduce((a, s) => a + Math.abs(s.pnlPips), 0)

  const winRate      = closed.length > 0 ? wins.length / closed.length * 100 : 0
  const profitFactor = totalLossPips > 0 ? totalWinPips / totalLossPips : totalWinPips > 0 ? 999 : 0
  const netPnlUsd    = (signals.filter(s => s.pnlUsd !== undefined).reduce((a, s) => a + (s.pnlUsd ?? 0), 0))
  const netPnlPips   = closed.reduce((a, s) => a + s.pnlPips, 0)

  // Max drawdown sobre capital inicial
  let peak = capitalInit, maxDD = 0, maxDDPct = 0
  let running = capitalInit
  for (const s of closed) {
    running += s.pnlUsd ?? 0
    if (running > peak) peak = running
    const dd = peak - running
    const ddPct = peak > 0 ? dd / peak * 100 : 0
    if (dd > maxDD) { maxDD = dd; maxDDPct = ddPct }
  }

  return {
    totalTrades:    closed.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        Math.round(winRate * 10) / 10,
    profitFactor:   Math.round(profitFactor * 1000) / 1000,
    netPnlPips:     Math.round(netPnlPips * 10) / 10,
    netPnlUsd:      Math.round(netPnlUsd * 100) / 100,
    maxDrawdownUsd: Math.round(maxDD * 100) / 100,
    maxDrawdownPct: Math.round(maxDDPct * 10) / 10,
    avgWinPips:     wins.length > 0 ? Math.round(totalWinPips / wins.length * 10) / 10 : 0,
    avgLossPips:    losses.length > 0 ? Math.round(totalLossPips / losses.length * 10) / 10 : 0,
    expectancyPips: closed.length > 0 ? Math.round(netPnlPips / closed.length * 10) / 10 : 0,
  }
}
