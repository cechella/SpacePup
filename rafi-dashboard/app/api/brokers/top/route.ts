import { NextResponse } from 'next/server'
import { getTopBroker } from '@/lib/top-broker'

// Retorna o broker #1 do ranking dinâmico para consumo pelo frontend
export const runtime = 'nodejs'

export async function GET() {
  const top = await getTopBroker()
  return NextResponse.json(top)
}
