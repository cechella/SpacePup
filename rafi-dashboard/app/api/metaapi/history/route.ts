import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 60

// Converte parâmetro de período para data de início
function periodToFrom(period: string): Date {
  const now = new Date()
  switch (period) {
    case 'today': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d
    }
    case '30d':  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case '3m':   return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    case '7d':
    default:     return new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000)
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') ?? '7d'

    const api        = new MetaApi(TOKEN)
    const account    = await api.metatraderAccountApi.getAccount(ACCOUNT)
    const connection = account.getRPCConnection()
    await connection.connect()
    await connection.waitSynchronized(8)

    const now  = new Date()
    const from = periodToFrom(period)
    const raw  = await (connection as any).getDealsByTimeRange(from, now, 0, 100)
    // getDealsByTimeRange retorna { deals: [...], synchronizing: bool }, não um array direto
    const deals = Array.isArray(raw) ? raw : ((raw as any).deals ?? [])

    await connection.close()

    const history = (deals as any[])
      .filter(d =>
        d.entryType === 'DEAL_ENTRY_OUT' &&
        (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
      )
      .map(d => ({
        id:      d.id,
        symbol:  d.symbol,
        type:    d.type,
        volume:  d.volume,
        price:   d.price,
        profit:  d.profit ?? 0,
        time:    d.time,
        comment: d.comment ?? '',
      }))
      .reverse() // mais recente primeiro

    return NextResponse.json({ history, period })
  } catch (e: any) {
    console.error('[MetaAPI history]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
