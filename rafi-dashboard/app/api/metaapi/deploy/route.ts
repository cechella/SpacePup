import { NextResponse } from 'next/server'

// Liga (deploy) as 3 contas MetaAPI — chamado pelo botão manual do dashboard
export const runtime = 'nodejs'

const TOKEN = process.env.METAAPI_TOKEN!
const BASE  = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'

const ACCOUNT_IDS = [
  '14a67aeb-66e6-4f59-8173-6bcdbf5b9699', // EXNESS ZERO
  '183329ea-e5d4-4b25-b711-2f6798bff62a', // pepperstone-pp
  '33f4d189-2923-41ad-b67d-4787a340966e', // TICKMILL Raw
]

export async function POST() {
  const results = await Promise.allSettled(
    ACCOUNT_IDS.map(id =>
      fetch(`${BASE}/users/current/accounts/${id}/deploy`, {
        method: 'POST',
        headers: { 'auth-token': TOKEN },
      }).then(r => ({ id, httpStatus: r.status, ok: r.status < 300 }))
    )
  )

  const summary = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: ACCOUNT_IDS[i], ok: false, erro: String((r as PromiseRejectedResult).reason) }
  )

  return NextResponse.json({ action: 'deploy', results: summary })
}
