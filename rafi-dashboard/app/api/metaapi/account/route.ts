import { NextResponse } from 'next/server'
import MetaApi from 'metaapi.cloud-sdk'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime     = 'nodejs'
export const maxDuration = 60

export async function GET() {
  let connection: any = null
  try {
    const api     = new MetaApi(TOKEN)
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT)

    // Deploy the account if it's not yet deployed (necessary after inactivity)
    if (account.state !== 'DEPLOYED') {
      await account.deploy()
    }
    await account.waitDeployed(60)

    connection = account.getRPCConnection()
    await connection.connect()
    // Aumentado para 30s — o MetaAPI precisa de tempo para buscar
    // o saldo atualizado do servidor MT5 da corretora após depósitos
    await connection.waitSynchronized(30)
    const info = await connection.getAccountInformation()

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
  } finally {
    if (connection) {
      try { await connection.close() } catch { /* ignora erro ao fechar */ }
    }
  }
}
