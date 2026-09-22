import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const period   = searchParams.get('period') ?? 'today'
    const brokerId = searchParams.get('broker') ?? ''

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    // Usa service role key para contornar RLS
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) {
      return NextResponse.json({ deals: [], error: 'supabase-not-configured' })
    }

    const supa = createClient(url, key, { auth: { persistSession: false } })

    const now = new Date()
    const fromISO = (() => {
      switch (period) {
        case 'today': { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString() }
        case '30d':   return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        case '3m':    return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
        default:      return new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()
      }
    })()

    let query = supa
      .from('rafi_deals')
      .select('*')
      .gte('time', fromISO)
      .order('time', { ascending: false })

    if (brokerId) query = query.eq('broker_id', brokerId)

    const { data, error } = await query

    if (error) {
      console.error('[api/deals]', error.message)
      return NextResponse.json({ deals: [], error: error.message })
    }

    return NextResponse.json({ deals: data ?? [] })
  } catch (e: any) {
    console.error('[api/deals]', e.message)
    return NextResponse.json({ deals: [], error: e.message }, { status: 500 })
  }
}
