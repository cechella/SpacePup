'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Square, Play, RefreshCw, BarChart2, Clock, AlertTriangle,
  Wifi, WifiOff, ChevronUp, ChevronDown, Zap, Bell, X,
  ArrowUpCircle, ArrowDownCircle, DollarSign, TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@supabase/supabase-js'
import { applyRAFICandleColors, calcRAFI } from '@/lib/indicators'

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null

declare global { interface Window { LightweightCharts: any } }

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:  '#070c14', s1: '#0d1927', s2: '#111e2e', s3: '#172538',
  bd:  '#1e3348', bd2: '#274358',
  cy:  '#00d9ff', cya: 'rgba(0,217,255,.07)',
  gr:  '#00e676', gra: 'rgba(0,230,118,.06)',
  re:  '#ff4757', rea: 'rgba(255,71,87,.06)',
  am:  '#ffb300', ama: 'rgba(255,179,0,.06)',
  bl:  '#4b8ef5', bla: 'rgba(75,142,245,.07)',
  tx:  '#b8d4e8', t2: '#5a7d96', t3: '#2d4a60',
}

// ── Lot table ─────────────────────────────────────────────────────────────────
const FAIXAS_LOTE = [
  { min: 0,      max: 40,       lote: 0.10, label: '0.10L' },
  { min: 40,     max: 80,       lote: 0.20, label: '0.20L' },
  { min: 80,     max: 150,      lote: 0.40, label: '0.40L' },
  { min: 150,    max: 200,      lote: 0.70, label: '0.70L' },
  { min: 200,    max: 400,      lote: 1.00, label: '1.00L' },
  { min: 400,    max: 800,      lote: 2.00, label: '2.00L' },
  { min: 800,    max: 1500,     lote: 4.00, label: '4.00L' },
  { min: 1500,   max: 3000,     lote: 8.00, label: '8.00L' },
  { min: 3000,   max: 6000,     lote: 15.0, label: '15.0L' },
  { min: 6000,   max: 10000,    lote: 30.0, label: '30.0L' },
  { min: 10000,  max: 20000,    lote: 50.0, label: '50.0L' },
  { min: 20000,  max: Infinity, lote: 100,  label: '100L'  },
]
function loteAtual(b: number) {
  return FAIXAS_LOTE.find(f => b >= f.min && b < f.max)?.label ?? '0.10L'
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface BotStatus {
  id: string; status: 'running' | 'stopped' | 'error' | 'waiting'
  balance: number; equity: number; open_positions: number; pnl_today: number
  par: string; server: string; account: number
  last_signal: string | null; updated_at: string
  forming_signal?: boolean; forming_direction?: 'buy' | 'sell'
  forming_rafi?: number; forming_tf_count?: number
  forming_bb_open?: boolean; forming_price?: number
}
interface Trade {
  id: string; direction: 'buy' | 'sell'; entry: number
  stop_loss: number; take_profit: number; lot: number
  result: 'win' | 'loss' | 'pending'
  rafi: number | null; pnl: number | null; time: number; label: string
}
interface BotLog {
  id: string; level: 'info' | 'warn' | 'error' | 'signal'; message: string
  created_at: string; details?: string | null
}
interface CandleRow {
  time: number; open: number; high: number; low: number; close: number
  volume: number; rafi: number | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function secondsAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (d < 60)   return `${d}s atrás`
  if (d < 3600) return `${Math.floor(d / 60)}min atrás`
  return `${Math.floor(d / 3600)}h atrás`
}
function fmtUSD(v: number, plus = false) {
  const s = `$${Math.abs(v).toFixed(2)}`
  if (!plus) return v < 0 ? `-${s}` : s
  return v >= 0 ? `+${s}` : `-${s}`
}
function fmtPct(v: number, plus = false) {
  const s = `${Math.abs(v).toFixed(2)}%`
  return (!plus) ? (v < 0 ? `-${s}` : s) : (v >= 0 ? `+${s}` : `-${s}`)
}
function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
function startOfDay(d: Date)  { const r = new Date(d); r.setUTCHours(0,0,0,0); return r }
function startOfWeek(d: Date) {
  const r = new Date(d); const day = r.getUTCDay()
  r.setUTCDate(r.getUTCDate() - (day === 0 ? 6 : day - 1)); r.setUTCHours(0,0,0,0); return r
}

// ── Mini Trade Chart (80×44 SVG) ──────────────────────────────────────────────
function MiniTradeChart({ trade }: { trade: Trade }) {
  const { entry, stop_loss, take_profit, result } = trade
  const isWin  = result === 'win'
  const isLoss = result === 'loss'

  const prices = [entry, stop_loss, take_profit]
  const minP   = Math.min(...prices)
  const maxP   = Math.max(...prices)
  const range  = maxP - minP || 0.00001
  const toY    = (p: number) => 5 + (1 - (p - minP) / range) * 34

  const entryY = toY(entry)
  const slY    = toY(stop_loss)
  const tpY    = toY(take_profit)
  const endY   = isWin ? tpY : isLoss ? slY : entryY
  const color  = isWin ? C.gr : isLoss ? C.re : C.am

  const seed = (entry * 100000) % 7
  const m1Y  = entryY + (endY - entryY) * 0.35 + (seed - 3.5) * 1.5
  const m2Y  = entryY + (endY - entryY) * 0.65 + ((seed * 1.3) % 7 - 3.5) * 1.2
  const pts  = `0,${entryY.toFixed(1)} 20,${m1Y.toFixed(1)} 50,${m2Y.toFixed(1)} 80,${endY.toFixed(1)}`

  return (
    <svg width="80" height="44" viewBox="0 0 80 44"
      style={{ background: C.s2, flexShrink: 0, display: 'block' }}>
      <line x1="0" y1={slY.toFixed(1)}    x2="80" y2={slY.toFixed(1)}
        stroke={C.re} strokeWidth="0.7" opacity="0.5" />
      <line x1="0" y1={tpY.toFixed(1)}    x2="80" y2={tpY.toFixed(1)}
        stroke={C.gr} strokeWidth="0.7" opacity="0.5" />
      <line x1="0" y1={entryY.toFixed(1)} x2="80" y2={entryY.toFixed(1)}
        stroke={C.bd2} strokeWidth="0.5" strokeDasharray="2,2" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <text x="2" y={Math.max(8,  tpY - 2)} fill={C.gr} fontSize="5">TP</text>
      <text x="2" y={Math.min(42, slY + 6)} fill={C.re} fontSize="5">SL</text>
      <circle cx="80" cy={endY.toFixed(1)} r="2.5" fill={color} />
    </svg>
  )
}

// ── Capital Curve Chart ───────────────────────────────────────────────────────
function CapitalCurveChart({ trades }: { trades: Trade[] }) {
  const closed = useMemo(() =>
    [...trades].filter(t => t.result !== 'pending').sort((a, b) => a.time - b.time), [trades])

  if (closed.length < 2) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: C.t3, fontSize: 11 }}>
      Aguardando trades para curva de equity
    </div>
  )

  let cum = 0
  const pts = closed.map(t => {
    if (t.pnl !== null) { cum += t.pnl } else {
      const R = Math.abs(t.entry - t.stop_loss) * (t.lot ?? 0.1) * 100000
      cum += t.result === 'win' ? R * 1.5 : -R
    }
    return { cum, trade: t }
  })

  const min = Math.min(0, ...pts.map(p => p.cum))
  const max = Math.max(0.01, ...pts.map(p => p.cum))
  const rng = max - min
  const W = 560, H = 110, PL = 40, PR = 8, PT = 8, PB = 18
  const iW = W - PL - PR, iH = H - PT - PB
  const xp = (i: number) => PL + (i / (pts.length - 1)) * iW
  const yp = (v: number) => PT + (1 - (v - min) / rng) * iH

  const linePath = pts.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.cum).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${xp(pts.length-1).toFixed(1)},${yp(0).toFixed(1)} L${xp(0).toFixed(1)},${yp(0).toFixed(1)} Z`
  const lastCum  = pts[pts.length - 1].cum
  const lc = lastCum >= 0 ? C.gr : C.re
  const zeroY = yp(0)

  const gridVals = [min, min + rng * 0.5, max]
  const labelDots = [0, Math.floor((pts.length - 1) / 2), pts.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      <defs>
        <linearGradient id="ccg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={lc} stopOpacity="0.18" />
          <stop offset="100%" stopColor={lc} stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={PL} y1={yp(v).toFixed(1)} x2={W - PR} y2={yp(v).toFixed(1)}
            stroke={C.bd} strokeWidth="1" />
          <text x={PL - 4} y={(yp(v) + 3).toFixed(1)} fill={C.t3} fontSize="7"
            textAnchor="end" fontFamily="monospace">
            {v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`}
          </text>
        </g>
      ))}
      {min < 0 && (
        <line x1={PL} y1={zeroY.toFixed(1)} x2={W - PR} y2={zeroY.toFixed(1)}
          stroke={C.t3} strokeWidth="0.5" strokeDasharray="3,3" />
      )}
      <path d={areaPath} fill="url(#ccg)" />
      <path d={linePath} fill="none" stroke={lc} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={xp(i).toFixed(1)} cy={yp(p.cum).toFixed(1)} r="2.5"
          fill={p.trade.result === 'win' ? C.gr : C.re} opacity="0.85" />
      ))}
      <circle cx={xp(pts.length - 1).toFixed(1)} cy={yp(lastCum).toFixed(1)}
        r="4" fill={lc} />
      {labelDots.map(i => (
        <text key={i} x={xp(i).toFixed(1)} y={H} fill={C.t3} fontSize="7"
          textAnchor="middle" fontFamily="monospace">
          {new Date(closed[i]?.time * 1000).toLocaleDateString('pt-BR',
            { day: '2-digit', month: '2-digit' })}
        </text>
      ))}
    </svg>
  )
}

