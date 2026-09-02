import { NextResponse } from 'next/server'

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol') || 'EURUSD'

  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/symbols/${symbol}/current-price?keepSubscription=false`,
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
    return NextResponse.json({
      bid: data.bid,
      ask: data.ask,
      time: data.time,
      symbol,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
