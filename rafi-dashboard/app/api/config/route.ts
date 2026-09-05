/**
 * API Route: /api/config
 * GET  — retorna config live + simulator + hash MD5 computado server-side
 * POST — salva configurações no Supabase via SERVICE_ROLE_KEY
 */
import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Campos da estratégia que o bot lê — deve ser idêntico ao CHAVES em executor.py
const CAMPOS_CONFIG = [
  'estrategia_modo', 'forca_limiar', 'rafi_periodo', 'sr_lookback',
  'swing_stop_lookback', 'ma_rapida', 'ma_lenta', 'ma_threshold',
  'bb_filtro_ativo', 'bb_limiar_estreita', 'bb_periodo', 'bb_desvios',
  'ratio_risco_retorno', 'max_trades_simultaneos',
  'autoscan_min_breakout', 'autoscan_min_gap_candles',
  'autoscan_stop_offset', 'bb_squeeze_expansao_min',
]

// Replica exatamente o calcular_hash_config() do executor.py:
// json.dumps(snapshot, sort_keys=True) → MD5 → primeiros 8 chars
function computeConfigHash(cfg: Record<string, unknown>): string {
  const snapshot: Record<string, unknown> = {}
  for (const k of CAMPOS_CONFIG) snapshot[k] = cfg[k] ?? null
  const ordered: Record<string, unknown> = {}
  for (const k of Object.keys(snapshot).sort()) ordered[k] = snapshot[k]
  return createHash('md5').update(JSON.stringify(ordered)).digest('hex').slice(0, 8)
}

export async function GET() {
  try {
    const supa = getServiceClient()
    const { data, error } = await supa
      .from('rafi_bot_config')
      .select('*')
      .in('profile', ['live', 'simulator'])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const live = data?.find((r: Record<string, unknown>) => r.profile === 'live')
    const sim  = data?.find((r: Record<string, unknown>) => r.profile === 'simulator')
    return NextResponse.json({
      live:      live ?? null,
      simulator: sim  ?? null,
      live_hash: live ? computeConfigHash(live as Record<string, unknown>) : null,
      sim_hash:  sim  ? computeConfigHash(sim  as Record<string, unknown>) : null,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
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

    // Filtra apenas os campos de estratégia — remove id, updated_at antigo e
    // outras colunas internas do Supabase que causam conflito de PK no upsert
    const payload: Record<string, unknown> = { profile, updated_at: ts }
    for (const k of CAMPOS_CONFIG) {
      if (k in cfg) payload[k] = cfg[k]
    }

    // Verifica se o perfil já existe para decidir entre update e insert
    const { data: existing } = await supa
      .from('rafi_bot_config')
      .select('profile')
      .eq('profile', profile)
      .limit(1)

    let error: { message?: string; details?: string; hint?: string } | null
    if (existing && existing.length > 0) {
      // Perfil existe — usa UPDATE para evitar conflito de PK
      const { error: e } = await supa
        .from('rafi_bot_config')
        .update(payload)
        .eq('profile', profile)
      error = e
    } else {
      // Perfil não existe — usa INSERT
      const { error: e } = await supa
        .from('rafi_bot_config')
        .insert(payload)
      error = e
    }

    if (error) {
      const msg = error.message ?? error.details ?? error.hint ?? JSON.stringify(error)
      return NextResponse.json({ error: msg }, { status: 500 })
    }

    return NextResponse.json({ ok: true, updated_at: ts })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message
      : (e && typeof e === 'object' && 'message' in e) ? String((e as any).message)
      : JSON.stringify(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
