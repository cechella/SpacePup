'use client'

import { createClient } from './supabase'

// Tipo compatível com ManualTrade de @/components/trade-panel
export interface TradeRecord {
  id: string
  direction: 'buy' | 'sell'
  entry: number
  stopLoss: number
  takeProfit: number
  label: string
  time: number
  lot: number
  leverage: number
  result?: 'win' | 'loss' | 'pending'
  rafi?: number
  rafiDir?: 'bull' | 'bear'
  bbWidth?: number
  snapshot?: string
  pnlUsd?: number
  capitalInicial?: number
  // Contexto de sessão para aprendizado da IA
  overlapPhase?:  'early' | 'mid' | 'late' | null
  sessionMinute?: number | null
  dayOfWeek?:     0 | 1 | 2 | 3 | null
  entryType?:     'manual' | 'bot'
}

function fromRow(row: Record<string, unknown>): TradeRecord {
  return {
    id:         String(row.id),
    direction:  row.direction as 'buy' | 'sell',
    entry:      Number(row.entry),
    stopLoss:   Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    label:      String(row.label ?? ''),
    time:       Number(row.time),
    lot:        Number(row.lot),
    leverage:   Number(row.leverage ?? 1000),
    result:     (row.result as TradeRecord['result']) ?? undefined,
    rafi:       row.rafi != null ? Number(row.rafi) : undefined,
    rafiDir:    (row.rafi_dir as TradeRecord['rafiDir']) ?? undefined,
    bbWidth:    row.bb_width != null ? Number(row.bb_width) : undefined,
    snapshot:   (row.snapshot as string) ?? undefined,
    pnlUsd:        row.pnl_usd != null ? Number(row.pnl_usd) : row.pnl != null ? Number(row.pnl) : undefined,
    capitalInicial: row.capital_inicial != null ? Number(row.capital_inicial) : undefined,
    overlapPhase:  (row.overlap_phase as TradeRecord['overlapPhase']) ?? undefined,
    sessionMinute: row.session_minute != null ? Number(row.session_minute) : undefined,
    dayOfWeek:     row.day_of_week != null ? Number(row.day_of_week) as 0|1|2|3 : undefined,
    entryType:     (row.entry_type as TradeRecord['entryType']) ?? undefined,
  }
}

function toRow(t: TradeRecord) {
  return {
    id:          t.id,
    direction:   t.direction,
    entry:       t.entry,
    stop_loss:   t.stopLoss,
    take_profit: t.takeProfit,
    label:       t.label,
    time:        t.time,
    lot:         t.lot,
    leverage:    t.leverage,
    result:      t.result ?? 'pending',
    rafi:        t.rafi ?? null,
    rafi_dir:    t.rafiDir ?? null,
    bb_width:    t.bbWidth ?? null,
    snapshot:    t.snapshot ?? null,
    pnl_usd:         t.pnlUsd ?? null,
    capital_inicial: t.capitalInicial ?? null,
    overlap_phase:   t.overlapPhase  ?? null,
    session_minute:  t.sessionMinute ?? null,
    day_of_week:     t.dayOfWeek     ?? null,
    entry_type:      t.entryType     ?? 'manual',
    updated_at:      new Date().toISOString(),
  }
}

export async function fetchTrades(): Promise<TradeRecord[]> {
  const db = createClient()
  const { data, error } = await db
    .from('rafi_trades')
    .select('*')
    .order('time', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => fromRow(r as Record<string, unknown>))
}

export async function upsertTrade(t: TradeRecord): Promise<void> {
  const db = createClient()
  const { error } = await db
    .from('rafi_trades')
    .upsert(toRow(t), { onConflict: 'id' })
  if (error) throw error
}

export async function upsertTrades(trades: TradeRecord[]): Promise<void> {
  if (!trades.length) return
  const db = createClient()
  const { error } = await db
    .from('rafi_trades')
    .upsert(trades.map(toRow), { onConflict: 'id' })
  if (error) throw error
}

export async function updateTradeResult(id: string, result: 'win' | 'loss'): Promise<void> {
  const db = createClient()
  const { error } = await db
    .from('rafi_trades')
    .update({ result, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// ── Candles do Supabase (tabela rafi_candles) ─────────────────────────────────
export interface CandleRow {
  time:   number
  open:   number
  high:   number
  low:    number
  close:  number
  volume?: number
}

export async function fetchCandles(): Promise<CandleRow[]> {
  const db = createClient()
  const { data, error } = await db
    .from('rafi_candles')
    .select('time,open,high,low,close,volume')
    .order('time', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => ({
    time:   Number(r.time),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: r.volume != null ? Number(r.volume) : undefined,
  }))
}

export async function countCandles(): Promise<number> {
  const db = createClient()
  const { count, error } = await db
    .from('rafi_candles')
    .select('*', { count: 'exact', head: true })
  if (error) return 0
  return count ?? 0
}

// Salva candles no Supabase em lotes de 500 (upsert por time)
export async function saveCandles(candles: CandleRow[]): Promise<void> {
  if (!candles.length) return
  const db = createClient()
  const BATCH = 500
  for (let i = 0; i < candles.length; i += BATCH) {
    const batch = candles.slice(i, i + BATCH).map(c => ({
      time:   c.time,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.volume ?? 0,
    }))
    const { error } = await db.from('rafi_candles').upsert(batch, { onConflict: 'time' })
    if (error) throw error
  }
}
