import { NextResponse } from 'next/server'

const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!
const BASE_ENV = process.env.METAAPI_BASE_URL ?? ''

// Testa o endpoint real de accountInformation (mesmo path do /api/metaapi/account)
const CANDIDATES = [
  'https://mt-client-api-v1.london.agiliumtrade.ai',
  'https://mt-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-client-api-v1.singapore.agiliumtrade.ai',
  'https://mt-client-api-v1.sydney.agiliumtrade.ai',
  'https://mt-client-api-v1.agiliumtrade.ai',
]

export const runtime = 'edge'

export async function GET() {
  const h = { 'auth-token': TOKEN }
  const out: Record<string, any> = {
    accountId:    ACCOUNT,
    tokenPresent: TOKEN?.length > 10 ? `${TOKEN.slice(0, 8)}…` : 'AUSENTE',
    metaApiBaseUrlEnv: BASE_ENV || '(não definido — usa london por padrão)',
    urlTests:     [] as any[],
  }

  // Testa o path real: /users/current/accounts/{id}/accountInformation
  for (const base of CANDIDATES) {
    try {
      const r = await fetch(
        `${base}/users/current/accounts/${ACCOUNT}/accountInformation`,
        { headers: h, signal: AbortSignal.timeout(6_000), cache: 'no-store' }
      )
      const body = await r.json().catch(() => null)
      out.urlTests.push({
        base,
        status: r.status,
        ok: r.status === 200,
        body: r.status === 200
          ? `balance=${body?.balance} equity=${body?.equity}`
          : (body?.message ?? body?.error ?? body),
      })
    } catch (e: any) {
      out.urlTests.push({ base, error: e.message })
    }
  }

  const working = out.urlTests.find((t: any) => t.ok)
  if (working) {
    out.workingBase = working.base
    out.recommendation = `Adicione no Vercel: METAAPI_BASE_URL = ${working.base}`
  } else {
    out.recommendation = 'Nenhuma URL funcionou — verifique se o token METAAPI_TOKEN está correto e se a conta MetaAPI está ativa em app.metaapi.cloud'
  }

  // Testa também o endpoint de history-deals (usado pelo today-pnl)
  if (working) {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    try {
      const r = await fetch(
        `${working.base}/users/current/accounts/${ACCOUNT}/history-deals/time/${todayStart.toISOString()}/${new Date().toISOString()}`,
        { headers: h, signal: AbortSignal.timeout(8_000), cache: 'no-store' }
      )
      const body = await r.json().catch(() => null)
      out.historyDealsStatus = r.status
      out.historyDealsCount  = Array.isArray(body) ? body.length : body
    } catch (e: any) {
      out.historyDealsError = e.message
    }
  }

  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