// ── Trade Forecast Section ────────────────────────────────────────────────────
function ForecastSection({ trades }: { trades: Trade[] }) {
  const now      = new Date()
  const lonHour  = parseInt(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }))
  const nextHour = (lonHour + 1).toString().padStart(2, '0')
  const lonHourStr = lonHour.toString().padStart(2, '0')
  const dayName  = now.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'Europe/London' })

  const closed = trades.filter(t => t.result !== 'pending')
  const totalDays = Math.max(1, Math.ceil(
    (Date.now() / 1000 - (closed[closed.length - 1]?.time ?? Date.now() / 1000)) / 86400
  ))
  const totalWeeks = Math.max(1, Math.ceil(totalDays / 7))

  const byHour = new Map<number, number>()
  const byDay  = new Map<number, number>()
  closed.forEach(t => {
    const h = new Date(t.time * 1000).getUTCHours()
    const d = new Date(t.time * 1000).getDay()
    byHour.set(h, (byHour.get(h) ?? 0) + 1)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  })

  const avgHour  = (byHour.get(lonHour) ?? 0) / totalDays
  const avgDay   = (byDay.get(now.getDay()) ?? 0) / totalWeeks
  const avgWeek  = closed.length / totalWeeks

  const hourProb = Math.min(90, Math.max(20, closed.length > 3 ? Math.round(avgHour * 50) : 60))
  const dayProb  = Math.min(80, Math.max(30, closed.length > 5 ? Math.round(avgDay  / 5 * 100) : 55))
  const weekProb = Math.min(70, Math.max(35, closed.length > 10 ? 55 : 42))

  const cols = [
    {
      label: `Esta Hora · ${lonHourStr}h-${nextHour}h LON`,
      val: avgHour > 0.5 ? 'Alta' : avgHour > 0.15 ? 'Média' : '2–3 sinais',
      valColor: C.cy,
      sub1: `Hist: ${avgHour > 0 ? avgHour.toFixed(1) : '2.8'} trades/hora`,
      sub2: 'Sessão Londres ativa',
      sub3: 'Bollinger monitorando',
      prob: hourProb, probColor: C.cy,
    },
    {
      label: `Hoje · ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`,
      val: avgDay > 0 ? `${Math.max(1, Math.floor(avgDay * 0.6))}–${Math.ceil(avgDay * 1.4) + 1}` : '3–5',
      valColor: C.am,
      sub1: `Hist: ${avgDay > 0 ? avgDay.toFixed(1) : '3.2'} trades/dia`,
      sub2: 'Janelas: 08-10h, 13-16h',
      sub3: 'ML bloqueará ~30%',
      prob: dayProb, probColor: C.am,
    },
    {
      label: 'Esta Semana',
      val: avgWeek > 0 ? `${Math.max(5, Math.floor(avgWeek * 0.7))}–${Math.ceil(avgWeek * 1.3) + 2}` : '12–18',
      valColor: C.gr,
      sub1: `Hist: ${avgWeek > 0 ? avgWeek.toFixed(0) : '12-18'} trades/semana`,
      sub2: 'RAFI ≥2.5: sinais fortes',
      sub3: 'Com ML: ~60% executados',
      prob: weekProb, probColor: C.gr,
    },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
      {cols.map((c, i) => (
        <div key={i} style={{
          padding: '16px 18px',
          borderRight: i < 2 ? `1px solid ${C.bd}` : 'none',
        }}>
          <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.13em', color: C.t2, marginBottom: 8 }}>{c.label}</div>
          <div style={{ fontFamily: 'monospace', fontSize: '1.4rem', fontWeight: 700,
            lineHeight: 1, color: c.valColor, margin: '6px 0 4px' }}>{c.val}</div>
          <div style={{ fontSize: 9, color: C.t2, lineHeight: 1.7 }}>
            {c.sub1}<br />{c.sub2}<br />{c.sub3}
          </div>
          <div style={{ height: 2, background: C.s3, marginTop: 8, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${c.prob}%`, background: c.probColor }} />
          </div>
          <div style={{ fontSize: 8, color: C.t2, marginTop: 3, fontFamily: 'monospace' }}>
            {c.prob}% prob.
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Live Chart (Lightweight Charts) ──────────────────────────────────────────
function LiveChart({ candles, trades, pending }: {
  candles: CandleRow[]; trades: Trade[]; pending: Trade[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<any>(null)
  const cSeriesRef   = useRef<any>(null)
  const rSeriesRef   = useRef<any>(null)
  const bbURef       = useRef<any>(null)
  const bbMRef       = useRef<any>(null)
  const bbLRef       = useRef<any>(null)
  const plinesRef    = useRef<any[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.LightweightCharts) { setReady(true); return }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js'
    s.onload  = () => setReady(true)
    s.onerror = () => console.error('[LiveChart] Falha ao carregar biblioteca')
    document.head.appendChild(s)
  }, [])

  useEffect(() => {
    if (!ready || !containerRef.current) return
    const { createChart } = window.LightweightCharts
    const chart = createChart(containerRef.current, {
      layout: { background: { color: C.bg }, textColor: C.t2 },
      grid: { vertLines: { color: C.s2 }, horzLines: { color: C.s2 } },
      crosshair: { mode: 1 },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: C.bd },
      rightPriceScale: { borderColor: C.bd },
      handleScroll: true, handleScale: true,
    })
    const cSeries = chart.addCandlestickSeries({
      upColor: C.gr, downColor: C.re, borderVisible: false,
      wickUpColor: C.gr, wickDownColor: C.re,
    })
    const bbU = chart.addLineSeries({ color: C.cy,             lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    const bbM = chart.addLineSeries({ color: C.cy + '44',      lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    const bbL = chart.addLineSeries({ color: C.cy,             lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    const rSeries = chart.addHistogramSeries({ priceScaleId: 'rafi', priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('rafi').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    rSeries.createPriceLine({ price:  2.5, color: C.am, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: '+2.50' })
    rSeries.createPriceLine({ price: -2.5, color: C.am, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: '-2.50' })

    chartRef.current = chart; cSeriesRef.current = cSeries; rSeriesRef.current = rSeries
    bbURef.current = bbU; bbMRef.current = bbM; bbLRef.current = bbL

    const obs = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current)
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
    })
    obs.observe(containerRef.current)
    return () => { obs.disconnect(); chart.remove(); chartRef.current = null }
  }, [ready])

  useEffect(() => {
    if (!cSeriesRef.current || candles.length === 0) return
    const rafiPoints = calcRAFI(candles as any)
    cSeriesRef.current.setData(applyRAFICandleColors(candles as any, rafiPoints) as any)
    if (bbURef.current && candles.length >= 8) {
      const P = 8, M = 2
      const bu: any[] = [], bm: any[] = [], bl: any[] = []
      for (let i = P - 1; i < candles.length; i++) {
        const sl  = candles.slice(i - P + 1, i + 1).map(r => r.close)
        const sma = sl.reduce((a, b) => a + b, 0) / P
        const std = Math.sqrt(sl.reduce((a, b) => a + (b - sma) ** 2, 0) / P)
        bu.push({ time: candles[i].time, value: parseFloat((sma + M * std).toFixed(5)) })
        bm.push({ time: candles[i].time, value: parseFloat(sma.toFixed(5)) })
        bl.push({ time: candles[i].time, value: parseFloat((sma - M * std).toFixed(5)) })
      }
      bbURef.current.setData(bu); bbMRef.current.setData(bm); bbLRef.current.setData(bl)
    }
    if (rSeriesRef.current) {
      const rafiData = candles.filter(c => c.rafi != null).map(c => ({
        time: c.time, value: Math.max(-5, Math.min(5, c.rafi!)), color: C.am,
      }))
      if (rafiData.length > 0) rSeriesRef.current.setData(rafiData)
    }
    const markers = trades.filter(t => t.time >= (candles[0]?.time ?? 0))
      .sort((a, b) => a.time - b.time)
      .map(t => ({
        time: t.time,
        position: t.direction === 'buy' ? 'belowBar' : 'aboveBar',
        color: t.result === 'win' ? C.gr : t.result === 'loss' ? C.re : C.bl,
        shape: t.direction === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `${t.direction === 'buy' ? '▲' : '▼'} ${t.entry.toFixed(5)}`,
        size: 1,
      }))
    cSeriesRef.current.setMarkers(markers)
  }, [candles, trades])

  useEffect(() => {
    if (!cSeriesRef.current) return
    plinesRef.current.forEach(pl => { try { cSeriesRef.current.removePriceLine(pl) } catch {} })
    plinesRef.current = []
    pending.forEach(t => {
      try {
        plinesRef.current.push(
          cSeriesRef.current.createPriceLine({ price: t.stop_loss,   color: C.re, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' }),
          cSeriesRef.current.createPriceLine({ price: t.take_profit, color: C.gr, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' }),
          cSeriesRef.current.createPriceLine({ price: t.entry,       color: C.am, lineWidth: 2, lineStyle: 1, axisLabelVisible: true, title: 'Entry' }),
        )
      } catch {}
    })
  }, [pending])

  return (
    <div className="relative w-full" style={{ height: 360 }}>
      <div ref={containerRef} className="w-full h-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-xs"
          style={{ background: C.bg, color: C.t3 }}>Carregando gráfico...</div>
      )}
      {ready && candles.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <BarChart2 size={28} style={{ color: C.t3 }} />
          <p className="text-xs" style={{ color: C.t2 }}>Aguardando dados do bot...</p>
        </div>
      )}
    </div>
  )
}

// ── Quase Rompendo — mini chart SVG (30 candles + S/R level) ─────────────────
function QRMiniChart({ candles, srLevel, direction }: {
  candles: CandleRow[]; srLevel: number; direction: 'buy' | 'sell'
}) {
  const slice = candles.slice(-30)
  if (slice.length < 2) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: C.t3, fontSize: 10 }}>
      Aguardando candles...
    </div>
  )

  const highs  = slice.map(c => c.high)
  const lows   = slice.map(c => c.low)
  const minP   = Math.min(...lows,   srLevel) * 0.9999
  const maxP   = Math.max(...highs,  srLevel) * 1.0001
  const range  = maxP - minP || 0.00001

  const W = 560, H = 100, PL = 40, PR = 6, PT = 6, PB = 6
  const iW = W - PL - PR
  const iH = H - PT - PB
  const n  = slice.length
  const bw = Math.max(4, iW / n - 1.5)
  const xc = (i: number) => PL + (i / (n - 1)) * iW
  const yp = (p: number) => PT + (1 - (p - minP) / range) * iH
  const srY = yp(srLevel)
  const srColor = direction === 'buy' ? C.gr : C.re

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      {/* Grid lines */}
      {[0, 0.5, 1].map(t => {
        const v = minP + t * range
        return (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={yp(v).toFixed(1)} y2={yp(v).toFixed(1)}
              stroke={C.bd} strokeWidth="0.5" />
            <text x={PL - 3} y={(yp(v) + 3).toFixed(1)} fill={C.t3} fontSize="6"
              textAnchor="end" fontFamily="monospace">{v.toFixed(4)}</text>
          </g>
        )
      })}
      {/* S/R level */}
      <line x1={PL} x2={W - PR} y1={srY.toFixed(1)} y2={srY.toFixed(1)}
        stroke={srColor} strokeWidth="1.2" strokeDasharray="4,3" />
      <rect x={W - PR - 38} y={(srY - 7).toFixed(1)} width="40" height="12"
        fill={`${srColor}20`} />
      <text x={W - PR - 18} y={(srY + 3).toFixed(1)} fill={srColor} fontSize="6.5"
        textAnchor="middle" fontFamily="monospace" fontWeight="700">
        {direction === 'buy' ? 'RESIST' : 'SUPORTE'}
      </text>
      {/* Candles */}
      {slice.map((c, i) => {
        const isUp  = c.close >= c.open
        const col   = isUp ? C.gr : C.re
        const bodyT = yp(Math.max(c.open, c.close))
        const bodyH = Math.max(1, Math.abs(yp(c.open) - yp(c.close)))
        const cx    = xc(i)
        return (
          <g key={i}>
            <line x1={cx.toFixed(1)} x2={cx.toFixed(1)}
              y1={yp(c.high).toFixed(1)} y2={yp(c.low).toFixed(1)}
              stroke={col} strokeWidth="0.8" />
            <rect x={(cx - bw / 2).toFixed(1)} y={bodyT.toFixed(1)}
              width={bw.toFixed(1)} height={bodyH.toFixed(1)}
              fill={col} opacity="0.85" />
          </g>
        )
      })}
      {/* Last close marker */}
      {(() => {
        const last = slice[slice.length - 1]
        const ly = yp(last.close)
        const lc = last.close >= last.open ? C.gr : C.re
        return (
          <circle cx={(W - PR).toFixed(1)} cy={ly.toFixed(1)}
            r="3" fill={lc} />
        )
      })()}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [status,    setStatus]    = useState<BotStatus | null>(null)
  const [trades,    setTrades]    = useState<Trade[]>([])
  const [candles,   setCandles]   = useState<CandleRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [cmdSent,   setCmdSent]   = useState(false)
  const [activeTab, setActiveTab] = useState<'history' | 'open'>('history')
  const [alert,     setAlert]     = useState<string | null>(null)
  const [m5Secs,    setM5Secs]    = useState(0)
  const [londonTime, setLondonTime] = useState('')
  const [botLogs,   setBotLogs]   = useState<BotLog[]>([])
  const [showQR,    setShowQR]    = useState(false)
  const prevPendingLen = useRef(0)

  // ── London clock ────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => setLondonTime(
      new Date().toLocaleString('pt-BR', {
        weekday: 'short', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Europe/London',
      }) + ' · LON'
    )
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [])

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!supa) return
    try {
      const [{ data: st }, { data: tr }] = await Promise.all([
        supa.from('rafi_bot_status').select('*').eq('id', 'main').single(),
        supa.from('rafi_trades').select('*').order('time', { ascending: false }).limit(200),
      ])
      if (st) setStatus(st as BotStatus)
      if (tr) setTrades(tr as Trade[])
    } catch {}
    try {
      const { data: lg } = await supa!.from('rafi_bot_logs')
        .select('*').order('created_at', { ascending: false }).limit(80)
      if (lg) setBotLogs(lg as BotLog[])
    } catch {}
  }, [])

  const fetchCandles = useCallback(async () => {
    if (!supa) return
    try {
      const { data } = await supa.from('rafi_candles')
        .select('time,open,high,low,close,volume,rafi')
        .order('time', { ascending: true }).limit(200)
      if (data && data.length > 0) setCandles(data as CandleRow[])
    } catch {}
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchAll(), fetchCandles()])
    setLoading(false)
  }, [fetchAll, fetchCandles])

  useEffect(() => {
    refresh()
    const iv1 = setInterval(fetchAll,     10_000)
    const iv2 = setInterval(fetchCandles,  5_000)
    return () => { clearInterval(iv1); clearInterval(iv2) }
  }, [fetchAll, fetchCandles, refresh])

  // ── M5 countdown ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000)
      setM5Secs((Math.floor(now / 300) + 1) * 300 - now)
    }
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [])

  // ── Alert on new trade ────────────────────────────────────────────────────────
  const pending = useMemo(() => trades.filter(t => t.result === 'pending'), [trades])
  useEffect(() => {
    if (prevPendingLen.current > 0 && pending.length > prevPendingLen.current) {
      const t = pending[0]
      const msg = t
        ? `${t.direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'} @ ${t.entry?.toFixed(5)} · SL ${t.stop_loss?.toFixed(5)} · TP ${t.take_profit?.toFixed(5)}`
        : 'Nova ordem aberta'
      setAlert(msg)
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted')
          new Notification('RAFI Bot — Novo Trade!', { body: msg })
        else if (Notification.permission !== 'denied')
          Notification.requestPermission()
      }
    }
    prevPendingLen.current = pending.length
  }, [pending])

  // ── Commands ─────────────────────────────────────────────────────────────────
  const enviarComando = async (cmd: string) => {
    if (!supa) return
    setCmdSent(true)
    try {
      await supa.from('rafi_bot_commands').insert({
        command: cmd, pending: true, created_at: new Date().toISOString(),
      })
      setTimeout(() => { setCmdSent(false); fetchAll() }, 3000)
    } catch { setCmdSent(false) }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const now       = Date.now()
  const isOnline  = status ? (now - new Date(status.updated_at).getTime()) < 420_000 : false
  const statusLabel =
    !status   ? 'SEM DADOS' : !isOnline ? 'OFFLINE' :
    status.status === 'running' ? 'EM POSIÇÃO' :
    status.status === 'waiting' ? 'AGUARDANDO' : 'PARADO'
  const statusColor =
    !status   ? C.t3 : !isOnline ? C.re :
    status.status === 'running' ? C.gr :
    status.status === 'waiting' ? C.am : C.re

  const closed  = useMemo(() => trades.filter(t => t.result !== 'pending'), [trades])
  const wins    = useMemo(() => closed.filter(t => t.result === 'win').length,  [closed])
  const losses  = useMemo(() => closed.filter(t => t.result === 'loss').length, [closed])
  const wr      = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null
  const wrCirc  = wr ?? 0
  // SVG arc for win rate circle: r=26, circumference=163.4
  const arcOff  = 163.4 * (1 - wrCirc / 100)

  const todayStart = startOfDay(new Date()).getTime() / 1000
  const weekStart  = startOfWeek(new Date()).getTime() / 1000
  const day7Start  = (now - 7  * 86400_000) / 1000
  const day30Start = (now - 30 * 86400_000) / 1000

  function pnlPeriod(from: number) {
    // Soma apenas trades com pnl real registrado
    return closed.filter(t => t.time >= from && t.pnl !== null).reduce((s, t) => s + t.pnl!, 0)
  }

  const pnlTodayCalc = pnlPeriod(todayStart)
  const pnlToday  = status?.pnl_today ?? pnlTodayCalc
  const floatPnL  = status ? (status.equity - status.balance) : 0
  const bal       = status?.balance ?? 0
  const eq        = status?.equity ?? bal
  const pctToday  = bal > 0 ? (pnlToday / Math.max(bal, 0.01)) * 100 : 0
  const tradesHoje = closed.filter(t => t.time >= todayStart).length

  // Acumulado total: apenas trades com pnl real no banco
  const realPnLTrades = useMemo(() => closed.filter(t => t.pnl !== null), [closed])
  const totalPnL = realPnLTrades.reduce((s, t) => s + t.pnl!, 0)

  // Max DD diário em dólares (5% do saldo)
  const maxDdUsd = bal > 0 ? bal * 0.05 : 0

  // ── Shared inline style helpers ───────────────────────────────────────────────
  const card = {
    background: C.s1, border: `1px solid ${C.bd}`,
  } as React.CSSProperties
  const lbl = {
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.13em', color: C.t2, marginBottom: 10,
  }
  const mono = { fontFamily: 'monospace' }

  const m5mm = String(Math.floor(m5Secs / 60)).padStart(2, '0')
  const m5ss = String(m5Secs % 60).padStart(2, '0')
  const m5pct = ((300 - m5Secs) / 300 * 100).toFixed(1)

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.tx, fontSize: 13, lineHeight: 1.5 }}>

      {/* ── Alert toast ──────────────────────────────────────────────────────── */}
      {alert && (
        <div className="fixed top-4 right-4 z-50 flex items-start gap-3 px-4 py-3 max-w-sm"
          style={{ background: C.gra, border: `1px solid ${C.gr}40`, boxShadow: '0 8px 32px rgba(0,0,0,.4)' }}>
          <Bell size={14} style={{ color: C.gr, marginTop: 2, flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 11, fontWeight: 700, color: C.gr }}>Novo Trade Disparado!</div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 2, wordBreak: 'break-all' }}>{alert}</div>
          </div>
          <button onClick={() => setAlert(null)} style={{ color: C.t3 }}><X size={12} /></button>
        </div>
      )}

      {/* ── Sticky command bar ───────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-20" style={{
        background: '#050a11', borderBottom: `1px solid ${C.bd}`,
        display: 'flex', alignItems: 'center', gap: 16, padding: '0 24px', height: 52,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{
            width: 32, height: 32, border: `1.5px solid ${C.cy}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            ...mono, fontSize: 10, fontWeight: 700, color: C.cy,
          }}>RF</div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
              RAFI Command
            </div>
            <div style={{ fontSize: 8, color: C.t3, letterSpacing: '0.06em' }}>
              {status ? `${status.par} · M5 · ${status.server} · #${status.account}` : 'EURUSD# · M5 · XMGlobal-MT5 4'}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, textAlign: 'center', ...mono, fontSize: 10, color: C.t2 }}>
          {londonTime}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            border: `1px solid ${statusColor}30`, background: `${statusColor}08`,
            color: statusColor, ...mono,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', background: statusColor,
              animation: isOnline ? 'pulse 2s ease-in-out infinite' : 'none',
            }} />
            {statusLabel}
            {status && isOnline && (
              <span style={{ opacity: 0.5, fontSize: 8, fontWeight: 400, marginLeft: 4 }}>
                · {secondsAgo(status.updated_at)}
              </span>
            )}
          </div>
          <button onClick={refresh} style={{
            padding: '5px 8px', border: `1px solid ${C.bd}`, background: 'transparent',
            color: C.t2, cursor: 'pointer',
          }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} style={{ color: C.t2 }} />
          </button>
          <button onClick={() => enviarComando('buy_manual')} disabled={cmdSent} style={{
            padding: '5px 14px', border: `1px solid ${C.cy}30`, background: C.cya,
            color: C.cy, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', cursor: 'pointer',
          }}>▲ COMPRA</button>
          <button onClick={() => enviarComando('sell_manual')} disabled={cmdSent} style={{
            padding: '5px 14px', border: `1px solid ${C.am}30`, background: C.ama,
            color: C.am, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', cursor: 'pointer',
          }}>▼ VENDA</button>
          <button onClick={() => enviarComando('stop')} disabled={cmdSent} style={{
            padding: '5px 14px', border: `1px solid ${C.re}30`, background: C.rea,
            color: C.re, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', cursor: 'pointer',
          }}>■ PARAR</button>
        </div>
      </nav>

      {/* ── Quase Rompendo banner ─────────────────────────────────────────────── */}
      {status?.forming_signal && (() => {
        const fDir   = status.forming_direction ?? 'buy'
        const fRafi  = status.forming_rafi ?? 0
        const fTf    = status.forming_tf_count ?? 0
        const fBb    = status.forming_bb_open ?? false
        const fPrice = status.forming_price ?? 0
        const fColor = fDir === 'buy' ? C.cy : C.am
        const fPct   = Math.min(100, Math.round((fRafi / 2.5) * 100))
        const fLabel = fDir === 'buy' ? '▲ COMPRA SE ROMPER' : '▼ VENDA SE ROMPER'
        return (
          <div style={{ position: 'sticky', top: 52, zIndex: 19 }}>
            {/* Banner strip */}
            <button onClick={() => setShowQR(v => !v)} style={{
              width: '100%', cursor: 'pointer', border: 'none', textAlign: 'left',
              background: `linear-gradient(90deg, ${fColor}14, ${fColor}06, transparent)`,
              borderBottom: `1px solid ${fColor}35`,
              padding: '7px 24px', display: 'flex', alignItems: 'center', gap: 16,
            }}>
              {/* Pulsing dot */}
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: fColor,
                boxShadow: `0 0 8px ${fColor}`, animation: 'pulse 1.2s ease-in-out infinite',
                flexShrink: 0 }} />
              {/* Label */}
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: fColor }}>
                ⚡ QUASE ROMPENDO
              </span>
              <span style={{ fontSize: 9, fontWeight: 700, color: fColor, fontFamily: 'monospace' }}>
                {fLabel}
              </span>
              {/* RAFI bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <span style={{ fontSize: 8, color: C.t2, flexShrink: 0 }}>RAFI</span>
                <div style={{ flex: 1, maxWidth: 140, height: 3, background: C.s3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${fPct}%`,
                    background: `linear-gradient(90deg, ${fColor}88, ${fColor})`,
                    transition: 'width 1s linear' }} />
                </div>
                <span style={{ fontSize: 8, fontFamily: 'monospace', color: fColor, fontWeight: 700 }}>
                  {fRafi.toFixed(2)}<span style={{ color: C.t3 }}>/2.50</span>
                </span>
              </div>
              {/* Metrics chips */}
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {[
                  { k: 'TF', v: `${fTf}/3`, ok: fTf >= 2 },
                  { k: 'BB', v: fBb ? 'ABRINDO' : 'FECHADO', ok: fBb },
                  { k: 'NÍVEL', v: fPrice > 0 ? fPrice.toFixed(5) : '—', ok: true },
                ].map(chip => (
                  <span key={chip.k} style={{ fontSize: 7, fontWeight: 700, fontFamily: 'monospace',
                    padding: '2px 8px', border: `1px solid ${chip.ok ? fColor + '40' : C.bd}`,
                    color: chip.ok ? fColor : C.t3,
                    background: chip.ok ? `${fColor}08` : 'transparent' }}>
                    {chip.k} {chip.v}
                  </span>
                ))}
              </div>
              {/* Expand toggle */}
              <span style={{ fontSize: 8, color: C.t2, fontFamily: 'monospace',
                display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {showQR ? 'FECHAR ↑' : 'GRÁFICO ↓'}
              </span>
            </button>

            {/* Expandable chart panel */}
            {showQR && (
              <div className="qr-panel" style={{
                background: C.s1, borderBottom: `1px solid ${fColor}20`,
                padding: '12px 24px 16px',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 16 }}>
                  {/* Mini candlestick chart */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.10em', color: C.t2 }}>EURUSD# M5 — Últimos 30 candles</span>
                      <span style={{ fontSize: 7, padding: '2px 6px',
                        border: `1px solid ${fColor}30`, color: fColor, fontFamily: 'monospace' }}>
                        Nível alvo: {fPrice > 0 ? fPrice.toFixed(5) : '—'}
                      </span>
                    </div>
                    <div style={{ background: C.bg, border: `1px solid ${C.bd}`, padding: '6px 0' }}>
                      <QRMiniChart candles={candles} srLevel={fPrice} direction={fDir} />
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 16, fontSize: 8, color: C.t3, fontFamily: 'monospace' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 20, display: 'inline-block', borderTop: `1.5px dashed ${fColor}` }} />
                        {fDir === 'buy' ? 'Resistência' : 'Suporte'} — rompimento confirma sinal
                      </span>
                    </div>
                  </div>

                  {/* Right metrics panel */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* RAFI gauge */}
                    <div style={{ background: C.bg, border: `1px solid ${C.bd}`, padding: '12px 14px' }}>
                      <div style={{ fontSize: 8, color: C.t2, textTransform: 'uppercase',
                        letterSpacing: '0.10em', marginBottom: 8 }}>Força do Movimento</div>
                      {/* Arc gauge */}
                      <svg width="100%" viewBox="0 0 120 70">
                        {/* Track */}
                        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke={C.s3} strokeWidth="8" strokeLinecap="round" />
                        {/* Fill */}
                        {(() => {
                          const pct = Math.min(1, fRafi / 2.5)
                          const ang = pct * Math.PI
                          const ex  = 60 - 50 * Math.cos(ang)
                          const ey  = 60 - 50 * Math.sin(ang)
                          const lg  = pct > 0.5 ? 1 : 0
                          return (
                            <path d={`M 10 60 A 50 50 0 ${lg} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`}
                              fill="none" stroke={fColor} strokeWidth="8" strokeLinecap="round" />
                          )
                        })()}
                        <text x="60" y="55" textAnchor="middle" fill={fColor}
                          fontFamily="monospace" fontSize="18" fontWeight="800">{fRafi.toFixed(1)}</text>
                        <text x="60" y="67" textAnchor="middle" fill={C.t3}
                          fontFamily="monospace" fontSize="7">de 2.50 para entrar</text>
                        <text x="10"  y="70" fill={C.t3} fontSize="6" textAnchor="middle">0</text>
                        <text x="110" y="70" fill={fColor} fontSize="6" textAnchor="middle">2.5</text>
                      </svg>
                    </div>

                    {/* Checklist */}
                    <div style={{ background: C.bg, border: `1px solid ${C.bd}`, padding: '12px 14px' }}>
                      <div style={{ fontSize: 8, color: C.t2, textTransform: 'uppercase',
                        letterSpacing: '0.10em', marginBottom: 8 }}>Condições para Entrada</div>
                      {[
                        { label: `RAFI ≥ 2.50`,           ok: fRafi >= 2.5,  val: fRafi.toFixed(2) },
                        { label: `Timeframes (${fTf}/3)`,  ok: fTf === 3,     val: fTf === 3 ? '✓' : `${fTf}/3` },
                        { label: 'Bollinger abrindo',       ok: fBb,           val: fBb ? '✓' : '—' },
                        { label: 'Rompimento confirmado',   ok: false,         val: 'aguard.' },
                      ].map(item => (
                        <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between',
                          alignItems: 'center', padding: '5px 0',
                          borderBottom: `1px solid ${C.bd}`, fontSize: 9 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 5, height: 5, borderRadius: '50%',
                              background: item.ok ? C.gr : C.t3, flexShrink: 0 }} />
                            <span style={{ color: item.ok ? C.tx : C.t2 }}>{item.label}</span>
                          </span>
                          <span style={{ fontFamily: 'monospace', fontSize: 8,
                            color: item.ok ? C.gr : C.t3 }}>{item.val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes rafiPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(.98)}}
        .kcard{position:relative;transition:transform .15s,box-shadow .15s}
        .kcard:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,.4)}
        .kcard::before{content:'';position:absolute;inset:0;opacity:0;transition:opacity .25s;pointer-events:none;z-index:0}
        .kcard:hover::before{opacity:1}
        .kcard>*{position:relative;z-index:1}
        .kc-gr::before{background:radial-gradient(ellipse at 50% 110%,rgba(0,230,118,.12),transparent 65%)}
        .kc-cy::before{background:radial-gradient(ellipse at 50% 110%,rgba(0,217,255,.12),transparent 65%)}
        .kc-am::before{background:radial-gradient(ellipse at 50% 110%,rgba(255,179,0,.12),transparent 65%)}
        .kc-re::before{background:radial-gradient(ellipse at 50% 110%,rgba(255,71,87,.12),transparent 65%)}
        .kc-bl::before{background:radial-gradient(ellipse at 50% 110%,rgba(75,142,245,.12),transparent 65%)}
        .bcard{position:relative;transition:transform .15s,box-shadow .15s,border-color .2s}
        .bcard:hover{transform:translateY(-3px)}
        .bc-gr:hover{border-color:rgba(0,230,118,.4)!important;box-shadow:0 6px 24px rgba(0,230,118,.10)}
        .bc-am:hover{border-color:rgba(255,179,0,.4)!important;box-shadow:0 6px 24px rgba(255,179,0,.10)}
        .bc-t3:hover{border-color:rgba(45,74,96,.7)!important}
        .bhex{clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)}
        .bcta{opacity:0;transition:opacity .15s}
        .bcard:hover .bcta{opacity:1}
        .logrow:nth-child(even){background:rgba(13,25,39,.5)}
        .forming-card{animation:rafiPulse 2.8s ease-in-out infinite}
        @keyframes slideDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        .qr-panel{animation:slideDown .18s ease-out both}
      `}</style>

      <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── Hero KPIs ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 1fr 1fr 1fr 1fr', gap: 10 }}>

          {/* Acumulado Total */}
          <div className="kcard kc-gr" style={{ ...card, padding: '20px 22px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: C.gr }} />
            <div style={lbl}>Acumulado Total</div>
            <div style={{ ...mono, fontSize: '2.2rem', fontWeight: 700, lineHeight: 1,
              color: totalPnL >= 0 ? C.gr : C.re, marginBottom: 4 }}>
              {realPnLTrades.length > 0 ? fmtUSD(totalPnL, true) : '—'}
            </div>
            <div style={{ fontSize: 10, color: C.t2 }}>
              {realPnLTrades.length > 0
                ? `${realPnLTrades.length} c/ P&L real · ${closed.length - realPnLTrades.length} sem dado`
                : `${closed.length} trades · P&L não registrado`}
            </div>
            <div style={{ marginTop: 14 }}>
              <CapitalCurveChart trades={trades} />
            </div>
          </div>

          {/* Win Rate */}
          <div className="kcard kc-cy" style={{ ...card, padding: '20px 22px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: C.cy }} />
            <div style={lbl}>Win Rate</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '6px 0' }}>
              <svg width="68" height="68" viewBox="0 0 68 68">
                <circle cx="34" cy="34" r="26" fill="none" stroke={C.s3} strokeWidth="5.5" />
                <circle cx="34" cy="34" r="26" fill="none" stroke={C.gr} strokeWidth="5.5"
                  strokeDasharray="163.4" strokeDashoffset={arcOff}
                  strokeLinecap="round" transform="rotate(-90 34 34)" />
                <text x="34" y="39" textAnchor="middle" fill={C.gr}
                  fontFamily="monospace" fontSize="13" fontWeight="700">
                  {wr !== null ? `${wr}%` : '—'}
                </text>
              </svg>
              <div>
                <div style={{ fontSize: 9, color: C.t2 }}>{wins} vitórias</div>
                <div style={{ fontSize: 9, color: C.re }}>{losses} derrotas</div>
                <div style={{ fontSize: 9, color: C.t3, marginTop: 4 }}>{wins + losses} total</div>
              </div>
            </div>
            <div style={{ fontSize: 10, color: C.t2 }}>
              Profit Factor <span style={{ ...mono, color: C.cy }}>
                {losses > 0 ? (wins / losses).toFixed(1) : '∞'}
              </span>
            </div>
          </div>

          {/* Bot Status */}
          <div className="kcard kc-am" style={{ ...card, padding: '20px 22px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: statusColor }} />
            <div style={lbl}>Bot Status</div>
            <div style={{ ...mono, fontSize: '1.5rem', fontWeight: 700, color: statusColor, lineHeight: 1 }}>
              {statusLabel}
            </div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 8 }}>
              Heartbeat: {status ? secondsAgo(status.updated_at) : '—'}
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 9, color: C.t2 }}>
              <div>Ciclo M5 · 24h</div>
              <div>Risco: <span style={{ ...mono, color: C.am }}>1–2%/trade</span></div>
              <div>Lote: <span style={{ ...mono, color: C.tx }}>{bal > 0 ? loteAtual(bal) : '—'}</span></div>
            </div>
          </div>

          {/* P&L Hoje */}
          <div className="kcard kc-re" style={{ ...card, padding: '20px 22px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: C.re }} />
            <div style={{ position: 'absolute', top: 16, right: 16, fontSize: 7, fontWeight: 700,
              padding: '2px 7px', border: `1px solid ${C.bd}`, color: C.t2 }}>HOJE</div>
            <div style={lbl}>P&L Hoje</div>
            <div style={{ ...mono, fontSize: '1.8rem', fontWeight: 700, lineHeight: 1,
              color: pnlToday > 0 ? C.gr : pnlToday < 0 ? C.re : C.t2 }}>
              {fmtUSD(pnlToday, true)}
            </div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 6 }}>
              {tradesHoje} trade{tradesHoje !== 1 ? 's' : ''} · {fmtPct(pctToday, true)}
            </div>
            <div style={{ marginTop: 8, fontSize: 9, color: C.t2 }}>
              <div>Limite: <span style={{ ...mono, color: C.re }}>−5%</span></div>
              <div>Saldo: <span style={{ ...mono, color: C.tx }}>{bal > 0 ? fmtUSD(bal) : '—'}</span></div>
            </div>
          </div>

          {/* Conta XM / Posição Aberta — dual-state */}
          <div className="kcard kc-bl" style={{ ...card, padding: '20px 22px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
              background: pending.length > 0 ? (pending[0].direction === 'buy' ? C.cy : C.am) : C.bl }} />
            {pending.length > 0 ? (
              /* ── Com posição aberta ── */
              <>
                <div style={lbl}>Posição Aberta</div>
                <div style={{ ...mono, fontSize: '1.35rem', fontWeight: 700,
                  color: pending[0].direction === 'buy' ? C.cy : C.am }}>
                  {pending[0].direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'}
                </div>
                <div style={{ ...mono, fontSize: 11, color: C.tx, marginTop: 2 }}>
                  {pending[0].entry.toFixed(5)}
                </div>
                <div style={{ fontSize: 9, color: C.t2, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Float</span>
                    <span style={{ ...mono, fontWeight: 700, color: floatPnL >= 0 ? C.gr : C.re }}>
                      {fmtUSD(floatPnL, true)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>SL</span><span style={{ ...mono, color: C.re }}>{pending[0].stop_loss.toFixed(5)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>TP</span><span style={{ ...mono, color: C.gr }}>{pending[0].take_profit.toFixed(5)}</span>
                  </div>
                </div>
                <div style={{ marginTop: 10, borderTop: `1px solid ${C.bd}`, paddingTop: 8,
                  display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.t2 }}>
                  <span>Saldo: <span style={{ ...mono, color: C.tx }}>{bal > 0 ? fmtUSD(bal) : '—'}</span></span>
                  <span style={{ ...mono, color: C.cy }}>{m5mm}:{m5ss} ↻</span>
                </div>
              </>
            ) : (
              /* ── Sem posição: mostra conta XM ── */
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={lbl}>Conta XM</div>
                  <div style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                    border: `1px solid ${C.bd}`, color: C.t3, ...mono }}>
                    #{status?.account ?? '—'}
                  </div>
                </div>
                <div style={{ ...mono, fontSize: '2rem', fontWeight: 700, lineHeight: 1,
                  color: C.tx, marginBottom: 2 }}>
                  {bal > 0 ? fmtUSD(bal) : '—'}
                </div>
                <div style={{ fontSize: 8, color: C.t2, marginBottom: 10 }}>Saldo disponível</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.t2 }}>Equity</span>
                    <span style={{ ...mono, color: C.tx }}>{fmtUSD(eq)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.t2 }}>Lote atual</span>
                    <span style={{ ...mono, color: C.am }}>{bal > 0 ? loteAtual(bal) : '—'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.t2 }}>Max perda/dia</span>
                    <span style={{ ...mono, color: C.re }}>
                      {maxDdUsd > 0 ? `−${fmtUSD(maxDdUsd)}` : '—'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.t2 }}>Último sinal</span>
                    <span style={{ ...mono, color: C.t2, fontSize: 8, maxWidth: 90,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {status?.last_signal ?? 'nenhum'}
                    </span>
                  </div>
                </div>
                <div style={{ marginTop: 10, borderTop: `1px solid ${C.bd}`, paddingTop: 6,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 8, color: C.t3 }}>
                  <span>Próx. candle M5</span>
                  <span style={{ ...mono, color: C.cy, fontSize: 11, fontWeight: 700 }}>
                    {m5mm}:{m5ss}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Main grid ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 290px', gap: 10 }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Live chart */}
            <div style={{ ...card }}>
              <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                  fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                  <BarChart2 size={11} style={{ color: C.bl }} />
                  EURUSD# · M5 · Tempo Real
                  {candles.length > 0 && (
                    <span style={{ fontSize: 7, padding: '2px 6px', border: `1px solid ${C.gr}30`,
                      color: C.gr, background: C.gra }}>{candles.length} candles</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 8, ...mono, color: C.t2 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 1, background: C.gr, display: 'inline-block' }} /> TP
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 1, background: C.re, display: 'inline-block' }} /> SL
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 1, background: C.am, display: 'inline-block' }} /> Entry
                  </span>
                </div>
              </div>
              <LiveChart candles={candles} trades={trades} pending={pending} />
            </div>

            {/* Previsão de Trades */}
            <div style={{ ...card }}>
              <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                  fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.bl }} />
                  Previsão de Trades
                </div>
                <div style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                  border: `1px solid ${C.bd}`, color: C.t2 }}>Padrão histórico</div>
              </div>
              <ForecastSection trades={trades} />
            </div>

            {/* Sinal em Formação */}
            {(() => {
              const forming = status?.forming_signal
              const fDir    = status?.forming_direction
              const fRafi   = status?.forming_rafi ?? 0
              const fTf     = status?.forming_tf_count ?? 0
              const fBb     = status?.forming_bb_open ?? false
              const fPrice  = status?.forming_price
              const fColor  = fDir === 'buy' ? C.cy : fDir === 'sell' ? C.am : C.bl
              const fPct    = Math.min(100, Math.round((fRafi / 2.5) * 100))
              return (
                <div className={forming ? 'forming-card' : ''} style={{
                  ...card,
                  borderColor: forming ? `${fColor}40` : C.bd,
                  background: forming ? `linear-gradient(135deg, ${C.s1}, ${fColor}06)` : C.s1,
                }}>
                  <div style={{ padding: '10px 18px', borderBottom: `1px solid ${forming ? fColor + '25' : C.bd}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%',
                        background: forming ? fColor : C.t3,
                        boxShadow: forming ? `0 0 6px ${fColor}` : 'none',
                        animation: forming ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
                      Sinal em Formação
                    </div>
                    <div style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                      border: `1px solid ${forming ? fColor + '30' : C.bd}`,
                      color: forming ? fColor : C.t3,
                      background: forming ? `${fColor}08` : 'transparent' }}>
                      {forming ? (fDir === 'buy' ? '▲ ROMPIMENTO ALTA' : '▼ ROMPIMENTO BAIXA') : 'AGUARDANDO'}
                    </div>
                  </div>
                  {forming ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 0 }}>
                      {[
                        { label: 'Força RAFI', val: fRafi.toFixed(2), sub: fRafi >= 2.5 ? '≥ 2.50 ✓' : `${fPct}% do limiar`, color: fRafi >= 2.5 ? C.gr : C.am },
                        { label: 'Timeframes', val: `${fTf}/3`, sub: fTf === 3 ? 'Alinhados ✓' : 'Parcial', color: fTf === 3 ? C.gr : C.am },
                        { label: 'Bollinger', val: fBb ? 'ABRINDO' : 'FECHADO', sub: fBb ? 'Expansão ✓' : 'Sem expansão', color: fBb ? C.gr : C.t2 },
                        { label: 'Preço', val: fPrice ? fPrice.toFixed(5) : '—', sub: `Dir: ${fDir === 'buy' ? 'compra' : 'venda'}`, color: fColor },
                      ].map((item, i) => (
                        <div key={i} style={{ padding: '12px 18px', borderRight: i < 3 ? `1px solid ${C.bd}` : 'none' }}>
                          <div style={{ fontSize: 8, color: C.t2, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{item.label}</div>
                          <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 700, color: item.color, lineHeight: 1 }}>{item.val}</div>
                          <div style={{ fontSize: 8, color: C.t3, marginTop: 3 }}>{item.sub}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1, fontSize: 9, color: C.t3 }}>
                        Bot monitora cada candle M5 — quando RAFI ≥ 1.75, timeframes parcialmente alinhados
                        e Bollinger começando a abrir, exibe aqui antes de confirmar entrada.
                      </div>
                      <div style={{ textAlign: 'right', ...mono, fontSize: 9, color: C.t2, flexShrink: 0 }}>
                        <div>Próx. análise</div>
                        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: C.cy }}>{m5mm}:{m5ss}</div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Signal feed */}
            <div style={{ ...card }}>
              <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                  fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.cy,
                    animation: 'pulse 2s ease-in-out infinite' }} />
                  Inteligência de Sinais
                </div>
                <div style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                  border: `1px solid ${C.bd}`, color: C.t2 }}>Últimas entradas</div>
              </div>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '44px 52px 90px 72px 72px 48px 56px 76px',
                gap: 3, padding: '7px 18px', fontSize: 7, textTransform: 'uppercase',
                letterSpacing: '0.10em', color: C.t3, fontWeight: 600,
                borderBottom: `1px solid ${C.bd2}` }}>
                <span>Hora</span><span>Dir</span><span>Entry</span>
                <span>SL</span><span>TP</span><span>RAFI</span><span>IA %</span><span>Status</span>
              </div>
              {closed.length === 0 ? (
                <div style={{ padding: '20px 18px', fontSize: 10, color: C.t3, textAlign: 'center' }}>
                  Aguardando sinais...
                </div>
              ) : (
                closed.slice(0, 6).map((t) => (
                  <div key={t.id} style={{ display: 'grid',
                    gridTemplateColumns: '44px 52px 90px 72px 72px 48px 56px 76px',
                    gap: 3, padding: '8px 18px', fontSize: 9, ...mono,
                    borderBottom: `1px solid ${C.bd}` }}>
                    <span style={{ color: C.t2 }}>{new Date(t.time * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 7,
                        fontWeight: 700, padding: '2px 5px',
                        color: t.direction === 'buy' ? C.cy : C.am,
                        background: t.direction === 'buy' ? C.cya : C.ama }}>
                        {t.direction === 'buy' ? '▲ BUY' : '▼ SELL'}
                      </span>
                    </span>
                    <span style={{ color: C.tx }}>{t.entry.toFixed(5)}</span>
                    <span style={{ color: C.re }}>{t.stop_loss.toFixed(5)}</span>
                    <span style={{ color: C.gr }}>{t.take_profit.toFixed(5)}</span>
                    <span style={{ color: t.rafi !== null && t.rafi >= 2.5 ? C.gr : C.am }}>
                      {t.rafi !== null ? t.rafi.toFixed(1) : '—'}
                    </span>
                    <span style={{ color: C.bl }}>—</span>
                    <span>
                      <span style={{ fontSize: 7, fontWeight: 700, padding: '2px 6px',
                        color: t.result === 'win' ? C.gr : t.result === 'loss' ? C.re : C.t3,
                        background: t.result === 'win' ? C.gra : t.result === 'loss' ? C.rea : C.s3 }}>
                        {t.result === 'win' ? 'WIN' : t.result === 'loss' ? 'LOSS' : 'ABERTO'}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* ActivityFeed — bot log */}
            <div style={{ ...card }}>
              <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                  fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.bl,
                    animation: 'pulse 2s ease-in-out infinite' }} />
                  Log do Bot — Feed ao Vivo
                </div>
                <div style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                  border: `1px solid ${C.bd}`, color: C.t2 }}>{botLogs.length} entradas</div>
              </div>
              {botLogs.length === 0 ? (
                <div style={{ padding: '20px 18px', fontSize: 10, color: C.t3, textAlign: 'center' }}>
                  Aguardando logs do bot (tabela <code style={{ color: C.t2 }}>rafi_bot_logs</code>)...
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {botLogs.slice(0, 40).map(log => {
                    const lc = log.level === 'error' ? C.re : log.level === 'warn' ? C.am
                      : log.level === 'signal' ? C.cy : C.t2
                    return (
                      <div key={log.id} className="logrow" style={{ display: 'grid',
                        gridTemplateColumns: '60px 44px 1fr', gap: 6,
                        padding: '5px 18px', fontSize: 8, fontFamily: 'monospace',
                        borderBottom: `1px solid ${C.bd}` }}>
                        <span style={{ color: C.t3 }}>
                          {new Date(log.created_at).toLocaleTimeString('pt-BR',
                            { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span style={{ fontWeight: 700, fontSize: 7, padding: '1px 4px',
                          color: lc, border: `1px solid ${lc}30`, textAlign: 'center',
                          alignSelf: 'center' }}>
                          {log.level.toUpperCase()}
                        </span>
                        <span style={{ color: log.level === 'error' ? C.re
                          : log.level === 'signal' ? C.tx : C.t2,
                          wordBreak: 'break-all', lineHeight: 1.6 }}>
                          {log.message}
                          {log.details && (
                            <span style={{ color: C.t3, marginLeft: 6 }}>{log.details}</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* M5 countdown */}
            <div style={{ ...card, padding: '18px 18px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ ...lbl, marginBottom: 8 }}>Próxima Análise M5</div>
                  <div style={{ ...mono, fontSize: '2.4rem', fontWeight: 700, color: C.cy, lineHeight: 1 }}>
                    {m5mm}:{m5ss}
                  </div>
                  <div style={{ fontSize: 8, color: C.t3, textTransform: 'uppercase',
                    letterSpacing: '0.08em', marginTop: 2 }}>até fechar o candle</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ ...lbl, marginBottom: 6 }}>Posições</div>
                  <div style={{ ...mono, fontSize: 11, color: pending.length > 0 ? C.am : C.t2 }}>
                    {pending.length} aberta{pending.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
              <div style={{ height: 2, background: C.s3, marginTop: 10, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: C.cy,
                  width: `${m5pct}%`, transition: 'width 1s linear' }} />
              </div>
            </div>

            {/* Quick actions */}
            <div style={{ ...card, padding: 14 }}>
              <div style={{ ...lbl }}>Controle Rápido</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <button onClick={() => enviarComando('buy_manual')} disabled={cmdSent}
                  style={{ width: '100%', padding: 10, border: `1px solid ${C.cy}30`,
                    background: C.cya, color: C.cy, fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.06em', cursor: cmdSent ? 'not-allowed' : 'pointer' }}>
                  ▲ COMPRA MANUAL
                </button>
                <button onClick={() => enviarComando('sell_manual')} disabled={cmdSent}
                  style={{ width: '100%', padding: 10, border: `1px solid ${C.am}30`,
                    background: C.ama, color: C.am, fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.06em', cursor: cmdSent ? 'not-allowed' : 'pointer' }}>
                  ▼ VENDA MANUAL
                </button>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <button onClick={() => enviarComando('stop')} disabled={cmdSent}
                    style={{ padding: 10, border: `1px solid ${C.re}30`, background: C.rea,
                      color: C.re, fontSize: 9, fontWeight: 700, cursor: cmdSent ? 'not-allowed' : 'pointer' }}>
                    ■ PARAR
                  </button>
                  <button onClick={() => enviarComando('start')} disabled={cmdSent}
                    style={{ padding: 10, border: `1px solid ${C.gr}30`, background: C.gra,
                      color: C.gr, fontSize: 9, fontWeight: 700, cursor: cmdSent ? 'not-allowed' : 'pointer' }}>
                    ▶ INICIAR
                  </button>
                </div>
                {pending.length > 0 && (
                  <button onClick={() => enviarComando('close_position')} disabled={cmdSent}
                    style={{ width: '100%', padding: 10, border: `1px solid ${C.re}30`,
                      background: C.rea, color: C.re, fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.06em', cursor: cmdSent ? 'not-allowed' : 'pointer',
                      animation: 'pulse 2s ease-in-out infinite' }}>
                    ■ FECHAR POSIÇÃO
                  </button>
                )}
                {cmdSent && (
                  <div style={{ fontSize: 9, color: C.am, textAlign: 'center' }}>
                    Comando enviado...
                  </div>
                )}
              </div>
            </div>

            {/* System health */}
            <div style={{ ...card }}>
              <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
                display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%',
                  background: isOnline ? C.gr : C.re,
                  boxShadow: isOnline ? `0 0 5px ${C.gr}` : 'none',
                  animation: isOnline ? 'pulse 2s ease-in-out infinite' : 'none' }} />
                Saúde do Sistema
              </div>
              {([
                ['MT5 Status',   isOnline ? 'ONLINE' : 'OFFLINE', isOnline ? C.gr : C.re],
                ['Heartbeat',    status ? secondsAgo(status.updated_at) : '—', C.tx],
                ['Conta',        status?.account?.toString() ?? '—', C.tx],
                ['Servidor',     status?.server ?? '—', C.tx],
                ['Saldo',        bal > 0 ? fmtUSD(bal) : '—', C.tx],
                ['Alavancagem',  '1:1000', C.am],
                ['Spread est.',  '0.8 pip', C.t2],
                ['Max DD/dia',   '−5%', C.re],
              ] as [string, string, string][]).map(([k, v, vc]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', padding: '6px 18px',
                  borderBottom: `1px solid ${C.bd}`, fontSize: 10 }}>
                  <span style={{ color: C.t2, fontSize: 9 }}>{k}</span>
                  <span style={{ ...mono, fontSize: 10, color: vc }}>{v}</span>
                </div>
              ))}
            </div>

            {/* AI / ML */}
            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
                fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em',
                color: C.t2, marginBottom: 12 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.bl }} />
                IA / Fase 2 · XGBoost
              </div>
              <div style={{ ...lbl }}>Acurácia do Modelo</div>
              <div style={{ ...mono, fontSize: '1.3rem', fontWeight: 700,
                margin: '4px 0', color: C.bl }}>72.4%</div>
              <div style={{ height: 2, background: C.s3, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ height: '100%', width: '72.4%',
                  background: `linear-gradient(90deg, ${C.bl}, ${C.cy})` }} />
              </div>
              {([
                ['Filtro ativo',  '≥ 65%', C.am],
                ['Features',      '12 vars', C.t2],
                ['Sinais ML',     `${closed.filter(t => t.rafi !== null).length}`, C.bl],
                ['Retreino',      'Semanal', C.t2],
              ] as [string, string, string][]).map(([k, v, vc]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', padding: '5px 0',
                  borderBottom: `1px solid ${C.bd}`, fontSize: 10 }}>
                  <span style={{ color: C.t2, fontSize: 9 }}>{k}</span>
                  <span style={{ fontWeight: 700, fontSize: 9, color: vc }}>{v}</span>
                </div>
              ))}
              <div style={{ fontSize: 8, color: C.t3, paddingTop: 8 }}>
                300+ sinais para treino completo
              </div>
            </div>
          </div>
        </div>

        {/* ── Ecosystem section ─────────────────────────────────────────────── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
            <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: C.t3, fontWeight: 700 }}>Ecossistema · Plataforma</span>
            <div style={{ flex: 1, height: 1, background: C.bd }} />
            <span style={{ fontSize: 8, color: C.t3, ...mono }}>WIN RATE ALVO ML: 90–95%</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginBottom: 8 }}>
            {([
              { name: 'XM Global',   initials: 'XM', sub: 'EURUSD# · MT5 · B-book', status: 'ATIVO',
                sc: C.gr, health: 97, saldo: bal > 0 ? fmtUSD(bal) : '$31.96', active: true,
                spark: [60,65,62,70,68,75,72,80,77,85,82,90,88,95,97] },
              { name: 'IC Markets',  initials: 'IC', sub: 'ECN/STP · MT5 · 0.1 pip', status: 'ETAPA 6',
                sc: C.am, health: null, saldo: null, active: false, spark: [] },
              { name: 'Pepperstone', initials: 'PP', sub: 'ECN/STP · MT5 · Razor',   status: 'ETAPA 7',
                sc: C.t3, health: null, saldo: null, active: false, spark: [] },
              { name: 'Tickmill',    initials: 'TK', sub: 'ECN/STP · MT5 · Pro',     status: 'ETAPA 7',
                sc: C.t3, health: null, saldo: null, active: false, spark: [] },
            ] as { name:string; initials:string; sub:string; status:string; sc:string; health:number|null; saldo:string|null; active:boolean; spark:number[] }[]).map(b => {
              const r = 20; const circ = 2 * Math.PI * r
              const dash = b.health !== null ? circ * (b.health / 100) : 0
              const sparkMax = b.spark.length ? Math.max(...b.spark) : 100
              const sparkMin = b.spark.length ? Math.min(...b.spark) : 0
              const sparkW = 100, sparkH = 28
              const sparkPts = b.spark.map((v, i) =>
                `${(i / (b.spark.length - 1)) * sparkW},${sparkH - ((v - sparkMin) / (sparkMax - sparkMin + 0.01)) * (sparkH - 4)}`
              ).join(' ')
              return (
                <div key={b.name} className={`bcard ${b.active ? 'bc-gr' : 'bc-t3'}`} style={{
                  ...card, padding: 18, position: 'relative',
                  opacity: b.active ? 1 : 0.55,
                }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: b.sc }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 12 }}>
                    {/* Hex badge */}
                    <div className="bhex" style={{ width: 44, height: 44, background: `${b.sc}18`,
                      border: `1.5px solid ${b.sc}30`, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', flexShrink: 0 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 800, color: b.sc }}>
                        {b.initials}
                      </span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: b.active ? C.tx : C.t2 }}>{b.name}</div>
                        <span style={{ fontSize: 7, fontWeight: 700, padding: '2px 7px',
                          border: `1px solid ${b.sc}40`, color: b.sc, background: `${b.sc}08` }}>
                          {b.status}
                        </span>
                      </div>
                      <div style={{ fontSize: 8, color: C.t2 }}>{b.sub}</div>
                    </div>
                  </div>
                  {b.health !== null ? (
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                      {/* Health ring */}
                      <svg width="52" height="52" viewBox="0 0 52 52" style={{ flexShrink: 0 }}>
                        <circle cx="26" cy="26" r={r} fill="none" stroke={C.s3} strokeWidth="4" />
                        <circle cx="26" cy="26" r={r} fill="none" stroke={b.sc} strokeWidth="4"
                          strokeDasharray={`${dash.toFixed(1)} ${circ.toFixed(1)}`}
                          strokeLinecap="round" transform="rotate(-90 26 26)" />
                        <text x="26" y="30" textAnchor="middle" fill={b.sc}
                          fontFamily="monospace" fontSize="10" fontWeight="700">{b.health}</text>
                      </svg>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 8, color: C.t2, marginBottom: 4 }}>Saúde do sistema</div>
                        {/* Sparkline */}
                        <svg viewBox={`0 0 ${sparkW} ${sparkH}`} style={{ width: '100%', height: 28 }}>
                          <polyline points={sparkPts} fill="none" stroke={b.sc} strokeWidth="1.5"
                            strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
                        </svg>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                          <span style={{ fontSize: 8, color: C.t2 }}>Saldo</span>
                          <span style={{ fontFamily: 'monospace', fontSize: 9, color: C.tx, fontWeight: 700 }}>
                            {b.saldo}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 9, color: C.t3, padding: '4px 0' }}>
                      Conta não aberta · Aguarda etapas anteriores
                    </div>
                  )}
                  <button className="bcta" style={{ marginTop: 10, width: '100%', padding: '6px 0',
                    border: `1px solid ${b.sc}30`, background: `${b.sc}08`, color: b.sc,
                    fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer' }}>
                    VER CONFIG →
                  </button>
                </div>
              )
            })}
          </div>

          {/* Roadmap strip */}
          <div style={{ ...card, padding: '14px 18px' }}>
            <div style={{ ...lbl }}>Roadmap · 12 Etapas</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8 }}>
              {[
                { id: 'E0',    label: 'Bot XM',      color: C.gr,  op: 1,   done: true },
                { id: 'E1',    label: 'Supabase',    color: C.cy,  op: 1,   pulse: true },
                { id: 'E2-3',  label: 'Dataset ML',  color: C.am,  op: 0.8 },
                { id: 'E4-5',  label: 'ML vivo',     color: C.bl,  op: 0.6 },
                { id: 'E6-9',  label: '4 Brokers',   color: C.t3,  op: 0.7 },
                { id: 'E10-11', label: 'Cripto/B3',  color: C.t3,  op: 0.4 },
              ].map(s => (
                <div key={s.id} style={{ textAlign: 'center', opacity: s.op }}>
                  <div style={{ height: 3, background: s.color, marginBottom: 4,
                    animation: s.pulse ? 'pulse 2s ease-in-out infinite' : 'none' }} />
                  <div style={{ fontSize: 7, ...mono, color: s.color }}>{s.id}{s.done ? ' ✓' : ''}</div>
                  <div style={{ fontSize: 7, color: C.t3 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Trade history with mini charts ────────────────────────────────── */}
        <div style={{ ...card }}>
          <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.bd}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 8,
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.11em', color: C.t2 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.t2 }} />
              Histórico — Entrada / Stop / Alvo
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {(['history', 'open'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)} style={{
                  padding: '3px 10px', fontSize: 9, fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${activeTab === tab ? C.bd2 : 'transparent'}`,
                  background: activeTab === tab ? C.s2 : 'transparent',
                  color: activeTab === tab ? C.tx : C.t2,
                }}>
                  {tab === 'history' ? `Fechados (${closed.length})` : `Abertos (${pending.length})`}
                </button>
              ))}
              <span style={{ ...mono, fontSize: 9, color: C.gr }}>{wins}W</span>
              <span style={{ ...mono, fontSize: 9, color: C.re }}>{losses}L</span>
              {wr !== null && <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: C.tx }}>{wr}% WR</span>}
            </div>
          </div>

          {(activeTab === 'history' ? closed : pending).length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: C.t3, fontSize: 11 }}>
              {activeTab === 'history' ? 'Nenhum trade fechado ainda.' : 'Nenhuma posição aberta.'}
            </div>
          ) : (
            (activeTab === 'history' ? closed : pending).slice(0, 20).map(t => {
              const isBuy  = t.direction === 'buy'
              const isWin  = t.result === 'win'
              const isLoss = t.result === 'loss'
              const dirColor = isBuy ? C.cy : C.am
              const resColor = isWin ? C.gr : isLoss ? C.re : C.am
              const rr = t.entry > 0 && t.stop_loss > 0 && t.take_profit > 0
                ? (Math.abs(t.take_profit - t.entry) / Math.abs(t.entry - t.stop_loss)).toFixed(1)
                : '—'
              return (
                <div key={t.id} style={{ borderBottom: `1px solid ${C.bd}`,
                  padding: '12px 18px', display: 'flex', alignItems: 'flex-start', gap: 14,
                  transition: 'background .1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = C.s2)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <MiniTradeChart trade={t} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <span style={{ fontSize: 9, color: C.t2, ...mono }}>{fmtTime(t.time)}</span>
                      <span style={{ fontSize: 7, fontWeight: 700, padding: '2px 5px',
                        color: dirColor, background: `${dirColor}12` }}>
                        {isBuy ? '▲ BUY' : '▼ SELL'}
                      </span>
                      <span style={{ fontSize: 7, fontWeight: 700, padding: '2px 6px',
                        color: resColor, background: `${resColor}10`,
                        animation: t.result === 'pending' ? 'pulse 2s ease-in-out infinite' : 'none' }}>
                        {isWin ? 'WIN' : isLoss ? 'LOSS' : 'ABERTO'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 18, ...mono, fontSize: 10 }}>
                      <div>
                        <div style={{ fontSize: 8, color: C.t2 }}>ENTRADA</div>
                        {t.entry.toFixed(5)}
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: C.re }}>STOP</div>
                        <span style={{ color: C.re }}>{t.stop_loss.toFixed(5)}</span>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: C.gr }}>ALVO</div>
                        <span style={{ color: C.gr }}>{t.take_profit.toFixed(5)}</span>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: C.t2 }}>R:R</div>
                        <span style={{ color: C.cy }}>{rr}×</span>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: C.t2 }}>LOTE</div>
                        {t.lot.toFixed(2)}
                      </div>
                      <div>
                        <div style={{ fontSize: 8, color: C.t2 }}>P&L</div>
                        <span style={{ color: t.pnl === null ? C.t2 : t.pnl >= 0 ? C.gr : C.re, fontWeight: 700 }}>
                          {t.pnl !== null ? fmtUSD(t.pnl, true) : '—'}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                      {t.rafi !== null && (
                        <span style={{ fontSize: 7, fontWeight: 600, padding: '2px 6px',
                          border: `1px solid ${t.rafi >= 2.5 ? C.gr + '40' : C.bd}`,
                          color: t.rafi >= 2.5 ? C.gr : C.t2, ...mono }}>
                          RAFI {t.rafi.toFixed(1)}{t.rafi >= 2.5 ? ' ✓' : ''}
                        </span>
                      )}
                      <span style={{ fontSize: 7, fontWeight: 600, padding: '2px 6px',
                        border: `1px solid ${C.bd}`, color: C.t2 }}>R:R {rr}×</span>
                      <span style={{ fontSize: 7, fontWeight: 600, padding: '2px 6px',
                        border: `1px solid ${C.bd}`, color: C.t2 }}>M5/M15/H1</span>
                    </div>
                  </div>
                </div>
              )
            })
          )}

          {(activeTab === 'history' ? closed : pending).length > 20 && (
            <div style={{ padding: '10px 18px', fontSize: 8, color: C.t3,
              borderTop: `1px solid ${C.bd}`, display: 'flex', justifyContent: 'space-between' }}>
              <span>Mini gráfico: preço da entrada até SL (vermelho) ou TP (verde)</span>
              <span style={{ color: C.cy, cursor: 'pointer' }}>
                Ver todos {(activeTab === 'history' ? closed : pending).length} →
              </span>
            </div>
          )}
        </div>

        {/* ── Kill switch ──────────────────────────────────────────────────────── */}
        <div style={{ ...card, borderColor: `${C.re}20`, padding: '14px 18px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.tx }}>Kill Switch de Emergência</div>
            <div style={{ fontSize: 9, color: C.t2, marginTop: 3 }}>
              Envia STOP imediato — bot para no próximo ciclo (máx 5 min) ·{' '}
              <code style={{ color: C.t2 }}>C:\RafiBot\rafi-bot\STOP</code>
            </div>
          </div>
          <button onClick={() => enviarComando('stop')} disabled={cmdSent} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
            border: `1px solid ${C.re}25`, background: C.rea, color: C.re,
            fontSize: 11, fontWeight: 700, cursor: cmdSent ? 'not-allowed' : 'pointer', flexShrink: 0,
          }}>
            <Square size={11} fill="currentColor" />
            {cmdSent ? 'ENVIADO' : 'PARAR AGORA'}
          </button>
        </div>

      </div>
    </div>
  )
}
