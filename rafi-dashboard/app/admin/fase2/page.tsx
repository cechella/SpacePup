'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  Brain, Zap, BarChart2, Download, ChevronRight,
  TrendingUp, TrendingDown, Activity, Target, Clock,
  CheckCircle2, Circle, AlertTriangle, Sparkles, RefreshCw,
  CheckCircle, XCircle, Lightbulb,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchTrades } from '@/lib/trades-db'

interface ManualTrade {
  id: string; direction: 'buy' | 'sell'; entry: number
  stopLoss: number; takeProfit: number; label: string
  time: number; lot: number; leverage: number
  result?: 'win' | 'loss' | 'pending'
  rafi?: number; rafiDir?: 'bull' | 'bear'; bbWidth?: number
  overlapPhase?: 'early' | 'mid' | 'late' | null
  pnlUsd?: number
  checkinSono?:    'otimo' | 'ok' | 'mal'    | null
  checkinEnergia?: 'alta'  | 'ok' | 'baixa'  | null
  checkinMental?:  'focado'| 'ok' | 'ruim'   | null
  checkinHumor?:   'feliz' | 'neutro' | 'triste' | null
}

const STORAGE_KEY  = 'rafi-trade-log'

// Aprendizado progressivo — sem cliff de 300 trades
const ML_CONFIANCA = [
  { min: 0,   max: 1,         label: 'Aguardando 1º trade', cor: '#484f58', pct: 0   },
  { min: 1,   max: 5,         label: 'Aprendendo',           cor: '#ef4444', pct: 18  },
  { min: 5,   max: 15,        label: 'Padrão inicial',        cor: '#f59e0b', pct: 35  },
  { min: 15,  max: 30,        label: 'Melhorando',            cor: '#f59e0b', pct: 55  },
  { min: 30,  max: 60,        label: 'Confiável',             cor: '#3b82f6', pct: 72  },
  { min: 60,  max: Infinity,  label: 'Alta confiança',        cor: '#10b981', pct: 88  },
]
function getConfianca(n: number) {
  return ML_CONFIANCA.find(c => n >= c.min && n < c.max) ?? ML_CONFIANCA[0]
}

function riskPips(e: number, s: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((e - s) * 10000) : Math.round((s - e) * 10000)
}
function rewardPips(e: number, t: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((t - e) * 10000) : Math.round((e - t) * 10000)
}
function fmtDate(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
}
function sessionLabel(ts: number): string {
  const h = new Date(ts * 1000).getUTCHours()
  if (h >= 8  && h < 12) return 'Londres'
  if (h >= 13 && h < 17) return 'NY'
  if (h >= 23 || h < 3)  return 'Ásia'
  return 'Overlap'
}
function isBomEstado(t: ManualTrade): boolean {
  return (
    t.checkinSono    !== 'mal'    &&
    t.checkinMental  !== 'ruim'   &&
    t.checkinHumor   !== 'triste' &&
    t.checkinEnergia !== 'baixa'
  )
}

