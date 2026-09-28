/**
 * GET  /api/admin/cleanup-bad-trades  — lista os trades IA dos dias 24-25/09/2026 corrompidos
 * DELETE /api/admin/cleanup-bad-trades — apaga esses trades do Supabase
 *
 * Cobre 24/09 e 25/09 BRT: bug do SL fixo + RAFI 0.8 sem filtro mínimo.
 * Só apaga entry_type='ia_autonoma' — trades manuais não são tocados.
 * Protegido pelo CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// 24/09/2026 00:00:00 BRT = 03:00:00 UTC
const DAY_START = Math.floor(new Date('2026-09-24T03:00:00.000Z').getTime() / 1000)
// 26/09/2026 00:00:00 BRT = 03:00:00 UTC — cobre 24/09 e 25/09 completos
const DAY_END   = Math.floor(new Date('2026-09-26T03:00:00.000Z').getTime() / 1000)

function checkAuth(req: NextRequest) {
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  return process.env.CRON_SECRET && auth === expected
}

// GET: mostra quais registros seriam deletados
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supa = getServiceClient()
  const { data, error, count } = await supa
    .from('rafi_trades')
    .select('id, time, direction, entry, result, pnl_usd, label, entry_type', { count: 'exact' })
    .gte('time', DAY_START)
    .lt('time', DAY_END)
    .eq('entry_type', 'ia_autonoma')
    .order('time', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    preview: true,
    message: `${count ?? 0} trade(s) seriam deletados`,
    trades: (data ?? []).map(t => ({
      id:        t.id,
      time:      new Date(t.time * 1000).toISOString(),
      direction: t.direction,
      entry:     t.entry,
      result:    t.result,
      pnl_usd:   t.pnl_usd,
      label:     t.label,
    })),
  })
}

// DELETE: apaga os registros do dia 24/09 + quaisquer OCO pendentes com timestamp em ms
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supa = getServiceClient()

  // 1) Trades IA dos dias 24-25/09 (timestamp em segundos)
  const { data: byDay, error: dayErr } = await supa
    .from('rafi_trades')
    .select('id')
    .gte('time', DAY_START)
    .lt('time', DAY_END)
    .eq('entry_type', 'ia_autonoma')

  if (dayErr) return NextResponse.json({ error: dayErr.message }, { status: 500 })

  // 2) Trades OCO pendentes com timestamp em milissegundos (time > 9_999_999_999)
  // Esses escaparam do filtro anterior porque usam ms em vez de segundos
  const { data: byMs, error: msErr } = await supa
    .from('rafi_trades')
    .select('id, label')
    .eq('result', 'pending')
    .gt('time', 9_999_999_999)

  if (msErr) return NextResponse.json({ error: msErr.message }, { status: 500 })

  const ids = [
    ...(byDay ?? []).map((t: { id: string }) => t.id),
    ...(byMs  ?? []).map((t: { id: string }) => t.id),
  ]

  if (ids.length === 0) {
    return NextResponse.json({ deleted: 0, message: 'Nenhum registro encontrado para deletar' })
  }

  const { error: deleteErr } = await supa
    .from('rafi_trades')
    .delete()
    .in('id', ids)

  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 })

  return NextResponse.json({
    deleted: ids.length,
    by_day:  (byDay ?? []).length,
    by_ms:   (byMs  ?? []).length,
    message: `${ids.length} trade(s) apagados com sucesso`,
    ids,
  })
}
