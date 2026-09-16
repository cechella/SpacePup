/**
 * POST /api/admin/reset-db
 * Apaga todos os dados de trades, candles, logs e IA.
 * Mantém configurações (config_risco, lote_faixas, brokers, bot_config).
 * Requer SUPABASE_SERVICE_ROLE_KEY para bypass de RLS.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Tabelas de trades/IA — sempre apagadas no reset
const TRADE_TABLES = [
  'rafi_trades',
  'rafi_historico',
  'rafi_backtest_runs',
  'rafi_bot_commands',
  'rafi_bot_logs',
  'rafi_bot_status',
  'rafi_uploads',
] as const

// Tabela de candles — apagada só se clearCandles=true
const CANDLE_TABLES = ['rafi_candles'] as const

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))

    // Verificação de confirmação obrigatória
    if (body.confirm !== 'RESETAR') {
      return NextResponse.json(
        { error: 'Confirmação inválida. Envie { "confirm": "RESETAR" }' },
        { status: 400 },
      )
    }

    const clearCandles = body.clearCandles === true
    const tables = clearCandles
      ? [...TRADE_TABLES, ...CANDLE_TABLES]
      : [...TRADE_TABLES]

    const supa = getServiceClient()
    const results: Record<string, string> = {}

    for (const table of tables) {
      // DELETE sem filtro apaga tudo — requer service role para ignorar RLS
      const { error } = await supa.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000')
      if (error) {
        // Tenta com filtro alternativo para tabelas sem coluna 'id'
        const { error: e2 } = await supa.from(table).delete().gte('created_at', '1970-01-01')
        results[table] = e2 ? `ERRO: ${e2.message}` : 'OK'
      } else {
        results[table] = 'OK'
      }
    }

    return NextResponse.json({
      ok: true,
      message: 'Banco de dados resetado com sucesso',
      tables: results,
      candlesCleared: clearCandles,
      resetAt: new Date().toISOString(),
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
