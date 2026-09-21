'use client'

import { useState, useEffect } from 'react'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { type CheckinResult } from '@/components/checkin-modal'
import { cn } from '@/lib/utils'
import { Clock, Brain, ShieldCheck, Trophy, Target } from 'lucide-react'

export interface TargetMetrics {
  dailyPct:    number   // % lucro hoje
  dailyPnl:   number   // $ lucro hoje
  weeklyPct:  number   // % lucro esta semana
  weeklyPnl:  number   // $ lucro esta semana
  daysHit:    number   // quantos dias da semana bateram a meta diária
  dailyMet:   boolean
  weeklyMet:  boolean
  locked:     boolean
  DAILY_TARGET:  number  // 7.0
  WEEKLY_TARGET: number  // 25.0
}

// Janelas de sessão em minutos desde meia-noite UTC
// NY FX começa às 12:00 UTC (8am EDT), não às 13:30 (NYSE open)
const LONDON  = { start: 8 * 60,  end: 16 * 60, label: 'London',   color: '#4499ff' }
const NY      = { start: 12 * 60, end: 20 * 60, label: 'New York', color: '#aa55ff' }
const OVERLAP = { start: 12 * 60, end: 16 * 60 }  // London–NY: 12:00–16:00 UTC

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

// Retorna true se o estado mental é "positivo" (bem dormido, focado, bem-humorado)
function isBomEstado(t: ManualTrade): boolean {
  return (
    (t as any).checkinSono    !== 'mal'    &&
    (t as any).checkinMental  !== 'ruim'   &&
    (t as any).checkinHumor   !== 'triste' &&
    (t as any).checkinEnergia !== 'baixa'
  )
}

