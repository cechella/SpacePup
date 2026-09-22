/**
 * POST /api/ml/enrich-retroactive
 * Busca candles históricos do MetaAPI para enriquecer trades em rafi_trades que
 * ainda não têm RAFI/BB Width preenchidos (entry_type='bot' sem rafi).
 * Calcula RAFI e BB Width server-side e atualiza os registros no Supabase.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { calcRAFI, calcBollingerBands } from '@/lib/indicators'
import { getTopBroker } from '@/lib/top-broker'
import type { CandleData } from '@/lib/types'

export const runtime     = 'nodejs'
export const maxDuration = 60 // segundos — requer plano Pro; no Hobby limita a 10s

const META_BASE  = process.env.METAAPI_MARKET_DATA_URL ?? 'https://mt-market-data-client-api-v1.london.agiliumtrade.ai'
const META_TOKEN = process.env.METAAPI_TOKEN!

// Offset do broker Pepperstone: UTC+3 (mesmo que o candle/route.ts principal)
const BROKER_OFFSET = 3 * 3600

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase não configurado')
  return createClient(url, key, { auth: { persistSession: false } })
}

// 100 candles M5 = ~8h — suficiente para calcular RAFI e BB Width
async function fetchMetaCandles(accountId: string, symbol: string, startTime: string, limit = 100): Promise<CandleData[]> {
  const qs = new URLSearchParams({ limit: String(limit), startTime })
  const url = `${META_BASE}/users/current/accounts/${accountId}/historical-market-data/symbols/${symbol}/timeframes/5m/candles?${qs}`
  const res = await fetch(url, {
    headers: { 'auth-token': META_TOKEN },
    signal:  AbortSignal.timeout(25_000),
    cache:   'no-store',
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`MetaAPI candles: ${res.status} — ${text}`)
  }
  const raw = await res.json()
  const arr: any[] = Array.isArray(raw) ? raw : (raw.candles ?? [])
  return arr
    .map(c => ({
      time:   new Date(c.time).getTime() / 1000 + BROKER_OFFSET,
      open:   Number(c.open),
      high:   Number(c.high),
      low:    Number(c.low),
      close:  Number(c.close),
      volume: c.tickVolume ?? c.volume ?? 0,
    }))
    .sort((a, b) => a.time - b.time)
}

export async function POST() {
  try {
    const supa = getSupabase()

    // Usa a mesma conta ativa que a rota principal de candles
    const broker = await getTopBroker()

    // Busca trades sem RAFI no Supabase
    const { data: missing, error: fetchErr } = await supa
      .from('rafi_trades')
      .select('id, time, rafi')
      .is('rafi', null)
      .order('time', { ascending: false })
      .limit(100)

    if (fetchErr) throw fetchErr
    if (!missing || missing.length === 0) {
      return NextResponse.json({ enriched: 0, total: 0, message: 'Nenhum trade sem RAFI' })
    }

    // Agrupa trades por janelas de 8 horas para minimizar chamadas à MetaAPI
    // Cada janela busca 100 candles M5 (~8h de contexto) a partir do candle mais recente + 30min
    const WINDOW_SEC = 8 * 3600
    const windows = new Map<number, number[]>() // chave: topo da janela em segundos, valor: lista de IDs

    for (const trade of missing) {
      const tradeSec  = Number(trade.time)
      // Arredonda para cima para a próxima janela de 8h
      const windowTop = (Math.floor(tradeSec / WINDOW_SEC) + 1) * WINDOW_SEC
      if (!windows.has(windowTop)) windows.set(windowTop, [])
      windows.get(windowTop)!.push(trade.id)
    }

    let enriched = 0
    const errors: string[] = []

    for (const [windowTop, ids] of Array.from(windows.entries())) {
      try {
        // startTime = top da janela + 30min de buffer (MetaAPI busca candles ANTES disso)
        const startIso = new Date((windowTop + 1800) * 1000).toISOString()
        const candles  = await fetchMetaCandles(broker.accountId, broker.symbol, startIso)

        if (candles.length < 14) continue // mínimo para calcular RAFI

        const rafiPoints = calcRAFI(candles)
        const bbBands    = calcBollingerBands(candles)

        // Mapa por tempo M5 arredondado (candle timestamps já têm BROKER_OFFSET aplicado)
        const rafiMap = new Map<number, { rafi: number; dir: 'bull' | 'bear'; bbWidth: number }>()
        const bbUpper = bbBands.upper
        const bbLower = bbBands.lower

        for (const pt of rafiPoints) {
          const upperPt = bbUpper.find(u => u.time === pt.time)
          const lowerPt = bbLower.find(l => l.time === pt.time)
          const width   = upperPt && lowerPt ? upperPt.value - lowerPt.value : 0
          rafiMap.set(pt.time, { rafi: pt.value, dir: pt.dir, bbWidth: width })
        }

        // Atualiza cada trade desta janela
        for (const id of ids) {
          const tradeRow = missing.find(t => t.id === id)
          if (!tradeRow) continue

          const tradeSec = Number(tradeRow.time)
          // Candle timestamps têm BROKER_OFFSET (+3h) — ajusta trade UTC para broker time antes de alinhar ao M5
          const m5ts     = Math.floor((tradeSec + BROKER_OFFSET) / 300) * 300

          // Busca exato ou mais próximo (±15min)
          let enrichData: { rafi: number; dir: 'bull' | 'bear'; bbWidth: number } | undefined = rafiMap.get(m5ts)
          if (!enrichData) {
            let best: { rafi: number; dir: 'bull' | 'bear'; bbWidth: number } | undefined
            let bestDiff = Infinity
            rafiMap.forEach((v, k) => {
              const diff = Math.abs(k - m5ts)
              if (diff < bestDiff && diff <= 900) { best = v; bestDiff = diff }
            })
            enrichData = best
          }

          if (!enrichData) continue

          const { error: updErr } = await supa
            .from('rafi_trades')
            .update({
              // RAFI sempre positivo (magnitude 0-5), como o indicador original.
              // rafi_dir guarda a direção (bull/bear) separadamente.
              rafi:       Math.abs(enrichData.rafi),
              rafi_dir:   enrichData.dir,
              bb_width:   enrichData.bbWidth,
              updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .is('rafi', null) // garante que não sobrescreve dado manual

          if (!updErr) enriched++
        }
      } catch (e: unknown) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }

    return NextResponse.json({
      enriched,
      total:   missing.length,
      windows: windows.size,
      errors:  errors.length > 0 ? errors : undefined,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
