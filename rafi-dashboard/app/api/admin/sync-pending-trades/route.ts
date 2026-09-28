/**
 * GET  /api/admin/sync-pending-trades — preview: lista quais pending seriam cancelados
 * POST /api/admin/sync-pending-trades — executa: cancela pending sem posição aberta no broker
 *
 * Lógica: busca todos os trades com result='pending' no Supabase e cruza com as posições
 * abertas reais no MetaAPI. Trades não encontrados no broker → result='cancelled'.
 * Resolve o problema de trades que fecham/cancelam no broker sem atualizar o banco.
 *
 * Protegido pelo CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getActiveBrokers } from '@/lib/top-broker'

export const runtime    = 'nodejs'
export const maxDuration = 15

const MT_BASE = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function checkAuth(req: NextRequest) {
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  return process.env.CRON_SECRET && auth === expected
}

interface MetaPos {
  id:        string
  type:      string  // 'POSITION_TYPE_BUY' | 'POSITION_TYPE_SELL'
  volume:    number
  openPrice: number
  openTime:  string
}

// Busca posições abertas reais de um broker
async function fetchOpenPositions(accountId: string): Promise<MetaPos[]> {
  try {
    const res = await fetch(
      `${MT_BASE}/users/current/accounts/${accountId}/positions`,
      { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(8_000), cache: 'no-store' },
    )
    if (!res.ok) return []
    const raw = await res.json()
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

// Verifica se um trade pendente do Supabase existe como posição aberta no broker
// Usa tolerância de 0.0002 no preço de entrada e 0.001 no volume
function matchesOpenPosition(trade: { entry: number; direction: string; lot: number }, positions: MetaPos[]): boolean {
  const dir = trade.direction === 'buy' ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL'
  return positions.some(p =>
    p.type === dir &&
    Math.abs(p.openPrice - trade.entry) <= 0.0002 &&
    Math.abs(p.volume - (trade.lot ?? 0.1)) <= 0.001,
  )
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supa = getServiceClient()

  const { data: pending, error } = await supa
    .from('rafi_trades')
    .select('id, direction, entry, lot, label, time, entry_type')
    .eq('result', 'pending')
    .order('time', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const brokers   = await getActiveBrokers()
  const allPos    = await Promise.all(brokers.map(b => fetchOpenPositions(b.accountId)))
  const positions = allPos.flat()

  const toCancel = (pending ?? []).filter(t => !matchesOpenPosition(t, positions))
  const toKeep   = (pending ?? []).filter(t =>  matchesOpenPosition(t, positions))

  return NextResponse.json({
    preview:     true,
    total_pending:  (pending ?? []).length,
    to_cancel:   toCancel.length,
    to_keep:     toKeep.length,
    open_positions_broker: positions.length,
    trades_to_cancel: toCancel.map(t => ({
      id:         t.id,
      direction:  t.direction,
      entry:      t.entry,
      lot:        t.lot,
      label:      t.label,
      time_iso:   new Date((t.time > 9_999_999_999 ? t.time : t.time * 1000)).toISOString(),
      entry_type: t.entry_type,
    })),
  })
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supa = getServiceClient()

  const { data: pending, error: fetchErr } = await supa
    .from('rafi_trades')
    .select('id, direction, entry, lot, label, time')
    .eq('result', 'pending')

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!pending || pending.length === 0) {
    return NextResponse.json({ cancelled: 0, message: 'Nenhum trade pendente encontrado' })
  }

  const brokers   = await getActiveBrokers()
  const allPos    = await Promise.all(brokers.map(b => fetchOpenPositions(b.accountId)))
  const positions = allPos.flat()

  const toCancel = pending.filter(t => !matchesOpenPosition(t, positions))

  if (toCancel.length === 0) {
    return NextResponse.json({
      cancelled: 0,
      kept: pending.length,
      message: 'Todos os pending têm posição aberta no broker — nenhum cancelamento necessário',
    })
  }

  const ids = toCancel.map(t => t.id)
  const { error: updateErr } = await supa
    .from('rafi_trades')
    .update({ result: 'cancelled', updated_at: new Date().toISOString() })
    .in('id', ids)

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({
    cancelled: ids.length,
    kept:      pending.length - ids.length,
    message:   `${ids.length} trade(s) marcados como cancelled (sem posição no broker)`,
    ids,
  })
}
