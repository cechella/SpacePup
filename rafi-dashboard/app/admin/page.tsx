'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import {
  TrendingUp, TrendingDown, BarChart2, Activity,
  Target, AlertTriangle, ChevronRight, Download,
  Zap, Clock, Award, X as XIcon, Layers, Upload,
  Lock, Radio, Shield, Settings, Wifi, WifiOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SCALE_TIERS, SCALE_TIER_LABELS, getLotForCapital, getNextTier, calcCapital } from '@/lib/lot-scaling'
import { fetchTrades, upsertTrades, updateTradeResult } from '@/lib/trades-db'
import { getSessionConfig, saveSessionConfig, SESSION_DEFAULTS, type SessionConfig } from '@/lib/session-config'

// ─── Palette tokens ──────────────────────────────────────────────────────────
const C = {
  bg:        '#07101c',
  card:      '#0d1c2e',
  card2:     '#132035',
  border:    '#162436',
  gold:      '#f0b429',
  teal:      '#1de9b6',
  rose:      '#ff4560',
  blue:      '#4a9eff',
  text:      '#e8f0fe',
  muted:     '#4a6070',
  sub:       '#6b82a0',
} as const

// ── Modal de preview do screenshot ───────────────────────────────────────────
function SnapshotModal({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(2)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const clampZoom = (v: number) => Math.min(6, Math.max(0.5, Math.round(v * 10) / 10))

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(z => clampZoom(z - e.deltaY * 0.001))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.92)' }}
      onClick={onClose}
    >
      <div
        className="relative rounded-xl overflow-hidden border shadow-2xl flex flex-col"
        style={{ maxWidth: '92vw', maxHeight: '85vh', borderColor: C.border }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-2 text-[10px] border-b flex items-center justify-between shrink-0"
          style={{ background: C.bg, borderColor: C.border, color: C.muted }}>
          <span>Captura do gráfico no momento da execução</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setZoom(z => clampZoom(z - 0.25))}
              className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
              style={{ background: C.card2, border: `1px solid ${C.border}`, color: C.sub }}>−</button>
            <span className="font-mono w-10 text-center" style={{ color: C.sub }}>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => clampZoom(z + 0.25))}
              className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
              style={{ background: C.card2, border: `1px solid ${C.border}`, color: C.sub }}>+</button>
            <button onClick={onClose} className="ml-2 p-1 rounded-full"
              style={{ background: C.card2, border: `1px solid ${C.border}`, color: C.sub }}>
              <XIcon size={12} />
            </button>
          </div>
        </div>
        <div className="overflow-auto" style={{ maxHeight: 'calc(85vh - 40px)', background: C.bg }} onWheel={handleWheel}>
          <img src={src} alt="Gráfico no trade" style={{
            display: 'block', width: `${zoom * 100}%`,
            minWidth: zoom < 1 ? undefined : '100%',
            imageRendering: zoom > 1.5 ? 'pixelated' : 'auto',
            transition: 'width 0.1s ease',
          }} />
        </div>
      </div>
    </div>
  )
}

// ── Tipos ────────────────────────────────────────────────────────────────────
interface ManualTrade {
  id: string; direction: 'buy' | 'sell'; entry: number
  stopLoss: number; takeProfit: number; label: string
  time: number; lot: number; leverage: number
  result?: 'win' | 'loss' | 'pending'
  rafi?: number; rafiDir?: 'bull' | 'bear'; bbWidth?: number
  snapshot?: string; pnlUsd?: number; capitalInicial?: number
}

const STORAGE_KEY = 'rafi-trade-log'
const ML_TARGET   = 300

function riskPips(e: number, s: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((e - s) * 10000) : Math.round((s - e) * 10000)
}
function rewardPips(e: number, t: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((t - e) * 10000) : Math.round((e - t) * 10000)
}
function pipValueUSD(lot: number) { return lot * 10 }

// ── Curva de capital mini SVG ─────────────────────────────────────────────────
function EquityCurve({ trades, height = 64 }: { trades: ManualTrade[]; height?: number }) {
  const decided = trades.filter(t => t.result === 'win' || t.result === 'loss')
  if (decided.length < 2) return (
    <div className="flex items-center justify-center h-full text-[10px]" style={{ color: C.muted }}>
      Rotule W/L para ver a curva
    </div>
  )
  const pts: number[] = [0]
  for (const t of decided) {
    const r = riskPips(t.entry, t.stopLoss, t.direction)
    const w = rewardPips(t.entry, t.takeProfit, t.direction)
    const pv = pipValueUSD(t.lot)
    const last = pts[pts.length - 1]
    pts.push(t.result === 'win' ? last + w * pv : last - r * pv)
  }
  const W = 400, H = height
  const min = Math.min(...pts), max = Math.max(...pts)
  const range = max - min || 1
  const toY = (v: number) => H - ((v - min) / range) * (H - 8) - 4
  const toX = (i: number) => (i / (pts.length - 1)) * W
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
  const fill = `${path} L${W},${H} L0,${H} Z`
  const finalPnl = pts[pts.length - 1]
  const color = finalPnl >= 0 ? C.teal : C.rose
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dash-eq" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1={toY(0).toFixed(1)} x2={W} y2={toY(0).toFixed(1)}
        stroke={C.border} strokeWidth="1" strokeDasharray="3 3" />
      <path d={fill} fill="url(#dash-eq)" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={toX(pts.length - 1)} cy={toY(finalPnl)} r="4" fill={color} />
    </svg>
  )
}

// ── Sparkline canvas para o hero ──────────────────────────────────────────────
function HeroSparkline({ trades, height = 80 }: { trades: ManualTrade[]; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const decided = useMemo(() => trades.filter(t => t.result === 'win' || t.result === 'loss'), [trades])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)

    if (decided.length < 2) {
      ctx.font = '11px Inter, sans-serif'
      ctx.fillStyle = C.muted
      ctx.textAlign = 'center'
      ctx.fillText('Rotule W/L para ver a curva', W / 2, H / 2)
      return
    }

    const pts: number[] = [0]
    for (const t of decided) {
      const r = riskPips(t.entry, t.stopLoss, t.direction)
      const w = rewardPips(t.entry, t.takeProfit, t.direction)
      const pv = pipValueUSD(t.lot)
      const last = pts[pts.length - 1]
      pts.push(t.result === 'win' ? last + w * pv : last - r * pv)
    }

    const min = Math.min(...pts), max = Math.max(...pts)
    const range = max - min || 1
    const pad = { t: 8, b: 8, l: 4, r: 4 }
    const toY = (v: number) => pad.t + (1 - (v - min) / range) * (H - pad.t - pad.b)
    const toX = (i: number) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r)

    const finalPnl = pts[pts.length - 1]
    const color = finalPnl >= 0 ? C.teal : C.rose

    // Fill gradient
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, color + '55')
    grad.addColorStop(1, color + '05')
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(pts[0]))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(toX(i), toY(pts[i]))
    ctx.lineTo(toX(pts.length - 1), H)
    ctx.lineTo(toX(0), H)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // Line
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(pts[0]))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(toX(i), toY(pts[i]))
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Zero line
    const zeroY = toY(0)
    if (zeroY > pad.t && zeroY < H - pad.b) {
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.moveTo(pad.l, zeroY)
      ctx.lineTo(W - pad.r, zeroY)
      ctx.strokeStyle = C.border
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }

    // End dot
    const ex = toX(pts.length - 1), ey = toY(finalPnl)
    ctx.beginPath()
    ctx.arc(ex, ey, 4, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()

    // Value label
    ctx.font = 'bold 10px monospace'
    ctx.fillStyle = color
    ctx.textAlign = 'right'
    ctx.fillText((finalPnl >= 0 ? '+' : '') + '$' + finalPnl.toFixed(2), W - pad.r - 6, ey - 6)

  }, [decided])

  return <canvas ref={canvasRef} width={400} height={height} style={{ width: '100%', height }} />
}

