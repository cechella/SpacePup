import { NextResponse } from 'next/server'

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export async function GET() {
  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/account-information`,
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
      balance: data.balance,
      equity: data.equity,
      margin: data.margin,
      freeMargin: data.freeMargin,
      leverage: data.leverage,
      currency: data.currency,
      server: data.server,
      connected: data.connected,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
