import { NextResponse } from 'next/server'

const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

const TF_MAP: Record<string, { rest: string; yahoo: string; yahooRange: string; minutes: number }> = {
  M5:  { rest: '5m',  yahoo: '5m',  yahooRange: '5d',  minutes: 5  },
  M15: { rest: '15m', yahoo: '15m', yahooRange: '60d', minutes: 15 },
  H1:  { rest: '1h',  yahoo: '60m', yahooRange: '60d', minutes: 60 },
}

export const runtime = 'edge'

// Fallback: Yahoo Finance — gratuito, sem API key, dados reais de forex
async function fetchYahoo(symbol: string, tf: typeof TF_MAP[string], sinceTs: number | null, limit: number) {
  const yahooSym = symbol === 'EURUSD' ? 'EURUSD=X' : `${symbol}=X`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${tf.yahoo}&range=${tf.yahooRange}&includePrePost=false`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal:  AbortSignal.timeout(8_000),
    cache:   'no-store',
  })

  if (!res.ok) throw new Error(`Yahoo Finance: ${res.status}`)

  const data = await res.json()
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error('Yahoo Finance: resposta inválida')

  const timestamps: number[] = result.timestamp ?? []
  const q = result.indicators?.quote?.[0] ?? {}

  let candles = timestamps
    .map((t: number, i: number) => ({
      time:   t,
      open:   q.open?.[i]   ?? null,
      high:   q.high?.[i]   ?? null,
      low:    q.low?.[i]    ?? null,
      close:  q.close?.[i]  ?? null,
      volume: q.volume?.[i] ?? 0,
    }))
    .filter((c: any) => c.open != null && c.close != null)
    .sort((a: any, b: any) => a.time - b.time)

  if (sinceTs) {
    candles = candles.filter((c: any) => c.time > sinceTs)
  } else {
    candles = candles.slice(-limit)
  }

  return candles
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol    = searchParams.get('symbol')    || 'EURUSD'
  const timeframe = searchParams.get('timeframe') || 'M5'
  const limit     = parseInt(searchParams.get('limit') || '100', 10)
  const since     = searchParams.get('since')
  const sinceTs   = since ? parseInt(since, 10) : null

  const tf = TF_MAP[timeframe] ?? TF_MAP['M5']

  const startTime  = sinceTs
    ? new Date(sinceTs * 1000).toISOString()
    : new Date(Date.now() - limit * tf.minutes * 60 * 1000 * 3).toISOString()
  const fetchLimit = sinceTs ? 500 : limit

  // Tenta MetaAPI primeiro; fallback automático para Yahoo Finance
  let metaError = ''
  try {
    const url = `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/${symbol}/timeframes/${tf.rest}/candles?startTime=${encodeURIComponent(startTime)}&limit=${fetchLimit}`

    const res = await fetch(url, {
      headers: { 'auth-token': TOKEN },
      signal:  AbortSignal.timeout(8_000),
      cache:   'no-store',
    })

    if (res.ok) {
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
        .slice(sinceTs ? 0 : -limit)

      if (candles.length > 0) {
        return NextResponse.json({ candles, symbol, timeframe, source: 'metaapi' })
      }
    } else {
      metaError = await res.text()
    }
  } catch (e: any) {
    metaError = e.message
  }

  // Fallback: Yahoo Finance
  try {
    const candles = await fetchYahoo(symbol, tf, sinceTs, limit)
    if (candles.length === 0) {
      return NextResponse.json({ error: 'Nenhum candle retornado (MetaAPI e Yahoo Finance)' }, { status: 404 })
    }
    return NextResponse.json({ candles, symbol, timeframe, source: 'yahoo' })
  } catch (e: any) {
    return NextResponse.json(
      { error: `MetaAPI: ${metaError} | Yahoo: ${e.message}` },
      { status: 500 },
    )
  }
}
