/**
 * GET  /api/admin/cleanup-bad-trades  — lista os trades IA do dia 24/09/2026 com resultado loss
 * DELETE /api/admin/cleanup-bad-trades — apaga esses trades do Supabase
 *
 * Protegido pelo CRON_SECRET. Uso único para limpar dados corrompidos pelo bug do SL.
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
// 25/09/2026 00:00:00 BRT = 03:00:00 UTC
const DAY_END   = Math.floor(new Date('2026-09-25T03:00:00.000Z').getTime() / 1000)

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
    .select('id, time, direction, entry, result, pnl_usd, label', { count: 'exact' })
    .eq('entry_type', 'ia_autonoma')
    .eq('result', 'loss')
    .gte('time', DAY_START)
    .lt('time', DAY_END)

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

// DELETE: apaga os registros
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supa = getServiceClient()

  // Primeiro busca os IDs para confirmar o que será apagado
  const { data: toDelete, error: selectErr } = await supa
    .from('rafi_trades')
    .select('id, time, direction, pnl_usd')
    .eq('entry_type', 'ia_autonoma')
    .eq('result', 'loss')
    .gte('time', DAY_START)
    .lt('time', DAY_END)

  if (selectErr) return NextResponse.json({ error: selectErr.message }, { status: 500 })
  if (!toDelete || toDelete.length === 0) {
    return NextResponse.json({ deleted: 0, message: 'Nenhum registro encontrado para deletar' })
  }

  const ids = toDelete.map(t => t.id)

  const { error: deleteErr } = await supa
    .from('rafi_trades')
    .delete()
    .in('id', ids)

  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 })

  return NextResponse.json({
    deleted: ids.length,
    message: `${ids.length} trade(s) apagados com sucesso`,
    ids,
  })
}
