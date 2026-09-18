import { NextResponse } from 'next/server'
import { getTopBroker } from '@/lib/top-broker'
import { createClient } from '@supabase/supabase-js'

// Retorna o broker #1 do ranking dinâmico (P&L → estado → health → exec_score → priority)
// enriquecido com nome e estado de saúde para o cabeçalho da Mesa de Operação.
export const runtime = 'nodejs'

export async function GET() {
  const top = await getTopBroker()

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return NextResponse.json({ ...top, id: top.brokerId, nome: top.brokerId, estado: 'STANDBY', health_score: 0, circuit_breaker: 'CLOSED' })

    const supa = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await supa
      .from('rafi_brokers')
      .select('id, nome, broker_health_state ( estado, circuit_breaker, health_score )')
      .eq('id', top.brokerId)
      .single()

    const h = Array.isArray(data?.broker_health_state)
      ? data.broker_health_state[0]
      : data?.broker_health_state

    return NextResponse.json({
      ...top,
      id:              top.brokerId,
      nome:            (data as any)?.nome ?? top.brokerId,
      estado:          h?.estado          ?? 'STANDBY',
      health_score:    h?.health_score    ?? 0,
      circuit_breaker: h?.circuit_breaker ?? 'CLOSED',
    })
  } catch {
    return NextResponse.json({ ...top, id: top.brokerId, nome: top.brokerId, estado: 'STANDBY', health_score: 0, circuit_breaker: 'CLOSED' })
  }
}
