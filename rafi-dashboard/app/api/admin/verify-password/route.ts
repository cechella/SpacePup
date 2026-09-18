import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({}))

  const adminPassword = process.env.ADMIN_CONFIG_PASSWORD
  if (!adminPassword) {
    return NextResponse.json({ ok: false, error: 'Senha não configurada no servidor' }, { status: 500 })
  }

  if (!password || typeof password !== 'string') {
    return NextResponse.json({ ok: false, error: 'Senha inválida' }, { status: 400 })
  }

  // Comparação direta server-side — a env var nunca chega ao cliente
  if (password === adminPassword) {
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: false, error: 'Senha incorreta' }, { status: 401 })
}