function computeCopilot(
  trades: ManualTrade[],
  rafiValue: number | null,
  bbExpanding: boolean | null,
  checkin: CheckinResult | null,
): CopilotResult {
  const checkinPenalty = checkin?.scorePenalty ?? 0
  const now    = new Date()
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const OVERLAP_START = OVERLAP.start  // 12:00 UTC
  const OVERLAP_END   = OVERLAP.end    // 16:00 UTC
  const inOverlap     = utcMin >= OVERLAP_START && utcMin < OVERLAP_END
  const sesMin        = utcMin - OVERLAP_START
  const overlapPhase  = inOverlap
    ? sesMin < 30 ? 'early' : sesMin < 90 ? 'mid' : 'late'
    : null
  const jsDay    = now.getUTCDay()
  const dayOfWeek = jsDay >= 1 && jsDay <= 4 ? jsDay - 1 : null
  const rafiStrong = rafiValue != null ? Math.abs(rafiValue) >= 2.5 : null

  const completed = trades.filter(t => t.result === 'win' || t.result === 'loss')
  // Trades com dado de check-in preenchido
  const withCheckin = completed.filter(t => (t as any).checkinSono != null)
  // similares = mesma fase de overlap (dentro ou fora)
  const similars  = completed.filter(t => (t.overlapPhase != null) === inOverlap)
  const wins      = similars.filter(t => t.result === 'win').length
  const losses    = similars.filter(t => t.result === 'loss').length
  const total     = wins + losses

  // ── Análise de estado mental ──────────────────────────────────────────────
  const bomEstado  = withCheckin.filter(isBomEstado)
  const malEstado  = withCheckin.filter(t => !isBomEstado(t))
  const bomWins    = bomEstado.filter(t => t.result === 'win').length
  const malWins    = malEstado.filter(t => t.result === 'win').length
  const bomRate    = bomEstado.length >= 1 ? Math.round((bomWins / bomEstado.length) * 100) : null
  const malRate    = malEstado.length >= 1 ? Math.round((malWins / malEstado.length) * 100) : null

  // Estado de hoje
  const hojeEstadoBom = checkin
    ? checkin.sono !== 'mal' && checkin.mental !== 'ruim' && checkin.humor !== 'triste' && checkin.energia !== 'baixa'
    : null

  let score: number
  let profileMsg: string

  if (total >= 10) {
    const baseRate = Math.round((wins / total) * 100)
    const bonus    = (rafiStrong ? 5 : 0) + (bbExpanding ? 3 : 0)
    // Ajuste pelo perfil de estado mental quando há dados suficientes
    let mentalAdj = 0
    if (hojeEstadoBom !== null && bomRate !== null && malRate !== null) {
      const diff = bomRate - malRate
      mentalAdj = hojeEstadoBom ? Math.round(diff * 0.3) : -Math.round(diff * 0.3)
    }
    score = Math.min(Math.max(baseRate + bonus + mentalAdj, 20), 95)
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

  // Aplica penalidade do check-in de estado mental
  score = Math.max(score - checkinPenalty, 5)

  const scoreColor = score >= 70 ? '#00e676' : score >= 55 ? '#ffcc44' : '#ef4444'
  const label      = score >= 70 ? 'Alta confiança' : score >= 55 ? 'Confiança média' : 'Baixa confiança'

  const phaseLabel = overlapPhase === 'early' ? 'early 0-30min'
    : overlapPhase === 'mid'  ? 'mid 30-90min'
    : overlapPhase === 'late' ? 'late 90-180min'
    : null

  // Fator de estado mental: aparece quando há dados suficientes
  let mentalFactor: { label: string; ok: boolean | null } | null = null
  if (bomRate !== null && hojeEstadoBom !== null) {
    if (malRate !== null) {
      mentalFactor = {
        label: hojeEstadoBom
          ? `Estado ótimo · acerto ${bomRate}% vs ${malRate}% (estado ruim)`
          : `Estado comprometido · acerto ${malRate}% vs ${bomRate}% (estado ótimo)`,
        ok: hojeEstadoBom,
      }
    } else {
      mentalFactor = {
        label: hojeEstadoBom
          ? `Estado ótimo · acerto ${bomRate}% (${bomEstado.length} trades)`
          : `Estado comprometido · acumulando dados…`,
        ok: hojeEstadoBom,
      }
    }
  }

  const factors: CopilotResult['factors'] = [
    {
      label: inOverlap
        ? `Overlap ativo${phaseLabel ? ` · ${phaseLabel}` : ''}`
        : 'Overlap inativo · aguardar 12:00 UTC',
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
    ...(mentalFactor ? [mentalFactor] : []),
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

// Retorna YYYY-MM-DD da segunda-feira desta semana + i dias (para chaves localStorage)
function getMondayPlusDays(i: number): string {
  const d = new Date()
  const jsDay = d.getUTCDay()
  const daysFromMon = jsDay === 0 ? 6 : jsDay - 1
  const mon = new Date(d)
  mon.setUTCDate(d.getUTCDate() - daysFromMon + i)
  return mon.toISOString().slice(0, 10)
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
  brokerCount?:     number          // nº de corretoras no capital consolidado
  discipline:       DisciplineState
  rafiValue:        number | null
  bbExpanding:      boolean | null
  checkin:          CheckinResult | null
  targets:          TargetMetrics | null
}

export function SessionSidebar({
  trades, onAdd, onRemove, onUpdate,
  lastPrice, lastCandleTime, externalEntry,
  freeMargin, livePrice,
  balance,
  brokerCount,
  discipline,
  rafiValue,
  bbExpanding,
  checkin,
  targets,
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
  const copilot = computeCopilot(trades, rafiValue, bbExpanding, checkin)

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

        {/* Header + UTC */}
        <div className="flex items-center gap-1.5 mb-2.5">
          <Clock size={11} className="text-[#7a96b8]" />
          <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Sessões</span>
          <span className="ml-auto text-[9px] font-mono text-[#334455]">
            {(() => {
              const d = new Date()
              return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`
            })()}
          </span>
        </div>

        {/* Minimap 24h — posição relativa ao dia UTC */}
        <div className="relative h-3.5 rounded bg-[#0a0e14] mb-1 overflow-hidden">
          {/* London */}
          <div className="absolute inset-y-0 bg-[#4499ff]/30"
            style={{ left:`${(LONDON.start/1440)*100}%`, width:`${((LONDON.end-LONDON.start)/1440)*100}%` }} />
          {/* NY */}
          <div className="absolute inset-y-0 bg-[#aa55ff]/25"
            style={{ left:`${(NY.start/1440)*100}%`, width:`${((NY.end-NY.start)/1440)*100}%` }} />
          {/* Overlap — ouro quando inativo, verde quando ativo */}
          <div className="absolute inset-y-0"
            style={{
              left:`${(OVERLAP.start/1440)*100}%`,
              width:`${((OVERLAP.end-OVERLAP.start)/1440)*100}%`,
              background: overlapActive ? 'rgba(0,230,118,0.35)' : 'rgba(245,158,11,0.22)',
              borderLeft:  overlapActive ? '1.5px solid rgba(0,230,118,0.7)' : '1.5px solid rgba(245,158,11,0.5)',
              borderRight: overlapActive ? '1.5px solid rgba(0,230,118,0.7)' : '1.5px solid rgba(245,158,11,0.5)',
            }} />
          {/* Cursor de tempo atual */}
          <div className="absolute inset-y-0 w-px bg-white/80"
            style={{ left:`${(utcMin()/1440)*100}%` }} />
        </div>

        {/* Eixo de horas */}
        <div className="flex justify-between text-[7px] font-mono text-[#1c3050] mb-3 px-0.5">
          {['00','06','12','16','20','24'].map(h => <span key={h}>{h}</span>)}
        </div>

        {/* Overlap — foco principal */}
        {overlapActive ? (
          <div className="rounded-lg border border-[#00e676]/30 bg-[#00e676]/[0.07] px-3 py-2 mb-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[8px] font-bold text-[#00e676] uppercase tracking-widest animate-pulse">● Overlap ativo</span>
              <span className="text-[7px] font-mono text-[#00e676]/50">12:00–16:00 UTC</span>
            </div>
            <div className="text-[24px] font-mono font-bold text-[#00e676] leading-none tabular-nums">
              {fmtMin(minsLeft(OVERLAP.end))}
            </div>
            <div className="text-[8px] text-[#00e676]/50 mt-0.5">restantes para operar</div>
          </div>
        ) : (() => {
          const done = utcMin() >= OVERLAP.end
          const away = done ? (1440 - utcMin()) + OVERLAP.start : minsUntil(OVERLAP.start)
          return (
            <div className="rounded-lg border border-[#1c3050] bg-[#131f2e] px-3 py-2 mb-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[8px] text-[#7a96b8] uppercase tracking-widest">
                  {done ? 'Overlap encerrado' : 'Overlap começa em'}
                </span>
                <span className="text-[7px] font-mono text-[#334455]">12:00–16:00 UTC</span>
              </div>
              {done
                ? <div className="text-[10px] font-mono text-[#334455]">retorna amanhã — {fmtMin(away)}</div>
                : <div className="text-[24px] font-mono font-bold text-[#4499ff] leading-none tabular-nums">{fmtMin(away)}</div>
              }
              {!done && <div className="text-[8px] text-[#334455] mt-0.5">maior liquidez do dia</div>}
            </div>
          )
        })()}

        {/* London + NY — status compacto */}
        <div className="flex gap-2">
          {[LONDON, NY].map(s => {
            const active = isActive(s.start, s.end)
            const pct    = active ? progress(s.start, s.end) * 100 : 0
            return (
              <div key={s.label} className="flex-1">
                <div className="flex items-center gap-1 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: active ? s.color : '#1c3050' }} />
                  <span className={cn('text-[9px] font-semibold', active ? 'text-[#ddeeff]' : 'text-[#334455]')}>
                    {s.label}
                  </span>
                  <span className={cn('ml-auto text-[8px] font-mono', active ? 'text-[#7a96b8]' : 'text-[#334455]')}>
                    {active ? `−${fmtMin(minsLeft(s.end))}` : `+${fmtMin(minsUntil(s.start))}`}
                  </span>
                </div>
                <div className="h-1 bg-[#0a0e14] rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-[30000ms]"
                    style={{ width:`${pct}%`, background: s.color, opacity: active ? 0.7 : 0 }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── CHECK-IN MENTAL ─────────────────────────── */}
      {checkin && (
        <div className={cn(
          'rounded-xl border p-3',
          checkin.blocked
            ? 'border-[#ef4444]/30 bg-[#ef4444]/8'
            : checkin.scorePenalty >= 20
            ? 'border-[#f59e0b]/30 bg-[#f59e0b]/8'
            : 'border-[#00e676]/20 bg-[#00e676]/8',
        )}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[11px]">🧠</span>
            <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Estado Mental</span>
            <span
              className="ml-auto text-[8px] font-bold px-1.5 py-0.5 rounded-full border"
              style={{
                color: checkin.blocked ? '#ef4444' : checkin.scorePenalty >= 20 ? '#f59e0b' : '#00e676',
                borderColor: checkin.blocked ? '#ef4444' + '50' : checkin.scorePenalty >= 20 ? '#f59e0b' + '50' : '#00e676' + '50',
                background:  checkin.blocked ? '#ef444418' : checkin.scorePenalty >= 20 ? '#f59e0b18' : '#00e67618',
              }}
            >
              {checkin.blocked ? 'BLOQUEADO' : checkin.scorePenalty >= 20 ? 'ATENÇÃO' : 'PRONTO'}
            </span>
          </div>
          <div className="flex gap-2 text-[9px]">
            {[
              { k: 'Sono',    v: checkin.sono    === 'otimo' ? '😴✓' : checkin.sono    === 'mal' ? '😴✗' : '😴' },
              { k: 'Energia', v: checkin.energia === 'alta'  ? '⚡✓' : checkin.energia === 'baixa'? '⚡✗' : '⚡' },
              { k: 'Mental',  v: checkin.mental  === 'focado'? '🎯✓' : checkin.mental  === 'ruim' ? '🎯✗' : '🎯' },
              { k: 'Humor',   v: checkin.humor   === 'feliz' ? '😊✓' : checkin.humor   === 'triste'? '😢✗': '😐' },
            ].map(item => (
              <div key={item.k} className="flex-1 text-center text-[#7a96b8]">
                <div className="text-[11px]">{item.v}</div>
                <div className="text-[8px] text-[#334455]">{item.k}</div>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* ── METAS ────────────────────────────────────── */}
      {targets && (
        <div className="rounded-xl border border-[#1c3050] bg-[#0f1824] p-3">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Target size={11} className="text-[#7a96b8]" />
            <span className="text-[9px] font-bold text-[#7a96b8] uppercase tracking-widest">Metas</span>
            {targets.locked ? (
              <span className="ml-auto text-[8px] font-bold px-1.5 py-0.5 rounded-full border text-[#ef4444] border-[#ef4444]/40 bg-[#ef4444]/10">
                🔒 BLOQUEADO
              </span>
            ) : targets.weeklyMet ? (
              <span className="ml-auto text-[8px] font-bold px-1.5 py-0.5 rounded-full border text-[#ffcc44] border-[#ffcc44]/40 bg-[#ffcc44]/10">
                🏆 SEMANA OK
              </span>
            ) : targets.dailyMet ? (
              <span className="ml-auto text-[8px] font-bold px-1.5 py-0.5 rounded-full border text-[#00e676] border-[#00e676]/40 bg-[#00e676]/10">
                ✓ DIA OK
              </span>
            ) : null}
          </div>

          {/* Capital consolidado — base de cálculo das metas */}
          {balance && balance > 0 && (
            <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-[#1c3050]">
              <span className="text-[8px] text-[#334455] uppercase tracking-widest">
                {(brokerCount ?? 1) > 1 ? `Capital · ${brokerCount} corretoras` : 'Capital'}
              </span>
              <span className="text-[10px] font-mono font-bold text-[#26c6da]">
                USD {balance.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {/* Meta diária */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[8px] text-[#334455] uppercase tracking-widest">Diária · {targets.DAILY_TARGET}%</span>
              <span
                className="text-[10px] font-mono font-bold"
                style={{ color: targets.dailyMet ? '#00e676' : targets.dailyPct >= targets.DAILY_TARGET * 0.7 ? '#f59e0b' : '#4499ff' }}
              >
                {targets.dailyPct >= 0 ? '+' : ''}{targets.dailyPct.toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 bg-[#131f2e] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min((targets.dailyPct / targets.DAILY_TARGET) * 100, 100)}%`,
                  background: targets.dailyMet
                    ? 'linear-gradient(90deg,#4499ff,#00e676)'
                    : targets.dailyPct >= targets.DAILY_TARGET * 0.7
                    ? 'linear-gradient(90deg,#4499ff,#f59e0b)'
                    : '#4499ff',
                }}
              />
            </div>
          </div>

          {/* Meta semanal */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[8px] text-[#334455] uppercase tracking-widest">Semanal · {targets.WEEKLY_TARGET}%</span>
              <span
                className="text-[10px] font-mono font-bold"
                style={{ color: targets.weeklyMet ? '#ffcc44' : targets.weeklyPct >= targets.WEEKLY_TARGET * 0.7 ? '#f59e0b' : '#4499ff' }}
              >
                {targets.weeklyPct >= 0 ? '+' : ''}{targets.weeklyPct.toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 bg-[#131f2e] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min((targets.weeklyPct / targets.WEEKLY_TARGET) * 100, 100)}%`,
                  background: targets.weeklyMet
                    ? 'linear-gradient(90deg,#4499ff,#ffcc44)'
                    : targets.weeklyPct >= targets.WEEKLY_TARGET * 0.7
                    ? 'linear-gradient(90deg,#4499ff,#f59e0b)'
                    : '#4499ff',
                }}
              />
            </div>
          </div>

          {/* Grid de dias SEG–QUI */}
          <div className="grid grid-cols-4 gap-1">
            {(['SEG','TER','QUA','QUI'] as const).map((day, i) => {
              const jsDay = new Date().getUTCDay()  // 1=Seg…4=Qui
              const thisDay = i + 1
              const isPast    = thisDay < jsDay
              const isToday   = thisDay === jsDay
              const dayMetKey = `rafi-daily-target-met-${getMondayPlusDays(i)}`
              const dayMet    = typeof window !== 'undefined' && localStorage.getItem(dayMetKey) === 'true'
              return (
                <div
                  key={day}
                  className={cn(
                    'rounded-lg py-1 text-center border transition-all',
                    dayMet
                      ? 'bg-[#00e676]/10 border-[#00e676]/30'
                      : isToday
                      ? 'bg-[#4499ff]/10 border-[#4499ff]/40'
                      : isPast
                      ? 'bg-[#131f2e] border-[#1c3050]'
                      : 'bg-[#0d1117] border-[#1c3050]',
                  )}
                >
                  <div className={cn(
                    'text-[7px] font-bold uppercase tracking-widest',
                    dayMet ? 'text-[#00e676]' : isToday ? 'text-[#4499ff]' : 'text-[#334455]',
                  )}>
                    {day}
                  </div>
                  <div className="text-[9px] mt-0.5">
                    {dayMet ? '✅' : isToday ? '🔄' : isPast ? '○' : '·'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

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
          locked={targets?.locked ?? false}
        />
      </div>
    </div>
  )
}
