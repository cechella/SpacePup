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
    updated_at:  new Date().toISOString(),
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
