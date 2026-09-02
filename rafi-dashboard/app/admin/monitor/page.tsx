'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Activity, Square, Play, RefreshCw, TrendingUp,
  DollarSign, BarChart2, Clock, AlertTriangle, Wifi, WifiOff,
  ChevronUp, ChevronDown, Zap, Target, Calendar, Bell, X,
  ArrowUpCircle, ArrowDownCircle, Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@supabase/supabase-js'
import { applyRAFICandleColors, calcRAFI } from '@/lib/indicators'

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null

// Lightweight Charts global (carregado dinamicamente)
declare global { interface Window { LightweightCharts: any } }

// ── Tabela de escalonamento de lotes ─────────────────────────────────────────
const FAIXAS_LOTE = [
  { min: 0,      max: 40,      lote: 0.10, label: '0.10L' },
  { min: 40,     max: 80,      lote: 0.20, label: '0.20L' },
  { min: 80,     max: 150,     lote: 0.40, label: '0.40L' },
  { min: 150,    max: 200,     lote: 0.70, label: '0.70L' },
  { min: 200,    max: 400,     lote: 1.00, label: '1.00L' },
  { min: 400,    max: 800,     lote: 2.00, label: '2.00L' },
  { min: 800,    max: 1500,    lote: 4.00, label: '4.00L' },
  { min: 1500,   max: 3000,    lote: 8.00, label: '8.00L' },
  { min: 3000,   max: 6000,    lote: 15.0, label: '15.0L' },
  { min: 6000,   max: 10000,   lote: 30.0, label: '30.0L' },
  { min: 10000,  max: 20000,   lote: 50.0, label: '50.0L' },
  { min: 20000,  max: Infinity, lote: 100, label: '100L'  },
]
function loteAtual(balance: number) {
  return FAIXAS_LOTE.find(f => balance >= f.min && balance < f.max)?.label ?? '0.10L'
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface BotStatus {
  id: string; status: 'running' | 'stopped' | 'error' | 'waiting'
  balance: number; equity: number; open_positions: number; pnl_today: number
  par: string; server: string; account: number
  last_signal: string | null; updated_at: string
}
interface Trade {
  id: string; direction: 'buy' | 'sell'; entry: number
  stop_loss: number; take_profit: number; lot: number
  result: 'win' | 'loss' | 'pending'
  rafi: number | null; pnl: number | null; time: number; label: string
}
interface CandleRow {
  time: number; open: number; high: number; low: number; close: number
  volume: number; rafi: number | null
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
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
function startOfDay(d: Date)  { const r = new Date(d); r.setUTCHours(0,0,0,0); return r }
function startOfWeek(d: Date) {
  const r = new Date(d); const day = r.getUTCDay()
  r.setUTCDate(r.getUTCDate() - (day === 0 ? 6 : day - 1)); r.setUTCHours(0,0,0,0); return r
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
          bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/20">{badge}</span>
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

// ── Equity sparkline ──────────────────────────────────────────────────────────
function EquitySparkline({ trades }: { trades: Trade[] }) {
  const closed = useMemo(() =>
    [...trades].filter(t => t.result !== 'pending').sort((a, b) => a.time - b.time), [trades])

  if (closed.length < 2) return (
    <div className="flex items-center justify-center h-full text-[#484f58] text-xs">
      Aguardando trades para curva de equity
    </div>
  )

  let cum = 0
  const points = closed.map(t => {
    if (t.pnl !== null) { cum += t.pnl } else {
      const R = Math.abs(t.entry - t.stop_loss) * (t.lot ?? 0.1) * 100000
      cum += t.result === 'win' ? R * 1.5 : -R
    }
    return cum
  })

  const min = Math.min(0, ...points), max = Math.max(0, ...points)
  const range = max - min || 1; const W = 500, H = 80, P = 8
  const x = (i: number) => P + (i / (points.length - 1)) * (W - P * 2)
  const y = (v: number) => P + (1 - (v - min) / range) * (H - P * 2)
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(points.length-1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
  const zeroY = y(0); const isPos = points[points.length - 1] >= 0
  const lc = isPos ? '#10b981' : '#ef4444'

  return (
    <div className="w-full h-full flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lc} stopOpacity="0.3" />
            <stop offset="100%" stopColor={lc} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line x1={P} y1={zeroY} x2={W-P} y2={zeroY} stroke="#30363d" strokeWidth="0.5" strokeDasharray="3,3" />
        <path d={area} fill="url(#eq-grad)" />
        <path d={path} fill="none" stroke={lc} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(points.length-1)} cy={y(points[points.length-1])} r="3" fill={lc} />
      </svg>
      <div className="flex justify-between text-[9px] font-mono text-[#484f58] px-2">
        <span>{closed[0] ? new Date(closed[0].time*1000).toLocaleDateString('pt-BR') : ''}</span>
        <span className={cn('font-bold', isPos ? 'text-[#10b981]' : 'text-[#ef4444]')}>
          {fmtUSD(points[points.length-1], true)} acumulado
        </span>
        <span>agora</span>
      </div>
    </div>
  )
}

// ── Daily P&L bars ────────────────────────────────────────────────────────────
function DailyBars({ trades }: { trades: Trade[] }) {
  const daily = useMemo(() => {
    const map = new Map<string, number>()
    trades.filter(t => t.result !== 'pending').forEach(t => {
      const key = new Date(t.time*1000).toISOString().slice(0,10)
      map.set(key, (map.get(key) ?? 0) + (t.pnl ?? (t.result === 'win' ? 1 : -1)))
    })
    return Array.from(map.entries()).sort(([a],[b]) => a.localeCompare(b)).slice(-14)
  }, [trades])

  if (daily.length === 0) return (
    <div className="flex items-center justify-center h-full text-[#484f58] text-xs">Sem histórico diário</div>
  )
  const maxAbs = Math.max(...daily.map(([,v]) => Math.abs(v)), 0.001)
  return (
    <div className="flex items-end gap-1 h-full px-1">
      {daily.map(([date, pnl]) => (
        <div key={date} className="flex flex-col items-center gap-0.5 flex-1 min-w-0 h-full justify-end">
          <div className="w-full rounded-sm min-h-[2px] transition-all"
            style={{ height: `${Math.max(4, Math.abs(pnl)/maxAbs*60)}px`,
              background: pnl >= 0 ? '#10b981' : '#ef4444', opacity: 0.8 }}
            title={`${date}: ${fmtUSD(pnl, true)}`} />
          <span className="text-[7px] text-[#484f58] truncate w-full text-center">{date.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Live Chart (Lightweight Charts) ──────────────────────────────────────────
function LiveChart({ candles, trades, pending }: {
  candles: CandleRow[]; trades: Trade[]; pending: Trade[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<any>(null)
  const cSeriesRef   = useRef<any>(null)
  const rSeriesRef   = useRef<any>(null)
  const bbURef       = useRef<any>(null)
  const bbMRef       = useRef<any>(null)
  const bbLRef       = useRef<any>(null)
  const plinesRef    = useRef<any[]>([])
  const [ready, setReady] = useState(false)

  // Carrega a biblioteca uma vez
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.LightweightCharts) { setReady(true); return }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js'
    s.onload  = () => setReady(true)
    s.onerror = () => console.error('[LiveChart] Falha ao carregar Lightweight Charts do CDN')
    document.head.appendChild(s)
  }, [])

  // Cria o gráfico uma vez ao estar pronto
  useEffect(() => {
    if (!ready || !containerRef.current) return
    const { createChart } = window.LightweightCharts

    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#1c2128' }, horzLines: { color: '#1c2128' } },
      crosshair: { mode: 1 },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      rightPriceScale: { borderColor: '#30363d' },
      handleScroll: true,
      handleScale: true,
    })

    // Mesma config do rafi-chart.tsx — cores definidas por applyRAFICandleColors
    const cSeries = chart.addCandlestickSeries({
      upColor:       '#10b981',
      downColor:     '#ef4444',
      borderVisible: false,
      wickUpColor:   '#10b981',
      wickDownColor: '#ef4444',
    })

    // Bandas de Bollinger BB(8,2) em ciano
    const bbU = chart.addLineSeries({ color: '#06b6d4',   lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    const bbM = chart.addLineSeries({ color: '#06b6d466', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    const bbL = chart.addLineSeries({ color: '#06b6d4',   lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })

    // RAFI histograma na parte inferior (escala separada)
    const rSeries = chart.addHistogramSeries({
      priceScaleId: 'rafi', priceLineVisible: false, lastValueVisible: false,
    })
    chart.priceScale('rafi').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    // Linhas de limiar ±2.50 (padrão oficial RAFI)
    rSeries.createPriceLine({ price:  2.5, color: '#f0a500', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: '+2.50' })
    rSeries.createPriceLine({ price: -2.5, color: '#f0a500', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: '-2.50' })

    chartRef.current = chart
    cSeriesRef.current = cSeries
    rSeriesRef.current = rSeries
    bbURef.current = bbU
    bbMRef.current = bbM
    bbLRef.current = bbL

    const obs = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    obs.observe(containerRef.current)

    return () => {
      obs.disconnect(); chart.remove()
      chartRef.current = null
      bbURef.current = null; bbMRef.current = null; bbLRef.current = null
    }
  }, [ready])

  // Atualiza dados dos candles, BB e RAFI
  useEffect(() => {
    if (!cSeriesRef.current || candles.length === 0) return

    // Calcula RAFI client-side (igual ao /admin/chart) para ter ponto em TODOS os candles
    const rafiPoints = calcRAFI(candles as any)
    cSeriesRef.current.setData(
      applyRAFICandleColors(candles as any, rafiPoints) as any
    )

    // Calcular e publicar BB(8,2)
    if (bbURef.current && candles.length >= 8) {
      const P = 8, M = 2
      const bu: {time: number, value: number}[] = []
      const bm: {time: number, value: number}[] = []
      const bl: {time: number, value: number}[] = []
      for (let i = P - 1; i < candles.length; i++) {
        const sl = candles.slice(i - P + 1, i + 1).map(r => r.close)
        const sma = sl.reduce((a, b) => a + b, 0) / P
        const std = Math.sqrt(sl.reduce((a, b) => a + (b - sma) ** 2, 0) / P)
        bu.push({ time: candles[i].time, value: parseFloat((sma + M * std).toFixed(5)) })
        bm.push({ time: candles[i].time, value: parseFloat(sma.toFixed(5)) })
        bl.push({ time: candles[i].time, value: parseFloat((sma - M * std).toFixed(5)) })
      }
      bbURef.current.setData(bu)
      bbMRef.current.setData(bm)
      bbLRef.current.setData(bl)
    }

    if (rSeriesRef.current) {
      const rafiData = candles
        .filter(c => c.rafi != null)
        .map((c, i, arr) => {
          const r = c.rafi!
          // Padrão oficial RAFI: âmbar único, barras com sinal (+ sobe, - desce)
          return { time: c.time, value: Math.max(-5, Math.min(5, r)), color: '#f0a500' }
        })
      if (rafiData.length > 0) rSeriesRef.current.setData(rafiData)
    }

    // Marcadores de trade
    const markers = trades
      .filter(t => t.time >= (candles[0]?.time ?? 0))
      .sort((a, b) => a.time - b.time)
      .map(t => ({
        time: t.time,
        position: t.direction === 'buy' ? 'belowBar' : 'aboveBar',
        color: t.direction === 'buy'
          ? (t.result === 'win' ? '#10b981' : t.result === 'loss' ? '#ef4444' : '#3b82f6')
          : (t.result === 'win' ? '#10b981' : t.result === 'loss' ? '#ef4444' : '#f59e0b'),
        shape: t.direction === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `${t.direction === 'buy' ? '▲' : '▼'} ${t.entry.toFixed(5)}`,
        size: 1,
      }))
    cSeriesRef.current.setMarkers(markers)
  }, [candles, trades])

  // Linhas de SL / TP / Entry para posições abertas
  useEffect(() => {
    if (!cSeriesRef.current) return
    plinesRef.current.forEach(pl => { try { cSeriesRef.current.removePriceLine(pl) } catch {} })
    plinesRef.current = []

    pending.forEach(t => {
      try {
        plinesRef.current.push(
          cSeriesRef.current.createPriceLine({ price: t.stop_loss,   color: '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' }),
          cSeriesRef.current.createPriceLine({ price: t.take_profit, color: '#10b981', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' }),
          cSeriesRef.current.createPriceLine({ price: t.entry,       color: '#f59e0b', lineWidth: 2, lineStyle: 1, axisLabelVisible: true, title: 'Entry' }),
        )
      } catch {}
    })
  }, [pending])

  return (
    <div className="relative w-full" style={{ height: 380 }}>
      <div ref={containerRef} className="w-full h-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117] text-[#484f58] text-xs">
          Carregando gráfico...
        </div>
      )}
      {ready && candles.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <BarChart2 size={28} className="text-[#30363d]" />
          <p className="text-xs text-[#484f58]">Aguardando dados do bot...</p>
          <p className="text-[9px] text-[#30363d]">O gráfico preenche automaticamente quando o bot reiniciar.</p>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [status,    setStatus]    = useState<BotStatus | null>(null)
  const [trades,    setTrades]    = useState<Trade[]>([])
  const [candles,   setCandles]   = useState<CandleRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [cmdSent,   setCmdSent]   = useState(false)
  const [activeTab, setActiveTab] = useState<'history' | 'open'>('history')
  const [alert,     setAlert]     = useState<string | null>(null)
  // Countdown até próximo candle M5
  const [m5Secs, setM5Secs] = useState(0)

  const prevPendingLen = useRef(0)

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

  const fetchCandles = useCallback(async () => {
    if (!supa) return
    try {
      const { data } = await supa
        .from('rafi_candles')
        .select('time,open,high,low,close,volume,rafi')
        .order('time', { ascending: true })
        .limit(200)
      if (data && data.length > 0) setCandles(data as CandleRow[])
    } catch {}  // tabela pode não existir ainda
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchAll(), fetchCandles()])
    setLoading(false)
  }, [fetchAll, fetchCandles])

  useEffect(() => {
    refresh()
    const iv1 = setInterval(fetchAll,    10_000)
    const iv2 = setInterval(fetchCandles, 5_000)
    return () => { clearInterval(iv1); clearInterval(iv2) }
  }, [fetchAll, fetchCandles, refresh])

  // Countdown até próximo fechamento M5 (calculado localmente, sem precisar do bot)
  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000)
      const next = (Math.floor(now / 300) + 1) * 300
      setM5Secs(next - now)
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [])

  // ── Alerta quando novo trade dispara ────────────────────────────────────────
  const pending = useMemo(() => trades.filter(t => t.result === 'pending'), [trades])
  useEffect(() => {
    if (prevPendingLen.current > 0 && pending.length > prevPendingLen.current) {
      const t = pending[0]
      const msg = t
        ? `${t.direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'} @ ${t.entry?.toFixed(5)} · SL ${t.stop_loss?.toFixed(5)} · TP ${t.take_profit?.toFixed(5)}`
        : 'Nova ordem aberta'
      setAlert(msg)
      // Notificação do browser (solicita permissão se necessário)
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          new Notification('RAFI Bot — Novo Trade!', { body: msg, icon: '/favicon.ico' })
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission()
        }
      }
    }
    prevPendingLen.current = pending.length
  }, [pending])

  // ── Comandos ────────────────────────────────────────────────────────────────
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

  // ── Métricas ────────────────────────────────────────────────────────────────
  const now = Date.now()
  const isOnline = status ? (now - new Date(status.updated_at).getTime()) < 420_000 : false
  const statusColor =
    !status   ? '#484f58' : !isOnline ? '#ef4444' :
    status.status === 'running' ? '#10b981' :
    status.status === 'waiting' ? '#f59e0b' : '#ef4444'
  const statusLabel =
    !status   ? 'SEM DADOS' : !isOnline ? 'OFFLINE' :
    status.status === 'running' ? 'EM POSIÇÃO' :
    status.status === 'waiting' ? 'AGUARDANDO' : 'PARADO'

  const closed  = useMemo(() => trades.filter(t => t.result !== 'pending'), [trades])
  const wins    = useMemo(() => closed.filter(t => t.result === 'win').length,  [closed])
  const losses  = useMemo(() => closed.filter(t => t.result === 'loss').length, [closed])
  const wr      = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null

  const todayStart = startOfDay(new Date()).getTime() / 1000
  const weekStart  = startOfWeek(new Date()).getTime() / 1000
  const day7Start  = (now - 7  * 86400_000) / 1000
  const day30Start = (now - 30 * 86400_000) / 1000

  function pnlPeriod(from: number) {
    return closed.filter(t => t.time >= from).reduce((s,t) => s + (t.pnl ?? (t.result === 'win' ? 1 : -1)), 0)
  }
  function wrPeriod(from: number) {
    const p = closed.filter(t => t.time >= from); const w = p.filter(t => t.result === 'win').length
    return p.length > 0 ? Math.round(w / p.length * 100) : null
  }

  const pnlToday = status?.pnl_today ?? pnlPeriod(todayStart)
  const pnlWeek  = pnlPeriod(weekStart)
  const pnl7d    = pnlPeriod(day7Start)
  const pnl30d   = pnlPeriod(day30Start)
  const wr7d     = wrPeriod(day7Start)

  const bal        = status?.balance ?? 0
  const floatPnL   = status ? (status.equity - status.balance) : 0
  const pctToday   = bal > 0 ? (pnlToday / (bal - pnlToday)) * 100 : 0
  const pct7d      = bal > 0 ? (pnl7d    / (bal - pnl7d))    * 100 : 0
  const pct30d     = bal > 0 ? (pnl30d   / (bal - pnl30d))   * 100 : 0

  const tradesHoje    = closed.filter(t => t.time >= todayStart).length
  const tradesSemana  = closed.filter(t => t.time >= weekStart).length
  const pnlColor = (v: number) => v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#484f58'

  return (
    <div className="min-h-screen bg-[#0d1117] p-4 space-y-4">

      {/* ── Alert toast ─────────────────────────────────────────────────────── */}
      {alert && (
        <div className="fixed top-4 right-4 z-50 flex items-start gap-3 px-4 py-3 rounded-xl
          bg-[#10b981]/15 border border-[#10b981]/40 shadow-2xl max-w-sm animate-in fade-in slide-in-from-top-2">
          <Bell size={14} className="text-[#10b981] mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-[#10b981]">Novo Trade Disparado!</div>
            <div className="text-[10px] text-[#8b949e] mt-0.5 break-all">{alert}</div>
          </div>
          <button onClick={() => setAlert(null)} className="text-[#484f58] hover:text-[#f0f6fc]">
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-black text-[#f0f6fc] flex items-center gap-2">
            <Activity size={18} className="text-[#10b981]" />
            Cockpit RAFI
          </h1>
          <p className="text-[10px] text-[#484f58] mt-0.5">
            {status
              ? `Conta ${status.account} · ${status.server} · ${status.par} · M5`
              : 'Aguardando conexão com o bot...'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
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
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold text-xs transition-all',
                cmdSent ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444] hover:bg-[#ef4444]/20')}>
              <Square size={11} fill="currentColor" />
              {cmdSent ? 'Enviando...' : 'PARAR'}
            </button>
          ) : (
            <button onClick={() => enviarComando('start')} disabled={cmdSent}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold text-xs transition-all',
                cmdSent ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#10b981]/10 border-[#10b981]/30 text-[#10b981] hover:bg-[#10b981]/20')}>
              <Play size={11} fill="currentColor" />
              {cmdSent ? 'Enviando...' : 'INICIAR'}
            </button>
          )}
        </div>
      </div>

      {/* ── Gráfico ao vivo + OCO ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">

        {/* Chart */}
        <div className="xl:col-span-3 bg-[#0d1117] border border-[#30363d] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
            <div className="flex items-center gap-2">
              <BarChart2 size={11} className="text-[#3b82f6]" />
              <span className="text-[9px] uppercase tracking-widest text-[#484f58]">
                EURUSD# · M5 · Tempo Real
              </span>
              {candles.length > 0 && (
                <span className="text-[8px] px-1.5 py-0.5 rounded bg-[#10b981]/10 text-[#10b981] border border-[#10b981]/20">
                  {candles.length} candles
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-[9px] font-mono text-[#484f58]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 inline-block bg-[#10b981]" /> TP
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 inline-block bg-[#ef4444]" /> SL
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-0.5 inline-block bg-[#f59e0b]" /> Entry
              </span>
            </div>
          </div>
          <LiveChart candles={candles} trades={trades} pending={pending} />
          <div className="px-4 py-1.5 border-t border-[#30363d] bg-[#161b22]">
            <div className="flex items-center gap-4 text-[8px] text-[#484f58] font-mono">
              <span>RAFI histograma (verde = força ≥2.5)</span>
              <span>· Setas = trades executados</span>
              <span>· Linhas = SL/TP posição aberta</span>
            </div>
          </div>
        </div>

        {/* OCO Panel */}
        <div className="xl:col-span-1 flex flex-col gap-3">

          {/* Ordem manual */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Zap size={11} className="text-[#f59e0b]" />
              <span className="text-xs font-semibold text-[#f0f6fc]">Ordem Manual</span>
            </div>
            <p className="text-[9px] text-[#484f58] leading-relaxed">
              Envia ordem imediata ao bot. Lote automático pelo capital atual.
              SL = mínima/máxima do candle · TP = R:R 1.5.
            </p>

            <button
              onClick={() => enviarComando('buy_manual')} disabled={cmdSent}
              className={cn(
                'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-bold text-sm transition-all',
                cmdSent ? 'bg-[#21262d] border border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#3b82f6]/15 border border-[#3b82f6]/40 text-[#3b82f6] hover:bg-[#3b82f6]/25 hover:border-[#3b82f6]/60',
              )}>
              <ArrowUpCircle size={16} />
              COMPRA (BUY)
            </button>
            <button
              onClick={() => enviarComando('sell_manual')} disabled={cmdSent}
              className={cn(
                'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-bold text-sm transition-all',
                cmdSent ? 'bg-[#21262d] border border-[#30363d] text-[#484f58] cursor-not-allowed'
                  : 'bg-[#f59e0b]/15 border border-[#f59e0b]/40 text-[#f59e0b] hover:bg-[#f59e0b]/25 hover:border-[#f59e0b]/60',
              )}>
              <ArrowDownCircle size={16} />
              VENDA (SELL)
            </button>

            {cmdSent && (
              <p className="text-[9px] text-[#f59e0b] text-center">Comando enviado ao bot...</p>
            )}
          </div>

          {/* Posições abertas com botão fechar */}
          {pending.length > 0 && (
            <div className="bg-[#161b22] border border-[#f59e0b]/25 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap size={11} className="text-[#f59e0b] animate-pulse" />
                  <span className="text-xs font-semibold text-[#f0f6fc]">
                    Posição Aberta ({pending.length})
                  </span>
                </div>
                {/* P&L flutuante: equity - balance */}
                {status && Math.abs(floatPnL) > 0.001 && (
                  <span className={cn('text-sm font-black font-mono',
                    floatPnL >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                    {fmtUSD(floatPnL, true)}
                  </span>
                )}
              </div>
              {pending.map(t => {
                const isBuy = t.direction === 'buy'
                const riskPips = isBuy
                  ? Math.round((t.entry - t.stop_loss) * 10000)
                  : Math.round((t.stop_loss - t.entry) * 10000)
                return (
                  <div key={t.id} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={cn('flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded',
                        isBuy ? 'bg-[#3b82f6]/15 text-[#3b82f6]' : 'bg-[#f59e0b]/15 text-[#f59e0b]')}>
                        {isBuy ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        {isBuy ? 'BUY' : 'SELL'}
                      </span>
                      <span className="font-mono text-sm text-[#f0f6fc] font-bold">{t.entry.toFixed(5)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1 text-[9px] font-mono">
                      <div className="text-[#484f58]">SL <span className="text-[#ef4444]">{t.stop_loss.toFixed(5)}</span></div>
                      <div className="text-[#484f58]">TP <span className="text-[#10b981]">{t.take_profit.toFixed(5)}</span></div>
                      <div className="text-[#484f58]">Lote <span className="text-[#f0f6fc]">{t.lot.toFixed(2)}L</span></div>
                      <div className="text-[#484f58]">Risco <span className="text-[#f0f6fc]">{riskPips}p</span></div>
                    </div>
                  </div>
                )
              })}
              <button
                onClick={() => enviarComando('close_position')} disabled={cmdSent}
                className={cn(
                  'flex items-center justify-center gap-2 px-3 py-2 rounded-lg font-bold text-xs transition-all',
                  cmdSent ? 'bg-[#21262d] border border-[#30363d] text-[#484f58] cursor-not-allowed'
                    : 'bg-[#ef4444]/10 border border-[#ef4444]/30 text-[#ef4444] hover:bg-[#ef4444]/20',
                )}>
                <Square size={11} fill="currentColor" />
                {cmdSent ? 'Enviando...' : 'FECHAR POSIÇÃO'}
              </button>
            </div>
          )}

          {/* Status MT5 + Countdown + Win Rate */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock size={11} className="text-[#f59e0b]" />
              <span className="text-xs font-semibold text-[#f0f6fc]">MT5</span>
            </div>
            <div className="space-y-1.5 text-[10px] font-mono">
              {isOnline ? (
                <>
                  <div className="flex items-center gap-2 text-[#10b981] font-bold">
                    <Wifi size={11} /> ONLINE
                  </div>
                  <div className="text-[#8b949e]">Conta: <span className="text-[#f0f6fc]">{status?.account}</span></div>
                  <div className="text-[#8b949e]">Servidor: <span className="text-[#f0f6fc]">{status?.server}</span></div>
                  <div className="text-[#8b949e]">Par: <span className="text-[#f0f6fc]">{status?.par}</span></div>
                  <div className="text-[#8b949e]">Posições abertas: <span className="text-[#f0f6fc]">{status?.open_positions}</span></div>
                  <div className="text-[#8b949e]">Heartbeat: <span className="text-[#f0f6fc]">{status ? secondsAgo(status.updated_at) : '—'}</span></div>
                  {wr !== null && (
                    <div className="text-[#8b949e]">Win Rate geral: <span className={cn('font-bold', wr >= 60 ? 'text-[#10b981]' : wr >= 50 ? 'text-[#f59e0b]' : 'text-[#ef4444]')}>{wr}%</span></div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2 text-[#ef4444]">
                  <WifiOff size={11} />
                  {status ? `Offline · ${secondsAgo(status.updated_at)}` : 'Bot não iniciado'}
                </div>
              )}
            </div>
          </div>

          {/* Próximo candle M5 */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={11} className="text-[#3b82f6]" />
              <span className="text-xs font-semibold text-[#f0f6fc]">Próxima Análise</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-black font-mono text-[#3b82f6]">
                {String(Math.floor(m5Secs / 60)).padStart(2, '0')}:{String(m5Secs % 60).padStart(2, '0')}
              </span>
              <span className="text-[9px] text-[#484f58] mb-1">até próximo M5</span>
            </div>
            <div className="mt-2 h-1 rounded-full bg-[#21262d] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#3b82f6] transition-all duration-1000"
                style={{ width: `${((300 - m5Secs) / 300) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Stats row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Saldo"     value={status ? fmtUSD(status.balance) : '—'}
          sub={status ? `Lote: ${loteAtual(status.balance)}` : 'aguardando bot'}
          color="#f0f6fc" icon={DollarSign} />
        <Stat label="P&L Hoje"  value={status ? fmtUSD(pnlToday, true) : '—'}
          sub={status ? fmtPct(pctToday, true) + ` · ${tradesHoje} trades` : ''}
          color={pnlColor(pnlToday)} icon={Calendar}
          badge={tradesHoje > 0 ? `${tradesHoje}T` : undefined} />
        <Stat label="P&L 7 Dias" value={fmtUSD(pnl7d, true) || '—'}
          sub={wr7d !== null ? `WR 7d: ${wr7d}%` : 'sem trades'}
          color={pnlColor(pnl7d)} icon={TrendingUp} />
        <Stat label="P&L 30 Dias" value={fmtUSD(pnl30d, true) || '—'}
          sub={fmtPct(pct30d, true)} color={pnlColor(pnl30d)} icon={BarChart2} />
        <Stat label="Win Rate"  value={wr !== null ? `${wr}%` : '—'}
          sub={`${wins}W / ${losses}L · ${wins+losses} total`}
          color={wr === null ? '#484f58' : wr >= 60 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#ef4444'}
          icon={Target} />
      </div>

      {/* ── Equity + Performance ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={12} className="text-[#10b981]" />
            <span className="text-[9px] uppercase tracking-widest text-[#484f58]">Curva de Equity</span>
            <span className="ml-auto text-[9px] text-[#484f58]">{closed.length} trades</span>
          </div>
          <div style={{ height: 100 }}>
            <EquitySparkline trades={trades} />
          </div>
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart2 size={12} className="text-[#3b82f6]" />
            <span className="text-[9px] uppercase tracking-widest text-[#484f58]">Performance</span>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Hoje',        pnl: pnlToday, pct: pctToday, n: tradesHoje },
              { label: 'Esta semana', pnl: pnlWeek,  pct: 0,        n: tradesSemana },
              { label: '7 dias',      pnl: pnl7d,    pct: pct7d,    n: closed.filter(t=>t.time>=day7Start).length },
              { label: '30 dias',     pnl: pnl30d,   pct: pct30d,   n: closed.filter(t=>t.time>=day30Start).length },
            ].map(({ label, pnl, pct, n }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[10px] text-[#8b949e]">{label}</span>
                <div className="text-right">
                  <span className="text-xs font-black font-mono" style={{ color: pnlColor(pnl) }}>
                    {n > 0 ? fmtUSD(pnl, true) : '—'}
                  </span>
                  {n > 0 && pct !== 0 && (
                    <span className="text-[9px] ml-1.5 font-mono" style={{ color: pnlColor(pct) }}>
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

      {/* ── Daily bars ─────────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={12} className="text-[#f59e0b]" />
          <span className="text-[9px] uppercase tracking-widest text-[#484f58]">P&L por dia (últimos 14 dias)</span>
        </div>
        <div style={{ height: 72 }}>
          <DailyBars trades={trades} />
        </div>
      </div>

      {/* ── Config + Lote + Conexão ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">

        {/* Parâmetros reais do bot */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Settings size={12} className="text-[#3b82f6]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Parâmetros do Bot</span>
          </div>
          <div className="space-y-1.5 text-[10px] font-mono">
            {([
              ['Estratégia',     'RAFI Breakout S/R'],
              ['R:R',            '1 : 1.5'],
              ['BB Período',     '8 · 2 desvios'],
              ['BB Squeeze',     '< 0.12% (relativo)'],
              ['BB Abertura',    '> 5% do squeeze'],
              ['SR Lookback',    '50 candles anteriores'],
              ['Rompimento mín', '0.3 pip (0.00003)'],
              ['Gap trades',     '8 candles mínimo'],
              ['Sessão',         '24h · sem filtro'],
              ['Spread estimado','0.8 pip (XM)'],
              ['Stop Loss',      'SEMPRE obrigatório'],
              ['Martingale',     'NÃO'],
              ['Alavancagem',    '1:1000 (XM)'],
            ] as const).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between py-0.5">
                <span className="text-[#484f58]">{k}</span>
                <span className={cn(
                  'font-medium',
                  v === 'SEMPRE obrigatório' || v === 'NÃO' ? 'text-[#10b981]' :
                  v.startsWith('24h') ? 'text-[#f59e0b]' : 'text-[#f0f6fc]'
                )}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Lote e escala */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <DollarSign size={12} className="text-[#10b981]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Lote & Escala</span>
          </div>
          {status ? (
            <div className="space-y-2">
              <div className="text-2xl font-black text-[#10b981] font-mono">{loteAtual(status.balance)}</div>
              <div className="text-[9px] text-[#484f58]">Saldo: {fmtUSD(status.balance)}</div>
              <div className="mt-3 space-y-0.5">
                {FAIXAS_LOTE.slice(0, 8).map(f => (
                  <div key={f.label} className={cn(
                    'flex justify-between text-[9px] font-mono px-1.5 py-0.5 rounded',
                    status.balance >= f.min && status.balance < f.max
                      ? 'bg-[#10b981]/10 text-[#10b981]' : 'text-[#484f58]',
                  )}>
                    <span>${f.min}–{f.max === Infinity ? '∞' : `$${f.max}`}</span>
                    <span>{f.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[#484f58] text-xs">Aguardando saldo...</div>
          )}
        </div>

        {/* Conexão MT5 detalhada */}
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
                <div className="text-[#8b949e]">Posições abertas: <span className="text-[#f0f6fc]">{status?.open_positions}</span></div>
                <div className="text-[#8b949e]">Win Rate geral: <span className={cn('font-bold',
                  wr === null ? 'text-[#484f58]' : wr >= 60 ? 'text-[#10b981]' : wr >= 50 ? 'text-[#f59e0b]' : 'text-[#ef4444]')}>
                  {wr !== null ? `${wr}%` : '—'}
                </span></div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[#ef4444]">
                <WifiOff size={11} />
                {status ? `Offline · ${secondsAgo(status.updated_at)}` : 'Bot não iniciado'}
              </div>
            )}
            {!supa && <div className="text-[#ef4444] mt-2">SUPABASE não configurado</div>}
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
                className={cn('px-3 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all',
                  activeTab === tab ? 'bg-[#21262d] text-[#f0f6fc]' : 'text-[#484f58] hover:text-[#8b949e]')}>
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
              {activeTab === 'history' ? 'Nenhum trade fechado ainda.' : 'Nenhuma posição aberta.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#30363d] bg-[#0d1117]">
                  {['Data/Hora','Dir','Entry','SL','TP','Lote','RAFI','P&L','Resultado'].map(h => (
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
            Alternativa: crie o arquivo <code className="text-[#8b949e]">STOP</code> em{' '}
            <code className="text-[#8b949e]">C:\RafiBot\rafi-bot\</code>
          </div>
        </div>
        <button onClick={() => enviarComando('stop')} disabled={cmdSent}
          className={cn('flex items-center gap-2 px-4 py-2 rounded-lg border font-bold text-xs transition-all shrink-0',
            cmdSent ? 'bg-[#21262d] border-[#30363d] text-[#484f58] cursor-not-allowed'
              : 'bg-[#ef4444]/10 border-[#ef4444]/25 text-[#ef4444] hover:bg-[#ef4444]/20')}>
          <Square size={11} fill="currentColor" />
          {cmdSent ? 'Enviado' : 'PARAR AGORA'}
        </button>
      </div>

    </div>
  )
}
