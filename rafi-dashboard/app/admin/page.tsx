'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import {
  TrendingUp, TrendingDown, BarChart2, Activity,
  Target, AlertTriangle, ChevronRight, Download,
  Zap, Clock, Award, X as XIcon, Upload,
  Lock, Radio, Shield, Settings, WifiOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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

// ── Broker Live Data type ─────────────────────────────────────────────────────
interface BrokerLiveData {
  id:                 string
  nome:               string
  tipo:               string
  metaapi_account_id: string | null
  balance:            number
  equity:             number
  freeMargin:         number
  updatedAt:          string | null
  todayPnl:           number
  connected:          boolean
}

// ── Cards de comparação de corretoras ─────────────────────────────────────────
const BROKER_META: Record<string, { label: string; color: string; bg: string }> = {
  pepperstone:    { label: 'PP',  color: '#4a9eff', bg: '#0d1a28' },
  fusion_markets: { label: 'FM',  color: '#a855f7', bg: '#150d27' },
  forex_com:      { label: 'FX',  color: '#22c55e', bg: '#0a1f12' },
  exness:         { label: 'EX',  color: '#1de9b6', bg: '#0a1a20' },
  xm:             { label: 'XM',  color: '#f0b429', bg: '#1f1508' },
}
function getBrokerMeta(id: string) {
  return BROKER_META[id] ?? { label: id.slice(0, 2).toUpperCase(), color: C.sub, bg: C.card2 }
}

