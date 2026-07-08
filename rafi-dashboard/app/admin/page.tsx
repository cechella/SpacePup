'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import {
  TrendingUp, TrendingDown, BarChart2, Activity,
  Target, AlertTriangle, ChevronRight, Download,
  Zap, Clock, Award, X as XIcon, Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Modal de preview do screenshot ───────────────────────────────────────────
function SnapshotModal({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)

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
      style={{ background: 'rgba(0,0,0,0.88)' }}
      onClick={onClose}
    >
      <div
        className="relative rounded-xl overflow-hidden border border-[#30363d] shadow-2xl flex flex-col"
        style={{ maxWidth: '92vw', maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="bg-[#0d1117] px-4 py-2 text-[10px] text-[#484f58] border-b border-[#30363d] flex items-center justify-between shrink-0">
          <span>Captura do gráfico no momento da execução</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoom(z => clampZoom(z - 0.25))}
              className="w-6 h-6 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#f0f6fc] flex items-center justify-center text-xs font-bold"
            >−</button>
            <span className="font-mono text-[#8b949e] w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom(z => clampZoom(z + 0.25))}
              className="w-6 h-6 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#f0f6fc] flex items-center justify-center text-xs font-bold"
            >+</button>
            <button
              onClick={onClose}
              className="ml-2 p-1 rounded-full bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#f0f6fc] transition-colors"
            >
              <XIcon size={12} />
            </button>
          </div>
        </div>
        {/* Image area — scrollable when zoomed */}
        <div
          className="overflow-auto bg-[#0d1117]"
          style={{ maxHeight: 'calc(85vh - 40px)' }}
          onWheel={handleWheel}
        >
          <img
            src={src}
            alt="Gráfico no trade"
            style={{
              display: 'block',
              width: `${zoom * 100}%`,
              minWidth: zoom < 1 ? undefined : '100%',
              imageRendering: zoom > 1.5 ? 'pixelated' : 'auto',
              transition: 'width 0.1s ease',
            }}
          />
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
  snapshot?: string
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
    <div className="flex items-center justify-center h-full text-[10px] text-[#484f58]">
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
  const color = finalPnl >= 0 ? '#10b981' : '#ef4444'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dash-eq" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1={toY(0).toFixed(1)} x2={W} y2={toY(0).toFixed(1)}
        stroke="#30363d" strokeWidth="1" strokeDasharray="3 3" />
      <path d={fill} fill="url(#dash-eq)" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={toX(pts.length - 1)} cy={toY(finalPnl)} r="4" fill={color} />
    </svg>
  )
}

// ── Progress bar do ML ────────────────────────────────────────────────────────
function MLProgress({ current }: { current: number }) {
  const pct = Math.min((current / ML_TARGET) * 100, 100)
  const color = pct >= 100 ? '#10b981' : pct >= 50 ? '#3b82f6' : '#f59e0b'
  const phase = pct >= 100 ? 'Pronto para treinar!' : pct >= 50 ? 'Fase 1B quase lá' : 'Fase 1A — mapeando'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#8b949e] font-medium">{phase}</span>
        <span className="font-mono font-bold" style={{ color }}>{current} / {ML_TARGET}</span>
      </div>
      <div className="h-2 bg-[#21262d] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex items-center justify-between text-[9px] text-[#484f58]">
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
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-widest text-[#484f58]">{label}</span>
        {Icon && <Icon size={13} style={{ color: color ?? '#484f58' }} />}
      </div>
      <div className="text-2xl font-black font-mono" style={{ color: color ?? '#f0f6fc' }}>{value}</div>
      {sub && <div className="text-[10px] text-[#484f58]">{sub}</div>}
    </div>
  )
}

