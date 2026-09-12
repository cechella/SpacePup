import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 60

export async function GET() {
  try {
    const api        = new MetaApi(TOKEN)
    const account    = await api.metatraderAccountApi.getAccount(ACCOUNT)
    const connection = account.getRPCConnection()
    await connection.connect()
    await connection.waitSynchronized(8)
    const raw = await connection.getPositions()
    await connection.close()

    const positions = raw.map((p: any) => ({
      id:           p.id,
      symbol:       p.symbol,
      type:         p.type,
      volume:       p.volume,
      openPrice:    p.openPrice,
      currentPrice: p.currentPrice,
      profit:       p.profit ?? 0,
      stopLoss:     p.stopLoss,
      takeProfit:   p.takeProfit,
      openTime:     p.time,
      comment:      p.comment,
    }))

    return NextResponse.json({ positions })
  } catch (e: any) {
    console.error('[MetaAPI positions GET]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { positionId } = await req.json()
    if (!positionId) return NextResponse.json({ error: 'positionId obrigatório' }, { status: 400 })

    const api        = new MetaApi(TOKEN)
    const account    = await api.metatraderAccountApi.getAccount(ACCOUNT)
    const connection = account.getRPCConnection()
    await connection.connect()
    await connection.waitSynchronized(8)
    await connection.closePosition(positionId, { comment: 'manual-close' })
    await connection.close()

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[MetaAPI positions DELETE]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