// ── Progress bar do ML ────────────────────────────────────────────────────────
function MLProgress({ current }: { current: number }) {
  const pct   = Math.min((current / ML_TARGET) * 100, 100)
  const color = pct >= 100 ? C.teal : pct >= 50 ? C.blue : C.gold
  const phase = pct >= 100 ? 'Pronto para treinar!' : pct >= 50 ? 'Fase 1B quase lá' : 'Fase 1A — mapeando'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium" style={{ color: C.sub }}>{phase}</span>
        <span className="font-mono font-bold" style={{ color }}>{current} / {ML_TARGET}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: C.card2 }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex items-center justify-between text-[9px]" style={{ color: C.muted }}>
        <span>0</span>
        <span>Treinar XGBoost</span>
        <span>{ML_TARGET}</span>
      </div>
    </div>
  )
}

// ── Stat card do cockpit ──────────────────────────────────────────────────────
function KPI({ label, value, sub, color, icon: Icon }: {
  label: string; value: string | number; sub?: string; color?: string; icon?: any
}) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-1" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-widest" style={{ color: C.muted }}>{label}</span>
        {Icon && <Icon size={13} style={{ color: color ?? C.muted }} />}
      </div>
      <div className="text-2xl font-black font-mono" style={{ color: color ?? C.text }}>{value}</div>
      {sub && <div className="text-[10px]" style={{ color: C.muted }}>{sub}</div>}
    </div>
  )
}

// ── Chips de observação ML por trade ──────────────────────────────────────────
function MLChips({ t, onSnapClick }: { t: ManualTrade; onSnapClick?: (src: string) => void }) {
  const r  = riskPips(t.entry, t.stopLoss, t.direction)
  const w  = rewardPips(t.entry, t.takeProfit, t.direction)
  const rr = r > 0 ? w / r : 0

  const chips: { label: string; color: string; note: string }[] = []

  if (t.rafi !== undefined) {
    const rafiColor = t.rafi >= 2.5 ? C.teal : t.rafi >= 1 ? C.sub : C.muted
    chips.push({
      label: `RAFI ${t.rafi.toFixed(1)}${t.rafi >= 2.5 ? ' ✓' : ''}`,
      color: rafiColor,
      note: t.rafi >= 2.5
        ? 'Força forte — padrão ideal (feature ML: rafiStrong=1)'
        : 'Força moderada/baixa — dado registrado para o ML correlacionar com resultado',
    })
  }

  if (rr >= 2)
    chips.push({ label: `R:R ${rr.toFixed(1)}×`, color: C.teal, note: `R:R ${rr.toFixed(2)} — favorável` })
  else if (rr >= 1.5)
    chips.push({ label: `R:R ${rr.toFixed(1)}×`, color: C.blue, note: `R:R ${rr.toFixed(2)} — acima da meta 1.5×` })
  else if (rr > 0)
    chips.push({ label: `R:R ${rr.toFixed(1)}×`, color: C.sub, note: `R:R ${rr.toFixed(2)} — abaixo de 1.5×` })

  if (t.rafiDir) {
    const aligned = (t.direction === 'buy' && t.rafiDir === 'bull') || (t.direction === 'sell' && t.rafiDir === 'bear')
    chips.push({
      label: aligned ? 'RAFI alinhado' : 'RAFI diverge',
      color: aligned ? C.teal : C.sub,
      note: aligned ? 'Candle e RAFI na mesma direção' : 'Diverge — price action tem prioridade',
    })
  }

  if (t.bbWidth !== undefined) {
    chips.push(t.bbWidth > 0.0015
      ? { label: 'BB aberto', color: C.teal, note: 'Bollinger expandindo' }
      : { label: 'BB estreito', color: C.sub, note: 'Bollinger comprimido' }
    )
  }

  if (!chips.length && !t.snapshot) return null

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2.5 border-b" style={{ borderColor: C.card2 }}>
      {t.snapshot && (
        <button onClick={() => onSnapClick?.(t.snapshot!)} title="Clique para ampliar"
          style={{ flexShrink: 0, marginRight: 6, padding: 0, border: 'none', background: 'none', cursor: 'zoom-in' }}>
          <img src={t.snapshot} alt="gráfico" style={{
            width: 120, height: 40, borderRadius: 4, border: `1px solid ${C.border}`,
            objectFit: 'cover', opacity: 0.85, display: 'block', transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '0.85')} />
        </button>
      )}
      {chips.length > 0 && <span className="text-[8px] mr-1 uppercase tracking-wider shrink-0" style={{ color: C.muted }}>feat →</span>}
      {chips.map((c, i) => (
        <span key={i} title={c.note} style={{ background: `${c.color}12`, border: `1px solid ${c.color}35`, color: c.color }}
          className="text-[8px] px-1.5 py-0.5 rounded font-mono cursor-help">
          {c.label}
        </span>
      ))}
    </div>
  )
}

