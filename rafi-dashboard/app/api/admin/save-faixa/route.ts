/**
 * POST /api/admin/save-faixa
 * Salva uma faixa de lote no Supabase via service_role.
 * Requer header X-Admin-Password com a senha correta.
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
  // Verifica senha
  const senha = req.headers.get('x-admin-password') ?? ''
  const senhaCorreta = process.env.ADMIN_CONFIG_PASSWORD ?? ''
  if (!senhaCorreta) {
    return NextResponse.json({ error: 'Senha não configurada no servidor' }, { status: 500 })
  }
  if (!senha || senha !== senhaCorreta) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const { ordem, lote, capital_min, capital_max } = await req.json()
    if (typeof ordem !== 'number') {
      return NextResponse.json({ error: 'ordem inválida' }, { status: 400 })
    }

    const supa = getServiceClient()
    const { error } = await supa
      .from('rafi_lote_faixas')
      .update({
        lote,
        capital_min,
        capital_max: capital_max ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('ordem', ordem)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
