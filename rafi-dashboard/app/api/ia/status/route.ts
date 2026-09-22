import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Campos atualizáveis via POST
type IAConfigUpdate = {
  ia_autonoma_ativa?: boolean
  sessao_sydney_tokyo?: boolean
  sessao_tokyo_london?: boolean
  meta_diaria_pct?: number
  meta_semanal_pct?: number
  threshold_confianca?: number
}

export async function GET() {
  const { data, error } = await supabase
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
    'meta_diaria_pct',
    'meta_semanal_pct',
    'threshold_confianca',
  ]
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabase
    .from('rafi_ia_config')
    .update(patch)
    .eq('id', 'default')
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
