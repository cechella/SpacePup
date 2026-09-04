/**
 * API Route: /api/config
 * Salva configurações do bot no Supabase usando SERVICE_ROLE_KEY (servidor).
 * O anon key no browser só tem SELECT — escritas passam por aqui.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { profile, cfg } = body

    if (!profile || !cfg) {
      return NextResponse.json({ error: 'profile e cfg são obrigatórios' }, { status: 400 })
    }
    if (!['live', 'simulator'].includes(profile)) {
      return NextResponse.json({ error: 'profile inválido' }, { status: 400 })
    }

    const supa = getServiceClient()
    const ts = new Date().toISOString()

    const { error } = await supa
      .from('rafi_bot_config')
      .upsert({ ...cfg, profile, updated_at: ts }, { onConflict: 'profile' })

    if (error) {
      const msg = error.message ?? error.details ?? error.hint ?? JSON.stringify(error)
      return NextResponse.json({ error: msg, code: error.code }, { status: 500 })
    }

    return NextResponse.json({ ok: true, updated_at: ts })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message
      : (e && typeof e === 'object' && 'message' in e) ? String((e as any).message)
      : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
