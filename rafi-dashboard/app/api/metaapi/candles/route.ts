import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

// Mapeamento de timeframes para o formato aceito pelo SDK
const TF_MAP: Record<string, { api: string; minutes: number }> = {
  M5:  { api: '5m',  minutes: 5  },
  M15: { api: '15m', minutes: 15 },
  H1:  { api: '1h',  minutes: 60 },
}

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M15'
  const limit     = parseInt(searchParams.get('limit') || '100', 10)

  const tf = TF_MAP[timeframe] ?? TF_MAP['M15']

  let connection: any = null
  try {
    const api = new MetaApi(TOKEN)
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT)

    // Conexão RPC: requisição/resposta sem sincronização completa (mais rápido)
    connection = account.getRPCConnection()
    await connection.connect()

    const startTime = new Date(Date.now() - tf.minutes * limit * 2 * 60 * 1000)
    const raw: any[] = await connection.getHistoricalCandles(symbol, tf.api, startTime, undefined, limit)

    const candles = (Array.isArray(raw) ? raw : []).map((c: any) => ({
      time:   new Date(c.time).getTime() / 1000,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tickVolume ?? c.volume ?? 0,
    }))

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    console.error('[MetaAPI SDK candles] erro:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  } finally {
    if (connection) {
      try { await connection.close() } catch (_) {}
    }
  }
}
