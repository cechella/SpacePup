'use client'

import { useState, useEffect } from 'react'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { cn } from '@/lib/utils'
import { Clock, Brain, ShieldCheck, Trophy } from 'lucide-react'

// Janelas de sessão em minutos desde meia-noite UTC
const LONDON  = { start: 8 * 60,       end: 16 * 60 + 30, label: 'London',   color: '#4499ff' }
const NY      = { start: 13 * 60 + 30, end: 20 * 60,      label: 'New York', color: '#aa55ff' }
const OVERLAP = { start: 13 * 60 + 30, end: 16 * 60 + 30 }

function utcMin(): number {
  const d = new Date()
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
function isActive(start: number, end: number): boolean { return utcMin() >= start && utcMin() < end }
function minsLeft(end: number): number { return Math.max(end - utcMin(), 0) }
function minsUntil(start: number): number {
  const diff = start - utcMin()
  return diff > 0 ? diff : 24 * 60 + diff
}
function fmtMin(m: number): string {
  const h = Math.floor(m / 60), mm = m % 60
  return h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`
}
function progress(start: number, end: number): number {
  if (!isActive(start, end)) return 0
  return (utcMin() - start) / (end - start)
}

function aiScore(): { pct: number; label: string; color: string } {
  if (isActive(OVERLAP.start, OVERLAP.end)) return { pct: 78, label: 'Overlap ativo',     color: '#00e676' }
  if (isActive(NY.start, NY.end))           return { pct: 65, label: 'Só NY ativo',        color: '#aa55ff' }
  if (isActive(LONDON.start, LONDON.end))   return { pct: 61, label: 'Só London ativo',    color: '#4499ff' }
  return                                           { pct: 32, label: 'Fora de sessão',      color: '#484f58' }
}

const MILESTONES = [100, 1_000, 10_000, 100_000, 1_000_000]
function journeyProgress(capital: number): { pct: number; current: number; next: number } {
  const cur  = [...MILESTONES].reverse().find(m => capital >= m) ?? 100
  const next = MILESTONES.find(m => m > capital) ?? 1_000_000
  return { pct: Math.min((capital - cur) / (next - cur), 1), current: cur, next }
}

export interface DisciplineState {
  stopsToday:          number
  consecutiveLosses:   number
  weeklyDrawdownPct:   number
}

interface Props {
  trades:           ManualTrade[]
  onAdd:            (t: ManualTrade) => void
  onRemove:         (id: string) => void
  onUpdate:         (id: string, p: Partial<ManualTrade>) => void
  lastPrice:        number
  lastCandleTime:   number
  externalEntry:    number | null
  freeMargin:       number | null
  livePrice:        number | null
  balance:          number | null
  discipline:       DisciplineState
}

export function SessionSidebar({
  trades, onAdd, onRemove, onUpdate,
  lastPrice, lastCandleTime, externalEntry,
  freeMargin, livePrice,
  balance,
  discipline,
}: Props) {
  // Tick a cada 30s para atualizar countdowns
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const londonActive  = isActive(LONDON.start, LONDON.end)
  const nyActive      = isActive(NY.start, NY.end)
  const overlapActive = isActive(OVERLAP.start, OVERLAP.end)
  const ai = aiScore()

  const capital    = balance ?? 100
  const journey    = journeyProgress(capital)

  const stopsOk    = discipline.stopsToday < 2
  const seqOk      = discipline.consecutiveLosses < 2
  const drawdownOk = discipline.weeklyDrawdownPct > -20
  const blocked    = !stopsOk || !drawdownOk
  const warn       = !blocked && !seqOk
  const statusColor = blocked ? '#ef4444' : warn ? '#f59e0b' : '#00e676'
  const statusLabel = blocked ? 'BLOQUEADO' : warn ? 'ATENÇÃO' : 'OK'

  return (
    <div className="hidden md:flex flex-col gap-3 w-80 shrink-0 overflow-y-auto max-h-[calc(100vh-4rem)] pb-4">

      {/* ── SESSÕES ─────────────────────────────────── */}
      <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
        <div className="flex items-center gap-1.5 mb-3">
          <Clock size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Sessões</span>
          {overlapActive && (
            <span className="ml-auto text-[8px] font-bold text-[#00e676] bg-[rgba(0,230,118,.1)] border border-[#00e676]/30 px-2 py-0.5 rounded-full animate-pulse">
              ● OVERLAP
            </span>
          )}
        </div>

        {[LONDON, NY].map(s => {
          const active = isActive(s.start, s.end)
          const pct    = active ? progress(s.start, s.end) * 100 : 0
          const label  = active
            ? `fecha em ${fmtMin(minsLeft(s.end))}`
            : `abre em ${fmtMin(minsUntil(s.start))}`
          return (
            <div key={s.label} className="mb-2.5 last:mb-0">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: active ? s.color : '#334455' }}
                  />
                  <span className={cn('text-[10px] font-semibold', active ? 'text-[#ddeeff]' : 'text-[#334455]')}>
                    {s.label}
                  </span>
                </div>
                <span className={cn('text-[9px] font-mono', active ? 'text-[#7a96b8]' : 'text-[#334455]')}>
                  {label}
                </span>
              </div>
              <div className="h-1.5 bg-[#131f2e] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-1000"
                  style={{ width: `${pct}%`, background: s.color, opacity: active ? 1 : 0 }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── IA P(WIN) ────────────────────────────────── */}
      <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Brain size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">IA P(Win)</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Anel SVG */}
          <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0">
            <circle cx="26" cy="26" r="21" fill="none" stroke="#131f2e" strokeWidth="6" />
            <circle
              cx="26" cy="26" r="21" fill="none"
              stroke={ai.color} strokeWidth="6"
              strokeDasharray={`${(ai.pct / 100) * 131.9} 131.9`}
              strokeLinecap="round"
              transform="rotate(-90 26 26)"
            />
            <text
              x="26" y="30"
              textAnchor="middle"
              fill={ai.color}
              fontSize="11"
              fontWeight="700"
              fontFamily="monospace"
            >
              {ai.pct}%
            </text>
          </svg>
          <div className="min-w-0">
            <div className="text-[12px] font-bold leading-none" style={{ color: ai.color }}>
              {ai.pct}% confiança
            </div>
            <div className="text-[9px] text-[#7a96b8] mt-1">{ai.label}</div>
            <div className="text-[8px] text-[#334455] mt-0.5">baseado na sessão atual</div>
          </div>
        </div>
      </div>

      {/* ── DISCIPLINA ───────────────────────────────── */}
      <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
        <div className="flex items-center gap-1.5 mb-2.5">
          <ShieldCheck size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Disciplina</span>
          <span
            className="ml-auto text-[8px] font-bold px-1.5 py-0.5 rounded-full border"
            style={{ color: statusColor, borderColor: `${statusColor}50`, background: `${statusColor}18` }}
          >
            {statusLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 mb-1.5">
          {[
            { label: 'Stops hoje', value: `${discipline.stopsToday}/2`, ok: stopsOk },
            { label: 'Seq. perdas', value: `${discipline.consecutiveLosses}/2`, ok: seqOk },
          ].map(row => (
            <div key={row.label} className="bg-[#131f2e] rounded-lg px-2 py-1.5">
              <div className="text-[8px] text-[#334455] uppercase tracking-wide mb-0.5">{row.label}</div>
              <div className={cn('text-[12px] font-mono font-bold', row.ok ? 'text-[#00e676]' : 'text-[#ef4444]')}>
                {row.value} {row.ok ? '✓' : '✗'}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-[#131f2e] rounded-lg px-2 py-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[8px] text-[#334455] uppercase tracking-wide">Drawdown semanal</span>
            <span className={cn('text-[11px] font-mono font-bold tabular-nums', drawdownOk ? 'text-[#7a96b8]' : 'text-[#ef4444]')}>
              {discipline.weeklyDrawdownPct.toFixed(1)}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 bg-[#1c3050] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(Math.abs(discipline.weeklyDrawdownPct) / 20 * 100, 100)}%`,
                background: drawdownOk ? '#4499ff' : '#ef4444',
              }}
            />
          </div>
        </div>
      </div>

      {/* ── JORNADA $100 → $1M ───────────────────────── */}
      <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
        <div className="flex items-center gap-1.5 mb-2.5">
          <Trophy size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Jornada</span>
          <span className="ml-auto text-[9px] font-mono font-bold text-[#ffcc44]">
            ${capital.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        </div>

        {/* Barra de progresso com marcadores de milestone */}
        <div className="relative mb-1">
          <div className="h-2 bg-[#131f2e] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${journey.pct * 100}%`,
                background: 'linear-gradient(90deg, #4499ff, #aa55ff)',
              }}
            />
          </div>
          {/* Marcadores de milestone */}
          {MILESTONES.slice(1, -1).map(m => {
            const logPct = Math.log10(m / 100) / Math.log10(10_000) * 100
            return (
              <div
                key={m}
                className="absolute top-0 h-2 w-px"
                style={{ left: `${logPct}%`, background: capital >= m ? '#ffcc44' : '#1c3050' }}
              />
            )
          })}
        </div>

        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[8px] text-[#334455]">
            Próximo: <span className="font-mono text-[#aa55ff]">${journey.next.toLocaleString()}</span>
          </span>
          <span className="text-[8px] text-[#334455]">
            {(journey.pct * 100).toFixed(1)}% do trecho
          </span>
        </div>

        {/* Milestones em chips */}
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          {MILESTONES.map(m => {
            const reached = capital >= m
            const label   = m >= 1_000_000 ? '1M' : m >= 1_000 ? `${m / 1_000}k` : '100'
            return (
              <span
                key={m}
                className={cn(
                  'text-[8px] font-mono px-1.5 py-0.5 rounded border',
                  reached
                    ? 'text-[#ffcc44] border-[#ffcc44]/40 bg-[#ffcc44]/10'
                    : 'text-[#334455] border-[#1c3050] bg-transparent',
                )}
              >
                {reached ? '✓' : '○'} ${label}
              </span>
            )
          })}
        </div>
      </div>

      {/* ── MAPEAR TRADE ─────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <TradePanel
          trades={trades}
          onAdd={onAdd}
          onRemove={onRemove}
          onUpdate={onUpdate}
          lastPrice={lastPrice}
          lastCandleTime={lastCandleTime}
          externalEntry={externalEntry}
          freeMargin={freeMargin}
          livePrice={livePrice}
        />
      </div>
    </div>
  )
}
