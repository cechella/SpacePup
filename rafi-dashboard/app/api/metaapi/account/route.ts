import { NextResponse } from 'next/server'

// Usa REST API direta do MetaAPI (igual à rota de preço) — sem SDK,
// sem conexão TCP, sem waitSynchronized. Retorna dados instantâneos.
const BASE    = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

export const runtime = 'edge'

export async function GET() {
  try {
    const res = await fetch(
      `${BASE}/users/current/accounts/${ACCOUNT}/accountInformation`,
      {
        headers: { 'auth-token': TOKEN },
        signal:  AbortSignal.timeout(8_000),
        cache:   'no-store',
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }

    const info = await res.json()

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
