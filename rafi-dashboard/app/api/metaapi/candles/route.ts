import { NextResponse } from 'next/server'

// REST API direta — sem SDK, sem timeout de 10s do Vercel hobby.
// O SDK MetaAPI pode levar 30s+ para getHistoricalCandles, ultrapassando
// o limite serverless e causando setMetaConnected(false) no cliente.
const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

// Mapeia o timeframe do cliente para o formato do MetaAPI REST
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
  // 'since': timestamp Unix em segundos — fetch incremental a partir desse candle
  const since     = searchParams.get('since')

  const tf = TF_MAP[timeframe] ?? TF_MAP['M5']

  // Se 'since' for passado, busca só candles novos (até 500); senão janela padrão
  const startTime = since
    ? new Date(parseInt(since, 10) * 1000).toISOString()
    : new Date(Date.now() - limit * tf.minutes * 60 * 1000 * 3).toISOString()
  const fetchLimit = since ? 500 : limit

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
      // Fetch normal: pega os últimos N; fetch incremental (since): retorna todos os novos
      .slice(since ? 0 : -limit)

    if (candles.length === 0) {
      return NextResponse.json({ error: 'Nenhum candle retornado' }, { status: 404 })
    }

    return NextResponse.json({ candles, symbol, timeframe })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
