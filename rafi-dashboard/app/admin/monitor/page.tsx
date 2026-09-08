'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { RefreshCw, X, TrendingUp, Bell } from 'lucide-react'
import { createClient } from '@supabase/supabase-js'

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null

// ── Design tokens — cockpit terminal escuro fixo ──────────────────────────────
const C = {
  bg:  '#07090F', bg2: '#0A0D15', s1: '#0C1018', s2: '#111825', s3: '#172030',
  b1:  '#1A2535', b2: '#243348',
  teal: '#00C896', gr: '#10B981', re: '#EF4444', am: '#F59E0B', bl: '#3B82F6',
  tx:  '#DCE8F8', t2: '#5C7399', t3: '#2E3D55',
  // aliases
  bd:  '#1A2535', bd2: 'rgba(26,37,53,.5)',
  cy:  '#3B82F6', cya: 'rgba(59,130,246,.08)',
  gra: 'rgba(16,185,129,.10)', rea: 'rgba(239,68,68,.10)', ama: 'rgba(245,158,11,.08)',
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
  config_hash?: string | null
  ml_modelo_carregado?: boolean
  ml_modo?: 'OBSERVAÇÃO' | 'ADAPTAÇÃO'
  ml_wr_rolling?: number | null
  ml_pf_rolling?: number | null
  ml_sinais_hoje?: number
  ml_aprovados_hoje?: number
  ml_treinado_em?: string | null
  ml_threshold?: number
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

// ── Equity Curve ──────────────────────────────────────────────────────────────
function EquityCurve({ trades }: { trades: Trade[] }) {
  const closed = useMemo(() =>
    [...trades].filter(t => t.result !== 'pending').sort((a, b) => a.time - b.time), [trades])

  if (closed.length < 2) return (
    <div style={{ height: 130, display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: C.t3, fontSize: 11 }}>
      Aguardando trades para curva de equity
    </div>
  )

  let cum = 0
  const pts = closed.map(t => {
    const comm = (t.lot ?? 0.1) * 7
    if (t.pnl !== null) { cum += t.pnl - comm } else {
      const R = Math.abs(t.entry - t.stop_loss) * (t.lot ?? 0.1) * 100000
      cum += t.result === 'win' ? R * 1.5 - comm : -R - comm
    }
    return { cum, trade: t }
  })

  const min = Math.min(0, ...pts.map(p => p.cum))
  const max = Math.max(0.01, ...pts.map(p => p.cum))
  const rng = max - min
  const W = 560, H = 120, PL = 44, PR = 8, PT = 8, PB = 18
  const iW = W - PL - PR, iH = H - PT - PB
  const xp = (i: number) => PL + (i / Math.max(pts.length - 1, 1)) * iW
  const yp = (v: number) => PT + (1 - (v - min) / rng) * iH

  const linePath = pts.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xp(i).toFixed(1)},${yp(p.cum).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${xp(pts.length-1).toFixed(1)},${yp(0).toFixed(1)} L${xp(0).toFixed(1)},${yp(0).toFixed(1)} Z`
  const lastCum  = pts[pts.length - 1].cum
  const lc = lastCum >= 0 ? C.teal : C.re
  const zeroY = yp(0)
  const gridVals = [min, min + rng * 0.5, max]
  const labelDots = [0, Math.floor((pts.length - 1) / 2), pts.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      <defs>
        <linearGradient id="ecg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={lc} stopOpacity="0.22" />
          <stop offset="100%" stopColor={lc} stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={PL} y1={yp(v).toFixed(1)} x2={W - PR} y2={yp(v).toFixed(1)}
            stroke={C.b1} strokeWidth="1" />
          <text x={PL - 4} y={(yp(v) + 3).toFixed(1)} fill={C.t3} fontSize="7"
            textAnchor="end" fontFamily="'JetBrains Mono', monospace">
            {v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`}
          </text>
        </g>
      ))}
      {min < 0 && (
        <line x1={PL} y1={zeroY.toFixed(1)} x2={W - PR} y2={zeroY.toFixed(1)}
          stroke={C.t3} strokeWidth="0.5" strokeDasharray="3,3" />
      )}
      <path d={areaPath} fill="url(#ecg)" />
      <path d={linePath} fill="none" stroke={lc} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={xp(i).toFixed(1)} cy={yp(p.cum).toFixed(1)} r="2.5"
          fill={p.trade.result === 'win' ? C.teal : C.re} opacity="0.85" />
      ))}
      <circle cx={xp(pts.length - 1).toFixed(1)} cy={yp(lastCum).toFixed(1)}
        r="4" fill={lc} />
      {labelDots.map(i => (
        <text key={i} x={xp(i).toFixed(1)} y={H} fill={C.t3} fontSize="7"
          textAnchor="middle" fontFamily="'JetBrains Mono', monospace">
          {new Date(closed[i]?.time * 1000).toLocaleDateString('pt-BR',
            { day: '2-digit', month: '2-digit' })}
        </text>
      ))}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [status,     setStatus]     = useState<BotStatus | null>(null)
  const [trades,     setTrades]     = useState<Trade[]>([])
  const [loading,    setLoading]    = useState(true)
  const [cmdSent,    setCmdSent]    = useState(false)
  const [alert,      setAlert]      = useState<string | null>(null)
  const [m5Secs,     setM5Secs]     = useState(0)
  const [londonTime, setLondonTime] = useState('')
  const [botLogs,    setBotLogs]    = useState<BotLog[]>([])
  const [tradeFilter, setTradeFilter] = useState<'all' | 'wins' | 'losses' | 'today'>('all')
  const prevPendingLen = useRef(0)

  // ── London clock ──────────────────────────────────────────────────────────
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

  // ── Fetch ──────────────────────────────────────────────────────────────────
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

  const fetchLogs = useCallback(async () => {
    if (!supa) return
    try {
      const { data: lg } = await supa.from('rafi_bot_logs')
        .select('*').order('created_at', { ascending: false }).limit(50)
      if (lg) setBotLogs(lg as BotLog[])
    } catch {}
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchAll(), fetchLogs()])
    setLoading(false)
  }, [fetchAll, fetchLogs])

  useEffect(() => {
    refresh()
    const iv1 = setInterval(fetchAll,   10_000)
    const iv2 = setInterval(fetchLogs,   5_000)
    return () => { clearInterval(iv1); clearInterval(iv2) }
  }, [fetchAll, fetchLogs, refresh])

  // ── M5 countdown ───────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000)
      setM5Secs((Math.floor(now / 300) + 1) * 300 - now)
    }
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [])

  // ── Alert on new trade ─────────────────────────────────────────────────────
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

  // ── Commands ───────────────────────────────────────────────────────────────
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

  // ── Metrics ────────────────────────────────────────────────────────────────
  const now      = Date.now()
  const isOnline = status ? (now - new Date(status.updated_at).getTime()) < 420_000 : false
  const statusLabel =
    !status   ? 'SEM DADOS' : !isOnline ? 'OFFLINE' :
    status.status === 'running' ? 'EM POSIÇÃO' :
    status.status === 'waiting' ? 'AGUARDANDO' : 'PARADO'
  const statusColor =
    !status   ? C.t3 : !isOnline ? C.re :
    status.status === 'running' ? C.teal :
    status.status === 'waiting' ? C.am : C.re

  const closed  = useMemo(() => trades.filter(t => t.result !== 'pending'), [trades])
  const wins    = useMemo(() => closed.filter(t => t.result === 'win').length,  [closed])
  const losses  = useMemo(() => closed.filter(t => t.result === 'loss').length, [closed])
  const wr      = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null

  const todayStart = startOfDay(new Date()).getTime() / 1000

  const realPnLTrades = useMemo(() => closed.filter(t => t.pnl != null), [closed])
  const totalGross    = realPnLTrades.reduce((s, t) => s + t.pnl!, 0)
  const totalComm     = realPnLTrades.reduce((s, t) => s + (t.lot ?? 0.1) * 7, 0)
  const totalNet      = totalGross - totalComm

  const pnlTodayCalc = closed
    .filter(t => t.time >= todayStart && t.pnl != null)
    .reduce((s, t) => s + t.pnl!, 0)
  const pnlToday   = status?.pnl_today ?? pnlTodayCalc
  const floatPnL   = status ? (status.equity - status.balance) : 0
  const bal        = status?.balance ?? 0
  const eq         = status?.equity ?? bal
  const pctToday   = bal > 0 ? (pnlToday / Math.max(bal, 0.01)) * 100 : 0
  const tradesHoje = closed.filter(t => t.time >= todayStart).length

  // Profit factor
  const grossWins   = realPnLTrades.filter(t => t.pnl! > 0).reduce((s, t) => s + t.pnl!, 0)
  const grossLosses = Math.abs(realPnLTrades.filter(t => t.pnl! < 0).reduce((s, t) => s + t.pnl!, 0))
  const pf          = grossLosses > 0 ? (grossWins / grossLosses) : null

  // Best / worst trade (net)
  const netTrades = realPnLTrades.map(t => ({ ...t, net: t.pnl! - (t.lot ?? 0.1) * 7 }))
  const maxWin    = netTrades.length ? Math.max(...netTrades.map(t => t.net)) : 0
  const maxLoss   = netTrades.length ? Math.min(...netTrades.map(t => t.net)) : 0

  // Streak
  const sortedClosed = [...closed].sort((a, b) => a.time - b.time)
  let streak = 0, streakType: 'win' | 'loss' | null = null
  for (let i = sortedClosed.length - 1; i >= 0; i--) {
    const r = sortedClosed[i].result
    if (r === 'pending') continue
    if (!streakType) { streakType = r as 'win' | 'loss'; streak = 1 }
    else if (r === streakType) streak++
    else break
  }

  // IA milestones
  const IA_MILESTONES = [10, 20, 50, 100, 200, 300]
  const iaCount    = closed.length
  const iaPct      = Math.min(100, (iaCount / 300) * 100)
  const nextMilestone = IA_MILESTONES.find(m => m > iaCount) ?? 300
  const prevMilestone = [...IA_MILESTONES].reverse().find(m => m <= iaCount) ?? 0
  const segPct = nextMilestone > prevMilestone
    ? Math.min(100, ((iaCount - prevMilestone) / (nextMilestone - prevMilestone)) * 100)
    : 100

  // Forming signal
  const showForming  = !!(status?.forming_signal)
  const formingDir   = status?.forming_direction ?? 'buy'
  const formingRafi  = status?.forming_rafi ?? 0
  const formingTf    = status?.forming_tf_count ?? 0
  const formingBb    = status?.forming_bb_open ?? false
  const formingPrice = status?.forming_price ?? 0

  // M5 timer
  const m5mm  = String(Math.floor(m5Secs / 60)).padStart(2, '0')
  const m5ss  = String(m5Secs % 60).padStart(2, '0')

  // Active position (first pending)
  const openPos = pending[0] ?? null

  // Trades table filter
  const filteredTrades = useMemo(() => {
    let list = [...closed].sort((a, b) => b.time - a.time)
    if (tradeFilter === 'wins')   list = list.filter(t => t.result === 'win')
    if (tradeFilter === 'losses') list = list.filter(t => t.result === 'loss')
    if (tradeFilter === 'today')  list = list.filter(t => t.time >= todayStart)
    return list.slice(0, 30)
  }, [closed, tradeFilter, todayStart])

  // Inline style helpers
  const mono = { fontFamily: "'JetBrains Mono', monospace" } as React.CSSProperties
  const card = {
    background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 12,
  } as React.CSSProperties
  const lbl = {
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.13em', color: C.t2, marginBottom: 6,
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.tx, fontSize: 13,
      lineHeight: 1.5, fontFamily: "'Inter', system-ui, sans-serif" }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${C.bg}; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.5} }
        .kpi-card:hover { border-color: ${C.teal}40 !important; }
        .trade-row:hover td { background: ${C.s2} !important; }
        .filter-btn { cursor: pointer; border: none; transition: all .15s; }
        .filter-btn:hover { background: ${C.b2} !important; color: ${C.tx} !important; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.b2}; border-radius: 2px; }
      `}</style>

      {/* ── Alert toast ────────────────────────────────────────────────────── */}
      {alert && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 50,
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 16px', maxWidth: 360, borderRadius: 12,
          background: C.s1, border: `1px solid ${C.teal}40`,
          boxShadow: '0 8px 32px rgba(0,0,0,.6)', animation: 'fadeIn .2s ease',
        }}>
          <Bell size={14} style={{ color: C.teal, marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.teal }}>Novo Trade Disparado!</div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 2, wordBreak: 'break-all' }}>{alert}</div>
          </div>
          <button onClick={() => setAlert(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t3, padding: 0 }}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: C.s1, borderBottom: `1px solid ${C.bd}`,
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px', height: 52,
      }}>
        {/* Logo */}
        <div style={{
          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
          background: `${C.teal}18`, border: `1px solid ${C.teal}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <TrendingUp size={14} style={{ color: C.teal }} />
        </div>
        <div style={{ marginRight: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, fontFamily: "'Space Grotesk', sans-serif" }}>
            RAFI Bot
          </div>
          <div style={{ fontSize: 9, color: C.t2, ...mono }}>
            {status ? `${status.par} · M5 · ${status.server}` : 'EURUSD · M5 · MetaTrader 5'}
          </div>
        </div>

        <div style={{ width: 1, height: 28, background: C.bd, margin: '0 8px', flexShrink: 0 }} />

        {/* AO VIVO badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6,
          background: isOnline ? `${C.teal}15` : `${C.re}15`,
          border: `1px solid ${isOnline ? C.teal : C.re}40`,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: isOnline ? C.teal : C.re,
            animation: isOnline ? 'pulse 1.8s ease-in-out infinite' : 'none',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: isOnline ? C.teal : C.re, ...mono }}>
            {statusLabel}
          </span>
          {status && isOnline && (
            <span style={{ fontSize: 9, color: C.t3, ...mono }}>· {secondsAgo(status.updated_at)}</span>
          )}
        </div>

        {/* EURUSD chip */}
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 6,
          border: `1px solid ${C.bl}30`, color: C.bl, background: C.cya, ...mono,
        }}>EURUSD · M5</span>

        <div style={{ flex: 1 }} />

        {/* London time */}
        <span style={{ fontSize: 10, color: C.t2, ...mono }}>{londonTime}</span>

        {/* M5 timer */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 6,
          background: C.s2, border: `1px solid ${C.bd}`,
        }}>
          <span style={{ fontSize: 9, color: C.t3, ...mono }}>M5</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.am, ...mono }}>{m5mm}:{m5ss}</span>
        </div>

        {/* Refresh */}
        <button onClick={refresh} disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8,
            background: C.s2, border: `1px solid ${C.bd}`, cursor: 'pointer',
            color: C.t2, fontSize: 11,
          }}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Atualizar
        </button>

        {/* Iniciar */}
        <button onClick={() => enviarComando('start')} disabled={cmdSent}
          style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: `${C.teal}18`, border: `1px solid ${C.teal}50`,
            color: C.teal, cursor: cmdSent ? 'not-allowed' : 'pointer', opacity: cmdSent ? .5 : 1,
          }}>
          ▶ Iniciar
        </button>

        {/* Parar */}
        <button onClick={() => enviarComando('stop')} disabled={cmdSent}
          style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: C.rea, border: `1px solid ${C.re}50`,
            color: C.re, cursor: cmdSent ? 'not-allowed' : 'pointer', opacity: cmdSent ? .5 : 1,
          }}>
          ■ Parar
        </button>
      </nav>

      {/* ── Forming signal banner ──────────────────────────────────────────── */}
      {showForming && (
        <div style={{
          background: formingDir === 'buy' ? `${C.teal}12` : `${C.re}12`,
          borderBottom: `1px solid ${formingDir === 'buy' ? C.teal : C.re}40`,
          padding: '8px 24px', display: 'flex', alignItems: 'center', gap: 12,
          animation: 'blink 2s ease-in-out infinite',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 800,
            color: formingDir === 'buy' ? C.teal : C.re, ...mono,
          }}>
            {formingDir === 'buy' ? '▲ SINAL EM FORMAÇÃO — COMPRA' : '▼ SINAL EM FORMAÇÃO — VENDA'}
          </span>
          <span style={{ fontSize: 10, color: C.t2, ...mono }}>
            RAFI {formingRafi.toFixed(2)}
          </span>
          <span style={{ fontSize: 10, color: C.t2 }}>·</span>
          <span style={{ fontSize: 10, color: formingTf >= 3 ? C.teal : C.am }}>
            {formingTf}/3 TF alinhados
          </span>
          <span style={{ fontSize: 10, color: C.t2 }}>·</span>
          <span style={{ fontSize: 10, color: formingBb ? C.teal : C.t3 }}>
            BB {formingBb ? '✓ abrindo' : '— fechado'}
          </span>
          {formingPrice > 0 && (
            <>
              <span style={{ fontSize: 10, color: C.t2 }}>·</span>
              <span style={{ fontSize: 10, color: C.tx, ...mono }}>{formingPrice.toFixed(5)}</span>
            </>
          )}
        </div>
      )}

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main style={{ width: '100%', padding: '20px 24px 40px' }}>

        {/* ── 5 KPI cards ────────────────────────────────────────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20,
        }}>
          {/* Saldo */}
          <div className="kpi-card" style={{
            ...card, padding: '14px 16px', transition: 'border-color .2s',
          }}>
            <div style={lbl}>Saldo</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.tx, ...mono, lineHeight: 1.1 }}>
              {fmtUSD(bal)}
            </div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 4, ...mono }}>
              Equity <span style={{ color: eq >= bal ? C.teal : C.re }}>{fmtUSD(eq)}</span>
            </div>
            {floatPnL !== 0 && (
              <div style={{ fontSize: 10, color: floatPnL >= 0 ? C.teal : C.re, ...mono }}>
                Float {fmtUSD(floatPnL, true)}
              </div>
            )}
            {bal > 0 && (
              <div style={{ fontSize: 9, color: C.t3, marginTop: 4 }}>
                Lote atual: <span style={{ color: C.teal }}>{loteAtual(bal)}</span>
              </div>
            )}
          </div>

          {/* Win Rate */}
          <div className="kpi-card" style={{ ...card, padding: '14px 16px', transition: 'border-color .2s' }}>
            <div style={lbl}>Win Rate</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 700, ...mono,
                color: wr === null ? C.t3 : wr >= 55 ? C.teal : wr >= 45 ? C.am : C.re }}>
                {wr !== null ? `${wr}%` : '—'}
              </span>
              <span style={{ fontSize: 10, color: C.t2, ...mono }}>
                {wins}W / {losses}L
              </span>
            </div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 4 }}>
              PF: <span style={{
                color: pf === null ? C.t3 : pf >= 1.5 ? C.teal : pf >= 1 ? C.am : C.re,
                fontWeight: 700, ...mono,
              }}>
                {pf !== null ? pf.toFixed(2) : '—'}
              </span>
            </div>
            {streak > 1 && streakType && (
              <div style={{ fontSize: 9, color: streakType === 'win' ? C.teal : C.re, marginTop: 4 }}>
                Sequência: {streak}× {streakType === 'win' ? 'ganhos' : 'perdas'}
              </div>
            )}
          </div>

          {/* Lucro Líquido */}
          <div className="kpi-card" style={{ ...card, padding: '14px 16px', transition: 'border-color .2s' }}>
            <div style={lbl}>Lucro Líquido</div>
            <div style={{ fontSize: 22, fontWeight: 700, ...mono, lineHeight: 1.1,
              color: totalNet >= 0 ? C.teal : C.re }}>
              {fmtUSD(totalNet, true)}
            </div>
            <div style={{ fontSize: 9, color: C.t3, marginTop: 4, ...mono }}>
              Bruto {fmtUSD(totalGross, true)}
            </div>
            <div style={{ fontSize: 9, color: C.re, ...mono }}>
              Comissão −{fmtUSD(totalComm)}
            </div>
          </div>

          {/* P&L Hoje */}
          <div className="kpi-card" style={{ ...card, padding: '14px 16px', transition: 'border-color .2s' }}>
            <div style={lbl}>P&L Hoje</div>
            <div style={{ fontSize: 22, fontWeight: 700, ...mono, lineHeight: 1.1,
              color: pnlToday >= 0 ? C.teal : C.re }}>
              {fmtUSD(pnlToday, true)}
            </div>
            <div style={{ fontSize: 10, color: C.t2, marginTop: 4 }}>
              <span style={{ color: pctToday >= 0 ? C.teal : C.re, ...mono }}>
                {fmtPct(pctToday, true)}
              </span>
              {' '}do saldo
            </div>
            <div style={{ fontSize: 9, color: C.t3, marginTop: 4 }}>
              {tradesHoje} trade{tradesHoje !== 1 ? 's' : ''} hoje
            </div>
          </div>

          {/* Melhor / Pior */}
          <div className="kpi-card" style={{ ...card, padding: '14px 16px', transition: 'border-color .2s' }}>
            <div style={lbl}>Melhor / Pior</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.teal, ...mono }}>
              {maxWin > 0 ? fmtUSD(maxWin, true) : '—'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.re, ...mono, marginTop: 2 }}>
              {maxLoss < 0 ? fmtUSD(maxLoss) : '—'}
            </div>
            <div style={{ fontSize: 9, color: C.t3, marginTop: 6 }}>
              {closed.length} trades fechados
            </div>
          </div>
        </div>

        {/* ── Main grid: Position card + Equity curve ───────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, marginBottom: 20 }}>

          {/* Position card */}
          <div style={{ ...card, padding: '16px 18px' }}>
            <div style={lbl}>Posição Aberta</div>
            {openPos ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{
                    fontSize: 13, fontWeight: 800, ...mono,
                    color: openPos.direction === 'buy' ? C.teal : C.re,
                  }}>
                    {openPos.direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'}
                  </span>
                  <span style={{ fontSize: 10, color: C.t2, ...mono }}>{openPos.lot}L</span>
                </div>
                {[
                  { label: 'Entrada', value: openPos.entry?.toFixed(5), color: C.tx },
                  { label: 'Stop Loss', value: openPos.stop_loss?.toFixed(5), color: C.re },
                  { label: 'Take Profit', value: openPos.take_profit?.toFixed(5), color: C.teal },
                ].map(row => (
                  <div key={row.label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '5px 0', borderBottom: `1px solid ${C.bd}30`,
                  }}>
                    <span style={{ fontSize: 10, color: C.t2 }}>{row.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: row.color, ...mono }}>
                      {row.value}
                    </span>
                  </div>
                ))}
                {openPos.rafi !== null && (
                  <div style={{ marginTop: 10, fontSize: 10, color: C.t2 }}>
                    RAFI: <span style={{ color: C.teal, ...mono }}>{openPos.rafi.toFixed(2)}</span>
                  </div>
                )}
                <div style={{ marginTop: 10, fontSize: 9, color: C.t3, ...mono }}>
                  {fmtTime(openPos.time)}
                </div>
              </>
            ) : (
              <div style={{
                height: 140, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
                <div style={{ fontSize: 28, opacity: .2 }}>◎</div>
                <div style={{ fontSize: 11, color: C.t3 }}>Sem posição aberta</div>
                {status && (
                  <div style={{ fontSize: 9, color: C.t3, ...mono }}>
                    Bot: <span style={{ color: statusColor }}>{statusLabel}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Equity curve */}
          <div style={{ ...card, padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={lbl}>Equity Curve (líquido)</div>
              <div style={{ display: 'flex', gap: 12, fontSize: 9, color: C.t2 }}>
                <span>
                  Max win: <span style={{ color: C.teal, ...mono }}>{maxWin > 0 ? fmtUSD(maxWin, true) : '—'}</span>
                </span>
                <span>
                  Max loss: <span style={{ color: C.re, ...mono }}>{maxLoss < 0 ? fmtUSD(maxLoss) : '—'}</span>
                </span>
              </div>
            </div>
            <EquityCurve trades={trades} />
          </div>
        </div>

        {/* ── IA Status bar ──────────────────────────────────────────────── */}
        <div style={{ ...card, padding: '14px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {/* Mode badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div style={{ ...lbl, marginBottom: 0 }}>IA Dinâmica</div>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, ...mono,
                background: status?.ml_modelo_carregado ? `${C.teal}15` : `${C.am}15`,
                border: `1px solid ${status?.ml_modelo_carregado ? C.teal : C.am}40`,
                color: status?.ml_modelo_carregado ? C.teal : C.am,
              }}>
                {status?.ml_modo ?? 'OBSERVAÇÃO'}
              </span>
            </div>

            {/* Progress bar */}
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 9, color: C.t3 }}>
                  {iaCount} trades → próximo milestone: {nextMilestone}
                </span>
                <span style={{ fontSize: 9, color: C.teal, ...mono }}>{iaPct.toFixed(1)}% (300)</span>
              </div>
              {/* Milestone track */}
              <div style={{ position: 'relative', height: 6, background: C.b1, borderRadius: 3 }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, height: '100%',
                  width: `${iaPct}%`, background: `linear-gradient(90deg, ${C.teal}80, ${C.teal})`,
                  borderRadius: 3, transition: 'width .5s ease',
                }} />
                {IA_MILESTONES.map(m => (
                  <div key={m} style={{
                    position: 'absolute', top: -2, left: `${(m / 300) * 100}%`,
                    width: 2, height: 10,
                    background: iaCount >= m ? C.teal : C.b2,
                    transform: 'translateX(-50%)',
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                {IA_MILESTONES.map(m => (
                  <span key={m} style={{
                    fontSize: 8, color: iaCount >= m ? C.teal : C.t3, ...mono,
                    position: 'relative', left: m === 300 ? '-8px' : m === 10 ? '0' : undefined,
                  }}>{m}</span>
                ))}
              </div>
            </div>

            {/* ML rolling stats */}
            {(status?.ml_wr_rolling != null || status?.ml_pf_rolling != null) && (
              <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
                {status?.ml_wr_rolling != null && (
                  <div>
                    <div style={{ ...lbl, marginBottom: 2 }}>WR Rolling</div>
                    <span style={{
                      fontSize: 14, fontWeight: 700, ...mono,
                      color: status.ml_wr_rolling >= 55 ? C.teal : status.ml_wr_rolling >= 45 ? C.am : C.re,
                    }}>
                      {status.ml_wr_rolling.toFixed(1)}%
                    </span>
                  </div>
                )}
                {status?.ml_pf_rolling != null && (
                  <div>
                    <div style={{ ...lbl, marginBottom: 2 }}>PF Rolling</div>
                    <span style={{
                      fontSize: 14, fontWeight: 700, ...mono,
                      color: status.ml_pf_rolling >= 1.5 ? C.teal : status.ml_pf_rolling >= 1 ? C.am : C.re,
                    }}>
                      {status.ml_pf_rolling.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Sinais hoje */}
            {status?.ml_sinais_hoje != null && (
              <div style={{ flexShrink: 0 }}>
                <div style={{ ...lbl, marginBottom: 2 }}>Sinais hoje</div>
                <span style={{ fontSize: 12, ...mono, color: C.tx }}>
                  {status.ml_aprovados_hoje ?? 0}
                  <span style={{ color: C.t3 }}>/{status.ml_sinais_hoje}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Trades table ───────────────────────────────────────────────── */}
        <div style={{ ...card, marginBottom: 20, overflow: 'hidden' }}>
          {/* Table header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: `1px solid ${C.bd}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.tx, fontFamily: "'Space Grotesk', sans-serif" }}>
              Histórico de Trades
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['all', 'wins', 'losses', 'today'] as const).map(f => (
                <button key={f} className="filter-btn"
                  onClick={() => setTradeFilter(f)}
                  style={{
                    fontSize: 10, padding: '3px 10px', borderRadius: 6,
                    background: tradeFilter === f ? `${C.teal}20` : C.s2,
                    border: `1px solid ${tradeFilter === f ? C.teal : C.bd}`,
                    color: tradeFilter === f ? C.teal : C.t2,
                    fontWeight: tradeFilter === f ? 700 : 400,
                  }}>
                  {f === 'all' ? 'Todos' : f === 'wins' ? 'Ganhos' : f === 'losses' ? 'Perdas' : 'Hoje'}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: C.s2 }}>
                  {['Data', 'Dir', 'Entrada', 'SL', 'TP', 'Lote', 'RAFI', 'P&L Bruto', 'Comissão', 'Líquido'].map(h => (
                    <th key={h} style={{
                      padding: '8px 10px', textAlign: h === 'Dir' ? 'center' : 'right',
                      fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '.08em',
                      textTransform: 'uppercase', whiteSpace: 'nowrap',
                      borderBottom: `1px solid ${C.bd}`,
                      ...(h === 'Data' ? { textAlign: 'left' } : {}),
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTrades.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{
                      padding: '32px', textAlign: 'center', color: C.t3, fontSize: 11,
                    }}>
                      Nenhum trade fechado
                    </td>
                  </tr>
                )}
                {filteredTrades.map(t => {
                  const isWin = t.result === 'win'
                  const comm  = (t.lot ?? 0.1) * 7
                  const net   = t.pnl !== null ? t.pnl - comm : null
                  const rowColor = isWin ? C.gr : C.re
                  return (
                    <tr key={t.id} className="trade-row">
                      <td style={{ padding: '7px 10px', color: C.t2, ...mono, whiteSpace: 'nowrap' }}>
                        {fmtTime(t.time)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 800, color: rowColor,
                          ...mono, display: 'block',
                        }}>
                          {t.direction === 'buy' ? '▲' : '▼'}
                        </span>
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: C.tx, ...mono }}>
                        {t.entry?.toFixed(5)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: C.re, ...mono }}>
                        {t.stop_loss?.toFixed(5)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: C.teal, ...mono }}>
                        {t.take_profit?.toFixed(5)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: C.t2, ...mono }}>
                        {(t.lot ?? 0.1).toFixed(2)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', ...mono,
                        color: t.rafi !== null ? (Math.abs(t.rafi) >= 2.5 ? C.teal : C.am) : C.t3 }}>
                        {t.rafi !== null ? t.rafi.toFixed(2) : '—'}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', ...mono,
                        color: t.pnl !== null ? (t.pnl >= 0 ? C.gr : C.re) : C.t3 }}>
                        {t.pnl !== null ? fmtUSD(t.pnl, true) : '—'}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: C.re, ...mono }}>
                        −{fmtUSD(comm)}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, ...mono,
                        color: net !== null ? (net >= 0 ? C.teal : C.re) : C.t3 }}>
                        {net !== null ? fmtUSD(net, true) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {filteredTrades.length > 0 && (
                <tfoot>
                  <tr style={{ background: C.s2, borderTop: `1px solid ${C.bd}` }}>
                    <td colSpan={7} style={{ padding: '7px 10px', fontSize: 10, color: C.t2 }}>
                      {filteredTrades.length} trade{filteredTrades.length !== 1 ? 's' : ''}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, ...mono,
                      color: filteredTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) >= 0 ? C.gr : C.re }}>
                      {fmtUSD(filteredTrades.reduce((s, t) => s + (t.pnl ?? 0), 0), true)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: C.re, ...mono }}>
                      −{fmtUSD(filteredTrades.reduce((s, t) => s + (t.lot ?? 0.1) * 7, 0))}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, ...mono, color: C.teal }}>
                      {(() => {
                        const net = filteredTrades.reduce((s, t) =>
                          s + (t.pnl ?? 0) - (t.lot ?? 0.1) * 7, 0)
                        return <span style={{ color: net >= 0 ? C.teal : C.re }}>{fmtUSD(net, true)}</span>
                      })()}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        {/* ── Log panel ──────────────────────────────────────────────────── */}
        <div style={{ ...card, marginBottom: 20 }}>
          <div style={{
            padding: '10px 16px', borderBottom: `1px solid ${C.bd}`,
            fontSize: 11, fontWeight: 600, color: C.t2, fontFamily: "'Space Grotesk', sans-serif",
          }}>
            Log do Bot
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', padding: '8px 0' }}>
            {botLogs.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: C.t3, fontSize: 11 }}>
                Aguardando logs…
              </div>
            ) : botLogs.slice(0, 15).map(log => {
              const lc = log.level === 'error' ? C.re
                : log.level === 'warn' ? C.am
                : log.level === 'signal' ? C.teal
                : C.t2
              return (
                <div key={log.id} style={{
                  display: 'flex', gap: 10, padding: '4px 16px',
                  borderBottom: `1px solid ${C.bd}18`,
                  alignItems: 'flex-start',
                }}>
                  <span style={{ fontSize: 9, color: C.t3, flexShrink: 0, ...mono, marginTop: 1 }}>
                    {new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span style={{
                    fontSize: 9, fontWeight: 700, flexShrink: 0, width: 40,
                    color: lc, ...mono, textTransform: 'uppercase',
                  }}>
                    {log.level}
                  </span>
                  <span style={{ fontSize: 11, color: C.tx, flex: 1, wordBreak: 'break-word' }}>
                    {log.message}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Kill switch ────────────────────────────────────────────────── */}
        <div style={{
          ...card, padding: '16px 20px',
          border: `1px solid ${C.re}25`, background: `${C.re}06`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.re, marginBottom: 2 }}>
              Kill Switch — Parada de Emergência
            </div>
            <div style={{ fontSize: 10, color: C.t3 }}>
              Encerra todas as posições e para o bot imediatamente. Ação irreversível.
            </div>
          </div>
          <button
            onClick={() => {
              if (confirm('CONFIRMAR: encerrar todas as posições e parar o bot agora?')) {
                enviarComando('kill')
              }
            }}
            disabled={cmdSent}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 12, fontWeight: 800,
              background: C.rea, border: `1px solid ${C.re}60`,
              color: C.re, cursor: cmdSent ? 'not-allowed' : 'pointer',
              opacity: cmdSent ? .5 : 1, letterSpacing: '0.06em',
            }}>
            ■ KILL SWITCH
          </button>
        </div>

      </main>
    </div>
  )
}
