import { NextResponse } from 'next/server'

const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

const TF_MAP: Record<string, { rest: string; minutes: number }> = {
  M5:  { rest: '5m',  minutes: 5  },
  M15: { rest: '15m', minutes: 15 },
  H1:  { rest: '1h',  minutes: 60 },
}

// Se o cache do Supabase for mais velho que isso, ignora o 'since' e busca fresco
const MAX_SINCE_AGO_MS = 5 * 24 * 60 * 60 * 1000 // 5 dias

export const runtime = 'edge'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M5'
  const limit     = parseInt(searchParams.get('limit') || '100', 10)
  const since     = searchParams.get('since')

  const tf = TF_MAP[timeframe] ?? TF_MAP['M5']

  // Se 'since' for passado mas for mais velho que 5 dias, trata como sem since
  // (MetaAPI não serve histórico muito antigo via REST — busca os últimos N candles)
  const sinceMs      = since ? parseInt(since, 10) * 1000 : 0
  const sinceRecente = sinceMs > 0 && (Date.now() - sinceMs) < MAX_SINCE_AGO_MS

  const startTime  = sinceRecente
    ? new Date(sinceMs).toISOString()
    : new Date(Date.now() - limit * tf.minutes * 60 * 1000 * 3).toISOString()
  const fetchLimit = sinceRecente ? 500 : limit

  try {
    const url = `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/${symbol}/timeframes/${tf.rest}/candles?startTime=${encodeURIComponent(startTime)}&limit=${fetchLimit}`

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
      .slice(sinceRecente ? 0 : -limit)

    if (candles.length === 0) {
      return NextResponse.json({ error: 'Nenhum candle retornado' }, { status: 404 })
    }

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
