import { NextResponse } from 'next/server'

// Rota temporária — habilita papéis CopyFactory nas 3 contas MetaAPI
// Chamar uma vez: GET /api/admin/setup-copyfactory
// Deletar após uso

const TOKEN = process.env.METAAPI_TOKEN!
const BASE  = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'

const ACCOUNTS = [
  { id: '14a67aeb-66e6-4f59-8173-6bcdbf5b9699', nome: 'EXNESS ZERO',   roles: ['PROVIDER'] },
  { id: '183329ea-e5d4-4b25-b711-2f6798bff62a', nome: 'pepperstone-pp', roles: ['SUBSCRIBER'] },
  { id: '33f4d189-2923-41ad-b67d-4787a340966e', nome: 'TICKMILL Raw',   roles: ['SUBSCRIBER'] },
]

export const runtime = 'nodejs'

export async function GET() {
  const results: Record<string, unknown>[] = []

  for (const acc of ACCOUNTS) {
    try {
      const res = await fetch(`${BASE}/users/current/accounts/${acc.id}`, {
        method: 'PUT',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ copyFactoryRoles: acc.roles }),
      })
      const text = await res.text()
      results.push({ conta: acc.nome, status: res.status, body: text || 'ok' })
    } catch (e) {
      results.push({ conta: acc.nome, erro: String(e) })
    }
  }

  return NextResponse.json({ ok: true, results })
}