// ── Trade recente ─────────────────────────────────────────────────────────────
function TradeRow({ t, onLabel, onSnapClick }: {
  t: ManualTrade; onLabel?: (id: string, r: 'win' | 'loss') => void; onSnapClick?: (src: string) => void
}) {
  const r       = riskPips(t.entry, t.stopLoss, t.direction)
  const w       = rewardPips(t.entry, t.takeProfit, t.direction)
  const rr      = r > 0 ? (w / r).toFixed(1) : '—'
  const gainUSD = w * pipValueUSD(t.lot)
  const riskUSD = r * pipValueUSD(t.lot)
  const dt      = new Date(t.time * 1000)
  const ds      = `${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  const isPending = !t.result || t.result === 'pending'

  return (
    <div style={{
      background: t.result === 'win' ? `${C.teal}08` : t.result === 'loss' ? `${C.rose}08` : 'transparent',
    }}>
      <div className="flex items-center gap-2 px-4 py-2 text-xs font-mono">
        <span className="w-24 shrink-0" style={{ color: C.muted }}>{ds}</span>
        {t.direction === 'buy'
          ? <span className="flex items-center gap-1 w-12 shrink-0" style={{ color: C.blue }}><TrendingUp size={10} />BUY</span>
          : <span className="flex items-center gap-1 w-12 shrink-0" style={{ color: C.gold }}><TrendingDown size={10} />SELL</span>
        }
        <span className="w-20 shrink-0" style={{ color: C.text }}>{t.entry.toFixed(5)}</span>
        <span className="w-14 text-right shrink-0 font-bold" style={{ color: C.teal }}>+${gainUSD.toFixed(0)}</span>
        <span className="w-14 text-right shrink-0" style={{ color: C.rose }}>-${riskUSD.toFixed(0)}</span>
        <span className="w-9 text-right shrink-0 font-bold" style={{
          color: parseFloat(rr) >= 1.5 ? C.teal : parseFloat(rr) >= 1 ? C.gold : C.rose
        }}>{rr}×</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {isPending && onLabel ? (
            <>
              <button onClick={() => onLabel(t.id, 'win')}
                className="px-2 py-0.5 rounded text-[9px] font-bold transition-colors cursor-pointer"
                style={{ background: `${C.teal}20`, color: C.teal, border: `1px solid ${C.teal}40` }}>WIN</button>
              <button onClick={() => onLabel(t.id, 'loss')}
                className="px-2 py-0.5 rounded text-[9px] font-bold transition-colors cursor-pointer"
                style={{ background: `${C.rose}20`, color: C.rose, border: `1px solid ${C.rose}40` }}>LOSS</button>
            </>
          ) : t.result === 'win' ? (
            <span className="px-1.5 py-0.5 rounded text-[9px]"
              style={{ background: `${C.teal}18`, color: C.teal, border: `1px solid ${C.teal}30` }}>WIN</span>
          ) : t.result === 'loss' ? (
            <span className="px-1.5 py-0.5 rounded text-[9px]"
              style={{ background: `${C.rose}18`, color: C.rose, border: `1px solid ${C.rose}30` }}>LOSS</span>
          ) : null}
        </div>
      </div>
      <MLChips t={t} onSnapClick={onSnapClick} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

const getLot = getLotForCapital

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

function ExpChart({ pts1, pts2, pts3, height = 120 }: {
  pts1: number[]; pts2: number[]; pts3: number[]; height?: number
}) {
  const W = 500, H = height
  const allVals = [...pts1, ...pts2, ...pts3].filter(v => v > 0)
  const logMin  = Math.log10(Math.max(1, Math.min(...allVals)))
  const logMax  = Math.log10(Math.max(...allVals, 1))
  const rng     = logMax - logMin || 1
  const n       = pts1.length
  const toY = (v: number) => {
    const safe = Math.max(1, v)
    return H - ((Math.log10(safe) - logMin) / rng) * (H - 16) - 8
  }
  const toX = (i: number) => (i / (n - 1)) * W
  const makePath = (pts: number[]) =>
    pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')

  const gridLines = [1_000, 10_000, 100_000, 300_000].filter(v => {
    const y = toY(v); return y > 4 && y < H - 4
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      {gridLines.map(v => (
        <g key={v}>
          <line x1="0" y1={toY(v)} x2={W} y2={toY(v)} stroke={C.border} strokeWidth="1" strokeDasharray="3 3" />
          <text x="4" y={toY(v) - 3} fill={C.muted} fontSize="8" fontFamily="monospace">{fmtK(v)}</text>
        </g>
      ))}
      <path d={makePath(pts3)} fill="none" stroke={C.rose} strokeWidth="1.5" strokeDasharray="5 3" opacity="0.6" />
      <path d={makePath(pts2)} fill="none" stroke={C.gold} strokeWidth="2" />
      <path d={makePath(pts1)} fill="none" stroke={C.teal} strokeWidth="2.5" />
      <circle cx={toX(n - 1)} cy={toY(pts1[n - 1])} r="4"   fill={C.teal} />
      <circle cx={toX(n - 1)} cy={toY(pts2[n - 1])} r="3.5" fill={C.gold} />
      <circle cx={toX(n - 1)} cy={toY(pts3[n - 1])} r="3"   fill={C.rose} />
    </svg>
  )
}

// ── Simulador de crescimento exponencial ─────────────────────────────────────
function LotScalingWidget({ trades }: { trades: ManualTrade[] }) {
  const [winRate, setWinRate] = useState(60)
  const N_SIM = 200

  const avgRiskP = useMemo(() => {
    if (!trades.length) return 5
    return trades.reduce((s, t) => s + riskPips(t.entry, t.stopLoss, t.direction), 0) / trades.length
  }, [trades])

  const avgRewardP = useMemo(() => {
    if (!trades.length) return 7.5
    return trades.reduce((s, t) => s + rewardPips(t.entry, t.takeProfit, t.direction), 0) / trades.length
  }, [trades])

  const simulate = useCallback((wr: number): number[] => {
    const pts = [100]
    let c = 100
    const period = 100
    const wins   = Math.round(wr)
    for (let i = 0; i < N_SIM; i++) {
      const lot   = getLot(c)
      const isWin = (i % period) < wins
      c = Math.max(0, c + (isWin ? avgRewardP * lot * 10 : -(avgRiskP * lot * 10)))
      pts.push(c)
      if (c <= 0) { for (let j = pts.length; j <= N_SIM; j++) pts.push(0); break }
    }
    return pts
  }, [avgRiskP, avgRewardP])

  const pt70 = useMemo(() => simulate(70), [simulate])
  const pt60 = useMemo(() => simulate(60), [simulate])
  const pt50 = useMemo(() => simulate(50), [simulate])

  const tradesTo300k = useMemo(() => {
    const pts = simulate(winRate)
    const idx = pts.findIndex(v => v >= 300_000)
    return idx === -1 ? null : idx
  }, [simulate, winRate])

  const currentPts = useMemo(() => simulate(winRate), [simulate, winRate])
  const finalCap   = currentPts[currentPts.length - 1]

  return (
    <div className="rounded-xl p-5 space-y-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Layers size={14} style={{ color: C.gold }} />
          <div>
            <span className="text-sm font-semibold" style={{ color: C.text }}>Escalonamento Exponencial de Lote</span>
            <span className="ml-2 text-[9px]" style={{ color: C.muted }}>$100 → $300k · EURUSD</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] mr-1" style={{ color: C.muted }}>Win rate:</span>
          {[50, 60, 70].map(w => (
            <button key={w} onClick={() => setWinRate(w)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
              style={winRate === w
                ? { background: `${C.blue}20`, border: `1px solid ${C.blue}50`, color: C.blue }
                : { border: `1px solid ${C.border}`, color: C.muted }}>
              {w}%
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: `Capital após ${N_SIM} trades`, val: fmtK(finalCap), sub: `com ${winRate}% win rate`,
            color: finalCap >= 300_000 ? C.teal : finalCap > 100 ? C.gold : C.rose },
          { label: 'Trades p/ $300k', val: tradesTo300k ? String(tradesTo300k) : '> ' + N_SIM,
            sub: tradesTo300k ? `≈ ${Math.ceil(tradesTo300k / 3)} dias (3/dia)` : 'não atingido',
            color: tradesTo300k ? C.teal : C.rose },
          { label: 'Lote atual ($100)', val: `${getLotForCapital(100).toFixed(2)}L`,
            sub: `+$${(avgRewardP * getLotForCapital(100) * 10).toFixed(0)}/WIN · -$${(avgRiskP * getLotForCapital(100) * 10).toFixed(0)}/LOSS`,
            color: C.gold },
        ].map(item => (
          <div key={item.label} className="rounded-lg p-3 text-center" style={{ background: C.bg }}>
            <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>{item.label}</div>
            <div className="text-xl font-black font-mono" style={{ color: item.color }}>{item.val}</div>
            <div className="text-[8px] mt-0.5" style={{ color: C.muted }}>{item.sub}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[8px] uppercase tracking-wider border-b" style={{ color: C.muted, borderColor: C.border }}>
              <th className="text-left py-2 pr-3 font-medium">Capital</th>
              <th className="text-right py-2 px-2 font-medium">Lote</th>
              <th className="text-right py-2 px-2 font-medium" style={{ color: C.teal }}>WIN/trade</th>
              <th className="text-right py-2 px-2 font-medium" style={{ color: C.rose }}>LOSS/trade</th>
              <th className="text-right py-2 px-2 font-medium">% risco</th>
              <th className="text-right py-2 pl-2 font-medium">EV/trade</th>
            </tr>
          </thead>
          <tbody>
            {SCALE_TIERS.map((tier, i) => {
              const gain    = avgRewardP * tier.lot * 10
              const loss    = avgRiskP   * tier.lot * 10
              const midCap  = i + 1 < SCALE_TIERS.length
                ? (tier.minCap + SCALE_TIERS[i + 1].minCap) / 2
                : tier.minCap * 1.5
              const refCap  = Math.max(tier.minCap || 100, midCap)
              const pctRisk = (loss / refCap) * 100
              const ev      = (winRate / 100) * gain - ((100 - winRate) / 100) * loss
              const isActive = finalCap >= tier.minCap && (i + 1 >= SCALE_TIERS.length || finalCap < SCALE_TIERS[i + 1].minCap)
              return (
                <tr key={tier.minCap} className="border-b" style={{ borderColor: `${C.border}66`, background: isActive ? `${C.gold}0a` : 'transparent' }}>
                  <td className="py-1.5 pr-3">
                    <span className="font-bold" style={{ color: isActive ? C.gold : C.sub }}>
                      {SCALE_TIER_LABELS[i]}
                    </span>
                    {isActive && (
                      <span className="ml-1.5 text-[8px] px-1 py-px rounded"
                        style={{ background: `${C.gold}25`, color: C.gold }}>AGORA</span>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right font-bold" style={{ color: C.text }}>{tier.lot.toFixed(2)}L</td>
                  <td className="py-1.5 px-2 text-right font-bold" style={{ color: C.teal }}>+${gain.toFixed(0)}</td>
                  <td className="py-1.5 px-2 text-right" style={{ color: C.rose }}>-${loss.toFixed(0)}</td>
                  <td className="py-1.5 px-2 text-right" style={{
                    color: pctRisk > 50 ? C.rose : pctRisk > 20 ? C.gold : C.sub
                  }}>{pctRisk.toFixed(0)}%</td>
                  <td className="py-1.5 pl-2 text-right font-bold" style={{ color: ev >= 0 ? C.teal : C.rose }}>
                    {ev >= 0 ? '+' : ''}${ev.toFixed(0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>
            Projeção — {N_SIM} trades · escala logarítmica
          </span>
          <div className="flex items-center gap-4 text-[9px]" style={{ color: C.muted }}>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block" style={{ background: C.teal }} />70%</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block" style={{ background: C.gold }} />60%</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block" style={{ background: C.rose }} />50%</span>
          </div>
        </div>
        <div className="rounded-lg px-3 py-2" style={{ background: C.bg }}>
          <ExpChart pts1={pt70} pts2={pt60} pts3={pt50} height={120} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[9px] font-mono mt-1">
          <span style={{ color: C.teal }}>70%: {fmtK(pt70[pt70.length - 1])}</span>
          <span className="text-center" style={{ color: C.gold }}>60%: {fmtK(pt60[pt60.length - 1])}</span>
          <span className="text-right" style={{ color: C.rose }}>50%: {fmtK(pt50[pt50.length - 1])}</span>
        </div>
      </div>
    </div>
  )
}

// ── Helpers de P&L por trade ──────────────────────────────────────────────────
function calcTradePnl(t: ManualTrade): number {
  if (t.result === 'win') {
    if (t.pnlUsd != null) return t.pnlUsd
    return rewardPips(t.entry, t.takeProfit, t.direction) * pipValueUSD(t.lot)
  }
  if (t.result === 'loss') {
    if (t.pnlUsd != null) return t.pnlUsd
    return -(riskPips(t.entry, t.stopLoss, t.direction) * pipValueUSD(t.lot))
  }
  return 0
}

// ── Lógica de gate/bloqueio de sessão ────────────────────────────────────────
function computeSessionGate(trades: ManualTrade[], cfg: SessionConfig) {
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const utcMin    = now.getUTCHours() * 60 + now.getUTCMinutes()

  const [sh, sm] = cfg.sessionStartUTC.split(':').map(Number)
  const [eh, em] = cfg.sessionEndUTC.split(':').map(Number)
  const sessionStartMin = sh * 60 + sm
  const sessionEndMin   = eh * 60 + em

  const isDayAllowed  = cfg.tradingDays.includes(dayOfWeek)
  const isTimeAllowed = utcMin >= sessionStartMin && utcMin < sessionEndMin

  // P&L de hoje (UTC)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayTs = todayStart.getTime() / 1000

  const todayTrades = trades.filter(t => t.time >= todayTs && (t.result === 'win' || t.result === 'loss'))
  const todayPnl = todayTrades.reduce((acc, t) => acc + calcTradePnl(t), 0)

  // P&L da semana (segunda-feira UTC)
  const weekStart = new Date()
  const dow = weekStart.getUTCDay()
  weekStart.setUTCDate(weekStart.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  weekStart.setUTCHours(0, 0, 0, 0)
  const weekTs = weekStart.getTime() / 1000

  const weekTrades = trades.filter(t => t.time >= weekTs && (t.result === 'win' || t.result === 'loss'))
  const weekPnl = weekTrades.reduce((acc, t) => acc + calcTradePnl(t), 0)

  // P&L do mês (1º do mês UTC)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthTs = monthStart.getTime() / 1000

  const monthTrades = trades.filter(t => t.time >= monthTs && (t.result === 'win' || t.result === 'loss'))
  const monthPnl = monthTrades.reduce((acc, t) => acc + calcTradePnl(t), 0)

  // Capital inicial para cálculo de drawdown semanal
  const capitalInicial = trades.find(t => t.capitalInicial != null)?.capitalInicial ?? cfg.capitalInicial
  const weekDrawdownPct = weekPnl < 0 ? Math.abs(weekPnl) / capitalInicial * 100 : 0

  // Perdas consecutivas (trades mais recentes primeiro)
  let consecutiveLosses = 0
  const decided = [...trades].filter(t => t.result === 'win' || t.result === 'loss').reverse()
  for (const t of decided) {
    if (t.result === 'loss') consecutiveLosses++
    else break
  }

  const lossGate      = consecutiveLosses >= cfg.maxConsecutiveLosses
  const drawdownGate  = weekDrawdownPct >= cfg.maxWeeklyDrawdownPct
  const dailyGoalMet  = todayPnl >= cfg.dailyGoal

  let isLocked = false
  let lockReason = ''

  if (!isDayAllowed) { isLocked = true; lockReason = 'Dia não permitido' }
  else if (!isTimeAllowed) { isLocked = true; lockReason = 'Fora da janela de sessão' }
  else if (lossGate) { isLocked = true; lockReason = `${cfg.maxConsecutiveLosses} perdas seguidas — pare` }
  else if (drawdownGate) { isLocked = true; lockReason = `Drawdown semanal ≥ ${cfg.maxWeeklyDrawdownPct}%` }

  return {
    isLocked, lockReason,
    isDayAllowed, isTimeAllowed,
    consecutiveLosses, lossGate,
    dailyGoalMet, drawdownGate,
    todayPnl, weekPnl, monthPnl, weekDrawdownPct,
  }
}
type SessionGate = ReturnType<typeof computeSessionGate>

// ── Jornada de Capital — arco logarítmico ─────────────────────────────────────
function CapitalJourney({ capitalAtual, cfg }: { capitalAtual: number; cfg: SessionConfig }) {
  const CX = 200, CY = 180, R = 150
  const arcLen = Math.PI * R

  const logMin = Math.log10(Math.max(cfg.capitalInicial, 1))
  const logMax = Math.log10(cfg.capitalTarget)
  const clamp  = Math.max(cfg.capitalInicial, Math.min(capitalAtual, cfg.capitalTarget))
  const progress = (Math.log10(clamp) - logMin) / (logMax - logMin)

  const filled  = progress * arcLen
  const dashArr = `${filled.toFixed(2)} ${(arcLen - filled + 2).toFixed(2)}`

  const posOnArc = (pct: number) => {
    const rad = ((1 - pct) * Math.PI)
    return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) }
  }

  const milestones = [
    { cap: 1_000,   label: '$1k' },
    { cap: 10_000,  label: '$10k' },
    { cap: 100_000, label: '$100k' },
  ].map(m => ({
    ...m,
    pct: (Math.log10(m.cap) - logMin) / (logMax - logMin),
  }))

  const curPos = posOnArc(progress)

  const fmtMoney = (v: number) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`
    return `$${v.toFixed(2)}`
  }

  const color = progress < 0.25 ? C.gold : progress < 0.75 ? C.blue : C.teal

  return (
    <div className="rounded-xl p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Target size={14} style={{ color: C.gold }} />
          <span className="text-sm font-semibold" style={{ color: C.text }}>Jornada de Capital</span>
        </div>
        <span className="text-[10px]" style={{ color: C.muted }}>escala logarítmica · $100 → $1M</span>
      </div>

      <div className="flex items-baseline justify-center gap-2 mb-1">
        <span className="text-3xl font-black font-mono" style={{ color }}>{fmtMoney(capitalAtual)}</span>
        <span className="text-sm font-mono" style={{ color: C.sub }}>{(progress * 100).toFixed(1)}% da jornada</span>
      </div>

      <svg viewBox="0 0 400 200" className="w-full" style={{ maxHeight: 170 }}>
        <path d="M 50,180 A 150,150 0 0 0 350,180" fill="none" stroke={C.card2} strokeWidth="14" strokeLinecap="round" />
        <path d="M 50,180 A 150,150 0 0 0 350,180" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round"
          strokeDasharray={dashArr} strokeDashoffset="0" style={{ transition: 'stroke-dasharray 1s ease' }} />

        {milestones.map(m => {
          const pos = posOnArc(m.pct)
          const adjY = pos.y - 10
          const reached = progress >= m.pct
          return (
            <g key={m.label}>
              <circle cx={pos.x} cy={adjY} r="7" fill={reached ? C.teal : C.card2} stroke={reached ? C.teal : C.muted} strokeWidth="2" />
              <text x={pos.x} y={adjY - 13} textAnchor="middle" fill={reached ? C.teal : C.muted}
                fontSize="11" fontFamily="monospace" fontWeight={reached ? '700' : '400'}>
                {m.label}
              </text>
            </g>
          )
        })}

        <circle cx={curPos.x} cy={curPos.y - 10} r="10" fill={color} stroke={C.bg} strokeWidth="3" />

        <text x="50" y="198" textAnchor="middle" fill={C.muted} fontSize="10" fontFamily="monospace">
          ${cfg.capitalInicial}
        </text>
        <text x="350" y="198" textAnchor="middle" fill={C.muted} fontSize="10" fontFamily="monospace">
          {fmtMoney(cfg.capitalTarget)}
        </text>
      </svg>
    </div>
  )
}

