import { NextResponse } from 'next/server'

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

const TF_MAP: Record<string, { api: string; minutes: number }> = {
  M5:  { api: '5m',  minutes: 5  },
  M15: { api: '15m', minutes: 15 },
  H1:  { api: '1h',  minutes: 60 },
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M15'
  const limit     = parseInt(searchParams.get('limit') || '500', 10)

  const tf = TF_MAP[timeframe] ?? TF_MAP['M15']

  // startTime: recua o suficiente para cobrir todos os candles pedidos
  const startTime = new Date(Date.now() - tf.minutes * limit * 60 * 1000 * 1.2).toISOString()

  const url = `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/${symbol}/timeframes/${tf.api}/candles?limit=${limit}&startTime=${encodeURIComponent(startTime)}`

  try {
    const res = await fetch(url, {
      headers: { 'auth-token': TOKEN },
      next: { revalidate: 0 },
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[MetaAPI candles] erro', res.status, errText, '| url:', url)
      return NextResponse.json(
        { error: `${res.status}: ${errText}` },
        { status: res.status },
      )
    }

    const data = await res.json()
    const raw: any[] = Array.isArray(data) ? data : (data.candles ?? [])

    const candles = raw.map((c: any) => ({
      time:   new Date(c.time).getTime() / 1000,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tickVolume ?? c.volume ?? 0,
    }))

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    console.error('[MetaAPI candles] exceção', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