// ── Chips de observação ML por trade ──────────────────────────────────────────
function MLChips({ t, onSnapClick }: { t: ManualTrade; onSnapClick?: (src: string) => void }) {
  const r  = riskPips(t.entry, t.stopLoss, t.direction)
  const w  = rewardPips(t.entry, t.takeProfit, t.direction)
  const rr = r > 0 ? w / r : 0

  const chips: { label: string; color: string; note: string }[] = []

  // RAFI
  if (t.rafi !== undefined) {
    if (t.rafi >= 2.5)
      chips.push({ label: `RAFI ${t.rafi.toFixed(1)} ✓`, color: '#10b981', note: 'sinal forte — padrão ideal para o ML' })
    else if (t.rafi >= 1)
      chips.push({ label: `RAFI ${t.rafi.toFixed(1)} ⚠`, color: '#f59e0b', note: 'abaixo de 2.5 — ML aprende a filtrar este sinal fraco' })
    else
      chips.push({ label: `RAFI ${t.rafi.toFixed(1)} ✗`, color: '#ef4444', note: 'RAFI muito fraco — contra-exemplo valioso para o ML' })
  }

  // R:R
  if (rr >= 2)
    chips.push({ label: `R:R ${rr.toFixed(1)}× excelente`, color: '#10b981', note: 'acima de 2:1 — risco/retorno ótimo' })
  else if (rr >= 1.5)
    chips.push({ label: `R:R ${rr.toFixed(1)}× ok`, color: '#3b82f6', note: 'acima da meta 1.5× — aceitável' })
  else if (rr > 0)
    chips.push({ label: `R:R ${rr.toFixed(1)}× ⚠`, color: '#f59e0b', note: 'abaixo da meta 1.5× — ML aprende que este setup é arriscado' })

  // Alinhamento direção x RAFI
  if (t.rafiDir) {
    const aligned = (t.direction === 'buy' && t.rafiDir === 'bull') ||
                    (t.direction === 'sell' && t.rafiDir === 'bear')
    if (aligned)
      chips.push({ label: 'Direção ✓', color: '#10b981', note: 'RAFI confirma a direção do trade' })
    else
      chips.push({ label: 'Divergência ✗', color: '#ef4444', note: 'RAFI aponta direção oposta — sinal de alerta' })
  }

  // BB Width
  if (t.bbWidth !== undefined) {
    if (t.bbWidth > 0.0015)
      chips.push({ label: 'BB aberto ✓', color: '#10b981', note: 'Bollinger expandindo — timing de entrada favorável' })
    else
      chips.push({ label: 'BB estreito ⚠', color: '#f59e0b', note: 'Bollinger estreito — mercado lateral, timing ruim' })
  }

  if (!chips.length && !t.snapshot) return null

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2.5 border-b border-[#21262d]">
      {/* Miniatura clicável do gráfico */}
      {t.snapshot && (
        <button
          onClick={() => onSnapClick?.(t.snapshot!)}
          title="Clique para ampliar"
          style={{ flexShrink: 0, marginRight: 6, padding: 0, border: 'none', background: 'none', cursor: 'zoom-in' }}
        >
          <img
            src={t.snapshot}
            alt="gráfico no trade"
            style={{
              width: 120, height: 40,
              borderRadius: 4,
              border: '1px solid #30363d',
              objectFit: 'cover',
              opacity: 0.85,
              display: 'block',
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '0.85')}
          />
        </button>
      )}
      {chips.length > 0 && (
        <span className="text-[8px] text-[#484f58] mr-1 uppercase tracking-wider shrink-0">ML →</span>
      )}
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
function TradeRow({ t, onLabel, onSnapClick }: { t: ManualTrade; onLabel?: (id: string, r: 'win' | 'loss') => void; onSnapClick?: (src: string) => void }) {
  const r       = riskPips(t.entry, t.stopLoss, t.direction)
  const w       = rewardPips(t.entry, t.takeProfit, t.direction)
  const rr      = r > 0 ? (w / r).toFixed(1) : '—'
  const gainUSD = w * pipValueUSD(t.lot)
  const riskUSD = r * pipValueUSD(t.lot)
  const dt = new Date(t.time * 1000)
  const ds = `${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  const isPending = !t.result || t.result === 'pending'
  return (
    <div className={cn(
      t.result === 'win'  && 'bg-[#10b981]/5',
      t.result === 'loss' && 'bg-[#ef4444]/5',
    )}>
      <div className="flex items-center gap-2 px-4 py-2 text-xs font-mono">
        <span className="text-[#484f58] w-24 shrink-0">{ds}</span>
        {t.direction === 'buy'
          ? <span className="flex items-center gap-1 text-[#3b82f6] w-12 shrink-0"><TrendingUp size={10} />BUY</span>
          : <span className="flex items-center gap-1 text-[#f59e0b] w-12 shrink-0"><TrendingDown size={10} />SELL</span>
        }
        <span className="text-[#f0f6fc] w-20 shrink-0">{t.entry.toFixed(5)}</span>
        <span className="text-[#10b981] w-14 text-right shrink-0 font-bold">+${gainUSD.toFixed(0)}</span>
        <span className="text-[#ef4444] w-14 text-right shrink-0">-${riskUSD.toFixed(0)}</span>
        <span className={cn('w-9 text-right shrink-0 font-bold',
          parseFloat(rr) >= 1.5 ? 'text-[#10b981]' : parseFloat(rr) >= 1 ? 'text-[#f59e0b]' : 'text-[#ef4444]')}>
          {rr}×
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {isPending && onLabel ? (
            <>
              <button onClick={() => onLabel(t.id, 'win')}
                className="px-2 py-0.5 rounded text-[9px] font-bold bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/30 hover:bg-[#10b981]/30 transition-colors cursor-pointer">
                WIN
              </button>
              <button onClick={() => onLabel(t.id, 'loss')}
                className="px-2 py-0.5 rounded text-[9px] font-bold bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/30 hover:bg-[#ef4444]/30 transition-colors cursor-pointer">
                LOSS
              </button>
            </>
          ) : t.result === 'win' ? (
            <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/25">WIN</span>
          ) : t.result === 'loss' ? (
            <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/25">LOSS</span>
          ) : null}
        </div>
      </div>
      <MLChips t={t} onSnapClick={onSnapClick} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

// Tiers de escalonamento agressivo: dobra o lote conforme o capital sobe
const SCALE_TIERS = [
  { minCap: 0,       lot: 0.20,  label: '$100'  },
  { minCap: 150,     lot: 0.40,  label: '$150'  },
  { minCap: 200,     lot: 0.80,  label: '$200'  },
  { minCap: 300,     lot: 1.00,  label: '$300'  },
  { minCap: 600,     lot: 2.00,  label: '$600'  },
  { minCap: 1_200,   lot: 4.00,  label: '$1.2k' },
  { minCap: 2_500,   lot: 8.00,  label: '$2.5k' },
  { minCap: 5_000,   lot: 15.00, label: '$5k'   },
  { minCap: 10_000,  lot: 30.00, label: '$10k'  },
  { minCap: 25_000,  lot: 60.00, label: '$25k'  },
  { minCap: 50_000,  lot: 120.00,label: '$50k'  },
  { minCap: 100_000, lot: 250.00,label: '$100k' },
  { minCap: 200_000, lot: 500.00,label: '$200k' },
]

function getLot(c: number): number {
  let lot = SCALE_TIERS[0].lot
  for (const t of SCALE_TIERS) { if (c >= t.minCap) lot = t.lot }
  return lot
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

// Gráfico em escala log (eixo Y) para mostrar crescimento exponencial
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

  // Grid lines para 1k, 10k, 100k, 300k
  const gridLines = [1_000, 10_000, 100_000, 300_000].filter(v => {
    const y = toY(v); return y > 4 && y < H - 4
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      {gridLines.map(v => (
        <g key={v}>
          <line x1="0" y1={toY(v)} x2={W} y2={toY(v)} stroke="#30363d" strokeWidth="1" strokeDasharray="3 3" />
          <text x="4" y={toY(v) - 3} fill="#484f58" fontSize="8" fontFamily="monospace">{fmtK(v)}</text>
        </g>
      ))}
      <path d={makePath(pts3)} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.6" />
      <path d={makePath(pts2)} fill="none" stroke="#f59e0b" strokeWidth="2" />
      <path d={makePath(pts1)} fill="none" stroke="#10b981" strokeWidth="2.5" />
      <circle cx={toX(n - 1)} cy={toY(pts1[n - 1])} r="4"   fill="#10b981" />
      <circle cx={toX(n - 1)} cy={toY(pts2[n - 1])} r="3.5" fill="#f59e0b" />
      <circle cx={toX(n - 1)} cy={toY(pts3[n - 1])} r="3"   fill="#ef4444" />
    </svg>
  )
}

// ── Simulador de crescimento exponencial ─────────────────────────────────────
function LotScalingWidget({ trades }: { trades: ManualTrade[] }) {
  const [winRate, setWinRate] = useState(60)
  const N_SIM = 200  // trades simulados

  const avgRiskP = useMemo(() => {
    if (!trades.length) return 5
    return trades.reduce((s, t) => s + riskPips(t.entry, t.stopLoss, t.direction), 0) / trades.length
  }, [trades])

  const avgRewardP = useMemo(() => {
    if (!trades.length) return 7.5
    return trades.reduce((s, t) => s + rewardPips(t.entry, t.takeProfit, t.direction), 0) / trades.length
  }, [trades])

  // Simulação determinística com padrão de win/loss
  const simulate = useCallback((wr: number): number[] => {
    const pts = [100]
    let c = 100
    const period = 100
    const wins   = Math.round(wr)  // ex: 60 wins em 100 trades
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

  // Quantos trades para $300k no cenário selecionado
  const tradesTo300k = useMemo(() => {
    const pts = simulate(winRate)
    const idx = pts.findIndex(v => v >= 300_000)
    return idx === -1 ? null : idx
  }, [simulate, winRate])

  const currentPts = useMemo(() => simulate(winRate), [simulate, winRate])
  const finalCap   = currentPts[currentPts.length - 1]

  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-[#f59e0b]" />
          <div>
            <span className="text-sm font-semibold text-[#f0f6fc]">Escalonamento Exponencial de Lote</span>
            <span className="ml-2 text-[9px] text-[#484f58]">$100 → $300k · EURUSD</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-[#484f58] mr-1">Win rate:</span>
          {[50, 60, 70].map(w => (
            <button key={w} onClick={() => setWinRate(w)}
              className={cn('px-3 py-1.5 rounded-lg text-xs font-bold transition-all border',
                winRate === w ? 'bg-[#3b82f6]/15 border-[#3b82f6]/40 text-[#3b82f6]'
                             : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]')}>
              {w}%
            </button>
          ))}
        </div>
      </div>

      {/* KPIs da simulação */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0d1117] rounded-lg p-3 text-center">
          <div className="text-[9px] uppercase tracking-wider text-[#484f58] mb-1">Capital após {N_SIM} trades</div>
          <div className={cn('text-xl font-black font-mono', finalCap >= 300_000 ? 'text-[#10b981]' : finalCap > 100 ? 'text-[#f59e0b]' : 'text-[#ef4444]')}>
            {fmtK(finalCap)}
          </div>
          <div className="text-[8px] text-[#484f58] mt-0.5">com {winRate}% win rate</div>
        </div>
        <div className="bg-[#0d1117] rounded-lg p-3 text-center">
          <div className="text-[9px] uppercase tracking-wider text-[#484f58] mb-1">Trades p/ $300k</div>
          <div className={cn('text-xl font-black font-mono', tradesTo300k ? 'text-[#10b981]' : 'text-[#ef4444]')}>
            {tradesTo300k ? tradesTo300k : '> ' + N_SIM}
          </div>
          <div className="text-[8px] text-[#484f58] mt-0.5">
            {tradesTo300k ? `≈ ${Math.ceil(tradesTo300k / 3)} dias (3/dia)` : 'não atingido'}
          </div>
        </div>
        <div className="bg-[#0d1117] rounded-lg p-3 text-center">
          <div className="text-[9px] uppercase tracking-wider text-[#484f58] mb-1">Lote atual ($100)</div>
          <div className="text-xl font-black font-mono text-[#f59e0b]">0.20L</div>
          <div className="text-[8px] text-[#484f58] mt-0.5">
            +${(avgRewardP * 0.20 * 10).toFixed(0)}/WIN · -${(avgRiskP * 0.20 * 10).toFixed(0)}/LOSS
          </div>
        </div>
      </div>

      {/* Tabela de tiers */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[8px] uppercase tracking-wider text-[#484f58] border-b border-[#30363d]">
              <th className="text-left py-2 pr-3 font-medium">Capital</th>
              <th className="text-right py-2 px-2 font-medium">Lote</th>
              <th className="text-right py-2 px-2 font-medium text-[#10b981]">WIN/trade</th>
              <th className="text-right py-2 px-2 font-medium text-[#ef4444]">LOSS/trade</th>
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
                <tr key={tier.minCap} className={cn(
                  'border-b border-[#30363d]/40',
                  isActive && 'bg-[#f59e0b]/8',
                )}>
                  <td className="py-1.5 pr-3">
                    <span className={cn('font-bold', isActive ? 'text-[#f59e0b]' : 'text-[#8b949e]')}>
                      {tier.label}
                    </span>
                    {isActive && <span className="ml-1.5 text-[8px] bg-[#f59e0b]/20 text-[#f59e0b] px-1 py-px rounded">AGORA</span>}
                  </td>
                  <td className="py-1.5 px-2 text-right font-bold text-[#f0f6fc]">{tier.lot.toFixed(2)}L</td>
                  <td className="py-1.5 px-2 text-right text-[#10b981] font-bold">+${gain.toFixed(0)}</td>
                  <td className="py-1.5 px-2 text-right text-[#ef4444]">-${loss.toFixed(0)}</td>
                  <td className={cn('py-1.5 px-2 text-right',
                    pctRisk > 50 ? 'text-[#ef4444]' : pctRisk > 20 ? 'text-[#f59e0b]' : 'text-[#8b949e]')}>
                    {pctRisk.toFixed(0)}%
                  </td>
                  <td className={cn('py-1.5 pl-2 text-right font-bold', ev >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                    {ev >= 0 ? '+' : ''}${ev.toFixed(0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Gráfico exponencial log */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider text-[#484f58]">
            Projeção — {N_SIM} trades · escala logarítmica
          </span>
          <div className="flex items-center gap-4 text-[9px] text-[#484f58]">
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#10b981] inline-block" />70%</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#f59e0b] inline-block" />60%</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#ef4444] inline-block" />50%</span>
          </div>
        </div>
        <div className="bg-[#0d1117] rounded-lg px-3 py-2">
          <ExpChart pts1={pt70} pts2={pt60} pts3={pt50} height={120} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[9px] font-mono mt-1">
          <span className="text-[#10b981]">70%: {fmtK(pt70[pt70.length - 1])}</span>
          <span className="text-[#f59e0b] text-center">60%: {fmtK(pt60[pt60.length - 1])}</span>
          <span className="text-[#ef4444] text-right">50%: {fmtK(pt50[pt50.length - 1])}</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [trades,       setTrades]       = useState<ManualTrade[]>([])
  const [mounted,      setMounted]      = useState(false)
  const [activeSnap,   setActiveSnap]   = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setTrades(parsed)
      }
    } catch {}
  }, [])

  const handleLabel = (id: string, result: 'win' | 'loss') => {
    const updated = trades.map(t => t.id === id ? { ...t, result } : t)
    setTrades(updated)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
  }

  const wins    = trades.filter(t => t.result === 'win').length
  const losses  = trades.filter(t => t.result === 'loss').length
  const pending = trades.filter(t => !t.result || t.result === 'pending').length
  const decided = wins + losses
  const winRate = decided > 0 ? Math.round(wins / decided * 100) : null

  const pnl = useMemo(() => trades.reduce((acc, t) => {
    if (t.result === 'win')  return acc + rewardPips(t.entry, t.takeProfit, t.direction) * pipValueUSD(t.lot)
    if (t.result === 'loss') return acc - riskPips(t.entry, t.stopLoss, t.direction)    * pipValueUSD(t.lot)
    return acc
  }, 0), [trades])

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

  const winRateColor = winRate === null ? '#f0f6fc'
    : winRate >= 60 ? '#10b981' : winRate >= 50 ? '#f59e0b' : '#ef4444'

  if (!mounted) return null

  return (
    <div className="min-h-screen bg-[#0d1117] p-5 space-y-5">
      {activeSnap && <SnapshotModal src={activeSnap} onClose={() => setActiveSnap(null)} />}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-black text-[#f0f6fc] flex items-center gap-2">
            <Activity size={20} className="text-[#3b82f6]" />
            RAFI Trading Bot
          </h1>
          <p className="text-xs text-[#484f58] mt-0.5">
            Cockpit de mapeamento · EURUSD M5 · XM Ultra Low
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-[#f59e0b]/10 border border-[#f59e0b]/25 text-[#f59e0b]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
            Fase 1A — Mapeamento
          </span>
          <Link href="/admin/chart"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[#3b82f6] text-white hover:bg-[#2563eb] transition-all font-semibold">
            <BarChart2 size={12} /> Mapear Trade
          </Link>
        </div>
      </div>

      {/* ── KPIs ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KPI label="Trades Mapeados" value={trades.length}
          sub={`${pending} aguardando W/L`} color="#3b82f6" icon={Target} />
        <KPI label="Win Rate"
          value={winRate !== null ? `${winRate}%` : '—'}
          sub={`${wins}W · ${losses}L`} color={winRateColor} icon={Award} />
        <KPI label="P&L Simulado"
          value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
          sub={pending > 0 ? `+$${pnlPotential.toFixed(0)} potencial (${pending} pend.)` : 'trades rotulados'}
          color={pnl >= 0 ? '#10b981' : '#ef4444'} icon={Zap} />
        <KPI label="R:R Médio"
          value={avgRR ? `${avgRR}×` : '—'}
          sub="meta ≥ 1.5×" icon={TrendingUp} />
        <KPI label="RAFI ≥ 2.5"
          value={rafiStrong}
          sub={`${trades.length > 0 ? Math.round(rafiStrong / trades.length * 100) : 0}% dos trades`}
          color="#10b981" icon={BarChart2} />
        <KPI label="Pendentes"
          value={pending}
          sub="rotule W ou L" color={pending > 0 ? '#f59e0b' : '#484f58'} icon={Clock} />
      </div>

      {/* ── Progresso ML ────────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-[#3b82f6]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Progresso para Treinar o ML</span>
          </div>
          <span className="text-[10px] text-[#484f58]">Meta: {ML_TARGET} trades rotulados</span>
        </div>
        <MLProgress current={trades.length} />
        {trades.length === 0 && (
          <p className="text-[10px] text-[#484f58] mt-3 text-center">
            Vá para <Link href="/admin/chart" className="text-[#3b82f6] hover:underline">Gráfico RAFI</Link> e comece a mapear os setups da semana de Jun 23-26.
          </p>
        )}
      </div>

      {/* ── Simulador de escalonamento ──────────────────────────────────────── */}
      <LotScalingWidget trades={trades} />

      {/* ── Curva de capital + Trades recentes ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Equity curve */}
        <div className="lg:col-span-1 bg-[#161b22] border border-[#30363d] rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-[#484f58]">Curva de Capital</span>
            <span className={cn('text-sm font-mono font-bold', pnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </span>
          </div>
          <div className="flex-1 min-h-[80px]">
            <EquityCurve trades={trades} />
          </div>
          {/* Mini donut distribuição */}
          <div className="border-t border-[#30363d] pt-3 grid grid-cols-3 text-center">
            <div>
              <div className="text-lg font-black font-mono text-[#10b981]">{wins}</div>
              <div className="text-[9px] text-[#484f58] uppercase">WIN</div>
            </div>
            <div>
              <div className="text-lg font-black font-mono text-[#ef4444]">{losses}</div>
              <div className="text-[9px] text-[#484f58] uppercase">LOSS</div>
            </div>
            <div>
              <div className="text-lg font-black font-mono text-[#484f58]">{pending}</div>
              <div className="text-[9px] text-[#484f58] uppercase">PEND.</div>
            </div>
          </div>
        </div>

        {/* Trades recentes */}
        <div className="lg:col-span-2 bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between bg-[#0d1117]">
            <span className="text-[10px] uppercase tracking-widest text-[#484f58]">Trades Recentes</span>
            <Link href="/admin/export"
              className="flex items-center gap-1 text-[9px] text-[#3b82f6] hover:text-[#93c5fd] transition-colors">
              Ver todos <ChevronRight size={10} />
            </Link>
          </div>
          {trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <BarChart2 size={32} className="text-[#30363d] mb-3" />
              <p className="text-[#484f58] text-xs">Nenhum trade mapeado ainda.</p>
            </div>
          ) : (
            <div>
              <div className="flex gap-2 px-4 py-2 text-[8px] uppercase tracking-wider text-[#484f58] border-b border-[#30363d]">
                <span className="w-24 shrink-0">Data/Hora</span>
                <span className="w-12 shrink-0">Dir</span>
                <span className="w-20 shrink-0">Entrada</span>
                <span className="w-14 shrink-0 text-right text-[#10b981]">Ganho</span>
                <span className="w-14 shrink-0 text-right text-[#ef4444]">Risco</span>
                <span className="w-9 shrink-0 text-right">R:R</span>
                <span className="ml-auto">Resultado</span>
              </div>
              {recent.map(t => <TradeRow key={t.id} t={t} onLabel={handleLabel} onSnapClick={setActiveSnap} />)}
            </div>
          )}
        </div>
      </div>

      {/* ── Ações rápidas ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link href="/admin/chart"
          className="flex items-center gap-3 p-4 bg-[#161b22] border border-[#30363d] rounded-xl hover:border-[#3b82f6]/50 hover:bg-[#3b82f6]/5 transition-all group">
          <div className="w-10 h-10 rounded-lg bg-[#3b82f6]/15 flex items-center justify-center shrink-0">
            <BarChart2 size={18} className="text-[#3b82f6]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f0f6fc]">Gráfico RAFI</div>
            <div className="text-[10px] text-[#484f58]">Mapear novos trades com OCO</div>
          </div>
          <ChevronRight size={14} className="ml-auto text-[#484f58] group-hover:text-[#3b82f6] transition-colors" />
        </Link>

        <Link href="/admin/export"
          className="flex items-center gap-3 p-4 bg-[#161b22] border border-[#30363d] rounded-xl hover:border-[#10b981]/50 hover:bg-[#10b981]/5 transition-all group">
          <div className="w-10 h-10 rounded-lg bg-[#10b981]/15 flex items-center justify-center shrink-0">
            <Download size={18} className="text-[#10b981]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f0f6fc]">Dataset ML</div>
            <div className="text-[10px] text-[#484f58]">Rotular W/L · exportar CSV</div>
          </div>
          <ChevronRight size={14} className="ml-auto text-[#484f58] group-hover:text-[#10b981] transition-colors" />
        </Link>

        <div className="flex items-center gap-3 p-4 bg-[#161b22] border border-[#30363d] rounded-xl opacity-50 cursor-not-allowed">
          <div className="w-10 h-10 rounded-lg bg-[#484f58]/15 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-[#484f58]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#484f58]">Bot Automático</div>
            <div className="text-[10px] text-[#30363d]">Disponível após Fase 2 (ML)</div>
          </div>
        </div>
      </div>
    </div>
  )
}
