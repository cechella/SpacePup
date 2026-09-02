'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Activity, Square, Play, RefreshCw, TrendingUp, TrendingDown,
  DollarSign, BarChart2, Clock, AlertTriangle, Wifi, WifiOff,
  ChevronUp, ChevronDown, Shield, Zap, Target, Calendar,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@supabase/supabase-js'

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null

// ── Faixas de lote (espelho da tabela Python) ─────────────────────────────────
const FAIXAS_LOTE = [
  { min: 0,      max: 40,      lote: '0.10L' },
  { min: 40,     max: 80,      lote: '0.20L' },
  { min: 80,     max: 150,     lote: '0.40L' },
  { min: 150,    max: 200,     lote: '0.70L' },
  { min: 200,    max: 400,     lote: '1.00L' },
  { min: 400,    max: 800,     lote: '2.00L' },
  { min: 800,    max: 1500,    lote: '4.00L' },
  { min: 1500,   max: 3000,    lote: '8.00L' },
  { min: 3000,   max: 6000,    lote: '15.0L' },
  { min: 6000,   max: 10000,   lote: '30.0L' },
  { min: 10000,  max: 20000,   lote: '50.0L' },
  { min: 20000,  max: Infinity, lote: '100L'  },
]
function loteAtual(balance: number) {
  return FAIXAS_LOTE.find(f => balance >= f.min && balance < f.max)?.lote ?? '0.10L'
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface BotStatus {
  id: string
  status: 'running' | 'stopped' | 'error' | 'waiting'
  balance: number
  equity: number
  open_positions: number
  pnl_today: number
  par: string
  server: string
  account: number
  last_signal: string | null
  updated_at: string
}

interface Trade {
  id: string
  direction: 'buy' | 'sell'
  entry: number
  stop_loss: number
  take_profit: number
  lot: number
  result: 'win' | 'loss' | 'pending'
  rafi: number | null
  pnl: number | null
  time: number
  label: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function secondsAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)   return `${diff}s atrás`
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`
  return `${Math.floor(diff / 3600)}h atrás`
}

function fmtUSD(v: number, plus = false) {
  const s = `$${Math.abs(v).toFixed(2)}`
  if (!plus) return v < 0 ? `-${s}` : s
  return v >= 0 ? `+${s}` : `-${s}`
}

function fmtPct(v: number, plus = false) {
  const s = `${Math.abs(v).toFixed(2)}%`
  if (!plus) return v < 0 ? `-${s}` : s
  return v >= 0 ? `+${s}` : `-${s}`
}

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function startOfDay(d: Date) {
  const r = new Date(d); r.setUTCHours(0, 0, 0, 0); return r
}
function startOfWeek(d: Date) {
  const r = new Date(d)
  const day = r.getUTCDay()
  r.setUTCDate(r.getUTCDate() - (day === 0 ? 6 : day - 1))
  r.setUTCHours(0, 0, 0, 0)
  return r
}

// ── Equity sparkline SVG ──────────────────────────────────────────────────────
function EquitySparkline({ trades, balance }: { trades: Trade[]; balance: number }) {
  const closed = useMemo(() =>
    [...trades]
      .filter(t => t.result !== 'pending')
      .sort((a, b) => a.time - b.time),
    [trades]
  )

  if (closed.length < 2) {
    return (
      <div className="flex items-center justify-center h-full text-[#484f58] text-xs">
        Aguardando trades para curva de equity
      </div>
    )
  }

  // Compute cumulative PNL (use actual pnl or estimate from R)
  let cumulative = 0
  const points = closed.map(t => {
    if (t.pnl !== null) {
      cumulative += t.pnl
    } else {
      // Estimate: win ≈ +1.5R, loss ≈ -1R (typical RR)
      const R = Math.abs(t.entry - t.stop_loss) * (t.lot ?? 0.1) * 100000
      cumulative += t.result === 'win' ? R * 1.5 : -R
    }
    return cumulative
  })

  const min = Math.min(0, ...points)
  const max = Math.max(0, ...points)
  const range = max - min || 1
  const W = 500, H = 80, PAD = 8

  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2)
  const y = (v: number) => PAD + (1 - (v - min) / range) * (H - PAD * 2)

  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`

  const zeroY = y(0)
  const isPositive = points[points.length - 1] >= 0
  const lineColor  = isPositive ? '#10b981' : '#ef4444'

  return (
    <div className="w-full h-full flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {/* Zero line */}
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY}
          stroke="#30363d" strokeWidth="0.5" strokeDasharray="3,3" />
        {/* Area fill */}
        <path d={area} fill="url(#eq-grad)" />
        {/* Equity line */}
        <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
        {/* Last point dot */}
        <circle
          cx={x(points.length - 1)} cy={y(points[points.length - 1])}
          r="3" fill={lineColor} />
      </svg>
      <div className="flex justify-between text-[9px] font-mono text-[#484f58] px-2">
        <span>{closed[0] ? new Date(closed[0].time * 1000).toLocaleDateString('pt-BR') : ''}</span>
        <span className={cn('font-bold', isPositive ? 'text-[#10b981]' : 'text-[#ef4444]')}>
          {fmtUSD(points[points.length - 1], true)} acumulado
        </span>
        <span>agora</span>
      </div>
    </div>
  )
}

