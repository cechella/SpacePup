import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 60

export async function PATCH(req: Request) {
  try {
    const { positionId, stopLoss, takeProfit } = await req.json()

    if (!positionId || (stopLoss === undefined && takeProfit === undefined)) {
      return NextResponse.json(
        { error: 'positionId e ao menos stopLoss ou takeProfit são obrigatórios' },
        { status: 400 },
      )
    }

    const api        = new MetaApi(TOKEN)
    const account    = await api.metatraderAccountApi.getAccount(ACCOUNT)
    const connection = account.getRPCConnection()
    await connection.connect()
    await connection.waitSynchronized(8)

    // Modifica SL e/ou TP da posição aberta
    const result = await connection.modifyPosition(positionId, stopLoss, takeProfit)

    await connection.close()

    return NextResponse.json({ ok: true, result })
  } catch (e: any) {
    console.error('[MetaAPI modify position]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
