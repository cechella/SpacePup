import { NextResponse } from 'next/server'

const BASE    = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime = 'edge'

export async function GET(req: Request) {
  try {
    // Suporta ?accountId=<uuid> para multi-broker; cai para env var se não informado
    const { searchParams } = new URL(req.url)
    const accountId = searchParams.get('accountId') ?? ACCOUNT

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const from = todayStart.toISOString()
    const to   = new Date().toISOString()

    const res = await fetch(
      `${BASE}/users/current/accounts/${accountId}/history-deals/time/${from}/${to}`,
      {
        headers: { 'auth-token': TOKEN },
        signal:  AbortSignal.timeout(8_000),
        cache:   'no-store',
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text, todayPnl: 0 }, { status: res.status })
    }

    const deals: any[] = await res.json()

    // Soma apenas deals de saída (DEAL_ENTRY_OUT) com tipo buy/sell
    const todayPnl = Array.isArray(deals)
      ? deals
          .filter(d =>
            d.entryType === 'DEAL_ENTRY_OUT' &&
            (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL')
          )
          .reduce((sum, d) => sum + (d.profit ?? 0), 0)
      : 0

    return NextResponse.json({
      todayPnl,
      dealCount: Array.isArray(deals)
        ? deals.filter(d =>
            d.entryType === 'DEAL_ENTRY_OUT' &&
            (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL')
          ).length
        : 0,
    })
  } catch (e: any) {
    console.error('[MetaAPI today-pnl]', e.message)
    return NextResponse.json({ error: e.message, todayPnl: 0 }, { status: 500 })
  }
}
