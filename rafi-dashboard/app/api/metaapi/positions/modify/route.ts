import { NextResponse } from 'next/server'

const BASE    = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime = 'edge'

export async function PATCH(req: Request) {
  try {
    const { positionId, stopLoss, takeProfit } = await req.json()

    if (!positionId || (stopLoss === undefined && takeProfit === undefined)) {
      return NextResponse.json(
        { error: 'positionId e ao menos stopLoss ou takeProfit são obrigatórios' },
        { status: 400 },
      )
    }

    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/trade`,
      {
        method:  'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ actionType: 'POSITION_MODIFY', positionId, stopLoss, takeProfit }),
        signal:  AbortSignal.timeout(15_000),
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
