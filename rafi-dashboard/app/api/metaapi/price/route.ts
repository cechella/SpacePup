import { NextResponse } from 'next/server'
import { getTopBroker } from '@/lib/top-broker'

const BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const top     = await getTopBroker()
  const ACCOUNT = top.accountId
  const symbol  = top.symbol  // EURUSDz para Exness, EURUSD para outros

  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/symbols/${symbol}/current-price?keepSubscription=true`,
      {
        headers: { 'auth-token': TOKEN },
        signal:  AbortSignal.timeout(4000),
        next:    { revalidate: 0 },
      }
    )

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: err }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json({ bid: data.bid, ask: data.ask, time: data.time, symbol })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
