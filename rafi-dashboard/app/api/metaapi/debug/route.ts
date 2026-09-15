import { NextResponse } from 'next/server'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

// SDK usa mt-market-data-client-api-v1 para candles históricos (não mt-client-api-v1)
const CANDIDATES = [
  'https://mt-market-data-client-api-v1.london.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.singapore.agiliumtrade.ai',
  'https://mt-client-api-v1.london.agiliumtrade.ai',
]

export const runtime = 'edge'

export async function GET() {
  const h = { 'auth-token': TOKEN }
  const out: Record<string, any> = {
    accountId:    ACCOUNT,
    tokenPresent: TOKEN?.length > 10 ? `${TOKEN.slice(0, 8)}…` : 'AUSENTE',
    urlTests:     [] as any[],
  }

  // Testa cada URL candidata com /users/current/accounts
  for (const base of CANDIDATES) {
    try {
      const r = await fetch(`${base}/users/current/accounts`, { headers: h, signal: AbortSignal.timeout(6_000) })
      const body = await r.json().catch(() => null)
      out.urlTests.push({
        base,
        status: r.status,
        ok: r.status === 200,
        body: Array.isArray(body) ? `${body.length} accounts` : body?.message ?? body,
      })
    } catch (e: any) {
      out.urlTests.push({ base, error: e.message })
    }
  }

  // Com a primeira URL que funcionar, testa candles
  const working = out.urlTests.find((t: any) => t.ok)
  if (working) {
    out.workingBase = working.base
    const startTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const url = `${working.base}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/EURUSD/timeframes/5m/candles?startTime=${encodeURIComponent(startTime)}&limit=5`
    try {
      const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(8_000) })
      out.candlesStatus = r.status
      out.candlesBody   = await r.json()
    } catch (e: any) {
      out.candlesError = e.message
    }
  }

  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
