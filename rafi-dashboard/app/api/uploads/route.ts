/**
 * API Route: /api/uploads
 * GET    — retorna histórico de uploads de dados de mercado
 * POST   — cria solicitação de upload (o bot na VM detecta e executa)
 * DELETE — cancela upload pendente
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
      .from('rafi_uploads')
      .select('id,arquivo,broker,status,progress_pct,storage_path,tamanho_bytes,error_msg,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ uploads: data ?? [] })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body   = await req.json()
    const broker = (body.broker as string | undefined) || 'pepperstone'

    const supa = getServiceClient()

    // Impede criar novo upload se já há um em andamento
    const { data: ativos } = await supa
      .from('rafi_uploads')
      .select('id')
      .in('status', ['pending', 'running'])
      .limit(1)

    if (ativos && ativos.length > 0) {
      return NextResponse.json(
        { error: 'Já há um upload em andamento. Aguarde a conclusão.' },
        { status: 409 },
      )
    }

    const { data, error } = await supa
      .from('rafi_uploads')
      .insert({
        arquivo:      `${broker}_EURUSD_M5.csv.gz`,
        broker,
        status:       'pending',
        progress_pct: 0,
      })
      .select('id')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ upload_id: data?.id }, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { upload_id } = await req.json()
    if (!upload_id) return NextResponse.json({ error: 'upload_id obrigatório' }, { status: 400 })

    const supa = getServiceClient()
    const { error } = await supa
      .from('rafi_uploads')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', upload_id)
      .eq('status', 'pending')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
