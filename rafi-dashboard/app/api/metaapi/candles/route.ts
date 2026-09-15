import { NextResponse } from 'next/server'

// SDK usa mt-market-data-client-api-v1 (não mt-client-api-v1) para candles históricos
const BASE    = 'https://mt-market-data-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

const TF_MAP: Record<string, { rest: string; minutes: number }> = {
  M5:  { rest: '5m',  minutes: 5  },
  M15: { rest: '15m', minutes: 15 },
  H1:  { rest: '1h',  minutes: 60 },
}

export const runtime = 'edge'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M5'
  const limit     = parseInt(searchParams.get('limit') || '100', 10)

  const tf = TF_MAP[timeframe] ?? TF_MAP['M5']

  // janela 3× maior para garantir N candles mesmo com fins de semana/sessões fechadas
  const windowMs  = limit * tf.minutes * 60 * 1000 * 3
  const startTime = new Date(Date.now() - windowMs).toISOString()

  try {
    const url = `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/${symbol}/timeframes/${tf.rest}/candles?startTime=${encodeURIComponent(startTime)}&limit=${limit}`

    const res = await fetch(url, {
      headers: { 'auth-token': TOKEN },
      signal:  AbortSignal.timeout(8_000),
      cache:   'no-store',
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    const raw = await res.json()
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? [])

    const candles = arr
      .map((c: any) => ({
        time:   new Date(c.time).getTime() / 1000,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.tickVolume ?? c.volume ?? 0,
      }))
      .sort((a: any, b: any) => a.time - b.time)
      .slice(-limit)

    if (candles.length === 0) {
      return NextResponse.json({ error: 'Nenhum candle retornado' }, { status: 404 })
    }

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