function BrokerCompareRow({ brokers }: { brokers: BrokerLiveData[] }) {
  if (brokers.length === 0) return null
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(brokers.length, 4)}, minmax(0, 1fr))` }}>
      {brokers.map(b => {
        const meta  = getBrokerMeta(b.id)
        const pnlColor = b.todayPnl > 0 ? C.teal : b.todayPnl < 0 ? C.rose : C.sub
        const hasMeta  = b.metaapi_account_id || b.id === 'pepperstone'
        return (
          <div key={b.id} className="rounded-xl p-4" style={{
            background: meta.bg,
            border: `1px solid ${b.connected ? meta.color + '40' : C.border}`,
          }}>
            {/* Logo + nome + badge */}
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs shrink-0"
                style={{ background: meta.color + '20', color: meta.color, border: `1px solid ${meta.color}40`, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.03em' }}>
                {meta.label}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold truncate" style={{ color: C.text, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.02em' }}>
                  {b.nome || b.id}
                </div>
                <div className="text-[9px]" style={{ color: C.muted }}>{b.tipo || 'ECN'}</div>
              </div>
              <div className="ml-auto shrink-0">
                {b.connected
                  ? <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${meta.color}15`, color: meta.color }}>● ao vivo</span>
                  : hasMeta
                    ? <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${C.gold}12`, color: C.gold }}>sincron.</span>
                    : <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${C.gold}12`, color: C.gold }}>aguardando</span>
                }
              </div>
            </div>

            {/* Balance */}
            <div className="mb-2">
              <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: C.muted }}>Saldo</div>
              <div className="font-black" style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 22,
                color: b.connected ? C.text : C.muted,
                lineHeight: 1,
              }}>
                {b.connected ? `$${b.balance.toFixed(2)}` : '—'}
              </div>
              {b.connected && b.equity !== b.balance && (
                <div className="text-[10px] mt-0.5" style={{ color: C.sub }}>
                  Equity <span style={{ color: C.text }}>${b.equity.toFixed(2)}</span>
                </div>
              )}
            </div>

            {/* P&L hoje */}
            <div className="pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
              <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: C.muted }}>P&L Hoje</div>
              <div className="font-bold text-sm font-mono" style={{ color: b.connected ? pnlColor : C.muted }}>
                {b.connected
                  ? `${b.todayPnl >= 0 ? '+' : ''}$${Math.abs(b.todayPnl).toFixed(2)}`
                  : hasMeta ? '—' : 'Configurar MetaAPI'
                }
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Progress bar do ML ────────────────────────────────────────────────────────
function MLProgress({ current }: { current: number }) {
  const color = current >= 20 ? C.teal : current >= 5 ? C.blue : C.gold
  const phase = current === 0
    ? 'Aguardando 1º trade'
    : `IA aprendendo — ${current} trade${current > 1 ? 's' : ''} coletado${current > 1 ? 's' : ''}`
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium" style={{ color: C.sub }}>{phase}</span>
        <span className="font-mono font-bold" style={{ color }}>{current} trades</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: C.card2 }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(current * 2, 100)}%`, background: color }} />
      </div>
      <div className="flex items-center justify-between text-[9px]" style={{ color: C.muted }}>
        <span>0</span>
        <span>Aprendizado contínuo</span>
        <span>∞</span>
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

  if (!chips.length) return null

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2.5 border-b" style={{ borderColor: C.card2 }}>
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

  const lossesToday = todayTrades.filter(t => t.result === 'loss').length
  const winsToday   = todayTrades.filter(t => t.result === 'win').length

  return {
    isLocked, lockReason,
    isDayAllowed, isTimeAllowed,
    consecutiveLosses, lossGate,
    dailyGoalMet, drawdownGate,
    todayPnl, weekPnl, monthPnl, weekDrawdownPct,
    lossesToday, winsToday,
  }
}
type SessionGate = ReturnType<typeof computeSessionGate>

// ── Disciplina & Sessão ───────────────────────────────────────────────────────
function DisciplinePanel({ gate, cfg }: { gate: SessionGate; cfg: SessionConfig }) {
  const drawdownFill  = Math.min(gate.weekDrawdownPct / cfg.maxWeeklyDrawdownPct * 100, 100)
  const drawdownColor = gate.drawdownGate ? C.rose : drawdownFill > 60 ? C.gold : C.teal

  const nowDay = new Date().getUTCDay()
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes()
  const [sh, sm] = cfg.sessionStartUTC.split(':').map(Number)
  const [eh, em] = cfg.sessionEndUTC.split(':').map(Number)
  const sessStartMin = sh * 60 + sm, sessEndMin = eh * 60 + em

  const DAY_SHORT = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB']

  const stopsColor = gate.lossesToday >= cfg.maxConsecutiveLosses ? C.rose
    : gate.lossesToday > 0 ? C.gold : C.teal
  const seqColor   = gate.lossGate ? C.rose : gate.consecutiveLosses > 0 ? C.gold : C.teal

  return (
    <div className="rounded-xl p-5 space-y-4" style={{
      background: C.card,
      border: `1px solid ${C.blue}40`,
      boxShadow: `inset 0 3px 0 ${C.blue}`,
    }}>
      <div className="flex items-center gap-2">
        <Shield size={13} style={{ color: C.blue }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.blue }}>Disciplina &amp; Sessão</span>
      </div>

      {/* Two big metric tiles */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg p-4 flex flex-col items-center justify-center" style={{
          background: `linear-gradient(135deg, ${stopsColor}22 0%, ${C.card2} 100%)`,
          border: `1px solid ${stopsColor}50`,
          boxShadow: `0 4px 20px ${stopsColor}12`,
          minHeight: 80,
        }}>
          <div className="font-black font-mono leading-none mb-1" style={{
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 40, color: stopsColor,
            textShadow: `0 0 20px ${stopsColor}60`,
          }}>
            {gate.lossesToday}<span className="text-2xl" style={{ color: C.sub }}>/{cfg.maxConsecutiveLosses}</span>
          </div>
          <div className="text-[8px] uppercase tracking-widest text-center font-bold" style={{ color: stopsColor }}>Stops Hoje</div>
        </div>
        <div className="rounded-lg p-4 flex flex-col items-center justify-center" style={{
          background: `linear-gradient(135deg, ${seqColor}22 0%, ${C.card2} 100%)`,
          border: `1px solid ${seqColor}50`,
          boxShadow: `0 4px 20px ${seqColor}12`,
          minHeight: 80,
        }}>
          <div className="font-black font-mono leading-none mb-1" style={{
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 40, color: seqColor,
            textShadow: `0 0 20px ${seqColor}60`,
          }}>
            {gate.consecutiveLosses}<span className="text-2xl" style={{ color: C.sub }}>/{cfg.maxConsecutiveLosses}</span>
          </div>
          <div className="text-[8px] uppercase tracking-widest text-center font-bold" style={{ color: seqColor }}>Seq. Perdas</div>
        </div>
      </div>

      {/* Drawdown linear bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] uppercase tracking-widest" style={{ color: C.muted }}>Drawdown Semanal</span>
          <span className="text-[9px] font-mono font-bold" style={{ color: drawdownColor }}>
            {gate.weekDrawdownPct.toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.card2 }}>
          <div className="h-full rounded-full transition-all duration-700" style={{
            width: `${drawdownFill.toFixed(1)}%`, background: drawdownColor, opacity: drawdownFill < 1 ? 0.4 : 1,
          }} />
        </div>
        <div className="text-[8px] mt-0.5" style={{ color: C.muted }}>Máximo permitido: {cfg.maxWeeklyDrawdownPct}%</div>
      </div>

      {/* Lock / ops blocked banner */}
      {gate.isLocked && (
        <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg" style={{
          background: `${C.rose}18`, border: `1px solid ${C.rose}40`,
        }}>
          <Lock size={10} style={{ color: C.rose }} />
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: C.rose }}>
            OPS BLOQUEADAS · {gate.lockReason}
          </span>
        </div>
      )}

      {/* Agenda */}
      <div>
        <div className="text-[8px] uppercase tracking-widest mb-2" style={{ color: C.muted }}>Agenda Semanal</div>
        <div className="flex gap-1 mb-2">
          {[1,2,3,4,5].map(d => {
            const allowed  = cfg.tradingDays.includes(d)
            const isToday  = d === nowDay
            const isActive = isToday && allowed && nowMin >= sessStartMin && nowMin < sessEndMin
            return (
              <div key={d} className="flex-1 py-1.5 rounded text-[8px] font-bold flex items-center justify-center" style={
                isActive  ? { background: C.teal, color: C.bg } :
                isToday && allowed ? { background: `${C.teal}25`, color: C.teal, border: `1px solid ${C.teal}50` } :
                allowed   ? { background: C.card2, color: C.sub } :
                             { background: C.bg, color: C.border, border: `1px solid ${C.border}` }
              }>{DAY_SHORT[d]}</div>
            )
          })}
        </div>
        <div className="text-[9px]" style={{ color: C.muted }}>
          Janela: {cfg.sessionStartUTC}–{cfg.sessionEndUTC} UTC
          {' · '}
          <span style={{ color: gate.isTimeAllowed && gate.isDayAllowed ? C.teal : C.muted }}>
            {gate.isTimeAllowed && gate.isDayAllowed ? 'Janela ativa' : 'Fora da janela'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Metas em Cascata ──────────────────────────────────────────────────────────
function GoalsCascade({ gate, cfg, capitalAtual, todayPnlOverride }: { gate: SessionGate; cfg: SessionConfig; capitalAtual: number; todayPnlOverride?: number | null }) {
  const logMin = Math.log10(Math.max(cfg.capitalInicial, 1))
  const logMax = Math.log10(cfg.capitalTarget)
  const todayPnlEff = todayPnlOverride ?? gate.todayPnl

  const goalPctLabel = (goal: number) => {
    if (!cfg.capitalInicial || !goal) return ''
    return `META ${Math.round(goal / cfg.capitalInicial * 100)}%`
  }

  const goals = [
    { key: 'HOJE',   label: goalPctLabel(cfg.dailyGoal),   value: todayPnlEff,   target: cfg.dailyGoal,   color: C.teal,
      pct: todayPnlEff <= 0 ? 0 : Math.min(todayPnlEff / cfg.dailyGoal * 100, 100) },
    { key: 'SEMANA', label: goalPctLabel(cfg.weeklyGoal),   value: gate.weekPnl,  target: cfg.weeklyGoal,  color: C.blue,
      pct: gate.weekPnl  <= 0 ? 0 : Math.min(gate.weekPnl  / cfg.weeklyGoal  * 100, 100) },
    { key: 'MÊS',    label: goalPctLabel(cfg.monthlyGoal),  value: gate.monthPnl, target: cfg.monthlyGoal, color: '#a855f7',
      pct: gate.monthPnl <= 0 ? 0 : Math.min(gate.monthPnl / cfg.monthlyGoal * 100, 100) },
  ]

  const fmtVal = (v: number) => (v >= 0 ? '+' : '') + `$${v.toFixed(2)}`
  const fmtTgt = (v: number) => v >= 1_000 ? `$${(v/1_000).toFixed(0)}k` : `$${v.toFixed(2)}`
  const fmtPct = (v: number) => {
    if (!cfg.capitalInicial) return ''
    return `${v >= 0 ? '+' : ''}${(v / cfg.capitalInicial * 100).toFixed(1)}%`
  }

  // JORNADA
  const clamp  = Math.max(cfg.capitalInicial, Math.min(capitalAtual, cfg.capitalTarget))
  const jPct   = ((Math.log10(clamp) - logMin) / (logMax - logMin)) * 100
  const jColor = jPct < 25 ? C.gold : jPct < 75 ? C.blue : C.teal
  const jMilestones = [1_000, 10_000, 100_000].map(cap => ({
    cap, pct: ((Math.log10(cap) - logMin) / (logMax - logMin)) * 100,
    label: cap >= 1_000_000 ? `$${cap/1_000_000}M` : cap >= 1_000 ? `$${cap/1_000}k` : `$${cap}`,
    reached: capitalAtual >= cap,
  }))
  const fmtCapital = (v: number) => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${(v/1_000).toFixed(1)}k` : `$${v.toFixed(0)}`

  return (
    <div className="rounded-xl p-5" style={{
      background: C.card,
      border: `1px solid ${C.teal}40`,
      boxShadow: `inset 0 3px 0 ${C.teal}`,
    }}>
      <div className="flex items-center gap-2 mb-4">
        <Award size={13} style={{ color: C.teal }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.teal }}>Metas em Cascata</span>
        <span className="ml-1 text-[8px] px-1.5 py-0.5 rounded font-bold uppercase" style={{
          background: `${C.teal}18`, border: `1px solid ${C.teal}40`, color: C.teal,
        }}>Redesenhado</span>
      </div>

      <div className="space-y-3">
        {goals.map(g => {
          const met = g.pct >= 100
          return (
            <div key={g.key}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-[8px] uppercase tracking-widest font-bold" style={{ color: C.muted }}>{g.key}</span>
                  {g.label && <span className="text-[8px]" style={{ color: C.sub }}>· {g.label}</span>}
                </div>
                <span className="text-[9px] font-mono font-bold" style={{ color: met ? C.teal : g.color }}>
                  {fmtPct(g.value)}{met ? ' ✓' : ''}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: C.card2 }}>
                <div className="h-full rounded-full transition-all duration-700" style={{
                  width: `${Math.max(0, g.pct).toFixed(1)}%`,
                  background: met ? C.teal : g.color,
                  opacity: g.pct <= 0 ? 0.3 : 1,
                }} />
              </div>
              <div className="flex items-center justify-between mt-0.5 text-[8px] font-mono" style={{ color: C.muted }}>
                <span>{fmtVal(g.value)} · {fmtPct(g.value)}</span>
                <span>{met ? '✓' : ''} meta {fmtTgt(g.target)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* JORNADA bar */}
      <div className="mt-4 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[8px] uppercase tracking-widest" style={{ color: C.muted }}>Jornada ${cfg.capitalInicial} → $1M</span>
          <span className="text-[9px] font-mono font-bold" style={{ color: jColor }}>{fmtCapital(capitalAtual)}</span>
        </div>
        <div className="relative h-2 rounded-full" style={{ background: C.card2 }}>
          <div className="h-full rounded-full transition-all duration-700" style={{
            width: `${Math.max(0, Math.min(jPct, 100)).toFixed(1)}%`, background: jColor,
          }} />
          {jMilestones.map(m => (
            <div key={m.cap} className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full transition-colors" style={{
              left: `${Math.min(m.pct, 98)}%`, transform: 'translate(-50%, -50%)',
              background: m.reached ? jColor : C.card, border: `1.5px solid ${m.reached ? jColor : C.muted}`,
            }} />
          ))}
        </div>
        <div className="flex justify-between mt-1.5 text-[8px] font-mono" style={{ color: C.muted }}>
          <span>${cfg.capitalInicial}</span>
          {jMilestones.map(m => (
            <span key={m.cap} style={{ color: m.reached ? jColor : C.muted, fontWeight: m.reached ? 700 : 400 }}>{m.label}</span>
          ))}
          <span>$1M</span>
        </div>
      </div>
    </div>
  )
}