// ── Daily P&L bar chart ───────────────────────────────────────────────────────
function DailyBars({ trades }: { trades: Trade[] }) {
  const daily = useMemo(() => {
    const map = new Map<string, number>()
    trades
      .filter(t => t.result !== 'pending')
      .forEach(t => {
        const key = new Date(t.time * 1000).toISOString().slice(0, 10)
        const pnl = t.pnl ?? (t.result === 'win' ? 1 : -1)
        map.set(key, (map.get(key) ?? 0) + pnl)
      })
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14) // last 14 days
  }, [trades])

  if (daily.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#484f58] text-xs">
        Sem histórico diário
      </div>
    )
  }

  const maxAbs = Math.max(...daily.map(([, v]) => Math.abs(v)), 0.001)

  return (
    <div className="flex items-end gap-1 h-full px-1">
      {daily.map(([date, pnl]) => {
        const pct = Math.abs(pnl) / maxAbs
        const isPos = pnl >= 0
        const label = date.slice(5) // MM-DD
        return (
          <div key={date} className="flex flex-col items-center gap-0.5 flex-1 min-w-0 h-full justify-end">
            <div
              className="w-full rounded-sm min-h-[2px] transition-all"
              style={{
                height: `${Math.max(4, pct * 60)}px`,
                background: isPos ? '#10b981' : '#ef4444',
                opacity: 0.8,
              }}
              title={`${date}: ${fmtUSD(pnl, true)}`}
            />
            <span className="text-[7px] text-[#484f58] truncate w-full text-center">{label}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, color, icon: Icon, badge }: {
  label: string; value: string; sub?: string; color?: string
  icon?: React.ElementType; badge?: string
}) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 relative overflow-hidden">
      {badge && (
        <span className="absolute top-3 right-3 text-[7px] font-bold px-1.5 py-0.5 rounded
          bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/20">
          {badge}
        </span>
      )}
      <div className="flex items-center gap-2 mb-2">
        {Icon && <Icon size={12} className="text-[#484f58]" />}
        <span className="text-[9px] uppercase tracking-widest text-[#484f58]">{label}</span>
      </div>
      <div className="text-xl font-black font-mono leading-none" style={{ color: color ?? '#f0f6fc' }}>
        {value}
      </div>
      {sub && <div className="text-[9px] text-[#484f58] mt-1">{sub}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [status,      setStatus]      = useState<BotStatus | null>(null)
  const [trades,      setTrades]      = useState<Trade[]>([])
  const [loading,     setLoading]     = useState(true)
  const [cmdSent,     setCmdSent]     = useState(false)
  const [activeTab,   setActiveTab]   = useState<'history' | 'open'>('history')

  // ── Fetch ───────────────────────────────────────────────────────────────────
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
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await fetchAll()
    setLoading(false)
  }, [fetchAll])

  useEffect(() => {
    refresh()
    const iv = setInterval(fetchAll, 10_000)
    return () => clearInterval(iv)
  }, [fetchAll, refresh])

  // ── Comando PARAR / INICIAR ─────────────────────────────────────────────────
  const enviarComando = async (cmd: 'stop' | 'start') => {
    if (!supa) return
    setCmdSent(true)
    try {
      await supa.from('rafi_bot_commands').insert({
        command: cmd, pending: true, created_at: new Date().toISOString(),
      })
      setTimeout(() => { setCmdSent(false); fetchAll() }, 3000)
    } catch { setCmdSent(false) }
  }

  // ── Métricas computadas ─────────────────────────────────────────────────────
  const now = Date.now()

  const isOnline = status
    ? (now - new Date(status.updated_at).getTime()) < 420_000 // 7min: cobre candle M5 (5min) + buffer
    : false

  const statusColor =
    !status    ? '#484f58' :
    !isOnline  ? '#ef4444' :
    status.status === 'running' ? '#10b981' :
    status.status === 'waiting' ? '#f59e0b' : '#ef4444'

  const statusLabel =
    !status    ? 'SEM DADOS' :
    !isOnline  ? 'OFFLINE'   :
    status.status === 'running' ? 'EM POSIÇÃO' :
    status.status === 'waiting' ? 'AGUARDANDO' : 'PARADO'

  const pending = useMemo(() => trades.filter(t => t.result === 'pending'), [trades])
  const closed  = useMemo(() => trades.filter(t => t.result !== 'pending'), [trades])
  const wins    = useMemo(() => closed.filter(t => t.result === 'win').length,  [closed])
  const losses  = useMemo(() => closed.filter(t => t.result === 'loss').length, [closed])
  const wr      = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null

  // Period filters
  const todayStart   = startOfDay(new Date()).getTime() / 1000
  const weekStart    = startOfWeek(new Date()).getTime() / 1000
  const day7Start    = (now - 7  * 86400_000) / 1000
  const day30Start   = (now - 30 * 86400_000) / 1000

  function pnlPeriod(fromTs: number) {
    return closed
      .filter(t => t.time >= fromTs)
      .reduce((s, t) => s + (t.pnl ?? (t.result === 'win' ? 1 : -1)), 0)
  }
  function wrPeriod(fromTs: number) {
    const p = closed.filter(t => t.time >= fromTs)
    const w = p.filter(t => t.result === 'win').length
    return p.length > 0 ? Math.round(w / p.length * 100) : null
  }

  const pnlToday  = status?.pnl_today ?? pnlPeriod(todayStart)
  const pnlWeek   = pnlPeriod(weekStart)
  const pnl7d     = pnlPeriod(day7Start)
  const pnl30d    = pnlPeriod(day30Start)
  const wr7d      = wrPeriod(day7Start)

  const bal = status?.balance ?? 0
  const pctToday = bal > 0 ? (pnlToday / (bal - pnlToday)) * 100 : 0
  const pct7d    = bal > 0 ? (pnl7d    / (bal - pnl7d))    * 100 : 0
  const pct30d   = bal > 0 ? (pnl30d   / (bal - pnl30d))   * 100 : 0

  const tradesHoje = closed.filter(t => t.time >= todayStart).length
  const tradesSemana = closed.filter(t => t.time >= weekStart).length

  const pnlColor  = (v: number) => v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#484f58'
  const pctColor  = (v: number) => v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#484f58'

  return (
    <div className="min-h-screen bg-[#0d1117] p-4 space-y-4">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-black text-[#f0f6fc] flex items-center gap-2">
            <Activity size={18} className="text-[#10b981]" />
            Cockpit RAFI
          </h1>
          <p className="text-[10px] text-[#484f58] mt-0.5">
            {status
              ? `Conta ${status.account} · ${status.server} · ${status.par}`
              : 'Aguardando conexão com o bot...'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Status pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold"
            style={{ background: `${statusColor}15`, borderColor: `${statusColor}30`, color: statusColor }}>
            <span className={cn('w-2 h-2 rounded-full', isOnline && 'animate-pulse')}
              style={{ background: statusColor }} />
            {statusLabel}
            {status && isOnline && (
              <span className="font-normal opacity-60 text-[9px]">· {secondsAgo(status.updated_at)}</span>
            )}
          </div>

          <button onClick={refresh}
            className="p-1.5 rounded-lg border border-[#30363d] text-[#484f58] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>

          {(isOnline && status?.status !== 'stopped') ? (
            <button onClick={() => enviarComando('stop')} disabled={cmdSent}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold text-xs transition-all',
                cmdSent ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444] hover:bg-[#ef4444]/20',
              )}>
              <Square size={11} fill="currentColor" />
              {cmdSent ? 'Enviando...' : 'PARAR'}
            </button>
          ) : (
            <button onClick={() => enviarComando('start')} disabled={cmdSent}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold text-xs transition-all',
                cmdSent ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#10b981]/10 border-[#10b981]/30 text-[#10b981] hover:bg-[#10b981]/20',
              )}>
              <Play size={11} fill="currentColor" />
              {cmdSent ? 'Enviando...' : 'INICIAR'}
            </button>
          )}
        </div>
      </div>

      {/* ── Top 5 stats ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat
          label="Saldo"
          value={status ? fmtUSD(status.balance) : '—'}
          sub={status ? `Lote: ${loteAtual(status.balance)}` : 'aguardando bot'}
          color="#f0f6fc"
          icon={DollarSign}
        />
        <Stat
          label="P&L Hoje"
          value={status ? fmtUSD(pnlToday, true) : '—'}
          sub={status ? fmtPct(pctToday, true) + ` · ${tradesHoje} trades` : ''}
          color={pnlColor(pnlToday)}
          icon={Calendar}
          badge={tradesHoje > 0 ? `${tradesHoje}T` : undefined}
        />
        <Stat
          label="P&L 7 Dias"
          value={fmtUSD(pnl7d, true) || '—'}
          sub={wr7d !== null ? `WR 7d: ${wr7d}%` : 'sem trades'}
          color={pnlColor(pnl7d)}
          icon={TrendingUp}
        />
        <Stat
          label="P&L 30 Dias"
          value={fmtUSD(pnl30d, true) || '—'}
          sub={fmtPct(pct30d, true)}
          color={pnlColor(pnl30d)}
          icon={BarChart2}
        />
        <Stat
          label="Win Rate"
          value={wr !== null ? `${wr}%` : '—'}
          sub={`${wins}W / ${losses}L · ${wins + losses} total`}
          color={wr === null ? '#484f58' : wr >= 60 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#ef4444'}
          icon={Target}
        />
      </div>

      {/* ── Charts ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Equity curve */}
        <div className="lg:col-span-2 bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={12} className="text-[#10b981]" />
            <span className="text-[9px] uppercase tracking-widest text-[#484f58]">Curva de Equity</span>
            <span className="ml-auto text-[9px] text-[#484f58]">{closed.length} trades</span>
          </div>
          <div style={{ height: 100 }}>
            <EquitySparkline trades={trades} balance={bal} />
          </div>
        </div>

        {/* Performance summary */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart2 size={12} className="text-[#3b82f6]" />
            <span className="text-[9px] uppercase tracking-widest text-[#484f58]">Performance</span>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Hoje',       pnl: pnlToday, pct: pctToday,  trades: tradesHoje },
              { label: 'Esta semana',pnl: pnlWeek,  pct: 0,         trades: tradesSemana },
              { label: '7 dias',     pnl: pnl7d,    pct: pct7d,     trades: closed.filter(t=>t.time>=day7Start).length },
              { label: '30 dias',    pnl: pnl30d,   pct: pct30d,    trades: closed.filter(t=>t.time>=day30Start).length },
            ].map(({ label, pnl, pct, trades: n }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[10px] text-[#8b949e]">{label}</span>
                <div className="text-right">
                  <span className="text-xs font-black font-mono" style={{ color: pnlColor(pnl) }}>
                    {n > 0 ? fmtUSD(pnl, true) : '—'}
                  </span>
                  {n > 0 && pct !== 0 && (
                    <span className="text-[9px] ml-1.5 font-mono" style={{ color: pctColor(pct) }}>
                      ({fmtPct(pct, true)})
                    </span>
                  )}
                  <div className="text-[8px] text-[#484f58]">{n} trade{n !== 1 ? 's' : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Barras diárias ──────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={12} className="text-[#f59e0b]" />
          <span className="text-[9px] uppercase tracking-widest text-[#484f58]">
            P&L por dia (últimos 14 dias)
          </span>
        </div>
        <div style={{ height: 72 }}>
          <DailyBars trades={trades} />
        </div>
      </div>

      {/* ── Posições abertas ───────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <div className="bg-[#161b22] border border-[#f59e0b]/25 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#30363d] bg-[#f59e0b]/5 flex items-center gap-2">
            <Zap size={12} className="text-[#f59e0b]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">
              Posições Abertas ({pending.length})
            </span>
          </div>
          <div className="divide-y divide-[#30363d]/50">
            {pending.map(t => {
              const isBuy = t.direction === 'buy'
              const riskPips = isBuy
                ? Math.round((t.entry - t.stop_loss) * 10000)
                : Math.round((t.stop_loss - t.entry) * 10000)
              return (
                <div key={t.id} className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      'flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded',
                      isBuy ? 'bg-[#3b82f6]/15 text-[#3b82f6]' : 'bg-[#f59e0b]/15 text-[#f59e0b]',
                    )}>
                      {isBuy ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      {isBuy ? 'BUY' : 'SELL'}
                    </span>
                    <span className="font-mono text-sm text-[#f0f6fc]">{t.entry.toFixed(5)}</span>
                  </div>
                  <div className="flex items-center gap-5 text-[10px] font-mono text-[#8b949e]">
                    <span>SL <span className="text-[#ef4444]">{t.stop_loss.toFixed(5)}</span></span>
                    <span>TP <span className="text-[#10b981]">{t.take_profit.toFixed(5)}</span></span>
                    <span>{t.lot.toFixed(2)}L</span>
                    <span>{riskPips}p risco</span>
                    {t.rafi !== null && (
                      <span>RAFI <span className={t.rafi >= 2.5 ? 'text-[#10b981]' : 'text-[#f59e0b]'}>
                        {t.rafi.toFixed(1)}
                      </span></span>
                    )}
                    <span className="text-[#484f58]">{fmtTime(t.time)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Config panels ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Proteções */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Shield size={12} className="text-[#3b82f6]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Proteções Ativas</span>
          </div>
          <div className="space-y-2 text-[10px] font-mono">
            {[
              ['Risco/trade',     '2%',  true],
              ['Perda máx/dia',   '5%',  true],
              ['Max posições',    '1',   true],
              ['Stop obrigatório','SIM', true],
              ['Martingale',      'NÃO', true],
              ['Alavancagem ef.', '≤ 1:50', true],
            ].map(([label, value, ok]) => (
              <div key={String(label)} className="flex items-center justify-between">
                <span className="text-[#484f58]">{label}</span>
                <span className={ok ? 'text-[#10b981]' : 'text-[#ef4444]'}>{String(value)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Lote atual */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <DollarSign size={12} className="text-[#10b981]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Lote & Escala</span>
          </div>
          {status ? (
            <div className="space-y-2">
              <div className="text-2xl font-black text-[#10b981] font-mono">
                {loteAtual(status.balance)}
              </div>
              <div className="text-[9px] text-[#484f58]">Saldo: {fmtUSD(status.balance)}</div>
              <div className="mt-3 space-y-1">
                {FAIXAS_LOTE.slice(0, 6).map(f => (
                  <div key={f.lote} className={cn(
                    'flex justify-between text-[9px] font-mono px-1.5 py-0.5 rounded',
                    status.balance >= f.min && status.balance < f.max
                      ? 'bg-[#10b981]/10 text-[#10b981]'
                      : 'text-[#484f58]',
                  )}>
                    <span>${f.min}–{f.max === Infinity ? '∞' : `$${f.max}`}</span>
                    <span>{f.lote}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[#484f58] text-xs">Aguardando saldo...</div>
          )}
        </div>

        {/* Conexão MT5 */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={12} className="text-[#f59e0b]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Conexão MT5</span>
          </div>
          <div className="space-y-2 text-[10px] font-mono">
            {isOnline ? (
              <>
                <div className="flex items-center gap-2 text-[#10b981] font-bold">
                  <Wifi size={11} /> ONLINE
                </div>
                <div className="text-[#8b949e]">Conta: <span className="text-[#f0f6fc]">{status?.account}</span></div>
                <div className="text-[#8b949e]">Servidor: <span className="text-[#f0f6fc]">{status?.server || '—'}</span></div>
                <div className="text-[#8b949e]">Par: <span className="text-[#f0f6fc]">{status?.par}</span></div>
                <div className="text-[#8b949e]">Heartbeat: <span className="text-[#f0f6fc]">{status ? secondsAgo(status.updated_at) : '—'}</span></div>
                <div className="text-[#8b949e]">Posições: <span className="text-[#f0f6fc]">{status?.open_positions}</span></div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[#ef4444]">
                <WifiOff size={11} />
                {status ? `Offline · ${secondsAgo(status.updated_at)}` : 'Bot não iniciado'}
              </div>
            )}
            {!supa && (
              <div className="text-[#ef4444] mt-2">
                SUPABASE não configurado
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Histórico de trades ────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#30363d] bg-[#0d1117] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart2 size={12} className="text-[#3b82f6]" />
            <span className="text-[9px] uppercase tracking-widest text-[#484f58]">Histórico</span>
          </div>
          <div className="flex items-center gap-1">
            {(['history', 'open'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-3 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all',
                  activeTab === tab
                    ? 'bg-[#21262d] text-[#f0f6fc]'
                    : 'text-[#484f58] hover:text-[#8b949e]',
                )}>
                {tab === 'history' ? `Fechados (${closed.length})` : `Abertos (${pending.length})`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[9px] font-mono">
            <span className="text-[#10b981]">{wins}W</span>
            <span className="text-[#ef4444]">{losses}L</span>
            {wr !== null && <span className="text-[#f0f6fc] font-bold">{wr}% WR</span>}
          </div>
        </div>

        {(activeTab === 'history' ? closed : pending).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <AlertTriangle size={24} className="text-[#30363d]" />
            <p className="text-xs text-[#484f58]">
              {activeTab === 'history'
                ? 'Nenhum trade fechado ainda.'
                : 'Nenhuma posição aberta.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#30363d] bg-[#0d1117]">
                  {['Data/Hora', 'Dir', 'Entry', 'SL', 'TP', 'Lote', 'RAFI', 'P&L', 'Resultado'].map(h => (
                    <th key={h} className="py-2 px-3 text-left text-[8px] uppercase tracking-wider text-[#484f58] font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(activeTab === 'history' ? closed : pending).slice(0, 50).map(t => {
                  const isBuy = t.direction === 'buy'
                  return (
                    <tr key={t.id} className={cn(
                      'border-b border-[#30363d]/40 text-[10px] font-mono hover:bg-[#21262d]/40',
                      t.result === 'win'     && 'bg-[#10b981]/3',
                      t.result === 'loss'    && 'bg-[#ef4444]/3',
                      t.result === 'pending' && 'bg-[#f59e0b]/3',
                    )}>
                      <td className="py-2 px-3 text-[#484f58] whitespace-nowrap">{fmtTime(t.time)}</td>
                      <td className="py-2 px-3">
                        <span className={cn('flex items-center gap-0.5 font-bold',
                          isBuy ? 'text-[#3b82f6]' : 'text-[#f59e0b]')}>
                          {isBuy ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
                          {isBuy ? 'BUY' : 'SELL'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-[#f0f6fc]">{t.entry.toFixed(5)}</td>
                      <td className="py-2 px-3 text-[#ef4444]">{t.stop_loss.toFixed(5)}</td>
                      <td className="py-2 px-3 text-[#10b981]">{t.take_profit.toFixed(5)}</td>
                      <td className="py-2 px-3 text-[#8b949e]">{t.lot.toFixed(2)}L</td>
                      <td className="py-2 px-3">
                        {t.rafi !== null
                          ? <span style={{ color: (t.rafi ?? 0) >= 2.5 ? '#10b981' : '#f59e0b' }}>{t.rafi.toFixed(1)}</span>
                          : <span className="text-[#484f58]">—</span>}
                      </td>
                      <td className="py-2 px-3 font-bold"
                        style={{ color: t.pnl == null ? '#484f58' : t.pnl >= 0 ? '#10b981' : '#ef4444' }}>
                        {t.pnl != null ? fmtUSD(t.pnl, true) : '—'}
                      </td>
                      <td className="py-2 px-3">
                        {t.result === 'win'
                          ? <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/25">WIN</span>
                          : t.result === 'loss'
                          ? <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/25">LOSS</span>
                          : <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#f59e0b]/15 text-[#f59e0b] border border-[#f59e0b]/25 animate-pulse">ABERTO</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Kill switch ─────────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#ef4444]/15 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs font-semibold text-[#f0f6fc]">Kill Switch de Emergência</div>
          <div className="text-[9px] text-[#484f58] mt-0.5">
            Envia STOP imediato — bot para no próximo ciclo (máx 5 min).
            Alternativa: crie o arquivo <code className="text-[#8b949e]">STOP</code> em <code className="text-[#8b949e]">C:\RafiBot\rafi-bot\</code>
          </div>
        </div>
        <button onClick={() => enviarComando('stop')} disabled={cmdSent}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg border font-bold text-xs transition-all shrink-0',
            cmdSent
              ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
              : 'bg-[#ef4444]/10 border-[#ef4444]/25 text-[#ef4444] hover:bg-[#ef4444]/20',
          )}>
          <Square size={11} fill="currentColor" />
          {cmdSent ? 'Enviado' : 'PARAR AGORA'}
        </button>
      </div>

    </div>
  )
}
