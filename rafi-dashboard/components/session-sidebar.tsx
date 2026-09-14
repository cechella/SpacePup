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

const DAY_ABBR = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
const DAY_NAME = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado']

interface CopilotResult {
  score:      number
  label:      string
  scoreColor: string
  factors:    { label: string; ok: boolean | null }[]
  similars:   ManualTrade[]
  profileMsg: string
  dataCount:  number
}

function computeCopilot(
  trades: ManualTrade[],
  rafiValue: number | null,
  bbExpanding: boolean | null,
): CopilotResult {
  const now    = new Date()
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const OVERLAP_START = 13 * 60 + 30
  const OVERLAP_END   = 16 * 60 + 30
  const inOverlap     = utcMin >= OVERLAP_START && utcMin < OVERLAP_END
  const sesMin        = utcMin - OVERLAP_START
  const overlapPhase  = inOverlap
    ? sesMin < 30 ? 'early' : sesMin < 90 ? 'mid' : 'late'
    : null
  const jsDay    = now.getUTCDay()
  const dayOfWeek = jsDay >= 1 && jsDay <= 4 ? jsDay - 1 : null
  const rafiStrong = rafiValue != null ? Math.abs(rafiValue) >= 2.5 : null

  const completed = trades.filter(t => t.result === 'win' || t.result === 'loss')
  // similares = mesma fase de overlap (dentro ou fora)
  const similars  = completed.filter(t => (t.overlapPhase != null) === inOverlap)
  const wins      = similars.filter(t => t.result === 'win').length
  const losses    = similars.filter(t => t.result === 'loss').length
  const total     = wins + losses

  let score: number
  let profileMsg: string

  if (total >= 10) {
    const baseRate = Math.round((wins / total) * 100)
    const bonus    = (rafiStrong ? 5 : 0) + (bbExpanding ? 3 : 0)
    score = Math.min(Math.max(baseRate + bonus, 20), 95)
    profileMsg = `Seu perfil: ${baseRate}% de acerto neste contexto. Últimas ${total} ocorrências: ${wins}W · ${losses}L.`
  } else if (total > 0) {
    const baseRate = Math.round((wins / total) * 100)
    score = Math.max(baseRate, 40)
    profileMsg = `${total} trades similares (${wins}W · ${losses}L). Acumulando dados…`
  } else {
    score = 45
    if (inOverlap)           score += 15
    if (rafiStrong === true) score += 10
    if (bbExpanding === true) score += 5
    if (dayOfWeek === 0 || dayOfWeek === 1) score += 5
    score = Math.min(score, 82)
    profileMsg = 'Opere para que a IA aprenda seu perfil.'
  }

  const scoreColor = score >= 70 ? '#00e676' : score >= 55 ? '#ffcc44' : '#ef4444'
  const label      = score >= 70 ? 'Alta confiança' : score >= 55 ? 'Confiança média' : 'Baixa confiança'

  const phaseLabel = overlapPhase === 'early' ? 'early 0-30min'
    : overlapPhase === 'mid'  ? 'mid 30-90min'
    : overlapPhase === 'late' ? 'late 90-180min'
    : null

  const factors: CopilotResult['factors'] = [
    {
      label: inOverlap
        ? `Overlap ativo${phaseLabel ? ` · ${phaseLabel}` : ''}`
        : 'Overlap inativo · aguardar 13:30 UTC',
      ok: inOverlap,
    },
    ...(rafiValue != null ? [{
      label: `RAFI ${rafiValue.toFixed(1)} ${rafiStrong ? '> 2.5 — forte' : Math.abs(rafiValue) >= 2.0 ? '> 2.0 — moderado' : '< 2.0 — fraco'}`,
      ok: rafiStrong,
    }] : []),
    ...(bbExpanding != null ? [{
      label: bbExpanding ? 'BB expandindo — volatilidade abrindo' : 'BB contraindo — aguardar expansão',
      ok: bbExpanding,
    }] : []),
    {
      label: dayOfWeek != null
        ? `${DAY_NAME[jsDay]} — dia operável`
        : 'Fora de Segunda–Quinta',
      ok: dayOfWeek != null,
    },
  ]

  return {
    score,
    label,
    scoreColor,
    factors,
    similars: completed.slice(-4).reverse(),
    profileMsg,
    dataCount: completed.length,
  }
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
  rafiValue:        number | null
  bbExpanding:      boolean | null
}

