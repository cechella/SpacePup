/**
 * API Route: /api/backtest
 * GET  — retorna histórico de runs de backtest
 * POST — cria novo run (o bot na VM detecta e executa)
 * DELETE — cancela run pendente
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
      .from('rafi_backtest_runs')
      .select('id,created_at,periodo,inicio,fim,capital,profile,status,config_hash,progress_pct,resultado,error_msg,updated_at')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ runs: data ?? [] })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { periodo, inicio, fim, capital, profile } = body

    if (!periodo && !inicio) {
      return NextResponse.json({ error: 'periodo é obrigatório' }, { status: 400 })
    }

    const supa = getServiceClient()
    const now  = new Date().toISOString()

    // Impede criar novo run se já existe um pendente ou em execução
    const { data: ativos } = await supa
      .from('rafi_backtest_runs')
      .select('id')
      .in('status', ['pending', 'running'])
      .limit(1)

    if (ativos && ativos.length > 0) {
      return NextResponse.json(
        { error: 'Já há um backtest em andamento. Aguarde a conclusão.' },
        { status: 409 },
      )
    }

    const { data, error } = await supa
      .from('rafi_backtest_runs')
      .insert({
        periodo:    periodo ?? null,
        inicio:     inicio  ?? null,
        fim:        fim     ?? null,
        capital:    capital ?? 20.0,
        profile:    profile ?? 'simulator',
        status:     'pending',
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, run_id: data?.id })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { run_id } = await req.json()
    if (!run_id) return NextResponse.json({ error: 'run_id obrigatório' }, { status: 400 })

    const supa = getServiceClient()
    const { error } = await supa
      .from('rafi_backtest_runs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', run_id)
      .eq('status', 'pending')  // só cancela se ainda pendente

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
