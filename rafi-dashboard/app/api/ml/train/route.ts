/**
 * API Route: POST /api/ml/train
 * Envia comando de retreino XGBoost para o bot via rafi_bot_commands.
 * O executor.py monitora essa tabela e inicia o treino quando vê o comando.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST() {
  try {
    const supa = getServiceClient()
    const { error } = await supa.from('rafi_bot_commands').insert({
      command: 'treinar_xgboost',
      pending: true,
      created_at: new Date().toISOString(),
    })
    if (error) throw error
    return NextResponse.json({ ok: true, message: 'Comando de treino enviado ao bot' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
