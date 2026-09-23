/**
 * GET /api/ml/test-order
 * Endpoint de diagnóstico — envia ordem real de 0.01 lote e retorna
 * a resposta COMPLETA do MetaAPI para depuração.
 * REMOVER após confirmar que as ordens abrem corretamente.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveBrokers } from '@/lib/top-broker'

export const runtime   = 'nodejs'
export const maxDuration = 10

const MT_BASE = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!

export async function GET(req: NextRequest) {
  const auth     = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const brokers = await getActiveBrokers()
  if (brokers.length === 0) {
    return NextResponse.json({ error: 'Nenhuma corretora ativa' })
  }

  // Testa apenas na primeira corretora para não abrir em todas
  const broker = brokers[0]

  // Busca preço atual para definir SL/TP realistas
  const priceRes = await fetch(
    `${MT_BASE}/users/current/accounts/${broker.accountId}/symbols/${broker.symbol}/current-price`,
    { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(5_000), cache: 'no-store' }
  ).catch(() => null)

  let bid = 1.10000
  let ask = 1.10010
  if (priceRes?.ok) {
    const p = await priceRes.json()
    bid = Number(p.bid ?? p.Bid ?? bid)
    ask = Number(p.ask ?? p.Ask ?? ask)
  }

  // Ordem SELL de 0.01 lote com SL/TP de 10 pips (só para testar)
  const payload = {
    actionType: 'ORDER_TYPE_SELL',
    symbol:     broker.symbol,
    volume:     0.01,
    stopLoss:   bid + 0.0010,   // SL 10 pips acima
    takeProfit: bid - 0.0010,   // TP 10 pips abaixo
    comment:    'IA-TEST-001',
  }

  const t0  = Date.now()
  const res = await fetch(`${MT_BASE}/users/current/accounts/${broker.accountId}/trade`, {
    method:  'POST',
    headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(8_000),
  })
  const latency = Date.now() - t0

  const rawBody = await res.text()
  let parsed: unknown
  try { parsed = JSON.parse(rawBody) } catch { parsed = rawBody }

  return NextResponse.json({
    broker:       broker.brokerId,
    accountId:    broker.accountId,
    symbol:       broker.symbol,
    payload,
    httpStatus:   res.status,
    httpOk:       res.ok,
    latencyMs:    latency,
    metaapiRaw:   parsed,   // resposta COMPLETA do MetaAPI
    bid,
    ask,
  })
}