export function SessionSidebar({
  trades, onAdd, onRemove, onUpdate,
  lastPrice, lastCandleTime, externalEntry,
  freeMargin, livePrice,
  balance,
  discipline,
  rafiValue,
  bbExpanding,
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
  const copilot = computeCopilot(trades, rafiValue, bbExpanding)

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

      {/* ── CO-PILOTO IA ─────────────────────────────── */}
      <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse shrink-0" />
          <Brain size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">CO-PILOTO IA</span>
          <span className="ml-auto text-[8px] font-bold text-[#00e676]">● IA ONLINE</span>
        </div>

        {/* Score ring + label */}
        <div className="flex items-center gap-3 mb-3">
          <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0">
            <circle cx="28" cy="28" r="22" fill="none" stroke="#131f2e" strokeWidth="7" />
            <circle
              cx="28" cy="28" r="22" fill="none"
              stroke={copilot.scoreColor} strokeWidth="7"
              strokeDasharray={`${(copilot.score / 100) * 138.2} 138.2`}
              strokeLinecap="round"
              transform="rotate(-90 28 28)"
              style={{ transition: 'stroke-dasharray 0.8s ease' }}
            />
            <text x="28" y="33" textAnchor="middle" fill={copilot.scoreColor} fontSize="12" fontWeight="700" fontFamily="monospace">
              {copilot.score}%
            </text>
          </svg>
          <div className="min-w-0">
            <div className="text-[13px] font-bold leading-tight" style={{ color: copilot.scoreColor }}>
              {copilot.label}
            </div>
            <div className="text-[9px] text-[#7a96b8] mt-0.5">Setup analisado pela IA</div>
          </div>
        </div>

        {/* Fatores Analisados */}
        <div className="mb-3">
          <div className="text-[8px] text-[#334455] uppercase tracking-widest mb-1.5">Fatores Analisados</div>
          <div className="flex flex-col gap-1">
            {copilot.factors.map((f, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span
                  className="text-[10px] mt-[1px] shrink-0 font-bold"
                  style={{ color: f.ok === null ? '#334455' : f.ok ? '#00e676' : '#ef4444' }}
                >
                  {f.ok === null ? '·' : f.ok ? '✓' : '✗'}
                </span>
                <span
                  className="text-[10px] leading-tight"
                  style={{ color: f.ok === null ? '#334455' : f.ok ? '#7a96b8' : 'rgba(239,68,68,0.7)' }}
                >
                  {f.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Mensagem de perfil */}
        <div className="bg-[#131f2e] rounded-lg px-2.5 py-2 mb-3">
          <p className="text-[9px] text-[#7a96b8] leading-relaxed">{copilot.profileMsg}</p>
        </div>

        {/* Últimos similares */}
        {copilot.similars.length > 0 && (
          <div>
            <div className="text-[8px] text-[#334455] uppercase tracking-widest mb-1.5">Últimos Similares</div>
            <div className="flex flex-col gap-1">
              {copilot.similars.map(t => {
                const win  = t.result === 'win'
                const d    = new Date((t.time ?? 0) * 1000)
                const abbr = DAY_ABBR[d.getUTCDay()]
                const hm   = `${String(d.getUTCHours()).padStart(2,'0')}h${String(d.getUTCMinutes()).padStart(2,'0')}`
                const pnl  = (t as ManualTrade & { pnlUsd?: number }).pnlUsd
                const pnlStr = pnl != null
                  ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`
                  : win ? 'WIN' : 'LOSS'
                const rafi = (t as ManualTrade & { rafi?: number }).rafi
                return (
                  <div key={t.id} className="flex items-center justify-between bg-[#131f2e] rounded-lg px-2 py-1.5">
                    <span className={cn('text-[10px] font-mono font-bold', win ? 'text-[#00e676]' : 'text-[#ef4444]')}>
                      {pnlStr}
                    </span>
                    <span className="text-[9px] text-[#7a96b8] font-mono">
                      {abbr} {hm}{rafi != null ? ` · RAFI ${rafi.toFixed(1)}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="text-[8px] text-[#334455] mt-1.5 text-center">
              baseado em {copilot.dataCount} trades históricos
            </div>
          </div>
        )}
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
