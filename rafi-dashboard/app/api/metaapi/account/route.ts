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
    const info = await connection.getAccountInformation()
    await connection.close()

    return NextResponse.json({
      balance:    info.balance,
      equity:     info.equity,
      margin:     info.margin,
      freeMargin: info.freeMargin,
      leverage:   info.leverage,
      currency:   info.currency ?? 'USD',
      updatedAt:  new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    })
  } catch (e: any) {
    console.error('[MetaAPI account]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
