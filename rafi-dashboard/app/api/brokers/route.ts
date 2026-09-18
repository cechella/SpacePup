/**
 * API Route: /api/brokers
 * GET  → lista todas as corretoras (rafi_brokers)
 * POST → ativa/desativa uma corretora { id, enabled }
 *        ou cria uma nova { id, nome, metaapi_account_id, simbolo?, broker_priority?, mt5_login?, mt5_servidor?, _create: true }
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
    // Busca brokers com estado de saúde em join lateral
    const { data, error } = await supa
      .from('rafi_brokers')
      .select(`
        *,
        broker_health_state (
          estado,
          circuit_breaker,
          health_score,
          motivo_estado,
          atualizado_em
        )
      `)
      .order('broker_priority', { ascending: true, nullsFirst: false })

    if (error) throw error

    // Achata o join: campos de saúde sobem para o nível raiz do broker
    const brokers = (data ?? []).map((b: Record<string, unknown> & { broker_health_state?: Record<string, unknown> | null }) => {
      const hs = b.broker_health_state
      return {
        ...b,
        broker_health_state: undefined,
        health_estado:    hs?.estado          ?? b.health_estado    ?? 'STANDBY',
        circuit_breaker:  hs?.circuit_breaker ?? 'CLOSED',
        health_score:     hs?.health_score    ?? b.health_score     ?? 0,
        motivo_estado:    hs?.motivo_estado   ?? null,
      }
    })

    return NextResponse.json({ brokers })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Modo criação: _create: true → INSERT nova corretora
    if (body._create) {
      const { id, nome, metaapi_account_id, simbolo, broker_priority, mt5_login, mt5_servidor } = body
      if (!id || !nome || !metaapi_account_id) {
        return NextResponse.json({ error: 'id, nome e metaapi_account_id são obrigatórios' }, { status: 400 })
      }
      const supa = getServiceClient()
      const { error } = await supa.from('rafi_brokers').insert({
        id,
        nome,
        metaapi_account_id,
        simbolo:         simbolo        ?? 'EURUSD',
        broker_priority: broker_priority ?? 99,
        mt5_login:       mt5_login       ?? null,
        mt5_servidor:    mt5_servidor    ?? null,
        enabled:         false,
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      if (error) throw error
      return NextResponse.json({ ok: true, id, created: true })
    }

    // Modo toggle bot_enabled
    if (typeof body.bot_enabled === 'boolean') {
      const { id, bot_enabled } = body
      if (!id) return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
      const supa = getServiceClient()
      const { error } = await supa
        .from('rafi_brokers')
        .update({ bot_enabled, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      return NextResponse.json({ ok: true, id, bot_enabled })
    }

    // Modo toggle enabled (Mesa de Operação)
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
    const { id, mt5_login, mt5_senha, mt5_servidor, mt5_simbolo, mt5_path, metaapi_account_id } = body

    if (!id) {
      return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (mt5_login           !== undefined) patch.mt5_login           = mt5_login
    if (mt5_senha           !== undefined) patch.mt5_senha           = mt5_senha
    if (mt5_servidor        !== undefined) patch.mt5_servidor        = mt5_servidor
    if (mt5_simbolo         !== undefined) patch.mt5_simbolo         = mt5_simbolo
    if (mt5_path            !== undefined) patch.mt5_path            = mt5_path
    if (metaapi_account_id  !== undefined) patch.metaapi_account_id  = metaapi_account_id
    // Sincroniza campos base que o bot usa para validar terminal conectado
    if (mt5_login    !== undefined && mt5_login !== null) patch.login    = mt5_login
    if (mt5_servidor !== undefined && mt5_servidor !== null) patch.servidor = mt5_servidor
    if (mt5_simbolo  !== undefined && mt5_simbolo  !== null) patch.simbolo  = mt5_simbolo

    const supa = getServiceClient()
    const { error } = await supa.from('rafi_brokers').update(patch).eq('id', id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
