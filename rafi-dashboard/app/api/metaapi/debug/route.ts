import { NextResponse } from 'next/server'

const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime = 'edge'

export async function GET() {
  const h = { 'auth-token': TOKEN }
  const out: Record<string, any> = {
    accountId:    ACCOUNT,
    tokenPresent: TOKEN?.length > 10 ? `${TOKEN.slice(0, 8)}…` : 'AUSENTE',
    base:         BASE,
  }

  // 1. Estado da conta
  try {
    const r = await fetch(`${BASE}/users/current/accounts/${ACCOUNT}`, { headers: h, signal: AbortSignal.timeout(10_000) })
    out.accountHttpStatus = r.status
    out.account = await r.json()
  } catch (e: any) {
    out.accountError = e.message
  }

  // 2. Teste de candles — 2h atrás, limite 5
  try {
    const startTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const url = `${BASE}/users/current/accounts/${ACCOUNT}/historical-market-data/symbols/EURUSD/timeframes/5m/candles?startTime=${encodeURIComponent(startTime)}&limit=5`
    out.candlesUrl = url
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(10_000) })
    out.candlesHttpStatus = r.status
    out.candlesBody = await r.json()
  } catch (e: any) {
    out.candlesError = e.message
  }

  // 3. Lista de contas (verifica se o accountId bate)
  try {
    const r = await fetch(`${BASE}/users/current/accounts`, { headers: h, signal: AbortSignal.timeout(10_000) })
    out.accountsHttpStatus = r.status
    const body = await r.json()
    out.accounts = Array.isArray(body) ? body.map((a: any) => ({ id: a.id, state: a.state, connectionStatus: a.connectionStatus, name: a.name, type: a.type })) : body
  } catch (e: any) {
    out.accountsError = e.message
  }

  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
