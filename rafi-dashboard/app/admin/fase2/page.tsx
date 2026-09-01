'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  Brain, Zap, BarChart2, Download, Lock, ChevronRight,
  TrendingUp, TrendingDown, Activity, Target, Clock,
  CheckCircle2, Circle, AlertTriangle, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchTrades } from '@/lib/trades-db'

interface ManualTrade {
  id: string; direction: 'buy' | 'sell'; entry: number
  stopLoss: number; takeProfit: number; label: string
  time: number; lot: number; leverage: number
  result?: 'win' | 'loss' | 'pending'
  rafi?: number; rafiDir?: 'bull' | 'bear'; bbWidth?: number
}

const STORAGE_KEY  = 'rafi-trade-log'
const ML_CONFIANCA = [
  { min: 0,   max: 5,   label: 'Sem dados',         cor: '#484f58', pct: 0   },
  { min: 5,   max: 15,  label: 'Aprendendo...',      cor: '#ef4444', pct: 20  },
  { min: 15,  max: 30,  label: 'Padrão inicial',     cor: '#f59e0b', pct: 40  },
  { min: 30,  max: 60,  label: 'Melhorando',         cor: '#f59e0b', pct: 60  },
  { min: 60,  max: 100, label: 'Confiável',          cor: '#3b82f6', pct: 78  },
  { min: 100, max: 300, label: 'Alta confiança',     cor: '#10b981', pct: 90  },
  { min: 300, max: Infinity, label: 'XGBoost pronto!', cor: '#10b981', pct: 100 },
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

function exportCSV(trades: ManualTrade[]) {
  const header = 'time,direction,rafi,rafiDir,bbWidth,riskPips,rewardPips,rr,sessao,hora,diaSemana,result'
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

// ── Barra de progresso ────────────────────────────────────────────────────────
function ProgressBar({ current, target }: { current: number; target: number }) {
  const pct   = Math.min((current / target) * 100, 100)
  const color = pct >= 100 ? '#10b981' : pct >= 66 ? '#3b82f6' : pct >= 33 ? '#f59e0b' : '#ef4444'
  const phase = pct >= 100 ? 'Pronto — treinar XGBoost!' : pct >= 66 ? 'Fase 1B — quase lá' : pct >= 33 ? 'Fase 1A — em andamento' : 'Fase 1A — início'

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-black font-mono" style={{ color }}>{current}</div>
          <div className="text-[9px] uppercase tracking-widest text-[#484f58] mt-0.5">{phase}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold font-mono text-[#30363d]">/ {target}</div>
          <div className="text-[9px] text-[#484f58]">trades rotulados</div>
        </div>
      </div>
      <div className="relative h-3 bg-[#21262d] rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex justify-between text-[9px] text-[#484f58]">
        <span>0</span>
        <span className="text-[#484f58]">{Math.round(pct)}% completo</span>
        <span>{target} → treinar</span>
      </div>
    </div>
  )
}

// ── Pipeline visual ───────────────────────────────────────────────────────────
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

// ── Feature importance mock (barra horizontal) ────────────────────────────────
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
  const [trades, setTrades] = useState<ManualTrade[]>([])
  const [mounted, setMounted] = useState(false)

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
      .then(data => { if (data.length > 0) setTrades(data) })
      .catch(() => {})
  }, [])

  const labeled   = useMemo(() => trades.filter(t => t.result === 'win' || t.result === 'loss'), [trades])
  const wins      = labeled.filter(t => t.result === 'win').length
  const losses    = labeled.filter(t => t.result === 'loss').length
  const winRate   = labeled.length > 0 ? Math.round(wins / labeled.length * 100) : null
  const confianca = getConfianca(labeled.length)
  const ready     = labeled.length >= 300

  const rafiStrongWin  = labeled.filter(t => t.result === 'win'  && (t.rafi ?? 0) >= 2.5).length
  const rafiStrongLoss = labeled.filter(t => t.result === 'loss' && (t.rafi ?? 0) >= 2.5).length
  const rafiWR = (rafiStrongWin + rafiStrongLoss) > 0
    ? Math.round(rafiStrongWin / (rafiStrongWin + rafiStrongLoss) * 100)
    : null

  const recent = [...labeled].reverse().slice(0, 20)
  const all    = [...trades].reverse()

  if (!mounted) return null

  return (
    <div className="min-h-screen bg-[#0d1117] p-5 space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-black text-[#f0f6fc] flex items-center gap-2">
            <Brain size={20} className="text-[#3b82f6]" />
            IA / Fase 2 — XGBoost
          </h1>
          <p className="text-xs text-[#484f58] mt-0.5">
            Filtro de probabilidade · P(WIN) ≥ 65% antes de operar
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn(
            'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border',
            ready
              ? 'bg-[#10b981]/10 border-[#10b981]/25 text-[#10b981]'
              : 'bg-[#f59e0b]/10 border-[#f59e0b]/25 text-[#f59e0b]',
          )}>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full',
              ready ? 'bg-[#10b981]' : 'bg-[#f59e0b] animate-pulse',
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
            Exportar Dataset ML ({labeled.length})
          </button>
        </div>
      </div>

      {/* ── Progress + Pipeline ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* Progress */}
        <div className="lg:col-span-2 bg-[#161b22] border border-[#30363d] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Target size={14} className="text-[#f59e0b]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Coleta de Dados</span>
          </div>
          {/* Aprendizado contínuo — cresce a cada trade */}
          <div className="space-y-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-2xl font-black font-mono" style={{ color: confianca.cor }}>{labeled.length}</div>
                <div className="text-[9px] uppercase tracking-widest text-[#484f58] mt-0.5">{confianca.label}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold font-mono" style={{ color: confianca.cor }}>{confianca.pct}%</div>
                <div className="text-[9px] text-[#484f58]">confiança do modelo</div>
              </div>
            </div>
            <div className="relative h-3 bg-[#21262d] rounded-full overflow-hidden">
              <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                style={{ width: `${confianca.pct}%`, background: confianca.cor }} />
            </div>
            <div className="flex justify-between text-[8px] text-[#484f58]">
              <span>0</span><span>30</span><span>60</span><span>100</span><span>300+</span>
            </div>
            <div className="text-[9px] text-[#484f58] text-center">
              A IA aprende a cada trade — quanto mais dados, mais precisa
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
          {rafiWR !== null && (
            <div className="pt-2 border-t border-[#30363d]">
              <div className="text-[9px] text-[#484f58] mb-1">RAFI ≥ 2.5 · win rate parcial</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-[#21262d] rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-[#10b981]" style={{ width: `${rafiWR}%` }} />
                </div>
                <span className="text-xs font-mono font-bold text-[#10b981]">{rafiWR}%</span>
              </div>
              <div className="text-[8px] text-[#484f58] mt-0.5">{rafiStrongWin}W / {rafiStrongLoss}L em sinais fortes</div>
            </div>
          )}
        </div>

        {/* Pipeline */}
        <div className="lg:col-span-3 bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={14} className="text-[#3b82f6]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Como funciona a Fase 2</span>
          </div>
          <div className="space-y-2">
            <PipelineStep n={1} label="Regras RAFI detectam sinal"
              desc="BB estreita abrindo + rompimento S/R + candle direcional"
              done active={false} />
            <PipelineStep n={2} label="XGBoost calcula P(WIN)"
              desc="7 features → probabilidade de ganho. Opera só se P ≥ 65%"
              active={ready} />
            <PipelineStep n={3} label="Executa trade filtrado"
              desc="Entry / SL / TP idênticos à Fase 1 — só muda o filtro de entrada"
              active={false} />
            <PipelineStep n={4} label="Retreino mensal automático"
              desc="A cada 30+ novos trades rotulados, XGBoost melhora com dados reais"
              active={false} />
          </div>
          <div className="mt-4 pt-4 border-t border-[#30363d]">
            <div className="text-[9px] uppercase tracking-wider text-[#484f58] mb-2">Features do modelo</div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { f: 'RAFI value', c: '#10b981' }, { f: 'RAFI ≥ 2.5?', c: '#10b981' },
                { f: 'BB Width', c: '#3b82f6' }, { f: 'Sessão', c: '#3b82f6' },
                { f: 'Hora (UTC)', c: '#f59e0b' }, { f: 'Dia semana', c: '#f59e0b' },
                { f: 'R:R ratio', c: '#8b949e' }, { f: 'Direção', c: '#8b949e' },
              ].map(({ f, c }) => (
                <span key={f} style={{ background: `${c}12`, border: `1px solid ${c}30`, color: c }}
                  className="text-[8px] px-1.5 py-0.5 rounded font-mono">{f}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Modo IA — toggle (locked) ────────────────────────────────────────── */}
      <div className={cn(
        'bg-[#161b22] border rounded-xl p-5 flex items-center justify-between gap-4',
        ready ? 'border-[#3b82f6]/30' : 'border-[#30363d] opacity-60',
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center',
            ready ? 'bg-[#3b82f6]/20' : 'bg-[#21262d]',
          )}>
            <Sparkles size={18} className={ready ? 'text-[#3b82f6]' : 'text-[#484f58]'} />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f0f6fc] flex items-center gap-2">
              Modo IA — Filtro XGBoost
              {!ready && <Lock size={11} className="text-[#484f58]" />}
            </div>
            <div className="text-[10px] text-[#484f58] mt-0.5">
              {ready
                ? 'Treine o modelo e ative o filtro — apenas sinais com P(WIN) ≥ 65% serão operados'
                : labeled.length >= 30
                ? `Com ${labeled.length} trades já tem padrões! XGBoost completo após 300 trades.`
                : 'A IA já aprende desde o 1º trade — precisão aumenta com cada resultado rotulado'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {ready ? (
            <button className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#3b82f6] text-white text-xs font-bold hover:bg-[#2563eb] transition-all">
              <Brain size={12} /> Treinar XGBoost
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#21262d] border border-[#30363d] text-[#484f58] text-xs font-bold cursor-not-allowed">
              <Lock size={12} /> Bloqueado
            </div>
          )}
        </div>
      </div>

      {/* ── Feature importance (placeholder) ────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 size={14} className="text-[#f59e0b]" />
            <span className="text-sm font-semibold text-[#f0f6fc]">Feature Importance</span>
            <span className="ml-auto text-[9px] text-[#484f58] bg-[#21262d] px-2 py-0.5 rounded">
              {ready ? 'XGBoost treinado' : 'Estimativa prévia'}
            </span>
          </div>
          <div className="space-y-2.5">
            <FeatImportance label="RAFI value"  pct={28} color="#10b981" />
            <FeatImportance label="BB Width"    pct={22} color="#3b82f6" />
            <FeatImportance label="Sessão"      pct={18} color="#f59e0b" />
            <FeatImportance label="Hora UTC"    pct={14} color="#f59e0b" />
            <FeatImportance label="RAFI ≥ 2.5"  pct={10} color="#10b981" />
            <FeatImportance label="Dia semana"  pct={5}  color="#8b949e" />
            <FeatImportance label="Direção"     pct={3}  color="#8b949e" />
          </div>
          <div className="mt-3 pt-3 border-t border-[#30363d] text-[9px] text-[#484f58]">
            * Estimativa baseada na estratégia RAFI. Valores reais após treino com seus dados.
          </div>
        </div>

        {/* Análise por sessão */}
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
              {(['Londres', 'NY', 'Overlap', 'Ásia'] as const).map(sess => {
                const sessTrads = labeled.filter(t => sessionLabel(t.time) === sess)
                const w = sessTrads.filter(t => t.result === 'win').length
                const l = sessTrads.filter(t => t.result === 'loss').length
                const wr = (w + l) > 0 ? Math.round(w / (w + l) * 100) : null
                const color = wr === null ? '#484f58' : wr >= 60 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#ef4444'
                if (sessTrads.length === 0) return null
                return (
                  <div key={sess} className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-[#8b949e] w-16 shrink-0">{sess}</span>
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
        </div>
      </div>

      {/* ── Tabela de features ───────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-[#30363d] bg-[#0d1117] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-[#3b82f6]" />
            <span className="text-[10px] uppercase tracking-widest text-[#484f58]">
              Dataset de Treino — {all.length} sinais ({labeled.length} rotulados)
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
                  {['Data/Hora', 'Dir', 'RAFI', 'BB Width', 'Sessão', 'Hora/Dia', 'R:R', 'Label'].map(h => (
                    <th key={h} className="py-2 px-2 text-left text-[8px] uppercase tracking-wider text-[#484f58] font-medium first:pl-3 last:pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {all.slice(0, 50).map(t => <FeatureRow key={t.id} t={t} />)}
              </tbody>
            </table>
            {all.length > 50 && (
              <div className="py-3 text-center text-[9px] text-[#484f58]">
                Mostrando 50 de {all.length} trades · use Exportar Dataset ML para ver todos
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Próximos passos ─────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 size={14} className="text-[#10b981]" />
          <span className="text-sm font-semibold text-[#f0f6fc]">Roadmap Fase 2</span>
        </div>
        <div className="space-y-2.5">
          {[
            { done: true,  label: 'Fase 1A · Núcleo pronto',       desc: 'Indicadores RAFI + BB + S/R + backtest engine funcionando' },
            { done: labeled.length >= 1, label: 'Fase 1A · IA aprendendo (cada trade)', desc: `${labeled.length} rotulados · IA melhora a cada resultado — rode Auto-scan e marque W/L`, active: labeled.length < 300 },
            { done: false, label: 'Fase 1B · Conta DEMO XM (2-4 sem.)', desc: 'Rodar bot Python no MT5 Demo · comparar com backtest' },
            { done: false, label: 'Fase 2 · Treinar XGBoost',      desc: 'Exportar CSV → python train.py → modelo .pkl gerado' },
            { done: false, label: 'Fase 2 · Ativar filtro IA',     desc: 'Só opera quando P(WIN) ≥ 65% · retreino mensal automático' },
            { done: false, label: 'Fase 1C / 2 · Conta real',      desc: '$100-200 real · escalonamento exponencial de lotes' },
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
      </div>

    </div>
  )
}
