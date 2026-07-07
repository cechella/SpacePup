export interface CandleData {
  time: number   // Unix timestamp (seconds)
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type TradeOutcome = 'win' | 'loss' | 'open'
export type TradeDirection = 'buy' | 'sell'

export interface TradeSignal {
  id: string
  time: number
  direction: TradeDirection
  entry: number
  stopLoss: number
  takeProfit: number
  riskPips: number
  outcome: TradeOutcome
  exitTime?: number
  exitPrice?: number
  pnlPips: number
  pnlUsd?: number
  lot?: number
}

export interface RAFIConfig {
  srLookback: number
  swingStopLookback: number
  maFast: number
  maSlow: number
  maThreshold: number
  rrRatio: number
  spreadPips: number
  riskPct: number
  capital: number
}

export interface BacktestResult {
  signals: TradeSignal[]
  ma20: LinePoint[]
  ma50: LinePoint[]
  equityCurve: EquityPoint[]
  stats: BacktestStats
}

export interface LinePoint {
  time: number
  value: number
}

export interface EquityPoint {
  time: number
  value: number
}

export interface BacktestStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  profitFactor: number
  netPnlPips: number
  netPnlUsd: number
  maxDrawdownUsd: number
  maxDrawdownPct: number
  avgWinPips: number
  avgLossPips: number
  expectancyPips: number
}