function exportCSV(trades: ManualTrade[]) {
  const header = 'time,direction,rafi,rafiDir,bbWidth,riskPips,rewardPips,rr,sessao,hora,diaSemana,result,sono,energia,mental,humor'
  const rows = trades
    .filter(t => t.result === 'win' || t.result === 'loss')
    .map(t => {
      const r  = riskPips(t.entry, t.stopLoss, t.direction)
      const w  = rewardPips(t.entry, t.takeProfit, t.direction)
      const rr = r > 0 ? (w / r).toFixed(2) : '0'
      const dt = new Date(t.time * 1000)
      return [
        new Date(t.time * 1000).toISOString(),
        t.direction,
        t.rafi?.toFixed(3) ?? '',
        t.rafiDir ?? '',
        t.bbWidth?.toFixed(5) ?? '',
        r, w, rr,
        sessionLabel(t.time),
        dt.getUTCHours(),
        dt.getUTCDay(),
        t.result,
        t.checkinSono ?? '',
        t.checkinEnergia ?? '',
        t.checkinMental ?? '',
        t.checkinHumor ?? '',
      ].join(',')
    })
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `rafi-ml-fase2-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Padrões aprendidos ────────────────────────────────────────────────────────
interface InsightData {
  label: string
  sublabel: string
  wins: number
  losses: number
  wr: number | null
  color: string
  highlight: boolean
}

function makeInsight(label: string, sublabel: string, trades: ManualTrade[]): InsightData {
  const wins = trades.filter(t => t.result === 'win').length
  const losses = trades.filter(t => t.result === 'loss').length
  const total = wins + losses
  const wr = total > 0 ? Math.round(wins / total * 100) : null
  const color = wr === null ? '#484f58' : wr >= 65 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#ef4444'
  return { label, sublabel, wins, losses, wr, color, highlight: wr !== null && wr >= 65 }
}

function computeInsights(labeled: ManualTrade[]) {
  const rafiStrong   = labeled.filter(t => (t.rafi ?? 0) >= 2.5)
  const rafiModerate = labeled.filter(t => { const r = t.rafi ?? 0; return r >= 1 && r < 2.5 })
  const rafiWeak     = labeled.filter(t => (t.rafi ?? 0) < 1 && t.rafi !== undefined)
  const buys         = labeled.filter(t => t.direction === 'buy')
  const sells        = labeled.filter(t => t.direction === 'sell')

  const withCheckin  = labeled.filter(t => t.checkinSono != null)
  const goodMental   = withCheckin.filter(isBomEstado)
  const badMental    = withCheckin.filter(t => !isBomEstado(t))

  const earlyWeek    = labeled.filter(t => { const d = new Date(t.time*1000).getUTCDay(); return d === 1 || d === 2 })
  const lateWeek     = labeled.filter(t => { const d = new Date(t.time*1000).getUTCDay(); return d === 3 || d === 4 })

  const cards: InsightData[] = [
    makeInsight('RAFI ≥ 2.5', 'Sinal super forte', rafiStrong),
    makeInsight('RAFI 1–2.5', 'Sinal moderado', rafiModerate),
    makeInsight('Compras', 'Direção BUY', buys),
    makeInsight('Vendas', 'Direção SELL', sells),
    makeInsight('Estado ótimo', 'Check-in positivo', goodMental),
    makeInsight('Estado ruim', 'Check-in negativo', badMental),
    makeInsight('Seg/Ter', 'Início da semana', earlyWeek),
    makeInsight('Qua/Qui', 'Final da semana', lateWeek),
  ]

  const withData = cards.filter(c => c.wins + c.losses > 0)
  const topCard = withData.length > 0 ? [...withData].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses))[0] : null

  let topMsg: string | null = null
  if (topCard && topCard.wr !== null) {
    const n = topCard.wins + topCard.losses
    topMsg = `"${topCard.label}": ${n} trade${n > 1 ? 's' : ''} → ${topCard.wr}% acerto${topCard.highlight ? ' ✓' : ''}`
    if (n === 1) topMsg += ' — acumule mais para confirmar'
  } else if (labeled.length === 0) {
    topMsg = 'Mapeie seu primeiro trade para começar o aprendizado'
  }

  // Mental state breakdown per dimension
  function dimStat(filter: (t: ManualTrade) => boolean) {
    return makeInsight('', '', labeled.filter(t => t.checkinSono != null && filter(t)))
  }

  const mental = {
    sono: {
      otimo: dimStat(t => t.checkinSono === 'otimo'),
      ok:    dimStat(t => t.checkinSono === 'ok'),
      mal:   dimStat(t => t.checkinSono === 'mal'),
    },
    energia: {
      alta:  dimStat(t => t.checkinEnergia === 'alta'),
      ok:    dimStat(t => t.checkinEnergia === 'ok'),
      baixa: dimStat(t => t.checkinEnergia === 'baixa'),
    },
    mental: {
      focado: dimStat(t => t.checkinMental === 'focado'),
      ok:     dimStat(t => t.checkinMental === 'ok'),
      ruim:   dimStat(t => t.checkinMental === 'ruim'),
    },
    humor: {
      feliz:  dimStat(t => t.checkinHumor === 'feliz'),
      neutro: dimStat(t => t.checkinHumor === 'neutro'),
      triste: dimStat(t => t.checkinHumor === 'triste'),
    },
  }

  return { cards, topMsg, mental, withCheckin: withCheckin.length }
}

// ── Componente InsightCard ─────────────────────────────────────────────────────
function InsightCard({ d }: { d: InsightData }) {
  return (
    <div className={cn(
      'rounded-xl border p-3 flex flex-col gap-1.5 transition-all',
      d.highlight
        ? 'border-[#10b981]/30 bg-[#10b981]/5'
        : d.wr !== null
        ? 'border-[#30363d] bg-[#0d1117]'
        : 'border-[#21262d] bg-[#0d1117] opacity-60',
    )}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#8b949e]">{d.label}</span>
        {d.highlight && <span className="text-[8px] text-[#10b981]">✓ acima meta</span>}
      </div>
      <div className="text-[9px] text-[#484f58]">{d.sublabel}</div>
      <div className="flex items-end gap-1.5 mt-0.5">
        <span className="text-xl font-black font-mono leading-none" style={{ color: d.color }}>
          {d.wr !== null ? `${d.wr}%` : '—'}
        </span>
      </div>
      <div className="text-[8px] font-mono text-[#484f58]">
        {d.wins + d.losses > 0 ? `${d.wins}W · ${d.losses}L (${d.wins + d.losses})` : 'sem dados'}
      </div>
      {d.wr !== null && (
        <div className="h-1 bg-[#21262d] rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${d.wr}%`, background: d.color }} />
        </div>
      )}
    </div>
  )
}

// ── Mini stat row para mental state breakdown ──────────────────────────────────
function MentalRow({ label, d }: { label: string; d: InsightData }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-[9px] text-[#8b949e] w-16 shrink-0 font-mono">{label}</span>
      <div className="flex-1 h-1.5 bg-[#21262d] rounded-full overflow-hidden">
        {d.wr !== null && (
          <div className="h-full rounded-full" style={{ width: `${d.wr}%`, background: d.color }} />
        )}
      </div>
      <span className="text-[9px] font-mono font-bold w-8 text-right shrink-0" style={{ color: d.color }}>
        {d.wr !== null ? `${d.wr}%` : '—'}
      </span>
      <span className="text-[8px] text-[#484f58] w-10 shrink-0">{d.wins + d.losses > 0 ? `${d.wins}W/${d.losses}L` : ''}</span>
    </div>
  )
}

