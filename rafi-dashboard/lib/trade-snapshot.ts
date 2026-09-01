'use client'

import type { CandleData } from './types'
import { calcBollingerBands } from './indicators'

const W  = 900
const H  = 440
const PL = 8      // padding left
const PR = 72     // padding right (price labels)
const PT = 46     // padding top (header)
const PB = 22     // padding bottom

interface TradeMeta {
  time:       number
  direction:  'buy' | 'sell'
  entry:      number
  stopLoss:   number
  takeProfit: number
  result:     'win' | 'loss' | 'pending'
  lot:        number
  rafi?:      number
}

export function generateTradeSnapshot(
  allCandles: CandleData[],
  trade: TradeMeta,
): string | null {
  if (typeof document === 'undefined') return null

  const entryIdx = allCandles.findIndex(c => c.time === trade.time)
  if (entryIdx < 0) return null

  // Janela: 40 candles antes + 30 depois (ou até o fim)
  const before   = 40
  const after    = 30
  const startIdx = Math.max(0, entryIdx - before)
  const endIdx   = Math.min(allCandles.length - 1, entryIdx + after)
  const seg      = allCandles.slice(startIdx, endIdx + 1)
  const relEntry = entryIdx - startIdx

  // Acha o candle de saída (onde TP ou SL foi atingido)
  let exitRelIdx = -1
  for (let j = relEntry + 1; j < seg.length; j++) {
    const c = seg[j]
    if (trade.direction === 'buy') {
      if (c.low  <= trade.stopLoss)   { exitRelIdx = j; break }
      if (c.high >= trade.takeProfit) { exitRelIdx = j; break }
    } else {
      if (c.high >= trade.stopLoss)   { exitRelIdx = j; break }
      if (c.low  <= trade.takeProfit) { exitRelIdx = j; break }
    }
  }

  // BB para a janela
  const bbFull = calcBollingerBands(allCandles, 8)
  const bbUMap = new Map(bbFull.upper.map(p  => [p.time, p.value]))
  const bbLMap = new Map(bbFull.lower.map(p  => [p.time, p.value]))
  const bbMMap = new Map(bbFull.middle.map(p => [p.time, p.value]))
  const bbSeg  = seg.map(c => ({
    upper: bbUMap.get(c.time) ?? 0,
    lower: bbLMap.get(c.time) ?? 0,
    mid:   bbMMap.get(c.time) ?? 0,
  }))

  // Canvas
  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Intervalo de preço
  const prices = [
    ...seg.map(c => c.high), ...seg.map(c => c.low),
    trade.entry, trade.stopLoss, trade.takeProfit,
    ...bbSeg.map(b => b.upper).filter(Boolean),
    ...bbSeg.map(b => b.lower).filter(Boolean),
  ]
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const pad  = (maxP - minP || 0.001) * 0.12
  const lo   = minP - pad
  const hi   = maxP + pad

  const cW = W - PL - PR
  const cH = H - PT - PB
  const n  = seg.length
  const bw = Math.max(2, (cW / n) * 0.65)

  const px = (i: number) => PL + (i + 0.5) * (cW / n)
  const py = (price: number) => PT + cH - ((price - lo) / (hi - lo)) * cH

  // ── Fundo ───────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, W, H)

  // Grade horizontal
  ctx.strokeStyle = '#1c2128'
  ctx.lineWidth   = 1
  for (let i = 0; i <= 4; i++) {
    const y = PT + (i / 4) * cH
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke()
  }

  // ── Bollinger Bands ──────────────────────────────────────────────────────────
  ctx.beginPath()
  bbSeg.forEach((b, i) => {
    if (!b.upper) return
    i === 0 ? ctx.moveTo(px(i), py(b.upper)) : ctx.lineTo(px(i), py(b.upper))
  })
  for (let i = bbSeg.length - 1; i >= 0; i--) {
    if (!bbSeg[i].lower) continue
    ctx.lineTo(px(i), py(bbSeg[i].lower))
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(38,198,218,0.06)'
  ctx.fill()

  ;(['upper', 'lower', 'mid'] as const).forEach((key, ki) => {
    ctx.globalAlpha  = ki === 2 ? 0.25 : 0.65
    ctx.strokeStyle  = '#26c6da'
    ctx.lineWidth    = ki === 2 ? 0.8 : 1.2
    ctx.setLineDash([])
    ctx.beginPath()
    let first = true
    bbSeg.forEach((b, i) => {
      const v = b[key]
      if (!v) return
      first ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))
      first = false
    })
    ctx.stroke()
  })
  ctx.globalAlpha = 1

  // ── Zona de resultado pós-entrada ────────────────────────────────────────────
  if (exitRelIdx > relEntry) {
    const zc = trade.result === 'win' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'
    ctx.fillStyle = zc
    ctx.fillRect(px(relEntry) - bw, PT, px(exitRelIdx) - px(relEntry) + bw * 2, cH)
  }

  // ── Candlesticks ─────────────────────────────────────────────────────────────
  for (let i = 0; i < seg.length; i++) {
    const c    = seg[i]
    const bull = c.close >= c.open
    const base = bull ? '#22c55e' : '#ef4444'
    const dim  = bull ? '#22c55e66' : '#ef444466'
    const col  = i === relEntry ? base
               : (exitRelIdx >= 0 && i > exitRelIdx) ? dim
               : base

    ctx.strokeStyle = col
    ctx.fillStyle   = col
    ctx.lineWidth   = 1

    // Pavio
    ctx.beginPath()
    ctx.moveTo(px(i), py(c.high))
    ctx.lineTo(px(i), py(c.low))
    ctx.stroke()

    // Corpo
    const bTop = py(Math.max(c.open, c.close))
    const bBot = py(Math.min(c.open, c.close))
    ctx.fillRect(px(i) - bw / 2, bTop, bw, Math.max(1, bBot - bTop))
  }

  // ── Destaque do candle de entrada ────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fillRect(px(relEntry) - bw, PT, bw * 2, cH)

  // ── Linhas horizontais: entrada, stop, alvo ───────────────────────────────────
  const hLine = (price: number, color: string, label: string, dash: number[]) => {
    ctx.setLineDash(dash)
    ctx.strokeStyle  = color
    ctx.lineWidth    = 1.5
    ctx.globalAlpha  = 0.9
    ctx.beginPath()
    ctx.moveTo(PL, py(price))
    ctx.lineTo(W - PR + 4, py(price))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha  = 1
    ctx.fillStyle    = color
    ctx.font         = 'bold 9px monospace'
    ctx.textAlign    = 'left'
    ctx.fillText(label, W - PR + 6, py(price) + 3)
  }

  hLine(trade.entry,      '#3b82f6', trade.entry.toFixed(5),      [4, 3])
  hLine(trade.stopLoss,   '#ef4444', trade.stopLoss.toFixed(5),   [3, 2])
  hLine(trade.takeProfit, '#22c55e', trade.takeProfit.toFixed(5), [3, 2])

  // ── Ponto de saída (onde o preço tocou TP ou SL) ─────────────────────────────
  if (exitRelIdx >= 0) {
    const exitCol   = trade.result === 'win' ? '#22c55e' : '#ef4444'
    const exitPrice = trade.result === 'win' ? trade.takeProfit : trade.stopLoss
    ctx.beginPath()
    ctx.arc(px(exitRelIdx), py(exitPrice), 6, 0, Math.PI * 2)
    ctx.fillStyle   = exitCol
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth   = 1.5
    ctx.stroke()
  }

  // ── Header ───────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#161b22'
  ctx.fillRect(0, 0, W, PT - 2)
  ctx.fillStyle = '#30363d'
  ctx.fillRect(0, PT - 2, W, 1)

  const dir      = trade.direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'
  const dirCol   = trade.direction === 'buy' ? '#22c55e' : '#ef4444'
  const resCol   = trade.result === 'win'  ? '#22c55e' : trade.result === 'loss' ? '#ef4444' : '#8b949e'
  const resText  = trade.result === 'win'  ? '✅ WIN' : trade.result === 'loss' ? '❌ LOSS' : '⏳ PEND'

  const riskPips = Math.abs(trade.entry - trade.stopLoss)   * 10000
  const gainPips = Math.abs(trade.takeProfit - trade.entry) * 10000
  const pipVal   = trade.lot * 10
  const gainUsd  = gainPips * pipVal
  const riskUsd  = riskPips * pipVal

  // Linha 1 — direção + resultado
  ctx.font      = 'bold 12px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = dirCol
  ctx.fillText(dir, 10, 17)

  ctx.font      = '10px system-ui, sans-serif'
  ctx.fillStyle = '#8b949e'
  ctx.fillText(`@ ${trade.entry.toFixed(5)}`, 90, 17)
  ctx.fillText(`${trade.lot.toFixed(2)} lotes`, 185, 17)
  if (trade.rafi) ctx.fillText(`RAFI ${trade.rafi.toFixed(1)}`, 255, 17)

  ctx.font      = 'bold 12px system-ui, sans-serif'
  ctx.fillStyle = resCol
  ctx.textAlign = 'right'
  ctx.fillText(resText, W - PR - 6, 17)
  ctx.textAlign = 'left'

  // Linha 2 — preços e valores em $
  ctx.font      = '9px monospace'
  ctx.fillStyle = '#3b82f6'
  ctx.fillText(`ENT ${trade.entry.toFixed(5)}`, 10, 33)

  ctx.fillStyle = '#ef4444'
  ctx.fillText(`SL ${trade.stopLoss.toFixed(5)}  (−${riskPips.toFixed(1)}p / −$${riskUsd.toFixed(0)})`, 120, 33)

  ctx.fillStyle = '#22c55e'
  ctx.fillText(`TP ${trade.takeProfit.toFixed(5)}  (+${gainPips.toFixed(1)}p / +$${gainUsd.toFixed(0)})`, 370, 33)

  return canvas.toDataURL('image/png')
}
