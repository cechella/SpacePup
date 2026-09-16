/**
 * GET  /api/admin/save-risco-param  — retorna todos os parâmetros de risco
 * POST /api/admin/save-risco-param  — atualiza um parâmetro via service_role
 *                                     Requer header X-Admin-Password.
 *                                     Parâmetros com bloqueado=true são rejeitados.
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
      .from('rafi_config_risco')
      .select('chave,valor,descricao,bloqueado')
      .order('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ params: data ?? [] })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const senha = req.headers.get('x-admin-password') ?? ''
  const senhaCorreta = process.env.ADMIN_CONFIG_PASSWORD ?? ''
  if (!senhaCorreta) {
    return NextResponse.json({ error: 'Senha não configurada no servidor' }, { status: 500 })
  }
  if (!senha || senha !== senhaCorreta) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const { chave, valor } = await req.json()
    if (!chave || typeof valor !== 'string') {
      return NextResponse.json({ error: 'chave e valor obrigatórios' }, { status: 400 })
    }

    const supa = getServiceClient()

    // Bloqueia parâmetros marcados como bloqueado=true no banco
    const { data: row } = await supa
      .from('rafi_config_risco')
      .select('bloqueado')
      .eq('chave', chave)
      .single()
    if (row?.bloqueado) {
      return NextResponse.json({ error: 'Parâmetro bloqueado — não pode ser alterado via admin' }, { status: 403 })
    }

    const { error } = await supa
      .from('rafi_config_risco')
      .update({ valor })
      .eq('chave', chave)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