// ── Cockpit de Sessão ─────────────────────────────────────────────────────────
function SessionCockpit({ gate, cfg }: { gate: SessionGate; cfg: SessionConfig }) {
  const dailyPct = gate.todayPnl <= 0 ? 0 : Math.min((gate.todayPnl / cfg.dailyGoal) * 100, 100)
  const nowUtc   = new Date()
  const timeStr  = `${String(nowUtc.getUTCHours()).padStart(2,'0')}:${String(nowUtc.getUTCMinutes()).padStart(2,'0')} UTC`

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-xl p-4" style={{
        background: C.card,
        border: `1px solid ${gate.isLocked ? C.rose + '50' : C.teal + '40'}`,
      }}>
        <div className="flex items-center gap-1.5 mb-2">
          {gate.isLocked
            ? <Lock size={11} style={{ color: C.rose }} />
            : <Radio size={11} style={{ color: C.teal }} />
          }
          <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Sessão</span>
        </div>
        <div className="text-xl font-black font-mono" style={{ color: gate.isLocked ? C.rose : C.teal }}>
          {gate.isLocked ? 'BLOQ' : 'OPEN'}
        </div>
        <div className="text-[9px] mt-1" style={{ color: gate.isLocked ? C.rose : C.teal + 'bb' }}>
          {gate.isLocked ? gate.lockReason : timeStr}
        </div>
        {!gate.isLocked && (
          <div className="text-[8px] mt-0.5" style={{ color: C.muted }}>
            {cfg.sessionStartUTC}–{cfg.sessionEndUTC} UTC
          </div>
        )}
      </div>

      <div className="rounded-xl p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-1.5 mb-2">
          <Target size={11} style={{ color: C.blue }} />
          <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Meta Diária</span>
        </div>
        <div className="text-xl font-black font-mono" style={{ color: gate.dailyGoalMet ? C.teal : C.text }}>
          {gate.todayPnl >= 0 ? '+' : ''}${gate.todayPnl.toFixed(2)}
        </div>
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: C.card2 }}>
          <div className="h-full rounded-full transition-all duration-700" style={{
            width: `${dailyPct}%`, background: gate.dailyGoalMet ? C.teal : C.blue,
          }} />
        </div>
        <div className="text-[9px] mt-1" style={{ color: C.muted }}>
          meta ${cfg.dailyGoal.toFixed(2)}{gate.dailyGoalMet ? ' ✓' : ''}
        </div>
      </div>

      <div className="rounded-xl p-4" style={{
        background: C.card,
        border: `1px solid ${gate.lossGate ? C.rose + '50' : C.border}`,
      }}>
        <div className="flex items-center gap-1.5 mb-2">
          <AlertTriangle size={11} style={{ color: gate.lossGate ? C.rose : gate.consecutiveLosses > 0 ? C.gold : C.muted }} />
          <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Perdas Seq.</span>
        </div>
        <div className="text-xl font-black font-mono" style={{
          color: gate.lossGate ? C.rose : gate.consecutiveLosses > 0 ? C.gold : C.teal
        }}>
          {gate.consecutiveLosses}/{cfg.maxConsecutiveLosses}
        </div>
        <div className="flex gap-1 mt-2">
          {Array.from({ length: cfg.maxConsecutiveLosses }).map((_, i) => (
            <div key={i} className="flex-1 h-1.5 rounded-full"
              style={{ background: i < gate.consecutiveLosses ? C.rose : C.card2 }} />
          ))}
        </div>
        <div className="text-[9px] mt-1" style={{ color: gate.lossGate ? C.rose : C.muted }}>
          {gate.lossGate ? 'Pare agora' : `${cfg.maxConsecutiveLosses - gate.consecutiveLosses} restante(s)`}
        </div>
      </div>
    </div>
  )
}

