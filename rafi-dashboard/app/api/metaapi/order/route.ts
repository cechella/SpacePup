import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { symbol = 'EURUSD', actionType, volume, stopLoss, takeProfit, comment = 'RAFI-Dashboard' } = body

    if (!actionType || !volume || !stopLoss) {
      return NextResponse.json({ error: 'actionType, volume e stopLoss são obrigatórios' }, { status: 400 })
    }

    const api        = new MetaApi(TOKEN)
    const account    = await api.metatraderAccountApi.getAccount(ACCOUNT)
    const connection = account.getRPCConnection()
    await connection.connect()
    await connection.waitSynchronized(8)

    let result: any
    if (actionType === 'ORDER_TYPE_BUY') {
      result = await connection.createMarketBuyOrder(symbol, volume, stopLoss, takeProfit, { comment })
    } else if (actionType === 'ORDER_TYPE_SELL') {
      result = await connection.createMarketSellOrder(symbol, volume, stopLoss, takeProfit, { comment })
    } else {
      await connection.close()
      return NextResponse.json({ error: `actionType inválido: ${actionType}` }, { status: 400 })
    }

    await connection.close()

    return NextResponse.json({
      orderId:    result?.orderId,
      positionId: result?.positionId,
      direction:  actionType === 'ORDER_TYPE_BUY' ? 'buy' : 'sell',
      symbol,
      volume,
      stopLoss,
      takeProfit,
    })
  } catch (e: any) {
    console.error('[MetaAPI order]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
