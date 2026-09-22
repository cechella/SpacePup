/**
 * POST /api/ml/sync-trades
 * Recebe deals fechados do MetaAPI e sincroniza com rafi_trades no Supabase.
 * Só insere trades novos (verifica IDs existentes) e nunca sobrescreve check-in manual.
 * Enriquece cada deal com RAFI, BB Width e check-in quando enviados pelo cliente.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

interface DealInput {
  id:             string
  direction:      'buy' | 'sell'
  entryPrice:     number | null
  price:          number
  profit:         number
  time:           string
  volume:         number
  // Enriquecimento — preenchido pelo chart quando rafiEnrichRef tem dados
  rafi?:          number | null
  rafiDir?:       'bull' | 'bear' | null
  bbWidth?:       number | null
  checkinSono?:   string | null
  checkinEnergia?: string | null
  checkinMental?:  string | null
  checkinHumor?:   string | null
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

    // Verifica quais IDs já existem — nunca sobrescreve registro completo com check-in manual
    const { data: existing } = await supa
      .from('rafi_trades')
      .select('id, rafi, checkin_sono')
      .in('id', ids)

    const existingMap = new Map((existing ?? []).map((r: { id: string; rafi: unknown; checkin_sono: unknown }) => [r.id, r]))
    const novos = deals.filter(d => !existingMap.has(d.id))

    // Trades que já existem mas ainda sem RAFI — atualiza se agora temos o dado
    const paraEnriquecer = deals.filter(d => {
      const ex = existingMap.get(d.id)
      return ex && ex.rafi == null && d.rafi != null
    })

    if (novos.length === 0 && paraEnriquecer.length === 0) {
      return NextResponse.json({ inserted: 0, enriched: 0 })
    }

    // Insere trades novos com todos os campos disponíveis
    if (novos.length > 0) {
      const rows = novos.map(d => ({
        id:              d.id,
        direction:       d.direction,
        entry:           d.entryPrice ?? d.price,
        stop_loss:       0,
        take_profit:     0,
        label:           'MetaAPI-Auto',
        time:            Math.floor(new Date(d.time).getTime() / 1000),
        lot:             d.volume,
        leverage:        1000,
        result:          d.profit > 0 ? 'win' : 'loss',
        pnl_usd:         d.profit,
        entry_type:      'bot',
        rafi:            d.rafi            ?? null,
        rafi_dir:        d.rafiDir         ?? null,
        bb_width:        d.bbWidth         ?? null,
        checkin_sono:    d.checkinSono     ?? null,
        checkin_energia: d.checkinEnergia  ?? null,
        checkin_mental:  d.checkinMental   ?? null,
        checkin_humor:   d.checkinHumor    ?? null,
        updated_at:      new Date().toISOString(),
      }))
      const { error } = await supa.from('rafi_trades').insert(rows)
      if (error) throw error
    }

    // Enriquece registros antigos que estavam sem RAFI
    let enriched = 0
    for (const d of paraEnriquecer) {
      const { error } = await supa
        .from('rafi_trades')
        .update({
          rafi:            d.rafi    ?? null,
          rafi_dir:        d.rafiDir ?? null,
          bb_width:        d.bbWidth ?? null,
          updated_at:      new Date().toISOString(),
        })
        .eq('id', d.id)
      if (!error) enriched++
    }

    return NextResponse.json({ inserted: novos.length, enriched })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
