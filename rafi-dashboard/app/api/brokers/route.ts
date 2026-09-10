/**
 * API Route: /api/brokers
 * GET  → lista todas as corretoras (rafi_brokers)
 * POST → ativa/desativa uma corretora { id, enabled }
 *
 * Escritas usam SERVICE_ROLE_KEY (servidor) — o anon key só tem SELECT.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET() {
  try {
    const supa = getServiceClient()
    const { data, error } = await supa
      .from('rafi_brokers')
      .select('*')
      .order('id')

    if (error) throw error
    return NextResponse.json({ brokers: data ?? [] })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, enabled } = body

    if (!id || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'id (string) e enabled (boolean) são obrigatórios' }, { status: 400 })
    }

    const supa = getServiceClient()
    const { error } = await supa
      .from('rafi_brokers')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error
    return NextResponse.json({ ok: true, id, enabled })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH → salva credenciais MT5 { id, mt5_login, mt5_senha, mt5_servidor, mt5_simbolo, mt5_path }
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, mt5_login, mt5_senha, mt5_servidor, mt5_simbolo, mt5_path } = body

    if (!id) {
      return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (mt5_login   !== undefined) patch.mt5_login   = mt5_login
    if (mt5_senha   !== undefined) patch.mt5_senha   = mt5_senha
    if (mt5_servidor !== undefined) patch.mt5_servidor = mt5_servidor
    if (mt5_simbolo !== undefined) patch.mt5_simbolo = mt5_simbolo
    if (mt5_path    !== undefined) patch.mt5_path    = mt5_path

    const supa = getServiceClient()
    const { error } = await supa.from('rafi_brokers').update(patch).eq('id', id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
