import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
// Cache de 10 minutos no edge — evita chamadas repetidas
export const revalidate = 600

export async function GET() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=BRL', {
      next: { revalidate: 600 },
    })
    if (!res.ok) throw new Error(`frankfurter ${res.status}`)
    const data = await res.json()
    const brl = data?.rates?.BRL
    if (!brl) throw new Error('sem taxa BRL')
    return NextResponse.json({ brl: Number(brl) }, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=60' },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'erro' }, { status: 500 })
  }
}
