import { NextResponse } from 'next/server'

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

const TF_MAP: Record<string, string> = {
  M5:  '5m',
  M15: '15m',
  H1:  '1h',
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M15'
  const limit     = searchParams.get('limit')     || '200'

  const tf = TF_MAP[timeframe] || '15m'

  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/${symbol}/timeframes/${tf}/candles?limit=${limit}`,
      {
        headers: { 'auth-token': TOKEN },
        next: { revalidate: 0 },
      }
    )

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: err }, { status: res.status })
    }

    const data = await res.json()
    // Normaliza para o formato usado pelo RAFIChart
    const candles = (data.candles || data || []).map((c: any) => ({
      time:   new Date(c.time).getTime() / 1000,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tickVolume || c.volume || 0,
    }))

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