// ── Curva de Aprendizado ───────────────────────────────────────────────────────
function LearningCurve({ labeled }: { labeled: ManualTrade[] }) {
  if (labeled.length === 0) return (
    <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
      <Brain size={20} className="text-[#30363d]" />
      <p className="text-[10px] text-[#484f58]">Rotule seu 1º trade W ou L para iniciar a curva</p>
    </div>
  )

  const sorted = [...labeled].sort((a, b) => a.time - b.time)
  const pts: { x: number; y: number; win: boolean }[] = []
  let w = 0
  sorted.forEach((t, i) => {
    if (t.result === 'win') w++
    pts.push({ x: i, y: Math.round(w / (i + 1) * 100), win: t.result === 'win' })
  })

  const W = 400, H = 110
  const PL = 28, PR = 8, PT = 12, PB = 18
  const xS = (i: number) => PL + (pts.length <= 1 ? (W - PL - PR) / 2 : (i / (pts.length - 1)) * (W - PL - PR))
  const yS = (v: number) => PT + (1 - v / 100) * (H - PT - PB)
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xS(i).toFixed(1)} ${yS(p.y).toFixed(1)}`).join(' ')
  const thr = yS(65)
  const cur = pts[pts.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 110 }}>
      {[0, 25, 50, 75, 100].map(v => (
        <line key={v} x1={PL} x2={W - PR} y1={yS(v)} y2={yS(v)} stroke="#1c2128" strokeWidth="1" />
      ))}
      {[0, 50, 100].map(v => (
        <text key={v} x={PL - 4} y={yS(v) + 3} textAnchor="end" fill="#484f58" fontSize="7" fontFamily="monospace">{v}%</text>
      ))}
      {/* Meta XGBoost 65% */}
      <line x1={PL} x2={W - PR} y1={thr} y2={thr} stroke="#3b82f6" strokeWidth="1" strokeDasharray="4,3" opacity="0.7" />
      <text x={W - PR - 2} y={thr - 3} textAnchor="end" fill="#3b82f6" fontSize="6" fontFamily="monospace" opacity="0.8">meta 65%</text>
      {/* Linha de aprendizado */}
      {pts.length > 1 && (
        <path d={line} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
      )}
      {/* Pontos */}
      {pts.map((p, i) => (
        <circle key={i} cx={xS(i)} cy={yS(p.y)} r="3.5" fill={p.win ? '#10b981' : '#ef4444'} stroke="#0d1117" strokeWidth="1.5" />
      ))}
      {/* Valor atual */}
      {cur && (
        <text x={xS(pts.length - 1)} y={yS(cur.y) - 6} textAnchor="middle"
          fill={cur.y >= 65 ? '#10b981' : '#f59e0b'} fontSize="9" fontWeight="700" fontFamily="monospace">
          {cur.y}%
        </text>
      )}
      {/* Eixo X: nº do trade */}
      {pts.length > 1 && [0, pts.length - 1].map(i => (
        <text key={i} x={xS(i)} y={H - 2} textAnchor="middle" fill="#484f58" fontSize="6" fontFamily="monospace">
          #{i + 1}
        </text>
      ))}
    </svg>
  )
}

// ── Descobertas da IA ──────────────────────────────────────────────────────────
function computeDiscoveries(labeled: ManualTrade[], insights: ReturnType<typeof computeInsights>): { icon: string; text: string; color: string }[] {
  const out: { icon: string; text: string; color: string }[] = []
  const { cards, mental } = insights

  // Melhor condição
  const best = cards.filter(c => c.wr !== null && (c.wins + c.losses) >= 1)
    .sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0))[0]
  if (best?.wr != null && best.wr >= 60) {
    out.push({ icon: '🏆', text: `${best.label}: ${best.wr}% de acerto (${best.wins + best.losses} trade${best.wins + best.losses > 1 ? 's' : ''})`, color: '#10b981' })
  }

  // Estado mental
  const gCard = cards.find(c => c.label === 'Estado ótimo')
  const bCard = cards.find(c => c.label === 'Estado ruim')
  if (gCard?.wr != null && bCard?.wr != null && gCard.wins + gCard.losses > 0 && bCard.wins + bCard.losses > 0) {
    const diff = gCard.wr - bCard.wr
    if (diff >= 10) out.push({ icon: '🧠', text: `Estado ótimo → +${diff}% de acerto vs estado ruim. Seu humor impacta o resultado.`, color: '#aa55ff' })
  } else if (gCard?.wr != null && gCard.wins + gCard.losses >= 1) {
    out.push({ icon: '🧠', text: `Estado ótimo: ${gCard.wr}% de acerto. Continue registrando para ver o impacto.`, color: '#aa55ff' })
  }

  // Sono
  if (mental.sono.otimo.wins + mental.sono.otimo.losses >= 1) {
    out.push({ icon: '😴', text: `Sono ótimo → ${mental.sono.otimo.wr}% acerto (${mental.sono.otimo.wins + mental.sono.otimo.losses} trades). Vale dormir bem antes de operar.`, color: '#3b82f6' })
  }

  // Pouco dado — encoraja
  if (out.length === 0 && labeled.length >= 1) {
    out.push({ icon: '📊', text: `${labeled.length} trade rotulado. Continue mapeando — a IA já está aprendendo seu padrão.`, color: '#f59e0b' })
  }
  if (out.length === 0) {
    out.push({ icon: '🚀', text: 'Rotule seu primeiro trade W ou L para a IA começar a aprender.', color: '#484f58' })
  }

  return out.slice(0, 3)
}

// ── Pipeline step ────────────────────────────────────────────────────────────
function PipelineStep({ n, label, desc, active, done }: {
  n: number; label: string; desc: string; active?: boolean; done?: boolean
}) {
  return (
    <div className={cn(
      'flex items-start gap-3 p-3 rounded-xl border transition-all',
      done   ? 'border-[#10b981]/30 bg-[#10b981]/5'  :
      active ? 'border-[#3b82f6]/30 bg-[#3b82f6]/5'  :
               'border-[#30363d] bg-[#0d1117] opacity-50',
    )}>
      <div className={cn(
        'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-black',
        done   ? 'bg-[#10b981]/20 text-[#10b981]' :
        active ? 'bg-[#3b82f6]/20 text-[#3b82f6]' :
                 'bg-[#21262d] text-[#484f58]',
      )}>
        {done ? <CheckCircle2 size={14} /> : n}
      </div>
      <div>
        <div className={cn('text-xs font-semibold',
          done ? 'text-[#10b981]' : active ? 'text-[#3b82f6]' : 'text-[#484f58]')}>
          {label}
        </div>
        <div className="text-[10px] text-[#484f58] mt-0.5">{desc}</div>
      </div>
    </div>
  )
}

// ── Feature row ───────────────────────────────────────────────────────────────
function FeatureRow({ t }: { t: ManualTrade }) {
  const r    = riskPips(t.entry, t.stopLoss, t.direction)
  const w    = rewardPips(t.entry, t.takeProfit, t.direction)
  const rr   = r > 0 ? (w / r).toFixed(1) : '—'
  const sess = sessionLabel(t.time)
  const hora = new Date(t.time * 1000).getUTCHours()
  const dia  = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][new Date(t.time * 1000).getUTCDay()]
  const rafiColor = !t.rafi ? '#484f58' : t.rafi >= 2.5 ? '#10b981' : t.rafi >= 1 ? '#f59e0b' : '#ef4444'
  const hasCheckin = t.checkinSono != null
  const bom = hasCheckin ? isBomEstado(t) : null

  return (
    <tr className={cn(
      'border-b border-[#30363d]/40 text-[10px] font-mono hover:bg-[#21262d]/40 transition-colors',
      t.result === 'win'  && 'bg-[#10b981]/4',
      t.result === 'loss' && 'bg-[#ef4444]/4',
    )}>
      <td className="py-1.5 pl-3 text-[#484f58]">{fmtDate(t.time)}</td>
      <td className="py-1.5 px-2">
        {t.direction === 'buy'
          ? <span className="flex items-center gap-1 text-[#3b82f6]"><TrendingUp size={9} />BUY</span>
          : <span className="flex items-center gap-1 text-[#f59e0b]"><TrendingDown size={9} />SELL</span>
        }
      </td>
      <td className="py-1.5 px-2 font-bold" style={{ color: rafiColor }}>
        {t.rafi?.toFixed(1) ?? '—'}
      </td>
      <td className="py-1.5 px-2 text-[#8b949e]">
        {t.bbWidth !== undefined ? (t.bbWidth * 10000).toFixed(1) + 'p' : '—'}
      </td>
      <td className="py-1.5 px-2 text-[#8b949e]">{sess}</td>
      <td className="py-1.5 px-2 text-[#484f58]">{hora}h {dia}</td>
      <td className="py-1.5 px-2 text-[#8b949e]">{rr}×</td>
      <td className="py-1.5 px-2">
        {bom === true  ? <span className="text-[8px] text-[#10b981]">🧠✓</span>
        : bom === false ? <span className="text-[8px] text-[#ef4444]">🧠✗</span>
        : <span className="text-[8px] text-[#484f58]">—</span>}
      </td>
      <td className="py-1.5 pr-3">
        {t.result === 'win'
          ? <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/25">WIN</span>
          : t.result === 'loss'
          ? <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/25">LOSS</span>
          : <span className="text-[#484f58]">—</span>
        }
      </td>
    </tr>
  )
}

// ── Feature importance mock ────────────────────────────────────────────────────
function FeatImportance({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-mono text-[#8b949e] w-24 shrink-0 text-right">{label}</span>
      <div className="flex-1 h-2 bg-[#21262d] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[9px] font-mono text-[#484f58] w-8 shrink-0">{pct}%</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Fase2Page() {
  const [trades, setTrades]           = useState<ManualTrade[]>([])
  const [mounted, setMounted]         = useState(false)
  const [trainStatus, setTrainStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const [trainMsg, setTrainMsg]       = useState('')

  async function handleTreinar() {
    setTrainStatus('loading')
    setTrainMsg('')
    try {
      const res  = await fetch('/api/ml/train', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Erro desconhecido')
      setTrainStatus('ok')
      setTrainMsg('Comando enviado ao bot — retreino iniciado em background')
    } catch (e: any) {
      setTrainStatus('err')
      setTrainMsg(e.message ?? 'Falha ao enviar comando')
    }
  }

  useEffect(() => {
    setMounted(true)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setTrades(parsed)
      }
    } catch {}
    fetchTrades()
      .then(data => { if (data.length > 0) setTrades(data as ManualTrade[]) })
      .catch(() => {})
  }, [])

  const labeled    = useMemo(() => trades.filter(t => t.result === 'win' || t.result === 'loss'), [trades])
  const wins       = labeled.filter(t => t.result === 'win').length
  const losses     = labeled.filter(t => t.result === 'loss').length
  const winRate    = labeled.length > 0 ? Math.round(wins / labeled.length * 100) : null
  const confianca  = getConfianca(labeled.length)
  const insights    = useMemo(() => computeInsights(labeled), [labeled])
  const discoveries = useMemo(() => computeDiscoveries(labeled, insights), [labeled, insights])
  const all         = [...trades].reverse()

  if (!mounted) return null

  return (
    <div className="min-h-screen bg-[#0d1117] p-5 space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-black text-[#f0f6fc] flex items-center gap-2">
            <Brain size={20} className="text-[#3b82f6]" />
            IA — Aprendizado Progressivo
          </h1>
          <p className="text-xs text-[#484f58] mt-0.5">
            A IA aprende desde o 1º trade · melhora continuamente a cada resultado
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn(
            'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border',
            confianca.pct >= 70
              ? 'bg-[#10b981]/10 border-[#10b981]/25 text-[#10b981]'
              : 'bg-[#f59e0b]/10 border-[#f59e0b]/25 text-[#f59e0b]',
          )}>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full',
              confianca.pct >= 70 ? 'bg-[#10b981]' : 'bg-[#f59e0b] animate-pulse',
            )} />
            {confianca.label} — {labeled.length} trades
          </span>
          <button
            onClick={() => labeled.length > 0 && exportCSV(trades)}
            disabled={labeled.length === 0}
            className={cn(
              'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-semibold transition-all',
              labeled.length > 0
                ? 'bg-[#3b82f6]/15 border-[#3b82f6]/30 text-[#3b82f6] hover:bg-[#3b82f6]/25'
                : 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed',
            )}
          >
            <Download size={12} />
            Exportar Dataset ({labeled.length})
          </button>
        </div>
      </div>

      {/* ── Progresso + Pipeline ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* Progresso */}
        <div className="lg:col-span-2 bg-[#161b22] border border-[#30363d] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Target size={14} className="text-[#f59e0b]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Confiança do Modelo</span>
          </div>
          <div className="space-y-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-2xl font-black font-mono" style={{ color: confianca.cor }}>{labeled.length}</div>
                <div className="text-[9px] uppercase tracking-widest text-[#484f58] mt-0.5">{confianca.label}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold font-mono" style={{ color: confianca.cor }}>{confianca.pct}%</div>
                <div className="text-[9px] text-[#484f58]">confiança atual</div>
              </div>
            </div>
            <div className="relative h-3 bg-[#21262d] rounded-full overflow-hidden">
              <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                style={{ width: `${confianca.pct}%`, background: confianca.cor }} />
            </div>
            <div className="flex justify-between text-[8px] text-[#484f58]">
              <span>0</span><span>5</span><span>15</span><span>30</span><span>60+</span>
            </div>
            <div className="text-[9px] text-[#484f58] text-center">
              Cada trade rotulado melhora a precisão — sem mínimo para começar
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-[#30363d]">
            <div className="text-center">
              <div className="text-lg font-black font-mono text-[#10b981]">{wins}</div>
              <div className="text-[8px] uppercase text-[#484f58]">WIN</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-black font-mono text-[#ef4444]">{losses}</div>
              <div className="text-[8px] uppercase text-[#484f58]">LOSS</div>
            </div>
            <div className="text-center">
              <div className={cn(
                'text-lg font-black font-mono',
                winRate === null ? 'text-[#484f58]' :
                winRate >= 60 ? 'text-[#10b981]' :
                winRate >= 50 ? 'text-[#f59e0b]' : 'text-[#ef4444]',
              )}>
                {winRate !== null ? `${winRate}%` : '—'}
              </div>
              <div className="text-[8px] uppercase text-[#484f58]">WIN RATE</div>
            </div>
          </div>
          {insights.withCheckin > 0 && (
            <div className="pt-2 border-t border-[#30363d]">
              <div className="text-[9px] text-[#484f58] mb-0.5">
                🧠 {insights.withCheckin} trade{insights.withCheckin > 1 ? 's' : ''} com check-in mental
              </div>
              <div className="text-[8px] text-[#484f58]">
                A IA cruza humor/sono/energia com resultado para aprender seu perfil
              </div>
            </div>
          )}
        </div>

        {/* Pipeline */}
        <div className="lg:col-span-3 bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={14} className="text-[#3b82f6]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Como a IA aprende</span>
          </div>
          <div className="space-y-2">
            <PipelineStep n={1} label="Trade executado + check-in"
              desc="RAFI, BB Width, sessão, hora, dia da semana, estado mental"
              done={labeled.length >= 1} active={labeled.length === 0} />
            <PipelineStep n={2} label="Resultado rotulado (W/L)"
              desc="A IA aprende o que funcionou naquele contexto exato"
              done={labeled.length >= 1} active={labeled.length === 0} />
            <PipelineStep n={3} label="Padrões detectados automaticamente"
              desc="Win rate por RAFI, sessão, estado mental, dia. Melhora a cada novo trade."
              done={labeled.length >= 1} active={labeled.length === 0} />
            <PipelineStep n={4} label="XGBoost treinável a qualquer momento"
              desc="Com 10+ trades já é útil. Com 30+ fica confiável. Retreino automático."
              active={labeled.length >= 10} done={false} />
          </div>
          <div className="mt-4 pt-4 border-t border-[#30363d]">
            <div className="text-[9px] uppercase tracking-wider text-[#484f58] mb-2">Features capturadas em cada trade</div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { f: 'RAFI valor', c: '#10b981' }, { f: 'RAFI ≥ 2.5?', c: '#10b981' },
                { f: 'BB Width', c: '#3b82f6' }, { f: 'Sessão', c: '#3b82f6' },
                { f: 'Hora (UTC)', c: '#f59e0b' }, { f: 'Dia semana', c: '#f59e0b' },
                { f: 'R:R ratio', c: '#8b949e' }, { f: 'Sono', c: '#aa55ff' },
                { f: 'Energia', c: '#aa55ff' }, { f: 'Mental', c: '#aa55ff' },
                { f: 'Humor', c: '#aa55ff' }, { f: 'Direção', c: '#8b949e' },
              ].map(({ f, c }) => (
                <span key={f} style={{ background: `${c}12`, border: `1px solid ${c}30`, color: c }}
                  className="text-[8px] px-1.5 py-0.5 rounded font-mono">{f}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── O que a IA já sabe ──────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Lightbulb size={14} className="text-[#f59e0b]" />
          <span className="text-sm font-semibold text-[#f0f6fc]">O que a IA já sabe</span>
          <span className="ml-auto text-[9px] text-[#484f58] bg-[#21262d] px-2 py-0.5 rounded">
            {labeled.length} trades rotulados
          </span>
        </div>
        {insights.topMsg && (
          <p className="text-[10px] text-[#8b949e] mb-4 mt-1 bg-[#0d1117] rounded-lg px-3 py-2">
            📊 {insights.topMsg}
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {insights.cards.map(d => <InsightCard key={d.label} d={d} />)}
        </div>
        {labeled.length === 0 && (
          <div className="text-center py-4 text-[10px] text-[#484f58]">
            Vá para Mesa de Operação → mapeie um trade → rotule W ou L → a IA aprende imediatamente
          </div>
        )}
      </div>

      {/* ── Curva de Aprendizado + Descobertas ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Curva de aprendizado */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={14} className="text-[#10b981]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Curva de Aprendizado</span>
            <span className="ml-auto text-[9px] text-[#484f58]">
              cada ponto = 1 trade rotulado
            </span>
          </div>
          <div className="text-[9px] text-[#484f58] mb-3">
            🟢 WIN &nbsp; 🔴 LOSS &nbsp; <span className="text-[#10b981]">linha = win rate acumulado</span>
            &nbsp; <span className="text-[#3b82f6]">- - - meta 65%</span>
          </div>
          <LearningCurve labeled={labeled} />
          {labeled.length > 0 && (
            <div className="mt-2 text-[9px] text-center text-[#484f58]">
              {labeled.length === 1
                ? 'Primeiro trade mapeado — a curva começa aqui'
                : `${labeled.length} trades — a linha mostra sua precisão evoluindo`}
            </div>
          )}
        </div>

        {/* Descobertas da IA */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb size={14} className="text-[#f59e0b]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Descobertas da IA</span>
            <span className="ml-auto text-[9px] text-[#484f58]">atualiza a cada trade</span>
          </div>
          <div className="space-y-3">
            {discoveries.map((d, i) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-xl"
                style={{ background: `${d.color}08`, border: `1px solid ${d.color}25` }}>
                <span className="text-base shrink-0 mt-0.5">{d.icon}</span>
                <p className="text-[10px] leading-relaxed" style={{ color: d.color === '#484f58' ? '#484f58' : '#c9d1d9' }}>
                  {d.text}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-[#30363d]">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse" />
              <span className="text-[9px] text-[#10b981] font-semibold">XGBoost retreina automaticamente</span>
            </div>
            <p className="text-[9px] text-[#484f58]">
              Toda vez que você rotula W ou L na página de histórico, o modelo retreina sozinho — sem você precisar clicar em nada.
            </p>
          </div>
        </div>
      </div>

      {/* ── Estado Mental × Win Rate ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Dimensões do check-in */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm">🧠</span>
            <span className="text-sm font-semibold text-[#f0f6fc]">Estado Mental × Resultado</span>
            <span className="ml-auto text-[9px] text-[#484f58] bg-[#21262d] px-2 py-0.5 rounded">
              {insights.withCheckin} com check-in
            </span>
          </div>
          {insights.withCheckin === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
              <AlertTriangle size={22} className="text-[#30363d]" />
              <p className="text-[10px] text-[#484f58]">Check-in aparece antes de operar — dados salvos automaticamente</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-[8px] uppercase tracking-widest text-[#484f58] mb-1.5">😴 Sono</div>
                <MentalRow label="ótimo" d={insights.mental.sono.otimo} />
                <MentalRow label="ok"    d={insights.mental.sono.ok} />
                <MentalRow label="mal"   d={insights.mental.sono.mal} />
              </div>
              <div className="border-t border-[#30363d] pt-3">
                <div className="text-[8px] uppercase tracking-widest text-[#484f58] mb-1.5">⚡ Energia</div>
                <MentalRow label="alta"  d={insights.mental.energia.alta} />
                <MentalRow label="ok"    d={insights.mental.energia.ok} />
                <MentalRow label="baixa" d={insights.mental.energia.baixa} />
              </div>
              <div className="border-t border-[#30363d] pt-3">
                <div className="text-[8px] uppercase tracking-widest text-[#484f58] mb-1.5">🎯 Mental + 😊 Humor</div>
                <MentalRow label="focado/feliz"  d={insights.mental.mental.focado} />
                <MentalRow label="ok/neutro"     d={insights.mental.mental.ok} />
                <MentalRow label="ruim/triste"   d={insights.mental.mental.ruim} />
              </div>
            </div>
          )}
        </div>

        {/* Win rate por sessão */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={14} className="text-[#3b82f6]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Win Rate por Sessão</span>
            <span className="ml-auto text-[9px] text-[#484f58] bg-[#21262d] px-2 py-0.5 rounded">
              {labeled.length} rotulados
            </span>
          </div>
          {labeled.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <AlertTriangle size={24} className="text-[#30363d] mb-2" />
              <div className="text-[10px] text-[#484f58]">Rotule trades W/L para ver análise por sessão</div>
            </div>
          ) : (
            <div className="space-y-3">
              {(['Londres', 'Overlap', 'NY', 'Ásia'] as const).map(sess => {
                const sessTrads = labeled.filter(t => sessionLabel(t.time) === sess)
                const w  = sessTrads.filter(t => t.result === 'win').length
                const l  = sessTrads.filter(t => t.result === 'loss').length
                const wr = (w + l) > 0 ? Math.round(w / (w + l) * 100) : null
                const color = wr === null ? '#484f58' : wr >= 60 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#ef4444'
                const sessColor = sess === 'Overlap' ? '#00e676' : sess === 'Londres' ? '#4499ff' : sess === 'NY' ? '#aa55ff' : '#8b949e'
                return (
                  <div key={sess} className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 w-16 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: sessColor }} />
                      <span className="text-[10px] font-mono text-[#8b949e]">{sess}</span>
                    </div>
                    <div className="flex-1 h-2 bg-[#21262d] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${wr ?? 0}%`, background: color }} />
                    </div>
                    <span className="text-[10px] font-mono font-bold w-8 text-right shrink-0" style={{ color }}>
                      {wr !== null ? `${wr}%` : '—'}
                    </span>
                    <span className="text-[9px] text-[#484f58] w-12 shrink-0">{w}W/{l}L</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Feature importance */}
          <div className="mt-4 pt-4 border-t border-[#30363d]">
            <div className="flex items-center gap-2 mb-3">
              <BarChart2 size={12} className="text-[#f59e0b]" />
              <span className="text-[10px] font-semibold text-[#f0f6fc]">Feature Importance</span>
              <span className="ml-auto text-[8px] text-[#484f58]">estimativa teórica</span>
            </div>
            <div className="space-y-2">
              <FeatImportance label="forca_rompimento" pct={26} color="#10b981" />
              <FeatImportance label="squeeze_ratio"    pct={18} color="#3b82f6" />
              <FeatImportance label="expansao_bb"      pct={14} color="#3b82f6" />
              <FeatImportance label="hora_utc"         pct={12} color="#f59e0b" />
              <FeatImportance label="estado_mental"    pct={10} color="#aa55ff" />
              <FeatImportance label="sessao"           pct={8}  color="#f59e0b" />
              <FeatImportance label="direcao/outros"   pct={12} color="#8b949e" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Modo IA — treinar ────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#3b82f6]/30 rounded-xl p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#3b82f6]/20">
            <Sparkles size={18} className="text-[#3b82f6]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f0f6fc]">Treinar XGBoost</div>
            <div className="text-[10px] text-[#484f58] mt-0.5">
              {labeled.length >= 10
                ? `${labeled.length} trades — já útil para treinar. Com 30+ fica mais confiável.`
                : `A IA aprende com cada trade. Com ${labeled.length} dados já vale treinar.`}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            onClick={handleTreinar}
            disabled={trainStatus === 'loading' || labeled.length === 0}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all',
              trainStatus === 'loading' || labeled.length === 0
                ? 'bg-[#21262d] border border-[#30363d] text-[#484f58] cursor-not-allowed'
                : 'bg-[#3b82f6] text-white hover:bg-[#2563eb]',
            )}
          >
            {trainStatus === 'loading'
              ? <><RefreshCw size={12} className="animate-spin" /> Enviando…</>
              : trainStatus === 'ok'
                ? <><CheckCircle size={12} /> Comando enviado</>
                : trainStatus === 'err'
                  ? <><XCircle size={12} /> Erro — tentar novamente</>
                  : <><Brain size={12} /> Treinar XGBoost ({labeled.length} trades)</>}
          </button>
          {trainMsg && (
            <span className={cn(
              'text-[9px] font-mono max-w-[240px] text-right',
              trainStatus === 'ok' ? 'text-[#10b981]' : 'text-[#ef4444]',
            )}>{trainMsg}</span>
          )}
        </div>
      </div>

      {/* ── Tabela de features ───────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-[#30363d] bg-[#0d1117] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-[#3b82f6]" />
            <span className="text-[10px] uppercase tracking-widest text-[#484f58]">
              Dataset — {all.length} sinais ({labeled.length} rotulados)
            </span>
          </div>
          <Link href="/admin/export"
            className="flex items-center gap-1 text-[9px] text-[#3b82f6] hover:text-[#93c5fd] transition-colors">
            Rotular W/L <ChevronRight size={10} />
          </Link>
        </div>

        {all.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Brain size={32} className="text-[#30363d] mb-3" />
            <p className="text-[#484f58] text-xs mb-2">Nenhum trade capturado ainda.</p>
            <Link href="/admin/chart"
              className="text-[9px] text-[#3b82f6] hover:underline flex items-center gap-1">
              Mapear trades no Gráfico RAFI <ChevronRight size={9} />
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#30363d] bg-[#0d1117]">
                  {['Data/Hora', 'Dir', 'RAFI', 'BB Width', 'Sessão', 'Hora/Dia', 'R:R', '🧠', 'Label'].map(h => (
                    <th key={h} className="py-2 px-2 text-left text-[8px] uppercase tracking-wider text-[#484f58] font-medium first:pl-3 last:pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {all.slice(0, 50).map(t => <FeatureRow key={t.id} t={t as ManualTrade} />)}
              </tbody>
            </table>
            {all.length > 50 && (
              <div className="py-3 text-center text-[9px] text-[#484f58]">
                Mostrando 50 de {all.length} trades · Exportar Dataset para ver todos
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Roadmap ─────────────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 size={14} className="text-[#10b981]" />
          <span className="text-sm font-semibold text-[#f0f6fc]">Roadmap — Aprendizado Contínuo</span>
        </div>
        <div className="space-y-2.5">
          {[
            { done: true,  label: 'Núcleo pronto',                 desc: 'Indicadores RAFI + BB + S/R + backtest engine funcionando' },
            { done: labeled.length >= 1, label: 'IA aprendendo — 1º trade',   desc: `${labeled.length} trades rotulados · cada resultado melhora a precisão`, active: labeled.length < 10 },
            { done: labeled.length >= 10, label: '10 trades — XGBoost útil',  desc: 'Com 10 dados já vale treinar · padrões iniciais detectados', active: labeled.length >= 1 && labeled.length < 10 },
            { done: labeled.length >= 30, label: '30 trades — modelo confiável', desc: 'Win rate por contexto estável · filtro XGBoost ativável', active: labeled.length >= 10 && labeled.length < 30 },
            { done: false, label: 'Bot replica seu padrão',         desc: 'Tokyo+Londres (07:00–08:00) e Sydney+Tokyo (23:00–07:00) GMT — sem emoção' },
            { done: false, label: 'Conta real + escalonamento',     desc: '$100–200 real · crescimento exponencial com gestão de risco rigorosa' },
          ].map(({ done, label, desc, active }) => (
            <div key={label} className={cn(
              'flex items-start gap-2.5 p-2.5 rounded-lg',
              active && 'bg-[#3b82f6]/5 border border-[#3b82f6]/15',
            )}>
              {done
                ? <CheckCircle2 size={13} className="text-[#10b981] mt-0.5 shrink-0" />
                : active
                ? <Circle size={13} className="text-[#3b82f6] mt-0.5 shrink-0" style={{ fill: '#3b82f620' }} />
                : <Circle size={13} className="text-[#30363d] mt-0.5 shrink-0" />
              }
              <div>
                <div className={cn('text-xs font-semibold',
                  done ? 'text-[#10b981]' : active ? 'text-[#3b82f6]' : 'text-[#8b949e]')}>
                  {label}
                </div>
                <div className="text-[9px] text-[#484f58] mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 pt-4 border-t border-[#30363d] text-[9px] text-[#484f58] leading-relaxed">
          <strong className="text-[#8b949e]">Arquitetura:</strong> A estratégia RAFI (rompimentos de S/R) é fixa e já está codificada.
          O que a IA aprende é o <em>filtro</em> — quando as condições são ótimas para o SEU perfil específico.
          O bot executa seu melhor self, sem emoção, nas sessões Tokyo+Londres e Sydney+Tokyo.
        </div>
      </div>

    </div>
  )
}
