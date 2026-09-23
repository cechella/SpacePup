import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Campos atualizáveis via POST
type IAConfigUpdate = {
  ia_autonoma_ativa?: boolean
  sessao_sydney_tokyo?: boolean
  sessao_tokyo_london?: boolean
  sessao_london_ny?: boolean
  meta_diaria_pct?: number
  meta_semanal_pct?: number
  threshold_confianca?: number
  xgboost_mode?: 'off' | 'shadow' | 'and' | 'xgboost'
}

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase não configurado')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET() {
  const supa = getClient()
  const { data, error } = await supa
    .from('rafi_ia_config')
    .select('*')
    .eq('id', 'default')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const body: IAConfigUpdate = await req.json()

  // Aceita apenas campos conhecidos
  const allowed: (keyof IAConfigUpdate)[] = [
    'ia_autonoma_ativa',
    'sessao_sydney_tokyo',
    'sessao_tokyo_london',
    'sessao_london_ny',
    'meta_diaria_pct',
    'meta_semanal_pct',
    'threshold_confianca',
    'xgboost_mode',
  ]
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const supa = getClient()
  const { data, error } = await supa
    .from('rafi_ia_config')
    .update(patch)
    .eq('id', 'default')
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