// ── Inteligência RAFI ─────────────────────────────────────────────────────────
function IntelPanel({ trades, winRate, avgRR, rafiStrong, winsCount, lossesCount, pendingCount }: {
  trades: ManualTrade[]; winRate: number | null; avgRR: string | null
  rafiStrong: number; winsCount: number; lossesCount: number; pendingCount: number
}) {
  const winRateColor = winRate === null ? C.text : winRate >= 60 ? C.teal : winRate >= 50 ? C.gold : C.rose
  const avgRRColor   = avgRR && parseFloat(avgRR) >= 1.5 ? C.teal : C.gold
  const rafiPct      = trades.length > 0 ? Math.round(rafiStrong / trades.length * 100) : 0
  const phaseColor   = trades.length >= 20 ? C.teal : trades.length >= 5 ? C.blue : trades.length > 0 ? C.gold : C.muted
  const mlBarPct     = Math.min(trades.length * 5, 100)  // 20 trades = barra cheia
  const mlActive     = trades.length >= 20

  const kpis = [
    { label: 'Win Rate',      val: winRate !== null ? `${winRate}%` : '—', sub: `${winsCount}W · ${lossesCount}L`, color: winRateColor,  Icon: Award },
    { label: 'R:R Médio',     val: avgRR ? `${avgRR}×` : '—',             sub: 'meta ≥ 1.5×',                    color: avgRRColor,    Icon: TrendingUp },
    { label: 'RAFI ≥ 2.5',    val: String(rafiStrong),                     sub: `${rafiPct}% dos trades`,         color: C.teal,        Icon: BarChart2 },
    { label: '% dos Trades',  val: `${rafiPct}%`,                          sub: `${trades.length} total`,         color: C.blue,        Icon: Target },
  ]

  return (
    <div className="rounded-xl p-5 space-y-4" style={{
      background: C.card,
      border: `1px solid #a855f740`,
      boxShadow: `inset 0 3px 0 #a855f7`,
    }}>
      <div className="flex items-center gap-2">
        <Zap size={13} style={{ color: '#a855f7' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#a855f7' }}>Inteligência RAFI</span>
        <span className="ml-1 text-[8px] px-1.5 py-0.5 rounded font-bold uppercase" style={{
          background: `${C.blue}18`, border: `1px solid ${C.blue}40`, color: C.blue,
        }}>1A Ativa</span>
      </div>

      {/* 2×2 KPI grid */}
      <div className="grid grid-cols-2 gap-2">
        {kpis.map(({ label, val, sub, color, Icon }) => (
          <div key={label} className="rounded-lg p-3 flex flex-col gap-0.5" style={{
            background: `linear-gradient(135deg, ${color}15 0%, ${C.card2} 100%)`,
            border: `1px solid ${color}40`,
          }}>
            <div className="flex items-center gap-1 text-[8px] uppercase tracking-widest" style={{ color: C.muted }}>
              <Icon size={8} style={{ color }} />
              {label}
            </div>
            <div className="text-xl font-black font-mono leading-tight" style={{ color }}>{val}</div>
            <div className="text-[8px]" style={{ color: C.muted }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ML progress */}
      <div>
        <div className="flex items-center justify-between mb-1 text-[8px] uppercase tracking-widest" style={{ color: C.muted }}>
          <span>ML — Aprendendo Padrões</span>
          <span className="font-mono font-bold" style={{ color: phaseColor }}>{trades.length} trades</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.card2 }}>
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${mlBarPct}%`, background: phaseColor }} />
        </div>
        <div className="flex items-center justify-between mt-1 text-[8px]" style={{ color: C.muted }}>
          <span>{mlActive ? 'Aprendendo — melhora a cada trade' : 'Coletando dados…'}</span>
          <span style={{ color: phaseColor }}>{trades.length} trade{trades.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Co-Piloto status */}
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{
        background: mlActive ? `${C.teal}12` : `${C.card2}`,
        border: `1px solid ${mlActive ? C.teal : C.border}30`,
      }}>
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{
          background: mlActive ? `${C.teal}20` : C.bg,
          border: `2px solid ${mlActive ? C.teal : C.border}`,
        }}>
          <span className="text-[9px] font-black font-mono" style={{ color: mlActive ? C.teal : C.muted }}>
            {trades.length > 0 ? `${trades.length}` : '0'}
          </span>
        </div>
        <div>
          <div className="text-[9px] font-semibold" style={{ color: phaseColor }}>
            Co-Piloto · {trades.length > 0 ? 'Aprendendo' : 'Aguardando'}
          </div>
          <div className="text-[8px]" style={{ color: C.muted }}>
            {trades.length > 0 ? 'Melhora a cada novo trade' : 'Opera o 1º trade para iniciar'}
          </div>
        </div>
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
  const [brokersLive,    setBrokersLive]    = useState<BrokerLiveData[]>([])
  const [configOpen,     setConfigOpen]     = useState(false)
  const [cfgDraft,       setCfgDraft]       = useState<SessionConfig>(SESSION_DEFAULTS)
  const [clockStr,       setClockStr]       = useState('')
  const [tradeFilter,    setTradeFilter]    = useState<'hoje' | '7d' | '30d'>('hoje')
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
    const fmt = () => {
      const n = new Date()
      return `${String(n.getUTCHours()).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')}:${String(n.getUTCSeconds()).padStart(2,'0')} UTC`
    }
    setClockStr(fmt())
    const id = setInterval(() => setClockStr(fmt()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!mounted) return

    const fetchBrokersSummary = async () => {
      setMetaLoading(true)
      try {
        // 1. Busca lista de corretoras habilitadas
        const bRes = await fetch('/api/brokers')
        const { brokers: brokerList } = bRes.ok ? await bRes.json() : { brokers: [] }
        const enabled: any[] = Array.isArray(brokerList) ? brokerList.filter((b: any) => b.enabled) : []

        // Se nenhuma corretora no Supabase, usa Pepperstone via env var
        const targets = enabled.length > 0 ? enabled : [{ id: 'pepperstone', nome: 'Pepperstone', tipo: 'Razor ECN', metaapi_account_id: null }]

        // 2. Busca MetaAPI para cada corretora em paralelo
        const results = await Promise.allSettled(
          targets.map(async (broker: any) => {
            const canFetch = broker.metaapi_account_id || broker.id === 'pepperstone'
            if (!canFetch) {
              return { id: broker.id, nome: broker.nome || broker.id, tipo: broker.tipo || 'ECN', metaapi_account_id: null, balance: 0, equity: 0, freeMargin: 0, updatedAt: null, todayPnl: 0, connected: false } as BrokerLiveData
            }
            const q = broker.metaapi_account_id ? `?accountId=${broker.metaapi_account_id}` : ''
            const [accRes, pnlRes] = await Promise.all([
              fetch(`/api/metaapi/account${q}`),
              fetch(`/api/metaapi/today-pnl${q}`),
            ])
            const acc = accRes.ok ? await accRes.json() : null
            const pnl = pnlRes.ok ? await pnlRes.json() : null
            return {
              id:                 broker.id,
              nome:               broker.nome || broker.id,
              tipo:               broker.tipo || 'ECN',
              metaapi_account_id: broker.metaapi_account_id ?? null,
              balance:            acc?.balance    ?? 0,
              equity:             acc?.equity     ?? 0,
              freeMargin:         acc?.freeMargin ?? 0,
              updatedAt:          acc?.updatedAt  ?? null,
              todayPnl:           typeof pnl?.todayPnl === 'number' ? pnl.todayPnl : 0,
              connected:          !!acc && !acc.error,
            } as BrokerLiveData
          })
        )

        const live: BrokerLiveData[] = results
          .filter(r => r.status === 'fulfilled')
          .map(r => (r as PromiseFulfilledResult<BrokerLiveData>).value)

        setBrokersLive(live)

        // Compatibilidade: alimenta metaAccount com Pepperstone (ou primeiro conectado)
        const primary = live.find(b => b.id === 'pepperstone') ?? live.find(b => b.connected)
        if (primary?.connected) {
          setMetaAccount({ balance: primary.balance, equity: primary.equity, freeMargin: primary.freeMargin, updatedAt: primary.updatedAt ?? undefined })
        }
        // P&L total = soma de todos os brokers conectados
        const sumPnl = live.filter(b => b.connected).reduce((s, b) => s + b.todayPnl, 0)
        if (live.some(b => b.connected)) setTodayPnlMeta(sumPnl)

      } catch {}
      setMetaLoading(false)
    }

    fetchBrokersSummary()
    const id = setInterval(fetchBrokersSummary, 60_000)
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

  // Capital consolidado: soma dos saldos de todas as corretoras conectadas
  const capitalConsolidado = brokersLive
    .filter(b => b.connected && b.balance > 0)
    .reduce((sum, b) => sum + b.balance, 0)

  const capitalParaJornada = capitalConsolidado > 0
    ? capitalConsolidado
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

  const filteredTrades = useMemo(() => {
    const sorted = [...trades].sort((a, b) => b.time - a.time)
    if (tradeFilter === 'hoje') {
      const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0)
      const ts = todayStart.getTime() / 1000
      return sorted.filter(t => t.time >= ts).slice(0, 30)
    }
    if (tradeFilter === '7d') {
      return sorted.filter(t => t.time >= Date.now() / 1000 - 7 * 86400).slice(0, 50)
    }
    return sorted.slice(0, 50)
  }, [trades, tradeFilter])

  // P&L do dia: soma dos brokers conectados via MetaAPI; cai para cálculo manual
  const connectedBrokers = brokersLive.filter(b => b.connected)
  const todayPnl         = todayPnlMeta ?? gate.todayPnl

  // Percentual do dia (relativo ao capital no início do dia)
  const capitalStartOfDay = capitalParaJornada - todayPnl
  const todayPct = capitalStartOfDay > 0 ? (todayPnl / capitalStartOfDay) * 100 : 0

  const heroColor    = todayPnl >= 0 ? C.teal : C.rose
  const winRateColor = winRate === null ? C.text : winRate >= 60 ? C.teal : winRate >= 50 ? C.gold : C.rose

  // Próxima janela de sessão (para "Retoma:")
  const nextSessionStr = useMemo(() => {
    const [sh, sm] = sessionConfig.sessionStartUTC.split(':').map(Number)
    const now = new Date()
    const nowDay = now.getUTCDay()
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
    for (let i = 1; i <= 7; i++) {
      const d = (nowDay + i) % 7
      if (sessionConfig.tradingDays.includes(d)) {
        return `${days[d]} às ${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')} UTC`
      }
    }
    return `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')} UTC`
  }, [sessionConfig])

  const primaryBroker = brokersLive.find(b => b.connected)

  if (!mounted) return null

  return (
    <div className="min-h-screen" style={{ background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      {activeSnap && <SnapshotModal src={activeSnap} onClose={() => setActiveSnap(null)} />}
      <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />

      {/* Toast */}
      {importMsg && (
        <div className="fixed top-16 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-2xl" style={{
          background: importMsg.ok ? `${C.teal}18` : `${C.rose}18`,
          border: `1px solid ${importMsg.ok ? C.teal : C.rose}50`,
          color: importMsg.ok ? C.teal : C.rose,
        }}>
          {importMsg.ok ? '✓' : '✗'} {importMsg.text}
        </div>
      )}

      {/* ── COMMAND STRIP ──────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-40 border-b" style={{
        background: `${C.bg}f2`,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderColor: C.border,
      }}>
        <div className="flex items-center gap-3 px-4 h-12">
          {/* Brand */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${C.gold}35, ${C.gold}15)`, border: `1px solid ${C.gold}45` }}>
              <Activity size={14} style={{ color: C.gold }} />
            </div>
            <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, color: C.text, letterSpacing: '-0.01em' }}>
              RAFI COMMAND
            </span>
          </div>

          {/* Live status chips */}
          <div className="flex items-center gap-2 ml-1 text-[10px] font-mono">
            {connectedBrokers.length > 0
              ? <span className="flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: `${C.teal}12`, color: C.teal, border: `1px solid ${C.teal}30` }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: C.teal }} />
                  {connectedBrokers.length} corretoras ao vivo
                </span>
              : <span className="flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: `${C.muted}12`, color: C.muted, border: `1px solid ${C.muted}30` }}>
                  <WifiOff size={9} />offline
                </span>
            }
            <span className="hidden sm:inline px-2 py-0.5 rounded-full" style={
              gate.isLocked
                ? { background: `${C.rose}15`, color: C.rose, border: `1px solid ${C.rose}30` }
                : { background: `${C.muted}10`, color: C.muted, border: `1px solid ${C.muted}20` }
            }>
              {gate.isLocked ? `OPS BLOQUEADAS` : '◉ Sessão Ativa'}
            </span>
            <span className="hidden md:inline px-2 py-0.5 rounded-full" style={{ background: `${C.gold}12`, color: C.gold, border: `1px solid ${C.gold}25` }}>
              Fase 1A · Manual
            </span>
          </div>

          <div className="flex-1" />

          {/* Clock */}
          {clockStr && (
            <span className="hidden md:inline font-mono text-sm font-bold" style={{ color: C.teal, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.03em' }}>
              {clockStr}
            </span>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1.5 ml-2">
            <button onClick={() => importRef.current?.click()}
              className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg font-semibold"
              style={{ background: `${C.teal}15`, border: `1px solid ${C.teal}30`, color: C.teal }}>
              <Upload size={11} />
              <span className="hidden sm:inline">Importar</span>
            </button>
            <Link href="/admin/chart"
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-bold"
              style={{ background: C.gold, color: C.bg }}>
              <BarChart2 size={11} /> Mapear
            </Link>
            <button onClick={() => { setCfgDraft(sessionConfig); setConfigOpen(o => !o) }}
              className="flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg"
              style={configOpen
                ? { background: `${C.gold}18`, border: `1px solid ${C.gold}40`, color: C.gold }
                : { background: C.card, border: `1px solid ${C.border}`, color: C.sub }}>
              <Settings size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="px-4 pt-4 pb-10 space-y-4">

        {/* ── Config panel ─────────────────────────────────────────────────── */}
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
                className="px-4 py-2 rounded-lg font-bold text-xs"
                style={{ background: C.gold, color: C.bg }}>Salvar</button>
              <button onClick={() => setConfigOpen(false)}
                className="px-4 py-2 rounded-lg font-semibold text-xs"
                style={{ background: C.card2, border: `1px solid ${C.border}`, color: C.sub }}>Cancelar</button>
              <button onClick={() => { saveSessionConfig(SESSION_DEFAULTS); setSessionConfig(SESSION_DEFAULTS); setCfgDraft(SESSION_DEFAULTS) }}
                className="ml-auto px-3 py-2 rounded-lg font-semibold text-[10px]"
                style={{ border: `1px solid ${C.border}`, color: C.muted }}>Restaurar padrões</button>
            </div>
          </div>
        )}

        {/* ── HERO BAND (3 cards) ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

          {/* Card 1: Capital Consolidado */}
          <div className="rounded-xl p-5" style={{
            background: `linear-gradient(160deg, ${C.card} 0%, #060f1a 100%)`,
            border: `1px solid ${C.teal}45`,
            boxShadow: `inset 0 3px 0 ${C.teal}, 0 12px 40px ${C.teal}18`,
          }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[8px] uppercase tracking-widest font-bold" style={{ color: C.teal }}>Capital Consolidado</span>
              {connectedBrokers.length > 0 && (
                <span className="text-[8px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${C.teal}12`, color: C.teal, border: `1px solid ${C.teal}25` }}>
                  {connectedBrokers.length} corretoras
                </span>
              )}
              {metaLoading && <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: C.muted }} />}
            </div>
            <div style={{
              fontFamily: "'Barlow Condensed', 'Arial Black', sans-serif",
              fontSize: 'clamp(40px, 5vw, 60px)', fontWeight: 900, lineHeight: 1,
              color: C.text, letterSpacing: '-0.03em',
              textShadow: `0 0 30px ${C.teal}40`,
            }}>
              ${capitalParaJornada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            {connectedBrokers.length > 1 && (
              <div className="mt-2 text-[9px] font-mono" style={{ color: C.sub }}>
                {connectedBrokers.map(b => `${b.nome} $${b.balance.toFixed(2)}`).join(' · ')}
              </div>
            )}
            {metaAccount && (
              <div className="mt-1.5 flex items-center gap-4 text-[9px] font-mono">
                <span style={{ color: C.sub }}>Equity ao vivo: <span style={{ color: C.text }}>${metaAccount.equity.toFixed(2)}</span></span>
                <span style={{ color: C.sub }}>Margem livre: <span style={{ color: C.blue }}>${metaAccount.freeMargin.toFixed(2)}</span></span>
              </div>
            )}
          </div>

          {/* Card 2: P&L Hoje */}
          <div className="rounded-xl p-5" style={{
            background: `linear-gradient(160deg, ${C.card} 0%, #060f1a 100%)`,
            border: `1px solid ${heroColor}50`,
            boxShadow: `inset 0 3px 0 ${heroColor}, 0 12px 40px ${heroColor}18`,
          }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[8px] uppercase tracking-widest font-bold" style={{ color: heroColor }}>P&amp;L Hoje</span>
              {connectedBrokers.length > 0
                ? <span className="text-[8px] font-mono flex items-center gap-1" style={{ color: C.teal }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: C.teal }} />ao vivo
                  </span>
                : <span className="text-[8px] font-mono" style={{ color: C.muted }}>calculado</span>
              }
            </div>
            <div style={{
              fontFamily: "'Barlow Condensed', 'Arial Black', sans-serif",
              fontSize: 'clamp(40px, 5vw, 60px)', fontWeight: 900, lineHeight: 1,
              color: heroColor, letterSpacing: '-0.03em',
              textShadow: `0 0 30px ${heroColor}50`,
            }}>
              {todayPnl >= 0 ? '+' : ''}${Math.abs(todayPnl).toFixed(2)}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
              {todayPct !== 0 && (
                <span className="font-black font-mono px-2 py-0.5 rounded text-sm" style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  background: `${heroColor}20`, color: heroColor, border: `1px solid ${heroColor}40`,
                }}>
                  {todayPct >= 0 ? '+' : ''}{todayPct.toFixed(2)}%
                </span>
              )}
              {winRate !== null && (
                <span className="text-[9px] font-mono" style={{ color: C.sub }}>
                  Win rate <span style={{ color: winRateColor, fontWeight: 700 }}>{winRate}%</span>
                </span>
              )}
              <span className="text-[9px] font-mono" style={{ color: C.sub }}>
                Ops <span style={{ color: C.text, fontWeight: 700 }}>{wins + losses}</span>
              </span>
              {avgRR && (
                <span className="text-[9px] font-mono" style={{ color: C.sub }}>
                  R:R médio <span style={{ color: parseFloat(avgRR) >= 1.5 ? C.teal : C.gold, fontWeight: 700 }}>{avgRR}×</span>
                </span>
              )}
            </div>
            {gate.dailyGoalMet && (
              <div className="mt-2 text-[9px]" style={{ color: C.teal }}>
                ✓ Meta diária batida · sessão encerrada
              </div>
            )}
          </div>

          {/* Card 3: Progresso de Metas */}
          <div className="rounded-xl p-5" style={{
            background: `linear-gradient(160deg, ${C.card} 0%, #060f1a 100%)`,
            border: `1px solid #a855f745`,
            boxShadow: `inset 0 3px 0 #a855f7, 0 12px 40px #a855f715`,
          }}>
            <div className="text-[8px] uppercase tracking-widest font-bold mb-4" style={{ color: '#a855f7' }}>Progresso de Metas</div>
            <div className="space-y-4">
              {[
                { key: 'DIÁRIA',  value: todayPnl, target: sessionConfig.dailyGoal,   color: C.teal },
                { key: 'SEMANAL', value: gate.weekPnl,  target: sessionConfig.weeklyGoal,  color: C.blue },
                { key: 'MENSAL',  value: gate.monthPnl, target: sessionConfig.monthlyGoal, color: '#a855f7' },
              ].map(g => {
                const pct = g.value <= 0 ? 0 : Math.min(g.value / g.target * 100, 100)
                const met = pct >= 100
                const pctStr = sessionConfig.capitalInicial > 0 ? `${g.value >= 0 ? '+' : ''}${(g.value / sessionConfig.capitalInicial * 100).toFixed(1)}%` : ''
                return (
                  <div key={g.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[8px] uppercase tracking-widest" style={{ color: C.muted }}>{g.key}</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color: met ? C.teal : g.color }}>
                        {pctStr}{met ? ' ✓' : ''}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.card2 }}>
                      <div className="h-full rounded-full transition-all duration-700" style={{
                        width: `${Math.max(0, pct).toFixed(1)}%`, background: met ? C.teal : g.color,
                        opacity: pct <= 0 ? 0.3 : 1,
                      }} />
                    </div>
                    {met && <div className="text-[8px] mt-0.5" style={{ color: C.teal }}>✓ meta {g.key.toLowerCase()} cumprida</div>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Broker Matrix ─────────────────────────────────────────────────── */}
        {brokersLive.length > 0 && <BrokerCompareRow brokers={brokersLive} />}

        {/* ── COCKPIT CONTROL BOARD ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Col 1 · Metas em Cascata */}
          <GoalsCascade gate={gate} cfg={sessionConfig} capitalAtual={capitalParaJornada} todayPnlOverride={todayPnlMeta} />

          {/* Col 2 · Disciplina & Sessão */}
          <DisciplinePanel gate={gate} cfg={sessionConfig} />

          {/* Col 3 · Inteligência RAFI */}
          <IntelPanel
            trades={trades}
            winRate={winRate}
            avgRR={avgRR}
            rafiStrong={rafiStrong}
            winsCount={wins}
            lossesCount={losses}
            pendingCount={pending}
          />
        </div>

        {/* ── Bottom section: 2 cols ────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Operações Recentes */}
          <div className="rounded-xl overflow-hidden" style={{
            background: C.card,
            border: `1px solid ${C.gold}40`,
            boxShadow: `inset 0 3px 0 ${C.gold}`,
          }}>
            <div className="px-4 py-3 border-b flex items-center justify-between" style={{ background: C.bg, borderColor: C.border }}>
              <div className="flex items-center gap-3">
                <span className="text-[9px] uppercase tracking-widest font-bold" style={{ color: C.gold }}>Operações Recentes</span>
                <div className="flex gap-1">
                  {(['hoje', '7d', '30d'] as const).map(f => (
                    <button key={f} onClick={() => setTradeFilter(f)}
                      className="text-[8px] px-2 py-0.5 rounded font-mono uppercase transition-colors"
                      style={tradeFilter === f
                        ? { background: `${C.blue}25`, color: C.blue, border: `1px solid ${C.blue}50` }
                        : { background: 'transparent', color: C.muted, border: '1px solid transparent' }}>
                      {f === 'hoje' ? 'Hoje' : f === '7d' ? '7 Dias' : '30 Dias'}
                    </button>
                  ))}
                </div>
              </div>
              <Link href="/admin/export"
                className="flex items-center gap-1 text-[9px] hover:underline" style={{ color: C.blue }}>
                Ver todos <ChevronRight size={10} />
              </Link>
            </div>
            {filteredTrades.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <BarChart2 size={28} style={{ color: C.border }} className="mb-2" />
                <p className="text-xs" style={{ color: C.muted }}>Nenhum trade neste período.</p>
              </div>
            ) : (
              <div>
                <div className="flex gap-2 px-4 py-1.5 text-[8px] uppercase tracking-wider border-b" style={{ color: C.muted, borderColor: C.border }}>
                  <span className="w-20 shrink-0">Hora</span>
                  <span className="w-14 shrink-0">Direção</span>
                  <span className="w-20 shrink-0">Entrada</span>
                  <span className="w-10 text-right shrink-0">R:R</span>
                  <span className="ml-auto text-right">P&amp;L</span>
                </div>
                {filteredTrades.map(t => {
                  const r  = riskPips(t.entry, t.stopLoss, t.direction)
                  const w  = rewardPips(t.entry, t.takeProfit, t.direction)
                  const rr = r > 0 ? (w / r).toFixed(1) : '—'
                  const trPnl = calcTradePnl(t)
                  const pnlColor = t.result === 'win' ? C.teal : t.result === 'loss' ? C.rose : C.sub
                  const isPend = !t.result || t.result === 'pending'
                  return (
                    <div key={t.id} className="flex items-center gap-2 px-4 py-2 text-xs font-mono border-b" style={{
                      borderColor: C.card2,
                      background: t.result === 'win' ? `${C.teal}06` : t.result === 'loss' ? `${C.rose}06` : 'transparent',
                    }}>
                      <span className="w-20 shrink-0 truncate text-[9px] font-mono" style={{ color: C.sub }}>
                        {new Date(t.time * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="w-14 shrink-0 flex items-center gap-1 text-[9px]">
                        {t.direction === 'buy'
                          ? <span className="flex items-center gap-1" style={{ color: C.blue }}><TrendingUp size={9} />BUY</span>
                          : <span className="flex items-center gap-1" style={{ color: C.gold }}><TrendingDown size={9} />SELL</span>
                        }
                        {!isPend && (
                          t.result === 'win'
                            ? <span className="text-[7px] px-1 rounded" style={{ background: `${C.teal}20`, color: C.teal }}>TP</span>
                            : t.result === 'loss'
                              ? <span className="text-[7px] px-1 rounded" style={{ background: `${C.rose}20`, color: C.rose }}>SL</span>
                              : null
                        )}
                      </span>
                      <span className="w-20 shrink-0 text-[9px]" style={{ color: C.text }}>{t.entry.toFixed(5)}</span>
                      <span className="w-10 text-right shrink-0 text-[9px] font-bold" style={{
                        color: parseFloat(rr) >= 1.5 ? C.teal : parseFloat(rr) >= 1 ? C.gold : C.muted,
                      }}>{rr}×</span>
                      <span className="ml-auto text-[9px] font-bold" style={{ color: pnlColor }}>
                        {!isPend ? (trPnl >= 0 ? '+' : '') + `$${trPnl.toFixed(2)}` : (
                          <span className="flex items-center gap-1">
                            <button onClick={() => handleLabel(t.id, 'win')} className="px-1 py-0.5 rounded cursor-pointer" style={{ background: `${C.teal}20`, color: C.teal, border: `1px solid ${C.teal}40`, fontSize: 8 }}>WIN</button>
                            <button onClick={() => handleLabel(t.id, 'loss')} className="px-1 py-0.5 rounded cursor-pointer" style={{ background: `${C.rose}20`, color: C.rose, border: `1px solid ${C.rose}40`, fontSize: 8 }}>LOSS</button>
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
                <div className="px-4 py-2 text-[9px] font-mono flex items-center justify-between" style={{
                  borderTop: `1px solid ${C.border}`, color: C.sub,
                }}>
                  <span>{filteredTrades.filter(t => t.result === 'win').length}W · {filteredTrades.filter(t => t.result === 'loss').length}L
                    {filteredTrades.filter(t => t.result === 'win').length + filteredTrades.filter(t => t.result === 'loss').length > 0 && (
                      <span style={{ color: C.teal }}> · {Math.round(filteredTrades.filter(t => t.result === 'win').length / (filteredTrades.filter(t => t.result === 'win').length + filteredTrades.filter(t => t.result === 'loss').length) * 100)}% win rate</span>
                    )}
                  </span>
                  <span style={{ color: C.teal }}>
                    Total: {(() => {
                      const s = filteredTrades.reduce((acc, t) => acc + calcTradePnl(t), 0)
                      return (s >= 0 ? '+' : '') + `$${s.toFixed(2)}`
                    })()}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Controle de Sessão */}
          <div className="rounded-xl overflow-hidden" style={{
            background: C.card,
            border: `1px solid ${gate.isLocked ? C.rose : C.teal}40`,
            boxShadow: `inset 0 3px 0 ${gate.isLocked ? C.rose : C.teal}`,
          }}>
            <div className="px-4 py-3 border-b" style={{ background: C.bg, borderColor: C.border }}>
              <span className="text-[9px] uppercase tracking-widest font-bold" style={{ color: gate.isLocked ? C.rose : C.teal }}>Controle de Sessão</span>
            </div>
            <div className="p-5 space-y-4">
              {/* Status */}
              <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.card2 }}>
                <span className="text-[10px]" style={{ color: C.sub }}>Status</span>
                <span className="text-[10px] font-bold font-mono flex items-center gap-2" style={{ color: gate.isLocked ? C.rose : C.teal }}>
                  {gate.isLocked ? (
                    <><Lock size={10} /> BLOQUEADO · {gate.lockReason}</>
                  ) : (
                    <><Radio size={10} className="animate-pulse" /> ABERTO</>
                  )}
                </span>
              </div>

              {/* Janela */}
              <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.card2 }}>
                <span className="text-[10px]" style={{ color: C.sub }}>Janela</span>
                <span className="text-[10px] font-mono" style={{ color: C.text }}>
                  {sessionConfig.sessionStartUTC}–{sessionConfig.sessionEndUTC} UTC
                </span>
              </div>

              {/* Retoma */}
              {!gate.isDayAllowed || !gate.isTimeAllowed ? (
                <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.card2 }}>
                  <span className="text-[10px]" style={{ color: C.sub }}>Retoma</span>
                  <span className="text-[10px] font-mono" style={{ color: C.teal }}>{nextSessionStr}</span>
                </div>
              ) : null}

              {/* Corretora ativa */}
              {primaryBroker && (
                <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.card2 }}>
                  <span className="text-[10px]" style={{ color: C.sub }}>Corretora</span>
                  <span className="text-[10px] font-mono" style={{ color: C.text }}>{primaryBroker.nome}</span>
                </div>
              )}

              {/* Quick actions */}
              <div className="flex items-center gap-2 pt-1">
                <Link href="/admin/chart"
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-semibold"
                  style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}30`, color: C.blue }}>
                  <BarChart2 size={10} /> Mapear
                </Link>
                <Link href="/admin/export"
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-semibold"
                  style={{ background: `${C.teal}12`, border: `1px solid ${C.teal}25`, color: C.teal }}>
                  <Download size={10} /> Dataset
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
