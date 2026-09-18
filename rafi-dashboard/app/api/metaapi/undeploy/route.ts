import { NextRequest, NextResponse } from 'next/server'

// Desliga (undeploy) as contas MetaAPI — chamado pelo cron das 17h30 UTC ou botão manual
export const runtime = 'nodejs'

const TOKEN = process.env.METAAPI_TOKEN!
const BASE  = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'

const ACCOUNT_IDS = [
  '14a67aeb-66e6-4f59-8173-6bcdbf5b9699', // EXNESS ZERO
  '183329ea-e5d4-4b25-b711-2f6798bff62a', // pepperstone-pp
  '33f4d189-2923-41ad-b67d-4787a340966e', // TICKMILL Raw
]

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results = await Promise.allSettled(
    ACCOUNT_IDS.map(id =>
      fetch(`${BASE}/users/current/accounts/${id}/undeploy`, {
        method: 'POST',
        headers: { 'auth-token': TOKEN },
      }).then(r => ({ id, status: r.status }))
    )
  )

  const summary = results.map((r, i) =>
    r.status === 'fulfilled'
      ? { id: ACCOUNT_IDS[i], ok: r.value.status < 300, httpStatus: r.value.status }
      : { id: ACCOUNT_IDS[i], ok: false, erro: String((r as PromiseRejectedResult).reason) }
  )

  console.log('[metaapi/undeploy]', JSON.stringify(summary))
  return NextResponse.json({ action: 'undeploy', results: summary })
}
