import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

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

  try {
    const api = new MetaApi(TOKEN)
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT)

    // startTime=undefined → retorna os candles mais recentes (API carrega de trás pra frente)
    const raw = await account.getHistoricalCandles(symbol, tf.api, undefined, limit)

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
    console.error('[MetaAPI candles] erro:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