// ── Painel de Risco ───────────────────────────────────────────────────────────
function RiskPanel({ gate, cfg }: { gate: SessionGate; cfg: SessionConfig }) {
  const gaugeProgress = Math.min(gate.weekDrawdownPct / cfg.maxWeeklyDrawdownPct, 1)
  const R = 44
  const arcLen = Math.PI * R
  const filledLen = gaugeProgress * arcLen
  const gaugeColor = gate.drawdownGate ? C.rose : gaugeProgress > 0.6 ? C.gold : C.teal

  const nowDay = new Date().getUTCDay()
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes()
  const [sh, sm] = cfg.sessionStartUTC.split(':').map(Number)
  const [eh, em] = cfg.sessionEndUTC.split(':').map(Number)
  const sessStartMin = sh * 60 + sm, sessEndMin = eh * 60 + em

  const DAY_LABELS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

  return (
    <div className="rounded-xl p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center gap-2 mb-4">
        <Shield size={14} style={{ color: C.blue }} />
        <span className="text-sm font-semibold" style={{ color: C.text }}>Gestão de Risco</span>
      </div>

      <div className="grid grid-cols-2 gap-5 items-start">
        <div className="flex flex-col items-center">
          <span className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Drawdown Semanal</span>
          <svg viewBox="0 0 120 90" className="w-32">
            <path d="M 16,76 A 44,44 0 0 1 104,76" fill="none" stroke={C.card2} strokeWidth="12" strokeLinecap="round" />
            <path d="M 16,76 A 44,44 0 0 1 104,76" fill="none" stroke={gaugeColor} strokeWidth="12" strokeLinecap="round"
              strokeDasharray={`${filledLen.toFixed(1)} ${(arcLen - filledLen + 2).toFixed(1)}`}
              style={{ transition: 'stroke-dasharray 0.8s ease' }} />
            <text x="60" y="66" textAnchor="middle" fill={C.text} fontSize="18" fontFamily="monospace" fontWeight="900">
              {gate.weekDrawdownPct.toFixed(0)}%
            </text>
            <text x="60" y="80" textAnchor="middle" fill={C.muted} fontSize="9" fontFamily="monospace">
              /{cfg.maxWeeklyDrawdownPct}% max
            </text>
          </svg>
          {gate.weekPnl < 0 && (
            <div className="text-[9px] font-mono" style={{ color: C.rose }}>
              -{Math.abs(gate.weekPnl).toFixed(2)} esta semana
            </div>
          )}
        </div>

        <div>
          <span className="text-[9px] uppercase tracking-wider block mb-2" style={{ color: C.muted }}>Agenda</span>
          <div className="grid grid-cols-7 gap-0.5 mb-3">
            {[0,1,2,3,4,5,6].map(d => {
              const allowed  = cfg.tradingDays.includes(d)
              const isToday  = d === nowDay
              const isActive = isToday && allowed && nowMin >= sessStartMin && nowMin < sessEndMin
              return (
                <div key={d} className="aspect-square rounded text-[9px] font-bold flex items-center justify-center" style={
                  isActive  ? { background: C.teal, color: C.bg } :
                  isToday && allowed ? { background: `${C.teal}25`, color: C.teal, border: `1px solid ${C.teal}50` } :
                  allowed   ? { background: C.card2, color: C.sub } :
                               { background: C.bg, color: C.border }
                }>{DAY_LABELS[d]}</div>
              )
            })}
          </div>
          <div className="space-y-1.5 text-[9px]" style={{ color: C.muted }}>
            <div className="flex items-center gap-1.5">
              <Clock size={9} />
              {cfg.sessionStartUTC}–{cfg.sessionEndUTC} UTC
            </div>
            <div className="flex items-center gap-1.5" style={{
              color: gate.isTimeAllowed && gate.isDayAllowed ? C.teal : C.muted
            }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                background: gate.isTimeAllowed && gate.isDayAllowed ? C.teal : C.border,
              }} />
              {gate.isTimeAllowed && gate.isDayAllowed ? 'Janela ativa agora' : 'Fora da janela'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Metas em Cascata ──────────────────────────────────────────────────────────
function GoalsCascade({ gate, cfg, capitalAtual }: { gate: SessionGate; cfg: SessionConfig; capitalAtual: number }) {
  const logMin = Math.log10(Math.max(cfg.capitalInicial, 1))
  const logMax = Math.log10(cfg.capitalTarget)

  const goals = [
    { label: 'Hoje',       value: gate.todayPnl,  target: cfg.dailyGoal,   color: C.blue,
      pct: gate.todayPnl <= 0 ? 0 : Math.min(gate.todayPnl / cfg.dailyGoal * 100, 100) },
    { label: 'Semana',     value: gate.weekPnl,   target: cfg.weeklyGoal,  color: C.teal,
      pct: gate.weekPnl  <= 0 ? 0 : Math.min(gate.weekPnl  / cfg.weeklyGoal  * 100, 100) },
    { label: 'Mês',        value: gate.monthPnl,  target: cfg.monthlyGoal, color: C.gold,
      pct: gate.monthPnl <= 0 ? 0 : Math.min(gate.monthPnl / cfg.monthlyGoal * 100, 100) },
    { label: 'Meta Final', value: capitalAtual,   target: cfg.capitalTarget, color: '#a855f7', isCapital: true,
      pct: ((Math.log10(Math.max(capitalAtual, cfg.capitalInicial)) - logMin) / (logMax - logMin)) * 100 },
  ]

  const fmtVal = (v: number, isCapital?: boolean) => {
    if (isCapital) {
      if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`
      if (v >= 1_000)     return `$${(v/1_000).toFixed(1)}k`
      return `$${v.toFixed(2)}`
    }
    return (v >= 0 ? '+' : '') + `$${v.toFixed(2)}`
  }
  const fmtTgt = (v: number) => {
    if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(0)}M`
    if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}k`
    return `$${v.toFixed(2)}`
  }

  return (
    <div className="rounded-xl p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center gap-2 mb-4">
        <Award size={14} style={{ color: C.teal }} />
        <span className="text-sm font-semibold" style={{ color: C.text }}>Metas em Cascata</span>
      </div>

      <div className="space-y-4">
        {goals.map(g => {
          const met = g.pct >= 100
          return (
            <div key={g.label}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px]" style={{ color: C.sub }}>{g.label}</span>
                <span className="text-[10px] font-mono" style={{ color: met ? C.teal : g.color }}>
                  {fmtVal(g.value, (g as any).isCapital)} / {fmtTgt(g.target)}{met ? ' ✓' : ''}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.card2 }}>
                <div className="h-full rounded-full transition-all duration-700" style={{
                  width: `${Math.max(0, g.pct).toFixed(1)}%`,
                  background: met ? C.teal : g.color,
                  opacity: g.pct <= 0 ? 0.3 : 1,
                }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [trades,         setTrades]         = useState<ManualTrade[]>([])
  const [mounted,        setMounted]        = useState(false)
  const [activeSnap,     setActiveSnap]     = useState<string | null>(null)
  const [importMsg,      setImportMsg]      = useState<{ text: string; ok: boolean } | null>(null)
  const [sessionConfig,  setSessionConfig]  = useState<SessionConfig>(SESSION_DEFAULTS)
  const [tick,           setTick]           = useState(0)
  const [metaAccount,    setMetaAccount]    = useState<{ balance: number; equity: number; freeMargin: number; updatedAt?: string } | null>(null)
  const [metaLoading,    setMetaLoading]    = useState(false)
  const [todayPnlMeta,   setTodayPnlMeta]  = useState<number | null>(null)
  const [configOpen,     setConfigOpen]     = useState(false)
  const [cfgDraft,       setCfgDraft]       = useState<SessionConfig>(SESSION_DEFAULTS)
  const importRef                           = useRef<HTMLInputElement>(null)

  // Injeta fontes premium via Google Fonts
  useEffect(() => {
    if (document.getElementById('rafi-fonts')) return
    const link = document.createElement('link')
    link.id   = 'rafi-fonts'
    link.rel  = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600;700&display=swap'
    document.head.appendChild(link)
  }, [])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const fetchAccount = async () => {
      setMetaLoading(true)
      try {
        const res = await fetch('/api/metaapi/account')
        if (res.ok) {
          const data = await res.json()
          setMetaAccount({
            balance:    data.balance    ?? 0,
            equity:     data.equity     ?? 0,
            freeMargin: data.freeMargin ?? 0,
            updatedAt:  data.updatedAt,
          })
        }
      } catch {}
      setMetaLoading(false)
    }
    const fetchTodayHistory = async () => {
      try {
        const res = await fetch('/api/metaapi/history?period=today')
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.history)) {
            const total = (data.history as { profit: number }[]).reduce((s, d) => s + (d.profit ?? 0), 0)
            setTodayPnlMeta(total)
          }
        }
      } catch {}
    }
    fetchAccount()
    fetchTodayHistory()
    const id = setInterval(() => { fetchAccount(); fetchTodayHistory() }, 60_000)
    return () => clearInterval(id)
  }, [mounted])

  useEffect(() => {
    setMounted(true)
    setSessionConfig(getSessionConfig())
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setTrades(parsed)
      }
    } catch {}
    fetchTrades()
      .then(data => {
        if (data.length > 0) {
          setTrades(data)
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch {}
        }
      })
      .catch((err) => console.error('[Supabase] fetchTrades:', err))
  }, [])

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        if (!Array.isArray(parsed)) throw new Error('JSON deve ser um array')
        const valid = parsed.filter((t: any) =>
          t && typeof t.id === 'string' && typeof t.direction === 'string' && typeof t.entry === 'number'
        ) as ManualTrade[]
        if (!valid.length) throw new Error('Nenhum trade válido encontrado')
        const merged = [...trades]
        const existingIds = new Set(merged.map(t => t.id))
        let added = 0
        for (const t of valid) {
          if (!existingIds.has(t.id)) { merged.push(t); added++ }
        }
        setTrades(merged)
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)) } catch {}
        const newTrades = valid.filter(t => !existingIds.has(t.id))
        if (newTrades.length > 0) upsertTrades(newTrades).catch(() => {})
        setImportMsg({ text: `${added} trades importados (${valid.length - added} duplicatas ignoradas)`, ok: true })
      } catch (err: any) {
        setImportMsg({ text: `Erro: ${err.message}`, ok: false })
      }
      setTimeout(() => setImportMsg(null), 5000)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleLabel = (id: string, result: 'win' | 'loss') => {
    const updated = trades.map(t => t.id === id ? { ...t, result } : t)
    setTrades(updated)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
    updateTradeResult(id, result).catch(() => {})
  }

  const wins    = trades.filter(t => t.result === 'win').length
  const losses  = trades.filter(t => t.result === 'loss').length
  const pending = trades.filter(t => !t.result || t.result === 'pending').length
  const decided = wins + losses
  const winRate = decided > 0 ? Math.round(wins / decided * 100) : null

  const pnl = useMemo(() => trades.reduce((acc, t) => {
    if (t.result === 'win') {
      if (t.pnlUsd != null) return acc + t.pnlUsd
      return acc + rewardPips(t.entry, t.takeProfit, t.direction) * pipValueUSD(t.lot)
    }
    if (t.result === 'loss') {
      if (t.pnlUsd != null) return acc + t.pnlUsd
      return acc - riskPips(t.entry, t.stopLoss, t.direction) * pipValueUSD(t.lot)
    }
    return acc
  }, 0), [trades])

  const capitalInicial = useMemo(
    () => trades.find(t => t.capitalInicial != null)?.capitalInicial ?? 0,
    [trades]
  )
  const capitalFinal = pnl + capitalInicial

  const capitalParaJornada = metaAccount
    ? metaAccount.balance
    : (capitalInicial > 0 ? capitalFinal : sessionConfig.capitalInicial + pnl)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gate = useMemo(() => computeSessionGate(trades, sessionConfig), [trades, sessionConfig, tick])

  const pnlPotential = useMemo(() => trades
    .filter(t => !t.result || t.result === 'pending')
    .reduce((acc, t) => acc + rewardPips(t.entry, t.takeProfit, t.direction) * pipValueUSD(t.lot), 0),
  [trades])

  const avgRR = useMemo(() => {
    const valid = trades.filter(t => riskPips(t.entry, t.stopLoss, t.direction) > 0)
    if (!valid.length) return null
    const sum = valid.reduce((acc, t) => {
      const r = riskPips(t.entry, t.stopLoss, t.direction)
      const w = rewardPips(t.entry, t.takeProfit, t.direction)
      return acc + w / r
    }, 0)
    return (sum / valid.length).toFixed(1)
  }, [trades])

  const rafiStrong = trades.filter(t => (t.rafi ?? 0) >= 2.5).length
  const recent = [...trades].reverse().slice(0, 8)

  // P&L do dia: prioriza MetaAPI (trades reais Pepperstone); cai para cálculo manual
  const todayPnl = todayPnlMeta ?? gate.todayPnl

  // Percentual do dia (relativo ao capital no início do dia)
  const capitalStartOfDay = capitalParaJornada - todayPnl
  const todayPct = capitalStartOfDay > 0 ? (todayPnl / capitalStartOfDay) * 100 : 0

  const heroColor    = todayPnl >= 0 ? C.teal : C.rose
  const winRateColor = winRate === null ? C.text : winRate >= 60 ? C.teal : winRate >= 50 ? C.gold : C.rose

  if (!mounted) return null

  return (
    <div className="min-h-screen p-4 space-y-4" style={{ background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      {activeSnap && <SnapshotModal src={activeSnap} onClose={() => setActiveSnap(null)} />}
      <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />

      {/* Toast */}
      {importMsg && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-2xl" style={{
          background: importMsg.ok ? `${C.teal}18` : `${C.rose}18`,
          border: `1px solid ${importMsg.ok ? C.teal : C.rose}50`,
          color: importMsg.ok ? C.teal : C.rose,
        }}>
          {importMsg.ok ? '✓' : '✗'} {importMsg.text}
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `linear-gradient(135deg, ${C.gold}30, ${C.gold}10)`, border: `1px solid ${C.gold}40` }}>
            <Activity size={18} style={{ color: C.gold }} />
          </div>
          <div>
            <h1 className="font-black tracking-tight" style={{
              color: C.text, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, letterSpacing: '-0.02em'
            }}>RAFI TRADING BOT</h1>
            <p className="text-[10px]" style={{ color: C.muted }}>EURUSD · Pepperstone · Fase 1A</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
            style={{ background: `${C.gold}15`, border: `1px solid ${C.gold}30`, color: C.gold }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: C.gold }} />
            Fase 1A — Mapeamento
          </span>
          <button onClick={() => importRef.current?.click()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold transition-all"
            style={{ background: `${C.teal}18`, border: `1px solid ${C.teal}35`, color: C.teal }}>
            <Upload size={12} /> Importar
          </button>
          <Link href="/admin/chart"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold transition-all"
            style={{ background: C.gold, color: C.bg }}>
            <BarChart2 size={12} /> Mapear Trade
          </Link>
          <button onClick={() => { setCfgDraft(sessionConfig); setConfigOpen(o => !o) }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold transition-all"
            style={configOpen
              ? { background: `${C.gold}20`, border: `1px solid ${C.gold}50`, color: C.gold }
              : { background: C.card, border: `1px solid ${C.border}`, color: C.sub }}>
            <Settings size={12} /> Config
          </button>
        </div>
      </div>

      {/* ── Status MetaAPI ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-mono" style={{
        background: metaAccount ? `${C.teal}08` : C.card,
        border: `1px solid ${metaAccount ? C.teal + '30' : C.border}`,
      }}>
        {metaLoading && !metaAccount
          ? <span className="flex items-center gap-1.5" style={{ color: C.muted }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: C.muted }} />
              Conectando Pepperstone…
            </span>
          : metaAccount
            ? <>
                <Wifi size={13} style={{ color: C.teal }} className="shrink-0" />
                <span className="font-semibold" style={{ color: C.teal }}>Pepperstone</span>
                <span style={{ color: C.muted }}>·</span>
                <span style={{ color: C.text }}>Saldo <span className="font-bold" style={{ color: C.teal }}>
                  ${metaAccount.balance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
                <span style={{ color: C.muted }}>·</span>
                <span style={{ color: C.sub }}>Equity <span style={{ color: C.text }}>
                  ${metaAccount.equity.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
                <span style={{ color: C.muted }}>·</span>
                <span style={{ color: C.sub }}>Margem livre <span style={{ color: C.blue }}>
                  ${metaAccount.freeMargin.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span></span>
                {metaLoading && <span className="ml-1 w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: C.teal }} />}
                {metaAccount.updatedAt && (
                  <span className="ml-auto text-[10px]" style={{ color: C.muted }}>
                    {new Date(metaAccount.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
              </>
            : <>
                <WifiOff size={13} style={{ color: C.muted }} className="shrink-0" />
                <span style={{ color: C.muted }}>MetaAPI offline — exibindo dados calculados por trades</span>
              </>
        }
      </div>

      {/* ── Config panel ───────────────────────────────────────────────────── */}
      {configOpen && (
        <div className="rounded-xl p-5 space-y-4" style={{ background: C.card, border: `1px solid ${C.gold}35` }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings size={14} style={{ color: C.gold }} />
              <span className="text-sm font-semibold" style={{ color: C.text }}>Configurações da Sessão</span>
            </div>
            <button onClick={() => setConfigOpen(false)} style={{ color: C.muted }}>
              <XIcon size={14} />
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            {[
              { key: 'capitalInicial',       label: 'Capital inicial ($)',      type: 'number', min: 1 },
              { key: 'dailyGoal',            label: 'Meta diária ($)',          type: 'number', min: 0 },
              { key: 'weeklyGoal',           label: 'Meta semanal ($)',         type: 'number', min: 0 },
              { key: 'monthlyGoal',          label: 'Meta mensal ($)',          type: 'number', min: 0 },
              { key: 'maxConsecutiveLosses', label: 'Max perdas seguidas',      type: 'number', min: 1 },
              { key: 'maxWeeklyDrawdownPct', label: 'Drawdown máx semanal (%)', type: 'number', min: 1 },
              { key: 'sessionStartUTC',      label: 'Início sessão (UTC)',      type: 'text' },
              { key: 'sessionEndUTC',        label: 'Fim sessão (UTC)',         type: 'text' },
            ].map(field => (
              <div key={field.key} className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>{field.label}</label>
                <input type={field.type} min={field.min}
                  value={(cfgDraft as any)[field.key]}
                  onChange={e => setCfgDraft(d => ({
                    ...d,
                    [field.key]: field.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value,
                  }))}
                  className="rounded-lg px-3 py-2 font-mono text-xs focus:outline-none"
                  style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => { saveSessionConfig(cfgDraft); setSessionConfig(cfgDraft); setConfigOpen(false) }}
              className="px-4 py-2 rounded-lg font-bold text-xs transition-colors"
              style={{ background: C.gold, color: C.bg }}>Salvar</button>
            <button onClick={() => setConfigOpen(false)}
              className="px-4 py-2 rounded-lg font-semibold text-xs transition-colors"
              style={{ background: C.card2, border: `1px solid ${C.border}`, color: C.sub }}>Cancelar</button>
            <button onClick={() => { saveSessionConfig(SESSION_DEFAULTS); setSessionConfig(SESSION_DEFAULTS); setCfgDraft(SESSION_DEFAULTS) }}
              className="ml-auto px-3 py-2 rounded-lg font-semibold text-[10px] transition-colors"
              style={{ border: `1px solid ${C.border}`, color: C.muted }}>Restaurar padrões</button>
          </div>
        </div>
      )}

      {/* ── HERO — Desempenho de hoje ───────────────────────────────────────── */}
      <div className="rounded-2xl p-6 relative overflow-hidden" style={{
        background: `linear-gradient(135deg, ${C.card} 0%, #0a1928 100%)`,
        border: `1px solid ${heroColor}30`,
      }}>
        {/* Brilho de fundo */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(ellipse 60% 80% at 5% 50%, ${heroColor}08, transparent)`,
        }} />

        <div className="relative grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
          {/* Números */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: C.muted }}>Desempenho Hoje</span>
              {todayPnlMeta !== null
                ? <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${C.teal}15`, color: C.teal }}>● Pepperstone ao vivo</span>
                : <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${C.muted}15`, color: C.muted }}>trades mapeados</span>
              }
            </div>
            <div className="flex items-end gap-4 flex-wrap">
              <div style={{
                fontFamily: "'Barlow Condensed', 'Arial Black', sans-serif",
                fontSize: 'clamp(52px, 8vw, 80px)',
                fontWeight: 900,
                lineHeight: 1,
                color: heroColor,
                letterSpacing: '-0.02em',
              }}>
                {todayPnl >= 0 ? '+' : ''}${Math.abs(todayPnl).toFixed(2)}
              </div>
              {todayPct !== 0 && (
                <div className="px-3 py-1.5 rounded-xl font-bold text-xl mb-1" style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  background: `${heroColor}20`,
                  color: heroColor,
                  border: `1px solid ${heroColor}40`,
                }}>
                  {todayPct >= 0 ? '+' : ''}{todayPct.toFixed(1)}%
                </div>
              )}
            </div>
            <div className="flex items-center gap-4 mt-3 text-sm font-mono flex-wrap">
              <span style={{ color: C.sub }}>Capital <span style={{ color: C.text, fontWeight: 700 }}>
                ${capitalParaJornada.toFixed(2)}
              </span></span>
              {todayPnl !== 0 && (
                <span style={{ color: C.sub }}>Win rate <span style={{ color: winRateColor, fontWeight: 700 }}>
                  {winRate !== null ? `${winRate}%` : '—'}
                </span></span>
              )}
            </div>
          </div>

          {/* Sparkline */}
          <div className="min-h-[80px]">
            <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Curva de Capital</div>
            <HeroSparkline trades={trades} height={72} />
          </div>
        </div>
      </div>

      {/* ── 4 Stat tiles ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Win Rate"
          value={winRate !== null ? `${winRate}%` : '—'}
          sub={`${wins}W · ${losses}L`} color={winRateColor} icon={Award} />
        <KPI label="R:R Médio"
          value={avgRR ? `${avgRR}×` : '—'}
          sub="meta ≥ 1.5×" icon={TrendingUp} color={avgRR && parseFloat(avgRR) >= 1.5 ? C.teal : C.gold} />
        <KPI label="RAFI ≥ 2.5"
          value={rafiStrong}
          sub={`${trades.length > 0 ? Math.round(rafiStrong / trades.length * 100) : 0}% dos trades`}
          color={C.teal} icon={BarChart2} />
        <KPI label="Total de Trades"
          value={trades.length}
          sub={`${pending} aguardando W/L`} color={C.blue} icon={Target} />
      </div>

      {/* ── Banner de bloqueio ─────────────────────────────────────────────── */}
      {gate.isLocked && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{
          background: `${C.rose}12`, border: `1px solid ${C.rose}40`
        }}>
          <Lock size={14} style={{ color: C.rose }} className="shrink-0" />
          <div>
            <span className="text-sm font-bold" style={{ color: C.rose }}>Sessão Bloqueada</span>
            <span className="ml-2 text-xs" style={{ color: `${C.rose}bb` }}>{gate.lockReason}</span>
          </div>
        </div>
      )}

      {/* ── Mission Control ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <CapitalJourney capitalAtual={capitalParaJornada} cfg={sessionConfig} />
        <SessionCockpit gate={gate} cfg={sessionConfig} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <RiskPanel gate={gate} cfg={sessionConfig} />
          <GoalsCascade gate={gate} cfg={sessionConfig} capitalAtual={capitalParaJornada} />
        </div>
      </div>

      {/* ── Progresso ML ────────────────────────────────────────────────────── */}
      <div className="rounded-xl p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap size={14} style={{ color: C.blue }} />
            <span className="text-sm font-semibold" style={{ color: C.text }}>Progresso para Treinar o ML</span>
          </div>
          <span className="text-[10px]" style={{ color: C.muted }}>Meta: {ML_TARGET} trades rotulados</span>
        </div>
        <MLProgress current={trades.length} />
        {trades.length === 0 && (
          <p className="text-[10px] mt-3 text-center" style={{ color: C.muted }}>
            Vá para <Link href="/admin/chart" style={{ color: C.blue }} className="hover:underline">Gráfico RAFI</Link> e comece a mapear os setups de hoje.
          </p>
        )}
      </div>

      {/* ── Simulador de escalonamento ──────────────────────────────────────── */}
      <LotScalingWidget trades={trades} />

      {/* ── Trades recentes ─────────────────────────────────────────────────── */}
      <div className="rounded-xl overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ background: C.bg, borderColor: C.border }}>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: C.muted }}>Trades Recentes</span>
          <Link href="/admin/export"
            className="flex items-center gap-1 text-[9px] hover:underline transition-colors" style={{ color: C.blue }}>
            Ver todos <ChevronRight size={10} />
          </Link>
        </div>
        {trades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <BarChart2 size={32} style={{ color: C.border }} className="mb-3" />
            <p className="text-xs" style={{ color: C.muted }}>Nenhum trade mapeado ainda.</p>
          </div>
        ) : (
          <div>
            <div className="flex gap-2 px-4 py-2 text-[8px] uppercase tracking-wider border-b" style={{ color: C.muted, borderColor: C.border }}>
              <span className="w-24 shrink-0">Data/Hora</span>
              <span className="w-12 shrink-0">Dir</span>
              <span className="w-20 shrink-0">Entrada</span>
              <span className="w-14 shrink-0 text-right" style={{ color: C.teal }}>Ganho</span>
              <span className="w-14 shrink-0 text-right" style={{ color: C.rose }}>Risco</span>
              <span className="w-9 shrink-0 text-right">R:R</span>
              <span className="ml-auto">Resultado</span>
            </div>
            {recent.map(t => <TradeRow key={t.id} t={t} onLabel={handleLabel} onSnapClick={setActiveSnap} />)}
          </div>
        )}
      </div>

      {/* ── Ações rápidas ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link href="/admin/chart"
          className="flex items-center gap-3 p-4 rounded-xl transition-all group"
          style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${C.blue}18` }}>
            <BarChart2 size={18} style={{ color: C.blue }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: C.text }}>Gráfico RAFI</div>
            <div className="text-[10px]" style={{ color: C.muted }}>Mapear novos trades com OCO</div>
          </div>
          <ChevronRight size={14} className="ml-auto" style={{ color: C.muted }} />
        </Link>

        <Link href="/admin/export"
          className="flex items-center gap-3 p-4 rounded-xl transition-all group"
          style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${C.teal}18` }}>
            <Download size={18} style={{ color: C.teal }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: C.text }}>Dataset ML</div>
            <div className="text-[10px]" style={{ color: C.muted }}>Rotular W/L · exportar CSV</div>
          </div>
          <ChevronRight size={14} className="ml-auto" style={{ color: C.muted }} />
        </Link>

        <div className="flex items-center gap-3 p-4 rounded-xl opacity-40 cursor-not-allowed"
          style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${C.muted}18` }}>
            <AlertTriangle size={18} style={{ color: C.muted }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: C.muted }}>Bot Automático</div>
            <div className="text-[10px]" style={{ color: C.border }}>Disponível após Fase 2 (ML)</div>
          </div>
        </div>
      </div>
    </div>
  )
}
