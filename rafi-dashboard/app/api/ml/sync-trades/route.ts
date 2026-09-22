/**
 * POST /api/ml/sync-trades
 * Recebe deals fechados do MetaAPI e sincroniza com rafi_trades no Supabase.
 * Só insere trades novos (verifica IDs existentes) e nunca sobrescreve check-in manual.
 * Trades auto-sincronizados têm entry_type='bot' e sem campos de check-in.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

interface DealInput {
  id:         string
  direction:  'buy' | 'sell'
  entryPrice: number | null
  price:      number
  profit:     number
  time:       string
  volume:     number
}

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase não configurado')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const deals: DealInput[] = Array.isArray(body?.deals) ? body.deals : []

    if (deals.length === 0) return NextResponse.json({ inserted: 0 })

    const supa = getClient()
    const ids  = deals.map(d => d.id)

    // Verifica quais IDs já existem — nunca sobrescreve
    const { data: existing } = await supa
      .from('rafi_trades')
      .select('id')
      .in('id', ids)

    const existingSet = new Set((existing ?? []).map((r: { id: string }) => r.id))
    const novos = deals.filter(d => !existingSet.has(d.id))

    if (novos.length === 0) return NextResponse.json({ inserted: 0 })

    const rows = novos.map(d => ({
      id:          d.id,
      direction:   d.direction,
      entry:       d.entryPrice ?? d.price,
      stop_loss:   0,
      take_profit: 0,
      label:       'MetaAPI-Auto',
      time:        Math.floor(new Date(d.time).getTime() / 1000),
      lot:         d.volume,
      leverage:    1000,
      result:      d.profit > 0 ? 'win' : 'loss',
      pnl_usd:     d.profit,
      entry_type:  'bot',
      updated_at:  new Date().toISOString(),
    }))

    const { error } = await supa.from('rafi_trades').insert(rows)
    if (error) throw error

    return NextResponse.json({ inserted: novos.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
