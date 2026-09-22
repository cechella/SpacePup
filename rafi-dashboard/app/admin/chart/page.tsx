'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoData, type Timeframe } from '@/lib/demo-data'
import { calcRAFI, calcSRLevels, calcBollingerBands, autoScanBreakouts } from '@/lib/indicators'
import { parseCSV, detectTimeframe, fmtDate, type LoadResult } from '@/lib/csv-loader'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { SessionSidebar, type TargetMetrics } from '@/components/session-sidebar'
import { CheckinModal, type CheckinResult } from '@/components/checkin-modal'
import { MetasOverlay } from '@/components/metas-overlay'
import { LiveMetaPopup } from '@/components/live-meta-popup'
import { type OCOState } from '@/components/oco-overlay'
import { cn, formatPrice } from '@/lib/utils'
import { getLotForCapital, getNextTier, calcCapital } from '@/lib/lot-scaling'
import { upsertTrade, fetchTrades, fetchCandles, countCandles } from '@/lib/trades-db'
import { upsertDailyGoal, fetchDailyGoal, fetchWeeklyGoal } from '@/lib/daily-goals-db'
import { Info, BarChart2, Crosshair, FolderOpen, X as XIcon, Hand, Layers, ScanLine, History, ChevronDown, Trash2, Database, Menu } from 'lucide-react'
import type { CandleData } from '@/lib/types'
import { generateTradeSnapshot } from '@/lib/trade-snapshot'
import { getSessionConfig } from '@/lib/session-config'
import { createClient as createSupabaseClient } from '@/lib/supabase'
import { IASuggestionModal, type IASuggestion } from '@/components/ia-suggestion-modal'
import { ModoAutonomoModal } from '@/components/modo-autonomo-modal'
import { ModoAutonomoBanner, type AutonomoTrade } from '@/components/modo-autonomo-banner'

const RAFIChart = dynamic(
  () => import('@/components/rafi-chart').then(m => m.RAFIChart),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-[#0d1117]">
        <div className="flex flex-col items-center gap-3 text-[#484f58]">
          <BarChart2 size={24} className="animate-pulse" />
          <span className="text-xs">Carregando gráfico…</span>
        </div>
      </div>
    ),
  },
)

const TIMEFRAMES: Timeframe[] = ['M5', 'M15', 'H1']

const OCO_LEVERAGE = 1000
const BASE_CAPITAL = 100  // capital inicial em USD

// OCO com lote calculado pela tabela de escalonamento
// Padrão: 10 pips SL · 30 pips TP → R:R 1:3 fixo
const SL_PIPS = 3   // $30 stop por lote
const TP_PIPS = 10  // $100 alvo por lote → R:R 1:3.3
function makeOCO(price: number, lot: number, time?: number): OCOState {
  const p     = (v: number) => Math.round(v * 100000) / 100000
  const slOff = SL_PIPS * 0.0001   // 3 pips = 0.0003
  const tpOff = TP_PIPS * 0.0001   // 10 pips = 0.0010
  return {
    lot,
    leverage:  OCO_LEVERAGE,
    direction: 'buy',
    entry:     p(price),
    sl:        p(price - slOff),
    tp:        p(price + tpOff),
    entryTime: time,
  }
}

// Calcula contexto de sessão para aprendizado da IA
function getOverlapContext(unixSec: number): {
  overlapPhase:  'early' | 'mid' | 'late' | null
  sessionMinute: number | null
  dayOfWeek:     number | null
} {
  const d      = new Date(unixSec * 1000)
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes()
  const START  = 13 * 60 + 30   // 13:30 UTC — início do overlap
  const END    = 16 * 60 + 30   // 16:30 UTC — fim do overlap
  const sesMin = utcMin - START

  let overlapPhase: 'early' | 'mid' | 'late' | null = null
  if (utcMin >= START && utcMin < END) {
    overlapPhase = sesMin < 30 ? 'early' : sesMin < 90 ? 'mid' : 'late'
  }

  // getUTCDay: 0=Dom 1=Seg … 5=Sex → índice dentro dos dias operacionais configurados
  const jsDay = d.getUTCDay()
  const tradingDays = typeof window !== 'undefined' ? getSessionConfig().tradingDays : [1,2,3,4]
  const dayOfWeek = tradingDays.includes(jsDay) ? (tradingDays.indexOf(jsDay) as number) : null

  return { overlapPhase, sessionMinute: overlapPhase !== null ? sesMin : null, dayOfWeek }
}

// Data atual no fuso de Brasília (UTC-3), para flags de meta diária
function brtDateStr() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  return brt.toISOString().slice(0, 10)
}

// Data da segunda-feira da semana atual em BRT — chave da flag de meta semanal.
// Muda toda segunda-feira 00:00 BRT (= 03:00 UTC), encerrando a semana anterior.
function brtWeekMondayStr() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const day = brt.getUTCDay()  // 0=Dom, 1=Seg, ..., 6=Sáb
  const daysFromMon = day === 0 ? 6 : day - 1
  const mon = new Date(brt)
  mon.setUTCDate(brt.getUTCDate() - daysFromMon)
  return mon.toISOString().slice(0, 10)
}

const STORAGE_KEY     = 'rafi-trade-log'
const CSV_HISTORY_KEY = 'rafi-csv-history'
const META_AUTO_KEY   = 'rafi-meta-auto'
const MAX_CSV_HISTORY = 5

interface CsvHistoryEntry {
  id:          string
  filename:    string
  dateFrom:    string
  dateTo:      string
  timeframe:   string
  count:       number
  loadedAt:    number
  candles:     CandleData[]
  scanResult?: { trades: number; wins: number; pnl: number }
}

// Badge de corretora: mapeamento brokerId → cores
const BROKER_BADGE: Record<string, { bg: string; ring: string; label: string }> = {
  tickmill:    { bg: '#1d4ed8', ring: '#3b82f6', label: 'TIC' },
  pepperstone: { bg: '#15803d', ring: '#22c55e', label: 'PEP' },
  exness:      { bg: '#b45309', ring: '#f59e0b', label: 'EXN' },
  icmarkets:   { bg: '#065f46', ring: '#10b981', label: 'ICM' },
}
function brokerBadge(brokerId: string, nome: string) {
  const b = BROKER_BADGE[brokerId] ?? { bg: '#374151', ring: '#6b7280', label: nome.slice(0, 3).toUpperCase() }
  return (
    <span
      style={{ background: b.bg, border: `1px solid ${b.ring}`, color: b.ring }}
      className="inline-block px-1 py-0 rounded text-[8px] font-bold font-mono leading-4 shrink-0"
    >
      {b.label}
    </span>
  )
}

export default function ChartPage() {
  const [trades,       setTrades]       = useState<ManualTrade[]>([])
  const [tf,           setTf]           = useState<Timeframe>('M5')
  const [clickedEntry, setClickedEntry] = useState<number | null>(null)
  const [clickedTime,  setClickedTime]  = useState<number | undefined>(undefined)
  const [ocoState,     setOcoState]     = useState<OCOState | null>(null)
  const [ocoVisible,   setOcoVisible]   = useState(true)
  const [csvData,      setCsvData]      = useState<LoadResult | null>(null)
  const [csvError,     setCsvError]     = useState<string | null>(null)
  const [panMode,      setPanMode]      = useState(false)   // true = navegar; false = colocar OCO
  const [csvHistory,   setCsvHistory]   = useState<CsvHistoryEntry[]>([])
  const [historyOpen,  setHistoryOpen]  = useState(false)
  const [activeCsvId,  setActiveCsvId]  = useState<string | null>(null)
  const [sbLoading,     setSbLoading]     = useState(false)
  const [sbCandleCount, setSbCandleCount] = useState<number | null>(null)
  const [metaLoading,   setMetaLoading]   = useState(false)
  const [metaConnected, setMetaConnected] = useState(false)
  const [metaError,     setMetaError]     = useState<string | null>(null)
  // Toggle global MetaAPI — sincronizado com localStorage da página Corretoras
  const [globalMapiActive, setGlobalMapiActive] = useState<boolean | null>(null)
  const [globalMapiStatus, setGlobalMapiStatus] = useState<'idle' | 'loading'>('idle')
  const [metaStep,      setMetaStep]      = useState<string>('')
  const [metaElapsed,   setMetaElapsed]   = useState(0)
  const metaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Feature 1: saldo e equity da conta primária (Pepperstone)
  const [metaAccount,   setMetaAccount]   = useState<{
    balance: number; equity: number; freeMargin: number; currency: string; updatedAt: string
  } | null>(null)
  // Capital consolidado: soma dos saldos de todas as corretoras habilitadas
  const [consolidatedBalance, setConsolidatedBalance] = useState<number | null>(null)
  // Feature 2: posições abertas em tempo real
  const [metaPositions, setMetaPositions] = useState<Array<{
    id: string; symbol: string; type: string; volume: number
    openPrice: number; currentPrice: number; profit: number
    stopLoss: number; takeProfit: number
  }>>([])
  const metaPositionsRef = useRef<typeof metaPositions>([])
  useEffect(() => { metaPositionsRef.current = metaPositions }, [metaPositions])
  // Feature 3: toast de feedback ao enviar ordem
  const [orderToast, setOrderToast] = useState<{ ok: boolean; msg: string } | null>(null)
  // Feature 4: countdown para próximo auto-refresh dos candles
  const [refreshIn,  setRefreshIn]  = useState(0)
  // Countdown regressivo até o fechamento da barra atual
  const [candleCountdown, setCandleCountdown] = useState(0)
  // Feature 5: alertas do bot (abertura/fechamento de posições)
  const [botAlerts,  setBotAlerts]  = useState<Array<{ id: string; kind: 'open' | 'close'; text: string }>>([])
  // Histórico de trades fechados da Pepperstone
  const [metaHistory, setMetaHistory] = useState<Array<{
    id: string; symbol: string; type: string; direction: 'buy' | 'sell'
    volume: number; price: number; profit: number; time: string; comment: string
    entryPrice?: number | null; positionId?: string | null
  }>>([])
  const [historyPeriod,      setHistoryPeriod]      = useState<'today' | '7d' | '30d' | '3m'>('today')
  const [historyLoading,     setHistoryLoading]     = useState(false)
  const [historyBroker,      setHistoryBroker]      = useState<string>('')  // '' = todas as corretoras (Auto)
  const [historyGroups,      setHistoryGroups]      = useState<Array<{ rank: number; brokerId: string; nome: string; trades: typeof metaHistory; fetchError?: string; httpStatus?: number }>>([])
  const [enabledBrokers,     setEnabledBrokers]     = useState<Array<{ id: string; nome: string }>>([]) // corretoras disponíveis para escolha
  // Posições abertas de TODAS as corretoras ativas (cross-broker live panel)
  const [allBrokerPositions, setAllBrokerPositions] = useState<Array<{
    rank: number; brokerId: string; nome: string; symbol: string
    positions: Array<{
      id: string; symbol: string; type: string; volume: number
      openPrice: number; currentPrice: number; profit: number
      commission: number; swap: number; netPnl?: number
      stopLoss: number; takeProfit: number; openTime?: string
    }>
    totalPnl: number; totalNetPnl?: number; error?: string | number
  }>>([])
  const allBrokerPositionsRef = useRef<typeof allBrokerPositions>([])
  useEffect(() => { allBrokerPositionsRef.current = allBrokerPositions }, [allBrokerPositions])
  // Preço ao vivo: atualiza o último candle tick a tick
  const [livePrice, setLivePrice] = useState<number | null>(null)
  // Ref direto para RAF no gráfico — sem passar pelo scheduler do React
  const livePriceRef = useRef<number | null>(null)
  // Edição inline de SL/TP: { positionId, sl: string, tp: string }
  const [editingPos, setEditingPos] = useState<{ id: string; sl: string; tp: string } | null>(null)
  // Mobile: gaveta lateral e aba ativa
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [mobileTab,    setMobileTab]    = useState<'chart' | 'positions' | 'trade' | 'history'>('chart')
  // Resize vertical do gráfico — desktop only
  const [chartH,    setChartH]    = useState(460)
  const [isDesktop, setIsDesktop] = useState(false)
  const chartHRef = useRef(460)
  useEffect(() => { chartHRef.current = chartH }, [chartH])
  // Zerar Tudo — confirmação inline e estado de loading
  const [closeAllConfirm, setCloseAllConfirm] = useState(false)
  const [closingAll,      setClosingAll]      = useState(false)
  // Pop-up "Meta Ao Vivo" — dispara quando liveDailyPct bate DAILY_TARGET com posições abertas
  const [showLiveMetaPopup,  setShowLiveMetaPopup]  = useState(false)
  const [liveMetaSnapshot,   setLiveMetaSnapshot]   = useState<{ pct: number; pnl: number; bal: number } | null>(null)
  const [liveMetaClosing,    setLiveMetaClosing]    = useState(false)
  const [liveMetaClosed,     setLiveMetaClosed]     = useState(false)
  const prevLiveMetaFiredRef = useRef(false)
  // Altura da toolbar interna (colapsável arrastando para cima)
  // null = altura natural (auto); 0 = colapsada
  const [toolbarH,    setToolbarH]    = useState<number | null>(null)
  const toolbarHRef = useRef<number>(52)  // estimativa inicial para o drag
  const toolbarElRef = useRef<HTMLDivElement | null>(null)  // mede altura real no DOM
  const prevPositionsRef = useRef<typeof metaPositions>([])
  // IA Suggestion — pop-up de sugestão de entrada
  const [iaSuggestion,     setIaSuggestion]     = useState<IASuggestion | null>(null)
  const [showIASuggestion, setShowIASuggestion] = useState(false)
  const [iaWatcherActive,  setIaWatcherActive]  = useState(true)
  const iaLastSuggestRef = useRef<number>(0)  // evita re-disparar a mesma sugestão dentro de 5min

  // Modo Autônomo — IA opera sozinha quando estado mental está comprometido
  const [showAutonomoModal, setShowAutonomoModal] = useState(false)
  const [autonomoAtivo,     setAutonomoAtivo]     = useState(false)
  const [autonomoTrades,    setAutonomoTrades]     = useState<AutonomoTrade[]>([])
  const [autonomoPnl,       setAutonomoPnl]        = useState(0)
  const autonomoLastRef = useRef<number>(0)  // evita re-execução dentro de 5min
  const META_DIARIA_PCT = 7  // 7% de meta diária

  // Check-in de estado mental do dia
  const [checkin,     setCheckin]     = useState<CheckinResult | null>(null)
  const [showCheckin, setShowCheckin] = useState(false)
  // Overlays de meta atingida
  const [showDailyOverlay,  setShowDailyOverlay]  = useState(false)
  const [showWeeklyOverlay, setShowWeeklyOverlay] = useState(false)
  const prevDailyMetRef  = useRef(false)
  const prevWeeklyMetRef = useRef(false)
  // Métricas salvas no Supabase — fallback quando MetaAPI está desconectado
  const [supabaseGoalData, setSupabaseGoalData] = useState<{
    dailyPct: number; dailyPnl: number; weeklyPct: number; weeklyPnl: number
  } | null>(null)
  // Dados fixos capturados no momento em que o overlay foi acionado —
  // independente de MetaAPI ainda estar carregando ou não
  const [overlayDailyData,  setOverlayDailyData]  = useState<{ pct: number; pnl: number; weeklyPct: number; weeklyPnl: number } | null>(null)
  const [overlayWeeklyData, setOverlayWeeklyData] = useState<{ pct: number; pnl: number; weeklyPct: number; weeklyPnl: number } | null>(null)
  // Roteamento multi-corretora: broker vencedor atual do ranking
  const [routeBroker, setRouteBroker] = useState<{
    id: string; nome: string; estado: string; health_score: number; circuit_breaker: string
  } | null>(null)
  const fileInputRef        = useRef<HTMLInputElement>(null)
  const historyPanelRef     = useRef<HTMLDivElement>(null)
  const snapshotCaptureRef  = useRef<((entryTime: number, oco?: { entry: number; sl: number; tp: number; direction: 'buy' | 'sell' }) => string | null) | null>(null)
  // Callback imperativo: SSE chama direto, sem passar pelo scheduler do React
  const chartUpdateCandleRef = useRef<((price: number) => void) | null>(null)
  // Botão Shift (MT5): reposiciona o gráfico com espaço à direita
  const shiftRangeRef = useRef<(() => void) | null>(null)
  // Alinhar à direita: última barra na borda direita
  const alignRightRef = useRef<(() => void) | null>(null)

  // Mostra check-in na primeira abertura do dia (seg–qui), qualquer horário.
  // Sempre aparece uma vez por dia — mesmo que a meta já tenha sido atingida,
  // para registrar o estado mental no Supabase e cruzar com os resultados.
  useEffect(() => {
    const CHECKIN_KEY = 'rafi-checkin-date'
    const today = brtDateStr()
    const done  = typeof window !== 'undefined' && localStorage.getItem(CHECKIN_KEY) === today
    if (done) return

    // Meta semanal já atingida esta semana — semana encerrada; check-in volta na segunda
    const weeklyGoalMet = typeof window !== 'undefined' && localStorage.getItem(`rafi-weekly-target-met-${brtWeekMondayStr()}`) === 'true'
    if (weeklyGoalMet) return

    // Usa dia da semana em BRT para não errar perto da meia-noite (11pm BRT = terça UTC)
    const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const jsDay = brtNow.getUTCDay()
    const activeDays = getSessionConfig().tradingDays
    if (activeDays.includes(jsDay)) setShowCheckin(true)
  }, [])

  // Ao abrir a página: se a meta diária já foi cumprida hoje (BRT), mostra overlay
  // imediatamente, sem depender do MetaAPI carregar — persiste até meia-noite BRT
  // Nota: o Supabase irá confirmar/limpar este flag em seguida via checkGoalsFromSupabase
  useEffect(() => {
    const today = brtDateStr()
    const stored    = typeof window !== 'undefined' ? localStorage.getItem(`rafi-daily-target-met-${today}`) : null
    const storedPnl = typeof window !== 'undefined' ? parseFloat(localStorage.getItem(`rafi-daily-pnl-${today}`) ?? '0') : 0
    // Só restaura do localStorage se houver P&L real salvo junto com a flag
    if (stored === 'true' && storedPnl > 0) {
      setOverlayDailyData({ pct: 0, pnl: storedPnl, weeklyPct: 0, weeklyPnl: 0 })
      setShowDailyOverlay(true)
      prevDailyMetRef.current = true  // evita duplo disparo quando MetaAPI carregar
    } else if (stored === 'true' && storedPnl <= 0) {
      // Flag stale sem P&L válido — limpa para evitar falso positivo
      try { localStorage.removeItem(`rafi-daily-target-met-${today}`) } catch { /* */ }
    }
  }, [])

  // Ao abrir a página: se a meta semanal já foi cumprida esta semana (BRT), mostra overlay
  // imediatamente — persiste até segunda-feira BRT da semana seguinte
  // Nota: o Supabase irá confirmar/limpar este flag em seguida via checkGoalsFromSupabase
  useEffect(() => {
    const weekMonday = brtWeekMondayStr()
    const stored = typeof window !== 'undefined' ? localStorage.getItem(`rafi-weekly-target-met-${weekMonday}`) : null
    const storedPnl = typeof window !== 'undefined' ? parseFloat(localStorage.getItem(`rafi-weekly-pnl-${weekMonday}`) ?? '0') : 0
    // Só restaura do localStorage se houver P&L real salvo junto com a flag
    if (stored === 'true' && storedPnl > 0) {
      setOverlayWeeklyData({ pct: 0, pnl: storedPnl, weeklyPct: 0, weeklyPnl: storedPnl })
      setShowWeeklyOverlay(true)
      prevWeeklyMetRef.current = true  // evita duplo disparo quando MetaAPI carregar
    } else if (stored === 'true' && storedPnl <= 0) {
      // Flag stale sem P&L válido — limpa para evitar falso positivo
      try { localStorage.removeItem(`rafi-weekly-target-met-${weekMonday}`) } catch { /* */ }
    }
  }, [])

  // ── IA Signal Watcher — avalia condições a cada 30s e dispara pop-up ─────────
  useEffect(() => {
    if (!iaWatcherActive) return

    async function checkSignal() {
      // Não avalia se já há sugestão visível ou se disparou nos últimos 5 min
      if (showIASuggestion) return
      if (Date.now() - iaLastSuggestRef.current < 5 * 60 * 1000) return
      // Não avalia se não há preço ao vivo
      const price = livePriceRef.current
      if (!price) return
      // Não avalia se já há 2+ posições abertas (limite de risco)
      if (allBrokerPositionsRef.current.reduce((acc, b) => acc + (b.positions?.length ?? 0), 0) >= 2) return

      // Coleta condições atuais a partir dos dados do gráfico
      const nowSec = Math.floor(Date.now() / 1000)
      const horaUtc = new Date().getUTCHours()

      // Pega o último valor de RAFI calculado (referência direta ao estado atual)
      // e o último candle M5 para determinar direção natural do mercado
      const storedTrades = typeof window !== 'undefined'
        ? JSON.parse(localStorage.getItem('rafi-trade-log') ?? '[]')
        : []
      const labeledCount = Array.isArray(storedTrades)
        ? storedTrades.filter((t: { result?: string }) => t.result === 'win' || t.result === 'loss').length
        : 0

      try {
        const res = await fetch('/api/ml/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rafi:          0,          // frontend vai sobrepor com valor atual quando disponível
            direction:     'buy',      // será determinado pela API com base nos trades recentes
            currentPrice:  price,
            horaUtc,
            capital:       consolidatedBalance ?? 100,
            labeled_count: labeledCount,
            checkinSono:    checkin?.sono    ?? null,
            checkinEnergia: checkin?.energia ?? null,
            checkinMental:  checkin?.mental  ?? null,
            checkinHumor:   checkin?.humor   ?? null,
          }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (data.suggestion === true) {
          setIaSuggestion(data as IASuggestion)
          setShowIASuggestion(true)
          iaLastSuggestRef.current = Date.now()
        }
      } catch {
        // silencioso — não interrompe a UI em caso de erro de rede
      }
    }

    const intervalId = setInterval(checkSignal, 30_000)
    return () => clearInterval(intervalId)
  }, [iaWatcherActive, showIASuggestion, checkin, consolidatedBalance])

  // ── Loop Autônomo — executa trades sem confirmação quando ativado ────────────
  useEffect(() => {
    if (!autonomoAtivo) return

    function getSessaoAtiva(): 'Londres' | 'NY' | null {
      const h = new Date().getUTCHours()
      if (h >= 8  && h < 12) return 'Londres'
      if (h >= 13 && h < 17) return 'NY'
      return null
    }

    async function runLoop() {
      const price = livePriceRef.current
      if (!price) return
      const sessao = getSessaoAtiva()
      if (!sessao) return  // fora das sessões — não opera

      const capital = consolidatedBalance ?? 100
      const metaUsd = capital * (META_DIARIA_PCT / 100)
      if (autonomoPnl >= metaUsd) return  // meta já atingida

      const posOpen = allBrokerPositionsRef.current.reduce((acc, b) => acc + (b.positions?.length ?? 0), 0)
      if (posOpen >= 2) return  // limite de posições simultâneas

      if (Date.now() - autonomoLastRef.current < 5 * 60 * 1000) return  // cooldown 5 min

      const stored = typeof window !== 'undefined'
        ? JSON.parse(localStorage.getItem('rafi-trade-log') ?? '[]')
        : []
      const labeledCount = Array.isArray(stored)
        ? stored.filter((t: { result?: string }) => t.result === 'win' || t.result === 'loss').length
        : 0

      try {
        const res = await fetch('/api/ml/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rafi:          0,
            direction:     'buy',
            currentPrice:  price,
            horaUtc:       new Date().getUTCHours(),
            capital,
            labeled_count: labeledCount,
            checkinSono:    checkin?.sono    ?? null,
            checkinEnergia: checkin?.energia ?? null,
            checkinMental:  checkin?.mental  ?? null,
            checkinHumor:   checkin?.humor   ?? null,
          }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (data.suggestion !== true || data.probability < 65) return

        autonomoLastRef.current = Date.now()
        const tradeId = `auto-${Date.now()}`
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

        // Registra trade autônomo como "em aberto"
        setAutonomoTrades(prev => [...prev, {
          id: tradeId, direction: data.direction, entry: data.entry,
          lot: data.lot, prob: data.probability, status: 'open', hora,
        }])

        // Envia ordem
        const orderRes = await fetch('/api/metaapi/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol:     'EURUSD',
            actionType: data.direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
            volume:     data.lot,
            stopLoss:   data.stopLoss,
            takeProfit: data.takeProfit,
            comment:    `AUTONOMO-P${data.probability}`,
          }),
        })

        if (orderRes.ok) {
          const result = await orderRes.json().catch(() => ({}))
          const tipo = data.direction === 'buy' ? 'COMPRA' : 'VENDA'
          const reps = (result.replication as Array<{ ok: boolean }>)?.filter(r => r.ok).length ?? 1
          setOrderToast({ ok: true, msg: `🤖 Autônomo: ${tipo} ${data.entry.toFixed(5)} · P=${data.probability}% · ${reps} corretora${reps > 1 ? 's' : ''} ✓` })
        } else {
          setAutonomoTrades(prev => prev.filter(t => t.id !== tradeId))
          const err = await orderRes.json().catch(() => ({}))
          setOrderToast({ ok: false, msg: `🤖 Autônomo: erro — ${err?.error ?? orderRes.status}` })
        }
        setTimeout(() => setOrderToast(null), 8000)
      } catch {
        // silencioso
      }
    }

    const iv = setInterval(runLoop, 5 * 60 * 1000)  // a cada 5 minutos
    runLoop()  // roda imediatamente ao ativar
    return () => clearInterval(iv)
  }, [autonomoAtivo, autonomoPnl, checkin, consolidatedBalance])

  function getAutonomoSessao(): 'Londres' | 'NY' | 'aguardando' {
    const h = new Date().getUTCHours()
    if (h >= 8  && h < 12) return 'Londres'
    if (h >= 13 && h < 17) return 'NY'
    return 'aguardando'
  }

  async function handleIAAuthorize(s: IASuggestion) {
    await fetch('/api/metaapi/order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:     'EURUSD',
        actionType: s.direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
        volume:     s.lot,
        stopLoss:   s.stopLoss,
        takeProfit: s.takeProfit,
        comment:    `IA-P${s.probability}`,
      }),
    })
      .then(async res => {
        if (res.ok) {
          const result = await res.json().catch(() => ({}))
          const tipo = s.direction === 'buy' ? 'COMPRA' : 'VENDA'
          const replicadas = (result.replication as Array<{ ok: boolean }>)?.filter(r => r.ok).length ?? 1
          setOrderToast({ ok: true, msg: `IA: Ordem ${tipo} enviada · ${replicadas} corretora${replicadas > 1 ? 's' : ''} ✓` })
        } else {
          const err = await res.json().catch(() => ({}))
          setOrderToast({ ok: false, msg: `IA: ${err?.error ?? res.status}` })
        }
        setTimeout(() => setOrderToast(null), 6000)
      })
      .catch(err => {
        setOrderToast({ ok: false, msg: `IA: ${err.message ?? 'Falha de rede'}` })
        setTimeout(() => setOrderToast(null), 6000)
      })
  }

  // Fallback: verifica Supabase para metas já cumpridas (funciona mesmo com MetaAPI
  // desconectado e em qualquer dispositivo — não depende do localStorage local)
  useEffect(() => {
    async function checkGoalsFromSupabase() {
      try {
        const today      = brtDateStr()
        const weekMonday = brtWeekMondayStr()

        // Verifica meta diária
        const daily = await fetchDailyGoal(today)
        if (daily?.dailyMet && daily.dailyPnl > 0) {
          localStorage.setItem(`rafi-daily-target-met-${today}`, 'true')
          localStorage.setItem(`rafi-daily-pnl-${today}`, String(daily.dailyPnl))
          setSupabaseGoalData({ dailyPct: daily.dailyPct, dailyPnl: daily.dailyPnl, weeklyPct: daily.weeklyPct, weeklyPnl: daily.weeklyPnl })
          // Captura os dados reais no momento do disparo — garante que o overlay mostre valores corretos
          // mesmo que targetMetrics ainda esteja zerado (MetaAPI carregando)
          setOverlayDailyData({ pct: daily.dailyPct, pnl: daily.dailyPnl, weeklyPct: daily.weeklyPct, weeklyPnl: daily.weeklyPnl })
          setShowDailyOverlay(true)
          setShowCheckin(false)
          prevDailyMetRef.current = true
        } else if (!daily?.dailyMet || (daily.dailyPnl ?? 0) <= 0) {
          // Nenhum registro válido no Supabase — limpa flag stale do localStorage
          try {
            localStorage.removeItem(`rafi-daily-target-met-${today}`)
            localStorage.removeItem(`rafi-daily-pnl-${today}`)
          } catch { /* */ }
          setShowDailyOverlay(false)
        }

        // Verifica meta semanal (qualquer dia da semana pode ter batido a meta)
        const weekly = await fetchWeeklyGoal(weekMonday)
        if (weekly?.weeklyMet && weekly.weeklyPnl > 0) {
          localStorage.setItem(`rafi-weekly-target-met-${weekMonday}`, 'true')
          localStorage.setItem(`rafi-weekly-pnl-${weekMonday}`, String(weekly.weeklyPnl))
          setSupabaseGoalData({ dailyPct: weekly.dailyPct, dailyPnl: weekly.dailyPnl, weeklyPct: weekly.weeklyPct, weeklyPnl: weekly.weeklyPnl })
          setOverlayWeeklyData({ pct: weekly.weeklyPct, pnl: weekly.weeklyPnl, weeklyPct: weekly.weeklyPct, weeklyPnl: weekly.weeklyPnl })
          setShowWeeklyOverlay(true)
          setShowCheckin(false)
          prevWeeklyMetRef.current = true
        } else if (!weekly?.weeklyMet || (weekly.weeklyPnl ?? 0) <= 0) {
          // Nenhum registro válido no Supabase — limpa flag stale do localStorage
          try {
            localStorage.removeItem(`rafi-weekly-target-met-${weekMonday}`)
            localStorage.removeItem(`rafi-weekly-pnl-${weekMonday}`)
          } catch { /* */ }
          setShowWeeklyOverlay(false)
        }
      } catch { /* Supabase indisponível — fallback silencioso para localStorage */ }
    }
    checkGoalsFromSupabase()
  }, [])

  function handleCheckinComplete(result: CheckinResult) {
    setCheckin(result)
    setShowCheckin(false)
    try { localStorage.setItem('rafi-checkin-date', brtDateStr()) } catch { /* */ }

    // Verifica se estado está comprometido — mostra modal de Modo Autônomo
    const estadoRuim =
      result.sono    === 'mal'    ||
      result.energia === 'baixa'  ||
      result.mental  === 'ruim'   ||
      result.humor   === 'triste'
    if (estadoRuim) {
      // Só oferece modo autônomo se há ≥ 10 trades rotulados
      const stored = typeof window !== 'undefined'
        ? JSON.parse(localStorage.getItem('rafi-trade-log') ?? '[]')
        : []
      const labeled = Array.isArray(stored)
        ? stored.filter((t: { result?: string }) => t.result === 'win' || t.result === 'loss').length
        : 0
      if (labeled >= 10) setShowAutonomoModal(true)
    }
  }

  // Estado de disciplina derivado do histórico de operações já carregado
  const disciplineState = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)  // 'YYYY-MM-DD'

    // Stops hoje: trades fechados com lucro negativo no dia atual
    const stopsToday = metaHistory.filter(t => {
      const tradeDate = t.time?.slice(0, 10) ?? ''
      return tradeDate === today && t.profit < 0
    }).length

    // Perdas consecutivas: contar da trade mais recente para trás
    let consecutiveLosses = 0
    for (const t of [...metaHistory].reverse()) {
      if (t.profit < 0) consecutiveLosses++
      else break
    }

    // Drawdown semanal: soma de todas as perdas dos últimos 7 dias / saldo atual
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1_000
    const weeklyPnl = metaHistory
      .filter(t => new Date(t.time).getTime() >= weekAgo)
      .reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const bal = metaAccount?.balance ?? 100
    const weeklyDrawdownPct = bal > 0 ? (weeklyPnl / bal) * 100 : 0

    return { stopsToday, consecutiveLosses, weeklyDrawdownPct }
  }, [metaHistory, metaAccount])

  const DAILY_TARGET  = 7.0
  const WEEKLY_TARGET = 25.0

  // Calcula progresso de metas diária e semanal a partir do histórico MetaAPI
  const targetMetrics = useMemo((): TargetMetrics => {
    // Usa data BRT (UTC-3) para evitar virada de dia UTC às 21h/22h BRT
    const today = brtDateStr()
    // Converte timestamp UTC de trade para data BRT
    const toBrtDate = (iso: string) =>
      new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // Início da semana em BRT (segunda-feira)
    const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const jsDay = brtNow.getUTCDay()
    const daysFromMon = jsDay === 0 ? 6 : jsDay - 1
    const mon = new Date(brtNow)
    mon.setUTCDate(brtNow.getUTCDate() - daysFromMon)
    const weekStart = mon.toISOString().slice(0, 10)

    const todayPnl = metaHistory
      .filter(t => toBrtDate(t.time ?? '') === today)
      .reduce((s, t) => s + (t.profit ?? 0), 0)

    const weekPnl = metaHistory
      .filter(t => {
        const dd = toBrtDate(t.time ?? '')
        return dd >= weekStart && dd <= today
      })
      .reduce((s, t) => s + (t.profit ?? 0), 0)

    // Capital base: consolidado (todas corretoras) > Pepperstone > fallback
    const bal          = consolidatedBalance ?? metaAccount?.balance ?? 100
    const startBal     = Math.max(bal - todayPnl, 1)
    const weekStartBal = Math.max(bal - weekPnl,  1)
    const dailyPct     = (todayPnl / startBal) * 100
    const weeklyPct    = (weekPnl  / weekStartBal) * 100

    // Quantidade de dias desta semana que bateram a meta (chaves localStorage)
    let daysHit = 0
    if (typeof window !== 'undefined') {
      const activeDays = getSessionConfig().tradingDays
      activeDays.forEach(weekday => {
        // Calcula o offset do dia na semana atual (segunda = 1)
        const offset = weekday === 0 ? 6 : weekday - 1  // dom=6 offset, seg=0, ter=1...
        const di = new Date(mon)
        di.setUTCDate(mon.getUTCDate() + offset)
        const dk = di.toISOString().slice(0, 10)
        if (localStorage.getItem(`rafi-daily-target-met-${dk}`) === 'true') daysHit++
      })
    }

    const dailyMet  = dailyPct  >= DAILY_TARGET
    const weeklyMet = weeklyPct >= WEEKLY_TARGET

    // Persiste flags de meta usando datas BRT (meia-noite BRT = 03:00 UTC)
    if (typeof window !== 'undefined') {
      if (dailyMet && todayPnl > 0) {
        localStorage.setItem(`rafi-daily-target-met-${brtDateStr()}`, 'true')
        localStorage.setItem(`rafi-daily-pnl-${brtDateStr()}`, String(todayPnl))
      }
      if (weeklyMet && weekPnl > 0) {
        localStorage.setItem(`rafi-weekly-target-met-${brtWeekMondayStr()}`, 'true')
        localStorage.setItem(`rafi-weekly-pnl-${brtWeekMondayStr()}`, String(weekPnl))
      }
    }

    return {
      dailyPct, dailyPnl: todayPnl,
      weeklyPct, weeklyPnl: weekPnl,
      daysHit,
      dailyMet, weeklyMet,
      locked: dailyMet || weeklyMet,
      DAILY_TARGET, WEEKLY_TARGET,
    }
  }, [metaHistory, metaAccount, consolidatedBalance])

  // Dispara overlay quando a meta é atingida pela primeira vez nesta sessão.
  // Aguarda saldo real (consolidado ou MetaAPI) para evitar falso positivo com
  // o fallback de $100 que inflaria o % antes dos dados carregarem.
  const balanceLoaded = consolidatedBalance !== null || (metaAccount?.balance ?? 0) > 0

  useEffect(() => {
    if (!balanceLoaded) return
    if (targetMetrics.dailyMet && !prevDailyMetRef.current) {
      // Captura valores reais do MetaAPI no momento do disparo
      setOverlayDailyData({ pct: targetMetrics.dailyPct, pnl: targetMetrics.dailyPnl, weeklyPct: targetMetrics.weeklyPct, weeklyPnl: targetMetrics.weeklyPnl })
      setShowDailyOverlay(true)
      setShowCheckin(false)
      // Persiste no Supabase — funciona mesmo após reconectar MetaAPI em outro dispositivo
      upsertDailyGoal({
        date:       brtDateStr(),
        dailyPct:   targetMetrics.dailyPct,
        dailyPnl:   targetMetrics.dailyPnl,
        dailyMet:   true,
        weeklyPct:  targetMetrics.weeklyPct,
        weeklyPnl:  targetMetrics.weeklyPnl,
        weeklyMet:  targetMetrics.weeklyMet,
        weekMonday: brtWeekMondayStr(),
      }).catch(() => {/* falha silenciosa */})
    }
    prevDailyMetRef.current = targetMetrics.dailyMet
  }, [targetMetrics.dailyMet, balanceLoaded])

  useEffect(() => {
    if (!balanceLoaded) return
    if (targetMetrics.weeklyMet && !prevWeeklyMetRef.current) {
      setOverlayWeeklyData({ pct: targetMetrics.weeklyPct, pnl: targetMetrics.weeklyPnl, weeklyPct: targetMetrics.weeklyPct, weeklyPnl: targetMetrics.weeklyPnl })
      setShowWeeklyOverlay(true)
      upsertDailyGoal({
        date:       brtDateStr(),
        dailyPct:   targetMetrics.dailyPct,
        dailyPnl:   targetMetrics.dailyPnl,
        dailyMet:   targetMetrics.dailyMet,
        weeklyPct:  targetMetrics.weeklyPct,
        weeklyPnl:  targetMetrics.weeklyPnl,
        weeklyMet:  true,
        weekMonday: brtWeekMondayStr(),
      }).catch(() => {/* falha silenciosa */})
    }
    prevWeeklyMetRef.current = targetMetrics.weeklyMet
  }, [targetMetrics.weeklyMet, balanceLoaded])

  // Inicializa altura do gráfico e detecta desktop
  useEffect(() => {
    setIsDesktop(window.innerWidth >= 768)
    try {
      const saved = parseInt(localStorage.getItem('mesa_chart_h') || '', 10)
      if (saved >= 200 && saved <= 1400) { setChartH(saved); chartHRef.current = saved }
    } catch {}
  }, [])

  // Arrasto da borda inferior do gráfico para redimensionar (desktop)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = chartHRef.current
    document.body.style.cursor    = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const newH = Math.max(200, Math.min(window.innerHeight - 200, startH + ev.clientY - startY))
      setChartH(newH)
    }
    const onUp = () => {
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      try { localStorage.setItem('mesa_chart_h', String(chartHRef.current)) } catch {}
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  // Arrasto da borda inferior da toolbar interna — arrastar ↑ colapsa, arrastar ↓ restaura
  const handleToolbarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    // Mede a altura real atual da toolbar no DOM para o drag ser preciso
    const naturalH = toolbarElRef.current?.getBoundingClientRect().height ?? toolbarHRef.current
    toolbarHRef.current = naturalH
    document.body.style.cursor    = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      // arrastar ↑ = clientY diminui = delta negativo → toolbarH diminui (colapsa)
      const newH = Math.max(0, Math.min(120, naturalH + ev.clientY - startY))
      setToolbarH(newH < 16 ? 0 : newH)
    }
    const onUp = () => {
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      // snap: se ficou no meio, colapsa (0) ou restaura (null = altura natural auto)
      setToolbarH(prev => (prev !== null && prev < naturalH / 2) ? 0 : null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  // Salva um LoadResult no histórico de CSVs (localStorage, máx MAX_CSV_HISTORY)
  const saveToHistory = useCallback((result: LoadResult) => {
    const entry: CsvHistoryEntry = {
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filename:  result.filename,
      dateFrom:  result.dateFrom,
      dateTo:    result.dateTo,
      timeframe: result.timeframe,
      count:     result.count,
      loadedAt:  Date.now(),
      candles:   result.candles,
    }
    setCsvHistory(prev => {
      // Evita duplicatas pelo mesmo filename+período
      const filtered = prev.filter(h => !(h.filename === entry.filename && h.dateFrom === entry.dateFrom && h.dateTo === entry.dateTo))
      const next = [entry, ...filtered].slice(0, MAX_CSV_HISTORY)
      try { localStorage.setItem(CSV_HISTORY_KEY, JSON.stringify(next)) } catch {}
      return next
    })
    setActiveCsvId(entry.id)
    return entry.id
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setCsvError(null)

    // Lê todos os arquivos em paralelo e mescla os candles
    Promise.all(
      files.map(f => new Promise<{ text: string; name: string }>((res, rej) => {
        const r = new FileReader()
        r.onload  = ev => res({ text: ev.target?.result as string, name: f.name })
        r.onerror = () => rej(new Error(`Erro ao ler ${f.name}`))
        r.readAsText(f, 'utf-8')
      }))
    ).then(results => {
      try {
        let result: LoadResult
        if (results.length === 1) {
          result = parseCSV(results[0].text, results[0].name)
        } else {
          // Múltiplos arquivos — mescla e ordena por tempo
          const allCandles = results.flatMap(r => {
            try { return parseCSV(r.text, r.name).candles } catch { return [] }
          })
          allCandles.sort((a, b) => a.time - b.time)
          const deduped = allCandles.filter((c, i) => i === 0 || c.time !== allCandles[i - 1].time)
          if (deduped.length === 0) throw new Error('Nenhum candle válido nos arquivos selecionados')
          result = {
            candles:   deduped,
            filename:  results.map(r => r.name).join(', '),
            dateFrom:  fmtDate(deduped[0].time),
            dateTo:    fmtDate(deduped[deduped.length - 1].time),
            timeframe: detectTimeframe(deduped),
            count:     deduped.length,
          }
        }
        setCsvData(result)
        saveToHistory(result)
        setTrades([])
      } catch (err: any) {
        setCsvError(err?.message ?? 'Erro desconhecido')
        setCsvData(null)
      }
    }).catch((err: any) => {
      setCsvError(err?.message ?? 'Erro ao ler arquivos')
    })
    e.target.value = ''
  }, [saveToHistory])

  const clearCSV = useCallback(() => {
    setCsvData(null); setCsvError(null); setTrades([]); setActiveCsvId(null)
  }, [])

  // Restaura um CSV do histórico sem precisar recarregar o arquivo
  const loadFromHistory = useCallback((entry: CsvHistoryEntry) => {
    setCsvData({
      candles:   entry.candles,
      filename:  entry.filename,
      dateFrom:  entry.dateFrom,
      dateTo:    entry.dateTo,
      timeframe: entry.timeframe,
      count:     entry.count,
    })
    setCsvError(null)
    setTrades([])
    setActiveCsvId(entry.id)
    setHistoryOpen(false)
  }, [])

  // Remove uma entrada do histórico
  const deleteFromHistory = useCallback((id: string) => {
    setCsvHistory(prev => {
      const next = prev.filter(h => h.id !== id)
      try { localStorage.setItem(CSV_HISTORY_KEY, JSON.stringify(next)) } catch {}
      return next
    })
    if (activeCsvId === id) { setCsvData(null); setCsvError(null); setTrades([]); setActiveCsvId(null) }
  }, [activeCsvId])

  // Carrega trades: localStorage primeiro (imediato) depois Supabase sobrescreve
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) setTrades(parsed)
      }
    } catch {}
    // Supabase é fonte de verdade
    fetchTrades()
      .then(data => {
        if (data.length > 0) {
          setTrades(data as any)
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch {}
        }
      })
      .catch(() => {})
    // Verifica quantos candles existem no Supabase
    countCandles().then(n => setSbCandleCount(n)).catch(() => {})
  }, [])

  // Salva trades no localStorage sempre que mudam
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)) } catch {}
  }, [trades])

  // Carrega 100 candles ao vivo via MetaAPI — simples e direto
  const loadCandlesFromMetaAPI = useCallback(async () => {
    // Opção A: bloqueia com mensagem amigável se MetaAPI global estiver desligado
    try {
      if (localStorage.getItem('rafi_mapi_active') === 'false') {
        setMetaError('MetaAPI desligado — use o toggle ao lado para ligar e conectar ao vivo')
        return
      }
    } catch {}
    setMetaLoading(true)
    setMetaError(null)
    setMetaElapsed(0)

    const steps = [
      'Conectando ao MetaAPI...',
      'Autenticando token...',
      'Abrindo canal WebSocket com Pepperstone...',
      'Aguardando MT5 responder (pode levar até 30s)...',
      'Baixando candles EURUSD...',
      'Processando dados...',
    ]
    let stepIdx = 0
    setMetaStep(steps[0])

    let elapsed = 0
    metaTimerRef.current = setInterval(() => {
      elapsed += 1
      setMetaElapsed(elapsed)
      const next = Math.min(Math.floor(elapsed / 3), steps.length - 1)
      if (next !== stepIdx) { stepIdx = next; setMetaStep(steps[next]) }
    }, 1000)

    try {
      const res  = await fetch(`/api/metaapi/candles?symbol=EURUSD&timeframe=${tf}&limit=100`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `MetaAPI: ${res.status}`)
      const rows: CandleData[] = data.candles ?? data
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('Nenhum candle retornado')
      rows.sort((a, b) => a.time - b.time)
      const result: LoadResult = {
        candles:   rows,
        filename:  'MetaAPI · ao vivo',
        dateFrom:  fmtDate(rows[0].time),
        dateTo:    fmtDate(rows[rows.length - 1].time),
        timeframe: detectTimeframe(rows),
        count:     rows.length,
      }
      setCsvData(result)
      setCsvError(null)
      setMetaConnected(true)
      saveToHistory(result)
    } catch (err: any) {
      const raw = err?.message ?? 'Erro MetaAPI'
      const friendly = /timeout|aborted|não respondeu/i.test(raw)
        ? 'MT5 ainda conectando — aguarde 30s e tente novamente'
        : raw
      setMetaError(friendly)
      setMetaConnected(false)
    } finally {
      if (metaTimerRef.current) clearInterval(metaTimerRef.current)
      setMetaLoading(false)
      setMetaStep('')
    }
  }, [tf, saveToHistory])

  // Opção B: toggle MetaAPI global — sincronizado com Corretoras via localStorage
  const toggleGlobalMapi = useCallback(async () => {
    const novoEstado = !globalMapiActive
    setGlobalMapiStatus('loading')
    try { localStorage.setItem('rafi_mapi_active', String(novoEstado)) } catch {}
    setGlobalMapiActive(novoEstado)
    await fetch(`/api/metaapi/${novoEstado ? 'deploy' : 'undeploy'}`, { method: 'POST' })
    setGlobalMapiStatus('idle')
    if (novoEstado) {
      try { localStorage.setItem(META_AUTO_KEY, 'true') } catch {}
      setTimeout(() => loadCandlesFromMetaAPI(), 5_000) // aguarda ~5s para conta conectar
    } else {
      try { localStorage.setItem(META_AUTO_KEY, 'false') } catch {}
      setMetaConnected(false)
      setCsvData(null)
    }
  }, [globalMapiActive, loadCandlesFromMetaAPI])

  // Lê estado global do MetaAPI do localStorage ao montar
  useEffect(() => {
    try {
      const saved = localStorage.getItem('rafi_mapi_active')
      if (saved !== null) setGlobalMapiActive(saved === 'true')
    } catch {}
  }, [])

  // true quando o bridge está rodando e Realtime já entregou dados → polling não sobrescreve
  const supaRtActiveRef = useRef(false)

  // Mapeia rows do rafi_positions → formato allBrokerPositions esperado pelo painel
  const buildAllBrokerPositions = useCallback((rows: any[]) => {
    const byBroker: Record<string, any[]> = {}
    for (const r of rows) {
      if (!byBroker[r.broker_id]) byBroker[r.broker_id] = []
      byBroker[r.broker_id].push(r)
    }
    const groups = enabledBrokers.map((b, idx) => {
      const bRows = byBroker[b.id] ?? []
      const positions = bRows.map((r: any) => ({
        id:           r.id,
        symbol:       r.symbol,
        type:         r.type,
        volume:       r.volume,
        openPrice:    r.open_price,
        currentPrice: r.current_price ?? r.open_price,
        profit:       r.profit        ?? 0,
        commission:   r.commission    ?? 0,
        swap:         r.swap          ?? 0,
        netPnl:       (r.profit ?? 0) + (r.commission ?? 0) + (r.swap ?? 0),
        stopLoss:     r.raw?.stopLoss  ?? 0,
        takeProfit:   r.raw?.takeProfit ?? 0,
        openTime:     r.opened_at,
      }))
      const totalPnl    = positions.reduce((s, p) => s + p.profit,             0)
      const totalNetPnl = positions.reduce((s, p) => s + (p.netPnl ?? p.profit), 0)
      const firstSymbol = positions[0]?.symbol ?? 'EURUSD'
      return { rank: idx + 1, brokerId: b.id, nome: b.nome, symbol: firstSymbol, positions, totalPnl, totalNetPnl }
    })
    setAllBrokerPositions(groups)
  }, [enabledBrokers])

  // Features 1, 2, 5: busca saldo + posições abertas (todas as corretoras), detecta atividade do bot
  const fetchLiveData = useCallback(async () => {
    try {
      const [accRes, posRes, allPosRes] = await Promise.allSettled([
        fetch('/api/metaapi/account'),
        fetch('/api/metaapi/positions'),
        fetch('/api/metaapi/all-positions'),
      ])
      if (accRes.status === 'fulfilled' && accRes.value.ok) {
        const acc = await accRes.value.json()
        if (!acc.error) setMetaAccount(acc)
      }
      if (posRes.status === 'fulfilled' && posRes.value.ok) {
        const data = await posRes.value.json()
        const newPos = data.positions ?? []
        setMetaPositions(prev => {
          const opened = newPos.filter((p: any) => !prev.find(pp => pp.id === p.id))
          const closed  = prev.filter(p => !newPos.find((pp: any) => pp.id === p.id))
          if (opened.length || closed.length) {
            setBotAlerts(a => [
              ...opened.map((p: any) => ({
                id:   `open-${p.id}-${Date.now()}`,
                kind: 'open' as const,
                text: `${p.type === 'POSITION_TYPE_BUY' ? '▲' : '▼'} ${p.symbol} ${p.volume}L @ ${p.openPrice}`,
              })),
              ...closed.map(p => ({
                id:   `close-${p.id}-${Date.now()}`,
                kind: 'close' as const,
                text: `Fechada · ${p.symbol} · ${p.profit >= 0 ? '+' : ''}$${p.profit.toFixed(2)}`,
              })),
              ...a,
            ].slice(0, 4))
            // Posição fechada: refaz poll a 1s, 3s e 6s para garantir que desaparece do painel
            if (closed.length > 0) {
              setTimeout(() => fetchLiveData(),            1_000)
              setTimeout(() => fetchLiveData(),            3_000)
              setTimeout(() => fetchHistory(historyPeriod), 6_000)
            }
          }
          prevPositionsRef.current = newPos
          return newPos
        })
      }
      // Atualiza posições multi-corretora sempre via REST — não depende do bridge Supabase
      // O Realtime do bridge ainda funciona como suplemento rápido quando ativo
      if (allPosRes.status === 'fulfilled' && allPosRes.value.ok) {
        const data = await allPosRes.value.json()
        setAllBrokerPositions(data.brokers ?? [])
      }
    } catch {}
  }, [])

  // Histórico: busca trades fechados pelo período e corretora selecionados.
  // Prioridade:
  //   MetaAPI ON  → MetaAPI REST (fonte completa e autoritativa)
  //   MetaAPI OFF → Supabase /api/deals (bridge, ignora RLS)
  const fetchHistory = useCallback(async (period = '7d', broker = '') => {
    setHistoryLoading(true)

    const todayBRT  = brtDateStr()
    const toBrtDate = (iso: string) =>
      new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // Busca MetaAPI e Supabase em paralelo — mescla para não perder deals
    const restPeriod = period === 'today' ? '7d' : period
    const metaParams = new URLSearchParams({ period: restPeriod })
    if (broker) { metaParams.set('broker', broker) } else { metaParams.set('all', 'true') }
    const dealsParams = new URLSearchParams({ period })
    if (broker) dealsParams.set('broker', broker)

    const [metaResult, supaResult] = await Promise.allSettled([
      metaConnected
        ? fetch(`/api/metaapi/history?${metaParams}`).then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null),
      fetch(`/api/deals?${dealsParams}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ])

    const metaData = metaResult.status === 'fulfilled' ? metaResult.value : null
    const supaData = supaResult.status === 'fulfilled' ? supaResult.value : null

    // ── Processa MetaAPI ──────────────────────────────────────────────────────
    let metaTrades: typeof metaHistory = metaData && !metaData.error ? (metaData.history ?? []) : []
    let metaGroupsRaw: typeof historyGroups | undefined =
      metaData && !metaData.error ? metaData.groups : undefined

    if (period === 'today') {
      metaTrades = metaTrades.filter(t => toBrtDate(t.time ?? '') === todayBRT)
      if (metaGroupsRaw) {
        metaGroupsRaw = metaGroupsRaw.map(g => ({
          ...g,
          trades: g.trades.filter(t => toBrtDate(t.time ?? '') === todayBRT),
        }))
      }
    }

    // ── Processa Supabase ─────────────────────────────────────────────────────
    const rawDeals: any[] = supaData?.deals ?? []
    const entryByPos: Record<string, number> = {}
    rawDeals
      .filter((d: any) => d.entry_type === 'DEAL_ENTRY_IN' && d.price && d.position_id)
      .forEach((d: any) => { entryByPos[d.position_id] = d.price })

    // brokerId auxiliar mantido em campo separado para agrupamento
    const supaTradesAnnotated: Array<typeof metaHistory[0] & { _brokerId: string }> = rawDeals
      .filter((d: any) =>
        d.entry_type === 'DEAL_ENTRY_OUT' &&
        (d.deal_type === 'DEAL_TYPE_BUY' || d.deal_type === 'DEAL_TYPE_SELL'),
      )
      .map((d: any) => ({
        id:         d.id as string,
        symbol:     d.symbol as string,
        type:       d.deal_type as string,
        direction:  (d.direction ?? (d.deal_type === 'DEAL_TYPE_SELL' ? 'buy' : 'sell')) as 'buy' | 'sell',
        volume:     d.volume as number,
        price:      d.price as number,
        entryPrice: (entryByPos[d.position_id] ?? null) as number | null,
        profit:     (d.profit ?? 0) as number,
        time:       typeof d.time === 'string' ? d.time as string : new Date(d.time).toISOString(),
        comment:    (d.comment ?? '') as string,
        positionId: (d.position_id ?? null) as string | null,
        _brokerId:  d.broker_id as string,
      }))

    // ── Mescla: MetaAPI é base; Supabase preenche deals ausentes ─────────────
    const seenIds = new Set(metaTrades.map(t => t.id))
    const supaOnlyAnnotated = supaTradesAnnotated.filter(t => !seenIds.has(t.id))

    // Remove campo auxiliar antes de persistir no estado
    const stripBid = ({ _brokerId: _, ...t }: typeof supaOnlyAnnotated[0]) => t
    const supaOnly = supaOnlyAnnotated.map(stripBid)
    const merged   = [...metaTrades, ...supaOnly]

    if (merged.length === 0) {
      setMetaHistory([])
      if (metaGroupsRaw) setHistoryGroups(metaGroupsRaw)
      setHistoryLoading(false)
      return
    }

    setMetaHistory(merged)

    // ── Reconstrói grupos com os deals extras do Supabase ────────────────────
    if (metaGroupsRaw) {
      // Tem grupos do MetaAPI — insere supaOnly no grupo correto
      const groupMap: Record<string, typeof metaGroupsRaw[0]> = {}
      for (const g of metaGroupsRaw) groupMap[g.brokerId] = { ...g, trades: [...g.trades] }

      for (let i = 0; i < supaOnlyAnnotated.length; i++) {
        const bid = supaOnlyAnnotated[i]._brokerId
        if (!bid) continue
        if (!groupMap[bid]) {
          const nome = enabledBrokers.find(b => b.id === bid)?.nome ?? bid
          groupMap[bid] = { rank: 99, brokerId: bid, nome, trades: [] }
        }
        groupMap[bid].trades.push(supaOnly[i])
      }

      setHistoryGroups(Object.values(groupMap).sort((a, b) => a.rank - b.rank))
    } else {
      // Sem grupos do MetaAPI — agrupa via broker_id do Supabase
      const brokerDeals: Record<string, typeof merged> = {}
      for (const trade of merged) {
        const raw = rawDeals.find((x: any) => x.id === trade.id)
        const bid = raw?.broker_id ?? broker ?? 'unknown'
        if (!brokerDeals[bid]) brokerDeals[bid] = []
        brokerDeals[bid].push(trade)
      }
      if (broker) {
        const nome = enabledBrokers.find(b => b.id === broker)?.nome ?? broker
        setHistoryGroups([{ rank: 0, brokerId: broker, nome, trades: merged }])
      } else {
        const groups = enabledBrokers.map((b, idx) => ({
          rank:     idx + 1,
          brokerId: b.id,
          nome:     b.nome,
          trades:   brokerDeals[b.id] ?? [],
        }))
        setHistoryGroups(groups)
      }
    }

    setHistoryLoading(false)
  }, [enabledBrokers, metaConnected])

  // Feature 2: fecha posição individual via MetaAPI
  const handleClosePosition = useCallback(async (positionId: string) => {
    // Busca símbolo e volume da posição para replicar o fechamento nas demais corretoras
    const pos = metaPositionsRef.current.find(p => p.id === positionId)
    try {
      const res = await fetch('/api/metaapi/positions', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ positionId, symbol: pos?.symbol, volume: pos?.volume }),
      })
      if (res.ok) {
        setMetaPositions(prev => prev.filter(p => p.id !== positionId))
      }
    } catch {}
  }, [])

  // Fecha todas as posições abertas de todas as corretoras de uma vez
  const handleCloseAll = useCallback(async () => {
    setClosingAll(true)
    const positions = [...metaPositionsRef.current]
    for (const pos of positions) {
      await handleClosePosition(pos.id)
    }
    setClosingAll(false)
    setCloseAllConfirm(false)
  }, [handleClosePosition])

  // Fecha todas as posições a partir do pop-up de meta ao vivo
  const handleLiveMetaCloseAll = useCallback(async () => {
    setLiveMetaClosing(true)
    const positions = [...metaPositionsRef.current]
    for (const pos of positions) {
      await handleClosePosition(pos.id)
    }
    setLiveMetaClosing(false)
    setLiveMetaClosed(true)
    setTimeout(() => setShowLiveMetaPopup(false), 3000)
  }, [handleClosePosition])

  // Modifica SL/TP de uma posição aberta via MetaAPI — replica para todas as corretoras ativas
  const handleModifyPosition = useCallback(async (positionId: string, sl: string, tp: string) => {
    const stopLoss   = parseFloat(sl)
    const takeProfit = parseFloat(tp)
    if (isNaN(stopLoss) || isNaN(takeProfit)) return

    // Busca símbolo e volume para localizar a posição nas corretoras secundárias
    const pos = metaPositionsRef.current.find(p => p.id === positionId)

    // Atualização otimista imediata — linha fica no lugar arrastado sem esperar API
    const snapshot = metaPositionsRef.current
    setMetaPositions(prev => prev.map(p =>
      p.id === positionId ? { ...p, stopLoss, takeProfit } : p,
    ))

    try {
      const res = await fetch('/api/metaapi/positions/modify', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ positionId, symbol: pos?.symbol, volume: pos?.volume, stopLoss, takeProfit }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        const count = (data.replication as Array<{ok:boolean}>)?.filter(r => r.ok).length ?? 1
        const sufixo = count > 1 ? ` em ${count} corretoras` : ''
        setOrderToast({ ok: true, msg: `SL/TP atualizados${sufixo} ✓` })
      } else {
        // Reverte para o valor anterior se a API rejeitou
        setMetaPositions(snapshot)
        setOrderToast({ ok: false, msg: data.error ?? 'Erro ao modificar posição' })
      }
    } catch {
      setMetaPositions(snapshot)
      setOrderToast({ ok: false, msg: 'Erro de conexão ao modificar posição' })
    }
    setEditingPos(null)
    setTimeout(() => setOrderToast(null), 4000)
  }, [])

  // Carrega candles do Supabase (tabela rafi_candles) — substitui CSV local
  const loadCandlesFromSupabase = useCallback(async () => {
    setSbLoading(true)
    try {
      const rows = await fetchCandles()
      if (rows.length === 0) { setSbLoading(false); return }
      const candles = rows as CandleData[]
      candles.sort((a, b) => a.time - b.time)
      const result: LoadResult = {
        candles,
        filename:  'Supabase · rafi_candles',
        dateFrom:  fmtDate(candles[0].time),
        dateTo:    fmtDate(candles[candles.length - 1].time),
        timeframe: detectTimeframe(candles),
        count:     candles.length,
      }
      setCsvData(result)
      setCsvError(null)
      saveToHistory(result)
    } catch (err: any) {
      setCsvError(err?.message ?? 'Erro ao carregar candles do Supabase')
    }
    setSbLoading(false)
  }, [saveToHistory])

  // Carrega histórico de CSVs do localStorage na inicialização
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CSV_HISTORY_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) setCsvHistory(parsed)
      }
    } catch {}
  }, [])

  // Auto-connect: reconecta MetaAPI se estava habilitado na sessão anterior
  useEffect(() => {
    try {
      if (localStorage.getItem(META_AUTO_KEY) === 'true') {
        loadCandlesFromMetaAPI()
      }
    } catch {}
    countCandles().then(n => setSbCandleCount(n)).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Roteamento: busca broker vencedor do ranking a cada 30s via /api/brokers/top
  // Usa a mesma lógica do servidor: P&L do dia → estado → health score → exec_score → priority
  useEffect(() => {
    const fetchRouting = async () => {
      try {
        // Busca lista completa para alimentar o seletor de histórico
        const listRes = await fetch('/api/brokers')
        const { brokers } = await listRes.json()
        const activeBrokers: any[] = Array.isArray(brokers)
          ? brokers.filter((b: any) => b.enabled && b.metaapi_account_id)
          : []
        if (activeBrokers.length) {
          setEnabledBrokers(activeBrokers.map((b: any) => ({ id: b.id, nome: b.nome ?? b.id })))
        }

        // Capital consolidado: busca saldo de cada corretora em paralelo e soma
        if (activeBrokers.length) {
          const balResults = await Promise.allSettled(
            activeBrokers.map((b: any) =>
              fetch(`/api/metaapi/account?accountId=${b.metaapi_account_id}`)
                .then(r => r.ok ? r.json() : null)
            )
          )
          const total = balResults.reduce((sum, r) => {
            if (r.status !== 'fulfilled' || !r.value || r.value.error) return sum
            return sum + (r.value.balance ?? 0)
          }, 0)
          if (total > 0) setConsolidatedBalance(total)
        }

        // Broker #1 real — inclui P&L do dia como critério primário
        const topRes = await fetch('/api/brokers/top')
        if (!topRes.ok) return
        const top = await topRes.json()
        if (!top?.id) return
        setRouteBroker({
          id:              top.id,
          nome:            top.nome ?? top.id,
          estado:          top.estado          ?? 'STANDBY',
          health_score:    top.health_score    ?? 0,
          circuit_breaker: top.circuit_breaker ?? 'CLOSED',
        })
      } catch { /* silencioso */ }
    }
    fetchRouting()
    const iv = setInterval(fetchRouting, 30_000)
    return () => clearInterval(iv)
  }, [])

  // Histórico: sempre carrega do Supabase (rafi_deals) — independente de MetaAPI estar conectado.
  // Quando MetaAPI está ON: Supabase primeiro (instantâneo via bridge), MetaAPI como fallback.
  // Quando MetaAPI está OFF: Supabase apenas — MetaAPI REST é ignorado no fetchHistory.
  useEffect(() => {
    fetchHistory(historyPeriod, historyBroker)
    const id = setInterval(() => fetchHistory(historyPeriod, historyBroker), 60_000)
    return () => clearInterval(id)
  }, [metaConnected, historyPeriod, historyBroker, fetchHistory])

  // Realtime Supabase: posições abertas + deals fechados (bridge em execução no VPS)
  // Quando o bridge não está rodando, este useEffect é no-op — o polling assume o controle.
  useEffect(() => {
    if (!metaConnected) return

    const supa = createSupabaseClient()

    // Carga inicial de posições abertas
    supa.from('rafi_positions').select('*').then(({ data }) => {
      if (!data?.length) return  // bridge não está rodando ainda
      supaRtActiveRef.current = true
      buildAllBrokerPositions(data)
    })

    // Realtime: qualquer mudança em rafi_positions → rebusca tudo
    const posChannel = supa
      .channel('rafi-positions-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rafi_positions' }, () => {
        supa.from('rafi_positions').select('*').then(({ data }) => {
          if (!data) return
          supaRtActiveRef.current = true
          buildAllBrokerPositions(data)
        })
      })
      .subscribe()

    // Realtime: novo deal fechado → atualiza histórico imediatamente
    const dealsChannel = supa
      .channel('rafi-deals-rt')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'rafi_deals', filter: 'entry_type=eq.DEAL_ENTRY_OUT' },
        () => { fetchHistory(historyPeriod, historyBroker) },
      )
      .subscribe()

    return () => {
      supaRtActiveRef.current = false
      supa.removeChannel(posChannel)
      supa.removeChannel(dealsChannel)
    }
  }, [metaConnected, buildAllBrokerPositions, fetchHistory, historyPeriod, historyBroker])

  // Features 1, 2, 5: poll saldo + posições quando MetaAPI ativo
  // Nos primeiros 30s após conectar faz poll a cada 2s (MetaAPI demora para ter stream pronto em todas as contas)
  // Depois disso cai para 5s normal
  useEffect(() => {
    if (!metaConnected) { setMetaAccount(null); setMetaPositions([]); setAllBrokerPositions([]); setBotAlerts([]); return }

    fetchLiveData()

    // Poll rápido inicial: 15 ciclos × 2s = 30s de aquecimento
    let normalIntervalId: ReturnType<typeof setInterval> | null = null
    let fastCount = 0
    const fastId = setInterval(() => {
      fetchLiveData()
      fastCount++
      if (fastCount >= 15) {
        clearInterval(fastId)
        // Após aquecimento, continua com poll normal de 3s
        normalIntervalId = setInterval(fetchLiveData, 3_000)
      }
    }, 2_000)

    return () => {
      clearInterval(fastId)
      if (normalIntervalId) clearInterval(normalIntervalId)
    }
  }, [metaConnected, fetchLiveData])



  // Tick ao vivo via polling: cada request é curto (~300ms), evita timeout do Vercel Edge (25s)
  useEffect(() => {
    if (!metaConnected) { setLivePrice(null); return }

    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastBid = 0
    let lastAsk = 0

    const poll = async () => {
      if (!active) return
      try {
        const res = await fetch('/api/metaapi/price?symbol=EURUSD')
        if (active && res.ok) {
          const data = await res.json()
          if (data.bid && data.ask && (data.bid !== lastBid || data.ask !== lastAsk)) {
            lastBid = data.bid
            lastAsk = data.ask
            const mid = (data.bid + data.ask) / 2
            chartUpdateCandleRef.current?.(mid) // direto ao gráfico, sem React
            livePriceRef.current = mid
            setLivePrice(mid)                   // estado para P&L
          }
        }
      } catch {}
      if (active) timer = setTimeout(poll, 300)
    }

    poll()

    return () => {
      active = false
      if (timer) clearTimeout(timer)
      setLivePrice(null)
    }
  }, [metaConnected])

  // Feature 4: countdown de auto-refresh dos candles baseado no timeframe
  useEffect(() => {
    if (!metaConnected) { setRefreshIn(0); return }
    const mins = tf === 'M5' ? 5 : tf === 'M15' ? 15 : 60
    let secs = mins * 60
    setRefreshIn(secs)
    const id = setInterval(() => {
      secs -= 1
      setRefreshIn(secs)
      if (secs <= 0) { secs = mins * 60; setRefreshIn(secs); loadCandlesFromMetaAPI() }
    }, 1_000)
    return () => clearInterval(id)
  }, [metaConnected, tf, loadCandlesFromMetaAPI])

  // Countdown regressivo até o fechamento do candle atual: tfSec - (now % tfSec)
  // Ancorado no relógio UTC, não no timestamp do último candle recebido (que já está fechado)
  useEffect(() => {
    const tfSec = tf === 'M5' ? 300 : tf === 'M15' ? 900 : 3600
    const tick = () => {
      const nowSec = Math.floor(Date.now() / 1000)
      setCandleCountdown(tfSec - (nowSec % tfSec))
    }
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [tf])

  // Fecha o painel de histórico ao clicar fora
  useEffect(() => {
    if (!historyOpen) return
    const handler = (e: MouseEvent) => {
      if (historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [historyOpen])

  const candles  = useMemo(
    () => csvData?.candles ?? generateDemoData(tf),
    [csvData, tf],
  )
  const rafiData = useMemo(() => calcRAFI(candles),           [candles])
  const srLevels = useMemo(() => calcSRLevels(candles),       [candles])
  const bbBands  = useMemo(() => calcBollingerBands(candles), [candles])

  const lastCandle = candles[candles.length - 1]
  const lastPrice  = lastCandle?.close ?? 0
  const lastTime   = lastCandle?.time  ?? 0
  // Contagem total de posições em todas as corretoras (para badge)
  const totalPositionCount = useMemo(
    () => allBrokerPositions.reduce((s, b) => s + b.positions.length, 0),
    [allBrokerPositions],
  )
  // P&L flutuante calculado tick a tick para TODAS as corretoras
  // livePrice atualiza a ~300ms, evitando o atraso do poll de 5s
  const liveBrokerPositions = useMemo(() => {
    return allBrokerPositions.map(broker => {
      const positions = broker.positions.map(p => {
        let profit = p.profit
        if (livePrice !== null && /eurusd/i.test(p.symbol)) {
          const dir = /buy/i.test(p.type) ? 1 : -1
          profit = Math.round((livePrice - p.openPrice) * dir * p.volume * 100000 * 100) / 100
        }
        const netPnl = Math.round((profit + (p.commission ?? 0) + (p.swap ?? 0)) * 100) / 100
        return { ...p, profit, netPnl }
      })
      const totalPnl    = Math.round(positions.reduce((s, p) => s + p.profit, 0) * 100) / 100
      const totalNetPnl = Math.round(positions.reduce((s, p) => s + (p.netPnl ?? p.profit), 0) * 100) / 100
      return { ...broker, positions, totalPnl, totalNetPnl }
    })
  }, [allBrokerPositions, livePrice])

  const liveTotalPnl = useMemo(
    () => liveBrokerPositions.reduce((s, b) => s + (b.totalNetPnl ?? b.totalPnl), 0),
    [liveBrokerPositions],
  )

  // P&L dos trades FECHADOS hoje por corretora — complementa o flutuante ao vivo
  const closedPnlTodayByBroker = useMemo(() => {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const todayTs = todayStart.getTime()
    const map: Record<string, number> = {}
    historyGroups.forEach(g => {
      map[g.brokerId] = g.trades
        .filter(t => new Date(t.time).getTime() >= todayTs)
        .reduce((s, t) => s + (t.profit ?? 0), 0)
    })
    return map
  }, [historyGroups])

  // Ranking ao vivo: reordena corretoras pelo P&L TOTAL = fechado hoje + flutuante agora
  // Quando há posições abertas, quem está ganhando mais sobe para #1 instantaneamente
  const liveRankedBrokers = useMemo(() => {
    const hasPositions = liveBrokerPositions.some(b => b.positions.length > 0)
    if (!hasPositions) return liveBrokerPositions
    return [...liveBrokerPositions]
      .sort((a, b) => {
        const totalA = (closedPnlTodayByBroker[a.brokerId] ?? 0) + (a.totalNetPnl ?? a.totalPnl)
        const totalB = (closedPnlTodayByBroker[b.brokerId] ?? 0) + (b.totalNetPnl ?? b.totalPnl)
        return totalB - totalA
      })
      .map((b, i) => ({ ...b, rank: i + 1 }))
  }, [liveBrokerPositions, closedPnlTodayByBroker])

  // ID e nome do broker #1 ao vivo — primitivos para evitar re-renders desnecessários
  const liveTopBrokerId   = useMemo(() =>
    liveRankedBrokers.some(b => b.positions.length > 0) ? (liveRankedBrokers[0]?.brokerId ?? null) : null,
    [liveRankedBrokers],
  )
  const liveTopBrokerNome = useMemo(() =>
    liveRankedBrokers.some(b => b.positions.length > 0) ? (liveRankedBrokers[0]?.nome ?? null) : null,
    [liveRankedBrokers],
  )

  // Lista plana de posições com P&L ao vivo — usada pelos painéis cross-broker
  const flatBrokerPositions = useMemo(
    () => liveRankedBrokers.flatMap(b =>
      b.positions.map(p => ({ ...p, brokerId: b.brokerId, brokerNome: b.nome, rank: b.rank }))
    ),
    [liveRankedBrokers],
  )

  // Atualiza "ORDEM VAI PARA" em tempo real quando o broker #1 muda ao vivo
  // Só dispara quando o ID do líder troca — não a cada tick de preço
  useEffect(() => {
    if (!liveTopBrokerId || !liveTopBrokerNome) return
    setRouteBroker(prev => {
      if (!prev || prev.id === liveTopBrokerId) return prev
      return { ...prev, id: liveTopBrokerId, nome: liveTopBrokerNome }
    })
  }, [liveTopBrokerId, liveTopBrokerNome])

  // P&L diário em tempo real = fechados hoje + flutuante das posições abertas
  // Atualiza a cada tick de preço (~300ms) — usado na barra "Dia %" para mostrar progresso real
  const liveDailyPnl = targetMetrics.dailyPnl + liveTotalPnl
  const liveDailyPct = useMemo(() => {
    const bal = consolidatedBalance ?? metaAccount?.balance ?? 100
    const startBal = Math.max(bal - targetMetrics.dailyPnl, 1)
    return (liveDailyPnl / startBal) * 100
  }, [liveDailyPnl, consolidatedBalance, metaAccount, targetMetrics.dailyPnl])

  // Pop-up ao vivo: dispara quando liveDailyPct bate a meta E há posição aberta
  // Aparece apenas uma vez por dia (localStorage) e só com saldo carregado
  useEffect(() => {
    if (!balanceLoaded) return
    if (prevLiveMetaFiredRef.current) return
    if (liveDailyPct < DAILY_TARGET) return
    if (totalPositionCount <= 0) return  // só faz sentido com posição aberta
    const today = brtDateStr()
    try { if (localStorage.getItem(`rafi-live-meta-${today}`) === 'true') return } catch {}
    prevLiveMetaFiredRef.current = true
    try { localStorage.setItem(`rafi-live-meta-${today}`, 'true') } catch {}
    const bal = consolidatedBalance ?? metaAccount?.balance ?? 100
    setLiveMetaSnapshot({ pct: liveDailyPct, pnl: liveDailyPnl, bal })
    setLiveMetaClosing(false)
    setLiveMetaClosed(false)
    setShowLiveMetaPopup(true)
    setShowCheckin(false)
  }, [liveDailyPct, totalPositionCount, balanceLoaded])

  // Equity ao vivo: saldo fixo + P&L calculado tick a tick via preço SSE
  // Evita o atraso do poll de 5s — exibe o capital total em tempo real
  const liveEquity = useMemo(() => {
    if (!metaAccount) return null
    if (metaPositions.length === 0 || livePrice === null) return metaAccount.balance
    const floating = metaPositions.reduce((sum, pos) => {
      if (/eurusd/i.test(pos.symbol)) {
        const dir = /buy/i.test(pos.type) ? 1 : -1
        return sum + (livePrice - pos.openPrice) * dir * pos.volume * 100000
      }
      return sum + (pos.profit ?? 0)  // posições não-EURUSD: usa último valor conhecido
    }, 0)
    return metaAccount.balance + floating
  }, [metaAccount, metaPositions, livePrice])

  // Valor atual do RAFI (último candle) — passado para o CO-PILOTO IA
  const currentRafiValue = useMemo(() => {
    const last = rafiData[rafiData.length - 1]
    return last?.value ?? null
  }, [rafiData])

  // BB expandindo? Compara os 2 últimos widths
  const currentBbExpanding = useMemo(() => {
    const upper = bbBands?.upper
    const lower = bbBands?.lower
    if (!upper || !lower || upper.length < 2 || lower.length < 2) return null
    const w1 = (upper[upper.length - 2]?.value ?? 0) - (lower[lower.length - 2]?.value ?? 0)
    const w2 = (upper[upper.length - 1]?.value ?? 0) - (lower[lower.length - 1]?.value ?? 0)
    return w2 > w1
  }, [bbBands])

  // RAFI sempre positivo: separa por dir do candle
  const strongBullBars = rafiData.filter(p => p.value >= 2.5).length
  const strongBearBars = rafiData.filter(p => p.value <= -2.5).length

  // Capital atual = base + P&L dos trades rotulados → determina lote pela tabela
  const currentCapital = useMemo(() => calcCapital(trades, BASE_CAPITAL), [trades])
  const currentLot     = useMemo(() => getLotForCapital(currentCapital),   [currentCapital])
  const nextTier       = useMemo(() => getNextTier(currentCapital),        [currentCapital])

  // Inicializa/reseta OCO quando o timeframe ou o lote calculado muda
  useEffect(() => {
    if (lastPrice > 0) {
      setOcoState(makeOCO(lastPrice, currentLot))
      setOcoVisible(true)
    }
  }, [lastPrice, currentLot])

  // Auto-muda para Navegar quando há posição aberta — overlay OCO atrapalha a visão
  // O usuário pode voltar para OCO manualmente a qualquer momento
  useEffect(() => {
    if (metaPositions.length > 0) setPanMode(true)
  }, [metaPositions.length])

  // Ao conectar MetaAPI, reseta OCO com preço ao vivo real (evita SL/TP da demo serem enviados)
  // Aguarda 1s para o SSE inicializar e livePriceRef ter o preço atual
  useEffect(() => {
    if (!metaConnected) return
    const timer = setTimeout(() => {
      const price = livePriceRef.current ?? lastPrice
      if (price > 0) {
        setOcoState(makeOCO(price, currentLot))
        setClickedEntry(null)
        setClickedTime(undefined)
      }
    }, 1000)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaConnected])

  const handleAdd = useCallback((t: ManualTrade) => {
    // Injeta estado mental do check-in para cruzamento posterior com resultado
    const tradeWithCheckin: ManualTrade = checkin ? {
      ...t,
      checkinId:      checkin.id      ?? null,
      checkinSono:    checkin.sono,
      checkinEnergia: checkin.energia,
      checkinMental:  checkin.mental,
      checkinHumor:   checkin.humor,
    } : t
    setTrades(p => [...p, tradeWithCheckin])
    upsertTrade(tradeWithCheckin as any).catch((err) => console.error('[Supabase] upsertTrade:', err))
  }, [checkin])
  const handleRemove = useCallback((id: string)     => setTrades(p => p.filter(t => t.id !== id)), [])
  const handleUpdate = useCallback((id: string, updates: Partial<ManualTrade>) =>
    setTrades(p => p.map(t => t.id === id ? { ...t, ...updates } : t)), [])

  // Executa OCO — captura features RAFI + BB para dataset ML
  const handleOCOExecute = useCallback((direction: 'buy' | 'sell') => {
    if (!ocoState) return
    const { entry } = ocoState
    const tpDist = Math.abs(ocoState.tp - entry)
    const slDist = Math.abs(ocoState.sl - entry)
    // BUY: TP acima, SL abaixo | SELL: TP abaixo, SL acima
    const tp = direction === 'buy' ? entry + tpDist : entry - tpDist
    const sl = direction === 'buy' ? entry - slDist : entry + slDist
    const p  = (v: number) => Math.round(v * 100000) / 100000

    // Features do momento para treinamento ML
    const lastRafi  = rafiData[rafiData.length - 1]
    const lastUpper = bbBands?.upper[bbBands.upper.length - 1]?.value
    const lastLower = bbBands?.lower[bbBands.lower.length - 1]?.value
    const bbWidth   = lastUpper !== undefined && lastLower !== undefined
      ? lastUpper - lastLower : undefined

    const entryTs  = ocoState.entryTime ?? lastTime
    const sesCtx   = getOverlapContext(entryTs)

    handleAdd({
      id:           `${Date.now()}-oco-${Math.random().toString(36).slice(2, 5)}`,
      direction,
      entry:        p(entry),
      stopLoss:     p(sl),
      takeProfit:   p(tp),
      label:        `OCO ${direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'} @ ${formatPrice(entry)} | ${ocoState.lot.toFixed(2)}L`,
      time:         entryTs,
      lot:          ocoState.lot,
      leverage:     ocoState.leverage,
      result:       'pending',
      rafi:         lastRafi?.value,
      rafiDir:      lastRafi?.dir,
      bbWidth,
      snapshot:     snapshotCaptureRef.current?.(entryTs, { entry: p(entry), sl: p(sl), tp: p(tp), direction }) ?? undefined,
      // Contexto de sessão para aprendizado da IA
      overlapPhase:  sesCtx.overlapPhase,
      sessionMinute: sesCtx.sessionMinute,
      dayOfWeek:     sesCtx.dayOfWeek,
      entryType:    'manual',
    })
    setOcoState(prev => prev ? { ...prev, direction, tp: p(tp), sl: p(sl) } : null)
    // Muda para Navegar imediatamente após disparar — limpa o gráfico para acompanhar a posição
    setPanMode(true)

    // Feature 3: envia para MetaAPI e mostra toast de feedback
    fetch('/api/metaapi/order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:     'EURUSD',
        actionType: direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
        volume:     ocoState.lot,
        stopLoss:   p(sl),
        takeProfit: p(tp),
      }),
    })
      .then(async res => {
        if (res.ok) {
          const result = await res.json().catch(() => ({}))
          const tipo = direction === 'buy' ? 'COMPRA' : 'VENDA'
          const nomeP = routeBroker?.nome ?? result.broker ?? 'Exness'
          const replicadas = (result.replication as Array<{ok:boolean}>)?.filter(r => r.ok).length ?? 1
          const sufixo = replicadas > 1 ? ` · replicada em ${replicadas} corretoras` : ''
          setOrderToast({ ok: true, msg: `Ordem ${tipo} enviada para ${nomeP}${sufixo} ✓` })
          setTimeout(() => fetchLiveData(), 3000)
        } else {
          const err = await res.json().catch(() => ({}))
          const nomeP = routeBroker?.nome ?? 'Corretora'
          setOrderToast({ ok: false, msg: `${nomeP} rejeitou: ${err?.error ?? res.status}` })
        }
        setTimeout(() => setOrderToast(null), 6000)
      })
      .catch(err => {
        setOrderToast({ ok: false, msg: err.message ?? 'Falha de rede ao enviar ordem' })
        setTimeout(() => setOrderToast(null), 6000)
      })
  }, [ocoState, lastTime, rafiData, bbBands, handleAdd])

  const handleOCOClose = useCallback(() => setOcoVisible(false), [])

  // Auto-scan: detecta rompimentos, avalia WIN/LOSS nos candles seguintes e compõe lote
  const handleAutoScan = useCallback(() => {
    // Sempre escaneia em M5 quando não há CSV — evita resultado errado ao trocar timeframe
    const scanCandles = csvData?.candles ?? generateDemoData('M5')
    if (!csvData && tf !== 'M5') setTf('M5')

    // Remove scans anteriores para evitar acumulação ao re-escanear
    setTrades(prev => prev.filter(t => !t.id.includes('-scan-')))

    const found = autoScanBreakouts(scanCandles)
    if (found.length === 0) return

    let capital = BASE_CAPITAL  // compõe capital trade a trade

    found.forEach(scan => {
      const lot = getLotForCapital(capital)

      // Avalia resultado: verifica qual foi atingido primeiro — TP ou SL
      const entryIdx = scanCandles.findIndex(c => c.time === scan.time)
      let result: 'win' | 'loss' | 'pending' = 'pending'
      for (let j = entryIdx + 1; j < scanCandles.length; j++) {
        const c = scanCandles[j]
        if (scan.direction === 'buy') {
          if (c.low  <= scan.stopLoss)   { result = 'loss'; break }
          if (c.high >= scan.takeProfit) { result = 'win';  break }
        } else {
          if (c.high >= scan.stopLoss)   { result = 'loss'; break }
          if (c.low  <= scan.takeProfit) { result = 'win';  break }
        }
      }

      // Atualiza capital para o próximo lote
      if (result === 'win') {
        const pips = scan.direction === 'buy'
          ? (scan.takeProfit - scan.entry) * 10000
          : (scan.entry - scan.takeProfit) * 10000
        capital = Math.max(0, capital + pips * lot * 10)
      } else if (result === 'loss') {
        const pips = scan.direction === 'buy'
          ? (scan.entry - scan.stopLoss) * 10000
          : (scan.stopLoss - scan.entry) * 10000
        capital = Math.max(0, capital - pips * lot * 10)
      }

      handleAdd({
        id:         `${scan.time}-scan-${scan.direction}`,
        direction:  scan.direction,
        entry:      scan.entry,
        stopLoss:   scan.stopLoss,
        takeProfit: scan.takeProfit,
        label:      `Auto ${scan.direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'} @ ${formatPrice(scan.entry)} | ${lot.toFixed(2)}L`,
        time:       scan.time,
        lot,
        leverage:   OCO_LEVERAGE,
        result,
        rafi:       scan.rafi,
        rafiDir:    scan.rafiDir,
        bbWidth:    scan.bbWidth,
        snapshot:   generateTradeSnapshot(scanCandles, {
          time:       scan.time,
          direction:  scan.direction,
          entry:      scan.entry,
          stopLoss:   scan.stopLoss,
          takeProfit: scan.takeProfit,
          result,
          lot,
          rafi:       scan.rafi,
        }) ?? undefined,
      })
    })

    // Salva resultado do scan no histórico do CSV ativo
    if (activeCsvId) {
      const wins  = found.filter(s => {
        const idx = scanCandles.findIndex(c => c.time === s.time)
        for (let j = idx + 1; j < scanCandles.length; j++) {
          const c = scanCandles[j]
          if (s.direction === 'buy') {
            if (c.low  <= s.stopLoss)   return false
            if (c.high >= s.takeProfit) return true
          } else {
            if (c.high >= s.stopLoss)   return false
            if (c.low  <= s.takeProfit) return true
          }
        }
        return false
      }).length
      const finalPnl = capital - BASE_CAPITAL
      setCsvHistory(prev => {
        const next = prev.map(h => h.id === activeCsvId
          ? { ...h, scanResult: { trades: found.length, wins, pnl: finalPnl } }
          : h
        )
        try { localStorage.setItem(CSV_HISTORY_KEY, JSON.stringify(next)) } catch {}
        return next
      })
    }
  }, [csvData, tf, handleAdd, activeCsvId])

  return (
    <div className="flex h-full overflow-hidden relative">

      {/* ── Banner Modo Autônomo — topo da página quando IA está operando ── */}
      {autonomoAtivo && (
        <ModoAutonomoBanner
          capital={consolidatedBalance ?? 100}
          metaAlvo={META_DIARIA_PCT}
          pnlHoje={autonomoPnl}
          sessaoAtiva={getAutonomoSessao()}
          trades={autonomoTrades}
          onPausar={() => {
            setAutonomoAtivo(false)
            setAutonomoTrades([])
            setAutonomoPnl(0)
          }}
        />
      )}

      {/* ── Modal de ativação do Modo Autônomo ── */}
      {showAutonomoModal && checkin && (
        <ModoAutonomoModal
          checkin={checkin}
          onAutonomo={() => {
            setShowAutonomoModal(false)
            setAutonomoAtivo(true)
            setAutonomoTrades([])
            setAutonomoPnl(0)
            setIaWatcherActive(false)  // desativa pop-ups durante modo autônomo
          }}
          onManual={() => setShowAutonomoModal(false)}
        />
      )}

      {/* ── Check-in de estado mental ── */}
      {showCheckin && <CheckinModal onComplete={handleCheckinComplete} />}

      {/* ── Overlay: meta diária atingida ── */}
      {showDailyOverlay && (
        <MetasOverlay
          type="daily"
          dailyPct={overlayDailyData?.pct  ?? targetMetrics.dailyPct}
          dailyPnl={overlayDailyData?.pnl  ?? targetMetrics.dailyPnl}
          weeklyPct={overlayDailyData?.weeklyPct ?? targetMetrics.weeklyPct}
          weeklyPnl={overlayDailyData?.weeklyPnl ?? targetMetrics.weeklyPnl}
          daysHit={targetMetrics.daysHit}
          currency={metaAccount?.currency ?? 'USD'}
          onClose={() => setShowDailyOverlay(false)}
        />
      )}

      {/* ── Overlay: meta semanal atingida ── */}
      {showWeeklyOverlay && (
        <MetasOverlay
          type="weekly"
          dailyPct={overlayWeeklyData?.pct  ?? targetMetrics.dailyPct}
          dailyPnl={overlayWeeklyData?.pnl  ?? targetMetrics.dailyPnl}
          weeklyPct={overlayWeeklyData?.weeklyPct ?? targetMetrics.weeklyPct}
          weeklyPnl={overlayWeeklyData?.weeklyPnl ?? targetMetrics.weeklyPnl}
          daysHit={targetMetrics.daysHit}
          currency={metaAccount?.currency ?? 'USD'}
          onClose={() => setShowWeeklyOverlay(false)}
        />
      )}

      {/* ── Pop-up Meta Ao Vivo ── */}
      {showLiveMetaPopup && liveMetaSnapshot && (
        <LiveMetaPopup
          pct={liveMetaSnapshot.pct}
          pnl={liveMetaSnapshot.pnl}
          bal={liveMetaSnapshot.bal}
          target={DAILY_TARGET}
          positionCount={totalPositionCount}
          brokerCount={allBrokerPositions.filter(b => b.positions.length > 0).length}
          currency={metaAccount?.currency ?? 'USD'}
          closing={liveMetaClosing}
          closed={liveMetaClosed}
          onCloseAll={handleLiveMetaCloseAll}
          onDismiss={() => setShowLiveMetaPopup(false)}
        />
      )}

      {/* ── Mobile: backdrop da gaveta ── */}
      <div
        className={cn(
          'fixed inset-0 bg-black/50 z-30 md:hidden transition-opacity duration-300',
          sidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ── Mobile: gaveta lateral deslizante ── */}
      <div className={cn(
        'fixed left-0 top-0 h-full w-[280px] bg-[#161b22] border-r border-[#30363d] z-40 flex flex-col overflow-y-auto md:hidden transition-transform duration-300',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        {/* Cabeçalho da gaveta */}
        <div className="px-4 pt-10 pb-4 border-b border-[#30363d] flex items-center justify-between">
          <div>
            <div className="font-bold text-base text-[#26c6da]">RAFI Dashboard</div>
            <div className="text-[10px] text-[#484f58] mt-0.5">Mesa de Operações</div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="text-[#484f58] hover:text-[#f0f6fc] p-1">
            <XIcon size={18} />
          </button>
        </div>

        {/* Capital consolidado + corretora principal */}
        {metaConnected && metaAccount && (
          <div className="px-4 py-3 border-b border-[#30363d]">
            {consolidatedBalance && consolidatedBalance > metaAccount.balance ? (
              <>
                <div className="text-[9px] font-semibold text-[#26c6da] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#26c6da] animate-pulse inline-block" />
                  Capital Consolidado · {enabledBrokers.length} corretoras
                </div>
                <div className="mb-3">
                  <div className="text-[22px] font-black font-mono text-[#26c6da]">
                    {metaAccount.currency} {consolidatedBalance.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[9px] text-[#484f58] mt-0.5">soma de todos os saldos</div>
                </div>
                <div className="flex justify-between items-center text-[12px]">
                  <span className="text-[#484f58]">{routeBroker?.nome ?? 'Principal'}</span>
                  <span className="font-mono font-bold text-[#f0f6fc]">
                    {metaAccount.currency} {metaAccount.balance.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between items-center text-[12px] mt-1">
                  <span className="text-[#484f58]">Margem livre</span>
                  <span className="font-mono font-bold text-[#f0f6fc]">
                    {metaAccount.freeMargin.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="text-[9px] font-semibold text-[#26c6da] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#26c6da] animate-pulse inline-block" />
                  {routeBroker?.nome ?? 'Corretora'} · MT5
                </div>
                <div className="space-y-2">
                  {([
                    { label: 'Saldo',        val: `${metaAccount.currency} ${metaAccount.balance.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, color: '#f0f6fc' },
                    { label: 'Equity',       val: (liveEquity ?? metaAccount.equity).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), color: '#22c55e' },
                    { label: 'Margem livre', val: metaAccount.freeMargin.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), color: '#f0f6fc' },
                  ] as const).map(r => (
                    <div key={r.label} className="flex justify-between items-center text-[12px]">
                      <span className="text-[#484f58]">{r.label}</span>
                      <span className="font-mono font-bold" style={{ color: r.color }}>{r.val}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Timeframe */}
        <div className="px-4 py-3 border-b border-[#30363d]">
          <div className="text-[9px] font-semibold text-[#8b949e] uppercase tracking-wider mb-2">Timeframe</div>
          <div className="flex gap-2">
            {TIMEFRAMES.map(t => (
              <button
                key={t}
                onClick={() => {
                  setTf(t); setTrades([])
                  if (metaConnected) { setCsvData(null); setMetaConnected(false) }
                  setSidebarOpen(false)
                }}
                className={cn(
                  'flex-1 py-2.5 rounded-xl text-sm font-bold border transition-all',
                  t === tf ? 'bg-[#3b82f6] border-[#3b82f6] text-white' : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]',
                )}
              >{t}</button>
            ))}
          </div>
        </div>

        {/* Fonte de dados */}
        <div className="px-4 py-3 border-b border-[#30363d]">
          <div className="text-[9px] font-semibold text-[#8b949e] uppercase tracking-wider mb-2">Fonte de Dados</div>
          <div className="space-y-2">
            <button
              onClick={() => {
                if (metaConnected) {
                  try { localStorage.setItem(META_AUTO_KEY, 'false') } catch {}
                  setMetaConnected(false); setCsvData(null)
                } else {
                  try { localStorage.setItem(META_AUTO_KEY, 'true') } catch {}
                  loadCandlesFromMetaAPI()
                }
                setSidebarOpen(false)
              }}
              disabled={metaLoading}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold border transition-all disabled:opacity-50',
                metaConnected
                  ? 'border-[#22c55e]/50 bg-[#22c55e]/8 text-[#22c55e] hover:bg-[#ef4444]/10 hover:border-[#ef4444]/40 hover:text-[#ef4444]'
                  : 'border-[#26c6da]/40 text-[#26c6da] hover:bg-[#26c6da]/10',
              )}
            >
              <span className={cn('w-2 h-2 rounded-full', metaConnected ? 'bg-[#22c55e] animate-pulse' : 'bg-[#26c6da]')} />
              {metaLoading ? 'Conectando…' : metaConnected ? 'MetaAPI · AO VIVO (toque para desligar)' : 'MetaAPI Ao Vivo'}
            </button>
            {metaLoading && (
              <div className="text-[10px] text-[#26c6da] px-1">{metaStep} ({metaElapsed}s)</div>
            )}
            {metaError && <div className="text-[10px] text-[#ef4444] px-1">⚠ {metaError}</div>}
            <button
              onClick={() => { fileInputRef.current?.click(); setSidebarOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] transition-all"
            >
              <FolderOpen size={14} /> Carregar CSV
            </button>
          </div>
        </div>

        {/* Ferramentas */}
        <div className="px-4 py-3">
          <div className="text-[9px] font-semibold text-[#8b949e] uppercase tracking-wider mb-2">Ferramentas</div>
          <div className="space-y-2">
            <button
              onClick={() => { handleAutoScan(); setSidebarOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-[#22c55e]/40 bg-[#22c55e]/8 text-[#22c55e] hover:bg-[#22c55e]/15 transition-all"
            >
              <ScanLine size={14} /> Auto Scan
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => { setPanMode(false); setSidebarOpen(false) }}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold border transition-all',
                  !panMode ? 'border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b]' : 'border-[#30363d] text-[#484f58]',
                )}
              ><Crosshair size={13} /> OCO</button>
              <button
                onClick={() => { setPanMode(true); setSidebarOpen(false) }}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold border transition-all',
                  panMode ? 'border-[#3b82f6] bg-[#3b82f6]/10 text-[#3b82f6]' : 'border-[#30363d] text-[#484f58]',
                )}
              ><Hand size={13} /> Navegar</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Área do gráfico ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 p-2 md:p-4 gap-2 md:gap-3 overflow-hidden md:overflow-y-auto pb-16 md:pb-0">

        {/* Header mobile — apenas em telas pequenas */}
        <div className="flex md:hidden flex-col gap-1.5 shrink-0 pt-1">
          {/* Linha 1: hamburger + título + badge */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg border border-[#30363d] text-[#484f58] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all"
            >
              <Menu size={17} />
            </button>
            <span className="font-bold text-[13px] text-[#f0f6fc] flex-1 truncate">Mesa de Operação</span>
            {metaConnected ? (
              <span className="flex items-center gap-1 text-[10px] font-bold text-[#22c55e] bg-[#22c55e]/10 border border-[#22c55e]/30 px-2 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse inline-block" />
                AO VIVO
              </span>
            ) : (
              <button
                onClick={() => { try { localStorage.setItem(META_AUTO_KEY, 'true') } catch {}; loadCandlesFromMetaAPI() }}
                disabled={metaLoading}
                className="text-[10px] font-bold text-[#26c6da] border border-[#26c6da]/40 px-2 py-1 rounded-full hover:bg-[#26c6da]/10 transition-all disabled:opacity-50"
              >
                {metaLoading ? 'Conectando…' : 'MetaAPI'}
              </button>
            )}
          </div>
          {/* Linha 2: botões M5 / M15 / H1 + countdown */}
          <div className="flex items-center gap-2">
            {TIMEFRAMES.map(t => (
              <button
                key={t}
                onClick={() => {
                  setTf(t); setTrades([])
                  if (metaConnected) { setCsvData(null); setMetaConnected(false) }
                }}
                className={cn(
                  'flex-1 py-1.5 rounded-lg text-[11px] font-bold border transition-all',
                  t === tf
                    ? 'bg-[#3b82f6] border-[#3b82f6] text-white'
                    : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]',
                )}
              >
                {t}
              </button>
            ))}
            <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#0d1117] border border-[#30363d] shrink-0">
              <span className="text-[#484f58] text-[10px]">⏱</span>
              <span className="text-[#8b949e] text-[11px] font-mono tabular-nums">
                {String(Math.floor(candleCountdown / 60)).padStart(2, '0')}:{String(candleCountdown % 60).padStart(2, '0')}
              </span>
            </div>
          </div>
        </div>

        {/* Header desktop — oculto em mobile */}
        <div className="hidden md:flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-bold text-[#f0f6fc]">Mesa de Operação</h1>
            <p className="text-xs text-[#8b949e] mt-0.5">
              {csvData
                ? <><span className="text-[#22c55e]">{csvData.timeframe}</span> · {csvData.dateFrom} → {csvData.dateTo} · <span className="text-[#22c55e]">{csvData.count.toLocaleString('pt-BR')} candles</span></>
                : <>EURUSD · {tf} · Semana demo</>
              }
              <span className="ml-2 mono text-[#484f58]">{formatPrice(lastPrice)}</span>
            </p>
          </div>

          {/* Legendas rápidas */}
          <div className="flex items-center gap-4 text-[10px]">
            <span className="flex items-center gap-1 text-[#22c55e]">
              <span className="w-2.5 h-2.5 bg-[#22c55e] inline-block rounded-sm" />Alta
            </span>
            <span className="flex items-center gap-1 text-[#ef4444]">
              <span className="w-2.5 h-2.5 bg-[#ef4444] inline-block rounded-sm" />Baixa
            </span>
            <span className="flex items-center gap-1 text-[#f59e0b]">
              <span className="w-2.5 h-2.5 bg-[#f59e0b] inline-block rounded-sm" />Exaustão
            </span>
            <span className="flex items-center gap-1 text-[#d1d5db]">
              <span className="w-2.5 h-2.5 bg-[#d1d5db] inline-block rounded-sm" />Consol.
            </span>
            <span className="flex items-center gap-1 text-[#26c6da]">
              <span className="w-4 h-0.5 bg-[#26c6da] inline-block" />BB(8,2)
            </span>
          </div>
        </div>

        {/* Feature 1: barra de saldo da corretora principal — só visível quando MetaAPI conectado (oculta em mobile, exibida na gaveta) */}
        {metaConnected && metaAccount && (
          <div className="hidden md:flex items-center gap-4 px-3 py-1.5 bg-[#0b1219] rounded-lg border border-[#30363d]/60 text-[10px] shrink-0 flex-wrap">
            <div className="flex items-center gap-1.5 font-semibold text-[#26c6da]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#26c6da] inline-block animate-pulse" />
              {routeBroker?.nome ?? 'Corretora'} · MT5
            </div>
            <div className="w-px h-4 bg-[#30363d]" />
            <span className="text-[#484f58]">Saldo</span>
            <span className="font-mono font-bold text-[#f0f6fc]">{metaAccount.currency} {metaAccount.balance.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
            <span className="text-[#484f58]">Equity</span>
            <span className="font-mono font-bold text-[#f0f6fc]">{(liveEquity ?? metaAccount.equity).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
            <span className="text-[#484f58]">Margem livre</span>
            <span className="font-mono font-bold text-[#f0f6fc]">{metaAccount.freeMargin.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
            {metaPositions.length > 0 && (
              <>
                <div className="w-px h-4 bg-[#30363d]" />
                <span className="text-[#484f58]">Abertas</span>
                <span className="font-mono font-bold text-[#22c55e]">{metaPositions.length}</span>
                <span className="text-[#484f58]">P&amp;L</span>
                <span className={cn('font-mono font-bold', liveTotalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
                  {liveTotalPnl >= 0 ? '+'  : ''}{liveTotalPnl.toFixed(2)} USD
                </span>
              </>
            )}
            <span className="ml-auto text-[#484f58]">Atualizado {metaAccount.updatedAt}</span>
          </div>
        )}

        {/* Barra de roteamento multi-corretora */}
        {routeBroker && (
          <div className="hidden md:flex items-center gap-3 px-3 py-1.5 bg-[#0b1219] rounded-lg border border-[#30363d]/60 text-[10px] shrink-0">
            <span className="text-[#484f58] font-semibold uppercase tracking-wider">
              {routeBroker.estado === 'STANDBY' ? 'Ordem vai para' : 'Próxima ordem →'}
            </span>
            <div className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded border font-bold text-[11px]',
              routeBroker.estado === 'ACTIVE'
                ? 'bg-[#3b82f6]/10 border-[#3b82f6]/30 text-[#3b82f6]'
                : routeBroker.estado === 'ACTIVE_REDUCED'
                ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
                : 'bg-[#484f58]/10 border-[#30363d] text-[#484f58]',
            )}>
              <span className={cn(
                'w-1.5 h-1.5 rounded-full inline-block',
                routeBroker.circuit_breaker === 'CLOSED' ? 'bg-[#22c55e]' : 'bg-[#ef4444]',
              )} />
              {routeBroker.nome.replace('pepperstone','Pepperstone').replace('exness','Exness')}
              {routeBroker.health_score > 0 && (
                <span className="text-[9px] font-bold opacity-70 ml-0.5">({Math.round(routeBroker.health_score)})</span>
              )}
            </div>
            <span className="text-[#30363d]">·</span>
            <span className={cn(
              'text-[9px] font-semibold uppercase tracking-wider',
              routeBroker.estado === 'ACTIVE' ? 'text-[#22c55e]' :
              routeBroker.estado === 'ACTIVE_REDUCED' ? 'text-[#f59e0b]' : 'text-[#484f58]',
            )}>{routeBroker.estado.replace('_', ' ')}</span>
            {routeBroker.circuit_breaker !== 'CLOSED' && (
              <span className="text-[9px] text-[#ef4444] font-semibold">· CB {routeBroker.circuit_breaker}</span>
            )}
          </div>
        )}

        {/* Banner de progresso de metas — exibido quando MetaAPI está conectado */}
        {metaConnected && (
          <div className="hidden md:flex items-center gap-2.5 px-3 py-1.5 bg-[#0b101a] rounded-lg border border-[#1c3050] shrink-0 text-[10px]">
            {/* Meta diária */}
            <span
              className="font-bold shrink-0 tabular-nums"
              style={{ color: targetMetrics.dailyMet ? '#00e676' : liveDailyPct >= DAILY_TARGET * 0.7 ? '#f59e0b' : '#7a96b8', minWidth: 60 }}
            >
              {targetMetrics.dailyMet ? '✓' : '◎'} Dia {liveDailyPct >= 0 ? '+' : ''}{liveDailyPct.toFixed(1)}%/{DAILY_TARGET}%
            </span>
            <div className="w-24 h-1.5 bg-[#131f2e] rounded-full overflow-hidden shrink-0">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min((liveDailyPct / DAILY_TARGET) * 100, 100)}%`,
                  background: targetMetrics.dailyMet
                    ? 'linear-gradient(90deg,#4499ff,#00e676)'
                    : liveDailyPct >= DAILY_TARGET * 0.7
                    ? 'linear-gradient(90deg,#4499ff,#f59e0b)'
                    : '#4499ff',
                }}
              />
            </div>
            <span className="text-[#1c3050]">|</span>
            {/* Meta semanal */}
            <span
              className="font-bold shrink-0 tabular-nums"
              style={{ color: targetMetrics.weeklyMet ? '#ffcc44' : '#7a96b8', minWidth: 70 }}
            >
              {targetMetrics.weeklyMet ? '🏆' : '◎'} Semana {targetMetrics.weeklyPct >= 0 ? '+' : ''}{targetMetrics.weeklyPct.toFixed(1)}%/{WEEKLY_TARGET}%
            </span>
            <div className="w-24 h-1.5 bg-[#131f2e] rounded-full overflow-hidden shrink-0">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min((targetMetrics.weeklyPct / WEEKLY_TARGET) * 100, 100)}%`,
                  background: targetMetrics.weeklyMet
                    ? 'linear-gradient(90deg,#4499ff,#ffcc44)'
                    : targetMetrics.weeklyPct >= WEEKLY_TARGET * 0.7
                    ? 'linear-gradient(90deg,#4499ff,#f59e0b)'
                    : '#4499ff',
                }}
              />
            </div>
            {targetMetrics.locked && (
              <>
                <span className="text-[#1c3050]">|</span>
                <span className="text-[8px] font-bold text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/30 px-1.5 py-0.5 rounded">
                  🔒 OPS BLOQUEADAS
                </span>
              </>
            )}
          </div>
        )}

        {/* Gráfico duplo (candles + RAFI) */}
        <div
          className="flex-1 min-h-0 rounded-xl border border-[#30363d] overflow-hidden flex flex-col md:flex-none"
          style={isDesktop ? { height: chartH } : undefined}
        >

          {/* Toolbar do gráfico — oculta em mobile; altura colapsável via drag handle */}
          <div
            ref={toolbarElRef}
            className="hidden md:flex items-center justify-between bg-[#161b22] shrink-0 overflow-hidden"
            style={isDesktop ? {
              // null = altura natural (auto); 0 = colapsada; número = durante drag
              height:       toolbarH === null ? undefined : toolbarH,
              borderBottom: toolbarH === 0 ? 'none' : '1px solid #30363d',
              padding:      toolbarH === 0 ? '0' : '8px 16px',
            } : { padding: '8px 16px', borderBottom: '1px solid #30363d' }}
          >
            <div className="flex items-center gap-3 text-[10px]">

              {/* Seletor de Timeframe */}
              {/* Input de arquivo oculto */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Timeframe — sempre habilitado; troca TF e refetch MetaAPI */}
              <div className="flex items-center gap-0.5 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d]">
                {TIMEFRAMES.map(t => (
                  <button
                    key={t}
                    disabled={metaLoading}
                    onClick={() => {
                      if (t === tf) return
                      setTf(t)
                      setTrades([])
                      setCsvData(null)
                      setMetaConnected(false)
                      // loadCandlesFromMetaAPI usa o tf atual do state — após setTf ele rodará com o novo TF
                      setTimeout(() => loadCandlesFromMetaAPI(), 0)
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all',
                      t === tf
                        ? 'bg-[#3b82f6] text-white'
                        : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Countdown da barra atual */}
              <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#0d1117] border border-[#30363d]">
                <span className="text-[#484f58] text-[10px]">⏱</span>
                <span className="text-[#8b949e] text-[11px] font-mono tabular-nums">
                  {String(Math.floor(candleCountdown / 60)).padStart(2, '0')}:{String(candleCountdown % 60).padStart(2, '0')}
                </span>
              </div>

              {/* Botão Carregar CSV + Histórico */}
              <div className="relative flex items-center gap-1" ref={historyPanelRef}>

                {/* Toggle global MetaAPI — sempre visível independente do estado dos candles */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} title={globalMapiActive ? 'MetaAPI ligado — clique para desligar' : 'MetaAPI desligado — clique para ligar'}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: globalMapiActive ? '#00e676' : '#5a7d96' }}>
                    {globalMapiStatus === 'loading' ? '…' : globalMapiActive ? 'ON' : 'OFF'}
                  </span>
                  <button
                    onClick={globalMapiStatus === 'loading' ? undefined : toggleGlobalMapi}
                    disabled={globalMapiStatus === 'loading'}
                    style={{
                      width: 36, height: 20, borderRadius: 10, border: 'none',
                      cursor: globalMapiStatus === 'loading' ? 'wait' : 'pointer',
                      background: globalMapiActive ? '#00e676' : '#1a2d42',
                      position: 'relative', transition: 'background .25s', flexShrink: 0,
                      opacity: globalMapiStatus === 'loading' ? 0.6 : 1,
                    }}>
                    <span style={{
                      position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                      background: '#fff', transition: 'left .25s',
                      left: globalMapiActive ? 18 : 2,
                    }} />
                  </button>
                </div>

                {csvData ? (
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#22c55e]/10 border border-[#22c55e]/30 text-[#22c55e] text-[10px] font-semibold">
                    <FolderOpen size={10} />
                    {csvData.filename.length > 28 ? csvData.filename.slice(0, 26) + '…' : csvData.filename}
                    · {csvData.count.toLocaleString('pt-BR')} candles
                    <button onClick={clearCSV} className="hover:text-red-400 transition-colors ml-0.5" title="Remover dados">
                      <XIcon size={10} />
                    </button>
                  </span>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] transition-all"
                      title="Carregar dados históricos reais (CSV Dukascopy ou MT5)"
                    >
                      <FolderOpen size={10} />
                      Carregar CSV
                    </button>
                    {sbCandleCount != null && sbCandleCount > 0 && (
                      <button
                        onClick={loadCandlesFromSupabase}
                        disabled={sbLoading}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-[#3b82f6]/50 text-[#3b82f6] hover:bg-[#3b82f6]/10 disabled:opacity-40 transition-all"
                        title={`Carregar ${sbCandleCount.toLocaleString('pt-BR')} candles do Supabase`}
                      >
                        <Database size={10} />
                        {sbLoading ? 'Carregando…' : `Supabase (${sbCandleCount.toLocaleString('pt-BR')})`}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (metaConnected) {
                          // Desabilitar: salva preferência e limpa estado
                          try { localStorage.setItem(META_AUTO_KEY, 'false') } catch {}
                          setMetaConnected(false)
                          setCsvData(null)
                        } else {
                          // Habilitar: salva preferência e conecta
                          try { localStorage.setItem(META_AUTO_KEY, 'true') } catch {}
                          loadCandlesFromMetaAPI()
                        }
                      }}
                      disabled={metaLoading || globalMapiActive === false}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-all disabled:opacity-50',
                        metaConnected
                          ? 'border-[#22c55e]/50 bg-[#22c55e]/8 text-[#22c55e] hover:bg-[#ef4444]/10 hover:border-[#ef4444]/40 hover:text-[#ef4444]'
                          : 'border-[#26c6da]/40 bg-[#26c6da]/8 text-[#26c6da] hover:bg-[#26c6da]/15',
                      )}
                      title={globalMapiActive === false ? 'Ligue o MetaAPI primeiro' : metaConnected ? 'Clique para desabilitar MetaAPI' : 'Carregar candles ao vivo via MetaAPI · Pepperstone'}
                    >
                      <span className={cn(
                        'w-1.5 h-1.5 rounded-full inline-block',
                        metaConnected ? 'bg-[#22c55e] animate-pulse' : 'bg-[#26c6da]',
                      )} />
                      {metaLoading ? 'Conectando…' : metaConnected ? 'MetaAPI · LIVE' : 'MetaAPI Ao Vivo'}
                    </button>
                    {/* Opção A: aviso quando MetaAPI global está desligado */}
                    {globalMapiActive === false && !metaConnected && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                        background: '#1a1500', border: '1px solid #3d2a00', borderRadius: 6,
                        fontSize: 10, color: '#ffb300',
                      }}>
                        ⚠ MetaAPI OFF — ligue o toggle para operar ao vivo
                      </div>
                    )}
                    {/* Feature 4: countdown para auto-refresh dos candles */}
                    {metaConnected && refreshIn > 0 && (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] border border-[#26c6da]/25 bg-[#26c6da]/6 text-[#26c6da] font-mono">
                        <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10">
                          <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20 6" />
                        </svg>
                        {Math.floor(refreshIn / 60)}:{String(refreshIn % 60).padStart(2, '0')}
                      </div>
                    )}
                    {metaLoading && (
                      <div className="flex flex-col gap-0.5 min-w-[220px]">
                        <div className="flex items-center justify-between text-[9px]">
                          <span className="text-[#26c6da] truncate max-w-[190px]">{metaStep}</span>
                          <span className="text-[#484f58] font-mono shrink-0 ml-1">{metaElapsed}s</span>
                        </div>
                        <div className="h-1 bg-[#21262d] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#26c6da] rounded-full transition-all duration-1000"
                            style={{ width: `${Math.min((metaElapsed / 30) * 100, 95)}%` }}
                          />
                        </div>
                        <span className="text-[8px] text-[#484f58]">
                          MetaAPI conecta via WebSocket ao Pepperstone MT5 — pode levar até 30s
                        </span>
                      </div>
                    )}
                    {!metaLoading && metaError && (
                      <span className="flex items-center gap-1 text-[#ef4444] text-[9px]" title={metaError}>
                        <span className="max-w-[180px] truncate">⚠ {metaError}</span>
                        {/conectando|aguarde|tente/i.test(metaError) && (
                          <button
                            onClick={loadCandlesFromMetaAPI}
                            className="shrink-0 underline hover:text-[#ff6b6b] transition-colors"
                          >
                            Tentar novamente
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                )}

                {/* Botão de histórico — aparece quando há entradas */}
                {csvHistory.length > 0 && (
                  <button
                    onClick={() => setHistoryOpen(o => !o)}
                    className={cn(
                      'flex items-center gap-0.5 px-1.5 py-1 rounded-md text-[11px] font-semibold border transition-all',
                      historyOpen
                        ? 'border-[#3b82f6]/50 bg-[#3b82f6]/10 text-[#3b82f6]'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                    )}
                    title={`${csvHistory.length} CSV${csvHistory.length > 1 ? 's' : ''} no histórico`}
                  >
                    <History size={10} />
                    <span className="text-[9px]">{csvHistory.length}</span>
                    <ChevronDown size={9} className={cn('transition-transform', historyOpen && 'rotate-180')} />
                  </button>
                )}

                {/* Painel do histórico */}
                {historyOpen && (
                  <div className="absolute top-full left-0 mt-1 z-50 w-[340px] bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl overflow-hidden">
                    <div className="px-3 py-2 border-b border-[#30363d] flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider flex items-center gap-1.5">
                        <History size={9} /> Histórico de CSVs
                      </span>
                      <span className="text-[9px] text-[#484f58]">máx. {MAX_CSV_HISTORY} · clique para restaurar</span>
                    </div>
                    <div className="divide-y divide-[#21262d]">
                      {csvHistory.map(entry => {
                        const isActive = entry.id === activeCsvId
                        const hasScan  = !!entry.scanResult
                        const sr       = entry.scanResult
                        const wr       = sr ? ((sr.wins / sr.trades) * 100).toFixed(1) : null
                        const pnlPos   = sr ? sr.pnl >= 0 : null
                        return (
                          <div
                            key={entry.id}
                            className={cn(
                              'flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[#21262d] transition-colors group',
                              isActive && 'bg-[#22c55e]/5 border-l-2 border-[#22c55e]',
                            )}
                            onClick={() => loadFromHistory(entry)}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={cn(
                                  'text-[9px] font-bold px-1 py-0.5 rounded',
                                  isActive ? 'bg-[#22c55e]/20 text-[#22c55e]' : 'bg-[#30363d] text-[#8b949e]',
                                )}>
                                  {entry.timeframe}
                                </span>
                                <span className="text-[10px] font-medium text-[#f0f6fc] truncate max-w-[140px]" title={entry.filename}>
                                  {entry.filename.length > 24 ? entry.filename.slice(0, 22) + '…' : entry.filename}
                                </span>
                                <span className="text-[9px] text-[#484f58] font-mono">{entry.count.toLocaleString('pt-BR')} ·</span>
                              </div>
                              <div className="text-[9px] text-[#484f58] mt-0.5">
                                {entry.dateFrom} → {entry.dateTo}
                                {isActive && <span className="ml-1.5 text-[#22c55e] font-semibold">● ativo</span>}
                              </div>
                              {hasScan && sr && wr && (
                                <div className={cn(
                                  'text-[9px] mt-0.5 font-mono font-semibold',
                                  pnlPos ? 'text-[#22c55e]' : 'text-[#ef4444]',
                                )}>
                                  AutoScan: {sr.trades}t · {wr}% WR · {pnlPos ? '+' : ''}{sr.pnl.toFixed(2)} USD
                                </div>
                              )}
                            </div>
                            <button
                              onClick={ev => { ev.stopPropagation(); deleteFromHistory(entry.id) }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-[#484f58] hover:text-[#ef4444] mt-0.5 shrink-0"
                              title="Remover do histórico"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    <div className="px-3 py-2 border-t border-[#30363d]">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[10px] font-semibold border border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] transition-all"
                      >
                        <FolderOpen size={10} />
                        Carregar novo CSV…
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {csvError && (
                <span className="text-[#ef4444] text-[9px] max-w-[180px] truncate" title={csvError}>
                  ⚠ {csvError}
                </span>
              )}

              <span className="text-[#30363d]">|</span>
              <span className="text-[#f0f6fc] font-medium">EURUSD {csvData?.timeframe ?? tf}</span>
              <span className="text-[#484f58]">{candles.length.toLocaleString('pt-BR')} candles</span>

              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#22c55e] inline-block" />
                <span className="text-[#22c55e]">Alta ≥2.5</span>
                <span className="text-[#484f58]">({strongBullBars}×)</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#ef4444] inline-block" />
                <span className="text-[#ef4444]">Baixa ≥2.5</span>
                <span className="text-[#484f58]">({strongBearBars}×)</span>
              </span>

              <span className="text-[#30363d]">|</span>

              {/* Alinhamento do gráfico — 2 botões estilo MT5 */}
              <div className="flex items-center gap-0 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d]">
                {/* Alinhar à esquerda: candles + espaço à direita (Shift MT5) */}
                <button
                  onClick={() => shiftRangeRef.current?.()}
                  className="flex items-center justify-center w-7 h-6 rounded-md text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all"
                  title="Alinhar à esquerda — candles com espaço à direita (Shift MT5)"
                >
                  <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
                    <rect x="0.5" y="0.5" width="15" height="10" rx="1.5" stroke="currentColor" strokeOpacity="0.4"/>
                    <rect x="2" y="3" width="2" height="5" rx="0.5" fill="currentColor"/>
                    <rect x="5" y="2" width="2" height="7" rx="0.5" fill="currentColor"/>
                    <rect x="8" y="4" width="2" height="4" rx="0.5" fill="currentColor"/>
                    <rect x="13" y="1" width="1" height="9" rx="0.5" fill="currentColor" opacity="0.5"/>
                  </svg>
                </button>
                {/* Alinhar à direita: última barra na borda direita */}
                <button
                  onClick={() => alignRightRef.current?.()}
                  className="flex items-center justify-center w-7 h-6 rounded-md text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all"
                  title="Alinhar à direita — última barra na borda direita"
                >
                  <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
                    <rect x="0.5" y="0.5" width="15" height="10" rx="1.5" stroke="currentColor" strokeOpacity="0.4"/>
                    <rect x="4" y="3" width="2" height="5" rx="0.5" fill="currentColor"/>
                    <rect x="7" y="2" width="2" height="7" rx="0.5" fill="currentColor"/>
                    <rect x="10" y="4" width="2" height="4" rx="0.5" fill="currentColor"/>
                    <rect x="13" y="3" width="2" height="5" rx="0.5" fill="currentColor"/>
                  </svg>
                </button>
              </div>

              <span className="text-[#30363d]">|</span>

              {/* Modo: Navegar / OCO */}
              <div className="flex items-center gap-0.5 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d]">
                {/* Navegar */}
                <button
                  onClick={() => setPanMode(true)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all',
                    panMode
                      ? 'bg-[#3b82f6] text-white'
                      : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                  )}
                  title="Modo navegar: clique e arraste para mover o gráfico"
                >
                  <Hand size={10} />
                  Navegar
                </button>
                {/* OCO */}
                <button
                  onClick={() => {
                    setPanMode(false)
                    if (!ocoVisible && ocoState) {
                      setOcoVisible(true)
                    } else if (!ocoVisible) {
                      setOcoState(makeOCO(lastPrice, currentLot))
                      setOcoVisible(true)
                    }
                  }}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all',
                    !panMode
                      ? 'bg-[#f59e0b]/15 border border-[#f59e0b]/40 text-[#f59e0b]'
                      : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                  )}
                  title="Modo OCO: clique no gráfico para posicionar entrada"
                >
                  <Crosshair size={10} />
                  OCO
                  {ocoVisible && !panMode && <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] inline-block" />}
                </button>
              </div>

              {/* Auto-scan */}
              <button
                onClick={handleAutoScan}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-[#22c55e]/40 bg-[#22c55e]/8 text-[#22c55e] hover:bg-[#22c55e]/15 transition-all"
                title="Detecta rompimentos de S/R com BB expandindo e adiciona como trades"
              >
                <ScanLine size={10} />
                Auto-scan
              </button>
            </div>

            {/* Indicador de capital e lote atual */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#f59e0b]/8 border border-[#f59e0b]/25 text-[10px]">
                <Layers size={9} className="text-[#f59e0b]" />
                <span className="text-[#f59e0b] font-bold font-mono">{currentLot.toFixed(2)}L</span>
                <span className="text-[#484f58]">· cap ${currentCapital.toFixed(0)}</span>
                {nextTier && (
                  <span className="text-[#484f58]">· próx: {nextTier.lot.toFixed(2)}L em ${nextTier.minCap.toLocaleString()}</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-[#484f58]">
                <Info size={10} />
                {panMode ? 'Arraste para navegar · scroll para zoom' : 'Clique no gráfico para mover entrada OCO'}
              </div>
            </div>
          </div>

          {/* Handle de colapso da toolbar — arrastar ↑ esconde toolbar, ↓ restaura */}
          {isDesktop && (
            <div
              className="hidden md:flex items-center justify-center h-2 shrink-0 cursor-row-resize group select-none bg-[#0d1117]"
              onMouseDown={handleToolbarResizeStart}
              onDoubleClick={() => setToolbarH(toolbarH === 0 ? null : 0)}
              title={toolbarH === 0 ? 'Arrastar ↓ ou duplo clique para exibir toolbar' : 'Arrastar ↑ para ocultar toolbar · Duplo clique para alternar'}
            >
              <div className="flex items-center gap-0.5 opacity-20 group-hover:opacity-100 transition-opacity">
                <span className="w-6 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
                <span className="w-1.5 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
                <span className="w-6 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
              </div>
            </div>
          )}

          {/* Chart */}
          <div className="flex-1 min-h-0">
            <RAFIChart
              candles={candles}
              rafiData={rafiData}
              srLevels={srLevels}
              trades={trades}
              bbBands={bbBands}
              onPriceClick={panMode ? undefined : (price, time) => {
                setClickedEntry(price)
                setClickedTime(time)
                setOcoState(prev => {
                  if (!prev) return makeOCO(price, currentLot, time)
                  const p = (v: number) => Math.round(v * 100000) / 100000
                  const dSL = prev.sl - prev.entry
                  const dTP = prev.tp - prev.entry
                  return { ...prev, entry: p(price), sl: p(price + dSL), tp: p(price + dTP), entryTime: time }
                })
              }}
              panMode={panMode}
              ocoState={ocoVisible && !panMode ? ocoState : null}
              onOCOChange={setOcoState}
              onOCOExecute={handleOCOExecute}
              onOCOClose={handleOCOClose}
              livePrice={livePrice}
              livePriceRef={livePriceRef}
              chartUpdateCandleRef={chartUpdateCandleRef}
              positions={metaPositions as any}
              onModifyPosition={(id, sl, tp) => handleModifyPosition(id, String(sl), String(tp))}
              snapshotCaptureRef={snapshotCaptureRef}
              shiftRangeRef={shiftRangeRef}
              alignRightRef={alignRightRef}
              freeMargin={metaAccount?.freeMargin ?? null}
            />
          </div>
        </div>

        {/* Handle de resize vertical — desktop only */}
        {isDesktop && (
          <div
            className="hidden md:flex items-center justify-center h-2 shrink-0 cursor-row-resize group select-none"
            onMouseDown={handleResizeStart}
            onDoubleClick={() => { setChartH(460); try { localStorage.removeItem('mesa_chart_h') } catch {} }}
            title="Arraste para redimensionar · Duplo clique para restaurar"
          >
            <div className="flex items-center gap-0.5 opacity-30 group-hover:opacity-100 transition-opacity">
              <span className="w-6 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
              <span className="w-1.5 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
              <span className="w-6 h-[2px] rounded-full bg-[#484f58] group-hover:bg-[#3b82f6] transition-colors" />
            </div>
          </div>
        )}

        {/* Feature 2: painel de posições abertas — só visível quando MetaAPI conectado e há posições (oculto em mobile, acessível pela aba Posições) */}
        {metaConnected && (metaPositions.length > 0 || flatBrokerPositions.length > 0) && (
          <div className="hidden md:block shrink-0 rounded-xl border border-[#30363d] bg-[#0b1219] overflow-hidden">
            <div className="px-4 py-2 border-b border-[#30363d] flex items-center justify-between">
              <span className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider">
                Posições Abertas
                {allBrokerPositions.length > 1 && (
                  <span className="ml-1 text-[#484f58] font-normal normal-case">· {allBrokerPositions.length} corretoras</span>
                )}
              </span>
              <span className={cn('text-[10px] font-mono font-bold', liveTotalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
                P&amp;L líq. {liveTotalPnl >= 0 ? '+' : ''}{liveTotalPnl.toFixed(2)} USD
              </span>
            </div>
            <div className="divide-y divide-[#21262d]">
              {(flatBrokerPositions.length > 0 ? flatBrokerPositions : metaPositions.map(p => ({ ...p, brokerId: '', brokerNome: routeBroker?.nome ?? '', rank: 1 }))).map(pos => {
                const isBuy     = pos.type === 'POSITION_TYPE_BUY'
                const pnlColor  = pos.profit >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
                const isEditing = editingPos?.id === pos.id
                return (
                  <div key={`${pos.brokerId}-${pos.id}`} className="px-4 py-2 text-[10px] hover:bg-[#161b22] transition-colors">
                    {/* Linha principal */}
                    <div className="flex items-center gap-2">
                      {brokerBadge(pos.brokerId, pos.brokerNome)}
                      <span className={cn('font-bold text-[11px]', isBuy ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
                        {isBuy ? '▲' : '▼'}
                      </span>
                      <span className="font-semibold text-[#f0f6fc] w-14">{pos.symbol}</span>
                      <span className="text-[#8b949e]">{pos.volume}L</span>
                      <span className="text-[#484f58]">@ {pos.openPrice.toFixed(5)}</span>
                      <span className="text-[#484f58]">→ {pos.currentPrice.toFixed(5)}</span>
                      <span className={cn('font-mono font-bold ml-auto', pnlColor)}>
                        {pos.profit >= 0 ? '+' : ''}{pos.profit.toFixed(2)} USD
                      </span>
                      {/* Botão editar SL/TP — usa positionId da corretora top para modify */}
                      <button
                        onClick={() => setEditingPos(isEditing ? null : {
                          id: pos.id,
                          sl: pos.stopLoss?.toFixed(5) ?? '',
                          tp: pos.takeProfit?.toFixed(5) ?? '',
                        })}
                        className={cn(
                          'flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-semibold border transition-colors',
                          isEditing
                            ? 'border-[#f59e0b]/50 bg-[#f59e0b]/10 text-[#f59e0b]'
                            : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                        )}
                        title="Editar SL e TP desta posição"
                      >
                        ✎ SL/TP
                      </button>
                      <button
                        onClick={() => handleClosePosition(pos.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-semibold border border-[#ef4444]/40 text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors"
                        title="Fechar posição via MetaAPI"
                      >
                        <XIcon size={9} /> Fechar
                      </button>
                    </div>

                    {/* Custos + P&L líquido (sempre visível) */}
                    {!isEditing && (() => {
                      const comm    = (pos as any).commission ?? 0
                      const sw      = (pos as any).swap ?? 0
                      const netP    = (pos as any).netPnl ?? (pos.profit + comm + sw)
                      const netClr  = netP >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
                      return (
                        <div className="flex items-center gap-4 mt-1 pl-5 text-[9px]">
                          <span className="text-[#484f58]">
                            SL <span className="font-mono text-[#ef4444]">{pos.stopLoss?.toFixed(5) ?? '—'}</span>
                          </span>
                          <span className="text-[#484f58]">
                            TP <span className="font-mono text-[#22c55e]">{pos.takeProfit?.toFixed(5) ?? '—'}</span>
                          </span>
                          {(comm !== 0 || sw !== 0) && (
                            <>
                              <span className="text-[#484f58]">
                                Com. <span className="font-mono text-[#ef4444]">{comm >= 0 ? '+' : ''}{comm.toFixed(2)}</span>
                              </span>
                              <span className="text-[#484f58]">
                                Swap <span className="font-mono" style={{ color: sw < 0 ? '#ef4444' : sw > 0 ? '#22c55e' : '#484f58' }}>
                                  {sw === 0 ? '—' : `${sw >= 0 ? '+' : ''}${sw.toFixed(2)}`}
                                </span>
                              </span>
                              <span className="text-[#484f58]">
                                Líq. <span className={cn('font-mono font-bold', netClr)}>{netP >= 0 ? '+' : ''}{netP.toFixed(2)} USD</span>
                              </span>
                            </>
                          )}
                        </div>
                      )
                    })()}

                    {/* Edição inline de SL/TP */}
                    {isEditing && editingPos && (() => {
                      // Preview P/L em USD: (nível - entrada) × volume × 100.000
                      // Funciona para EURUSD e qualquer par cotado em USD
                      const slVal = parseFloat(editingPos.sl)
                      const tpVal = parseFloat(editingPos.tp)
                      const contractSize = 100_000
                      const slUsd = !isNaN(slVal)
                        ? (isBuy ? slVal - pos.openPrice : pos.openPrice - slVal) * pos.volume * contractSize
                        : null
                      const tpUsd = !isNaN(tpVal)
                        ? (isBuy ? tpVal - pos.openPrice : pos.openPrice - tpVal) * pos.volume * contractSize
                        : null
                      const fmtUsd = (v: number) =>
                        (v >= 0 ? '+' : '') + v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
                      return (
                        <div className="mt-2 pl-5 space-y-1.5">
                          {/* SL */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[9px] text-[#ef4444] font-semibold w-4">SL</span>
                            <input
                              type="number"
                              step="0.00001"
                              value={editingPos.sl}
                              onChange={e => setEditingPos(p => p ? { ...p, sl: e.target.value } : p)}
                              className="w-24 px-2 py-1 rounded bg-[#0d1117] border border-[#ef4444]/40 text-[#ef4444] text-[10px] font-mono focus:outline-none focus:border-[#ef4444]"
                            />
                            {slUsd !== null && (
                              <span className={cn(
                                'text-[10px] font-mono font-bold tabular-nums',
                                slUsd >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]',
                              )}>
                                {fmtUsd(slUsd)}
                              </span>
                            )}
                          </div>
                          {/* TP */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[9px] text-[#22c55e] font-semibold w-4">TP</span>
                            <input
                              type="number"
                              step="0.00001"
                              value={editingPos.tp}
                              onChange={e => setEditingPos(p => p ? { ...p, tp: e.target.value } : p)}
                              className="w-24 px-2 py-1 rounded bg-[#0d1117] border border-[#22c55e]/40 text-[#22c55e] text-[10px] font-mono focus:outline-none focus:border-[#22c55e]"
                            />
                            {tpUsd !== null && (
                              <span className={cn(
                                'text-[10px] font-mono font-bold tabular-nums',
                                tpUsd >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]',
                              )}>
                                {fmtUsd(tpUsd)}
                              </span>
                            )}
                          </div>
                          {/* Botões */}
                          <div className="flex items-center gap-2 pt-0.5">
                            <button
                              onClick={() => handleModifyPosition(pos.id, editingPos.sl, editingPos.tp)}
                              className="px-2.5 py-1 rounded text-[9px] font-bold bg-[#22c55e]/15 border border-[#22c55e]/50 text-[#22c55e] hover:bg-[#22c55e]/25 transition-colors"
                            >
                              ✓ Confirmar
                            </button>
                            <button
                              onClick={() => setEditingPos(null)}
                              className="px-2.5 py-1 rounded text-[9px] font-semibold border border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] transition-colors"
                            >
                              ✕ Cancelar
                            </button>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Posições Abertas ao Vivo — cross-broker, sempre visível (mobile + desktop) ── */}
        {metaConnected && (flatBrokerPositions.length > 0 || metaPositions.length > 0) && (
          <div className="shrink-0 rounded-xl border border-[#3b82f633] bg-[#0b1219] overflow-hidden">
            <div className="px-4 py-2 border-b border-[#30363d] flex items-center justify-between">
              <span className="text-[10px] font-semibold text-[#3b82f6] uppercase tracking-wider flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
                Posições Abertas
                {allBrokerPositions.length > 1 && (
                  <span className="text-[#484f58] font-normal normal-case ml-1">
                    · {allBrokerPositions.length} corretoras · {flatBrokerPositions.length} pos.
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <span className={cn('text-[10px] font-mono font-bold', liveTotalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
                  P&amp;L líq. {liveTotalPnl >= 0 ? '+' : ''}{liveTotalPnl.toFixed(2)} USD
                </span>
                {/* Zerar Tudo — fecha todas as posições abertas */}
                {!closeAllConfirm ? (
                  <button
                    onClick={() => setCloseAllConfirm(true)}
                    disabled={closingAll}
                    className="text-[9px] font-semibold px-2 py-0.5 rounded border border-[#ef444455] text-[#ef4444] hover:bg-[#ef444415] transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    × Zerar tudo
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] text-[#ef4444] font-semibold whitespace-nowrap">
                      Fechar {flatBrokerPositions.length} pos.?
                    </span>
                    <button
                      onClick={handleCloseAll}
                      disabled={closingAll}
                      className="text-[9px] font-semibold px-2 py-0.5 rounded bg-[#ef4444] text-white hover:bg-[#dc2626] transition-colors disabled:opacity-60 whitespace-nowrap"
                    >
                      {closingAll ? '...' : 'Confirmar'}
                    </button>
                    <button
                      onClick={() => setCloseAllConfirm(false)}
                      disabled={closingAll}
                      className="text-[9px] font-semibold px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-white transition-colors disabled:opacity-40"
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr className="border-b border-[#21262d]">
                    {['Corretora', 'Par', 'Dir', 'Lote', 'Entrada', 'TP', 'SL', 'P&L Bruto', 'Comissão', 'Swap', 'P&L Líq.', ''].map(h => (
                      <th key={h} className="px-3 py-1.5 text-left text-[8px] font-semibold text-[#484f58] uppercase tracking-widest whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#21262d]/50">
                  {(flatBrokerPositions.length > 0
                    ? flatBrokerPositions
                    : metaPositions.map(p => ({ ...p, brokerId: '', brokerNome: routeBroker?.nome ?? '', rank: 1 }))
                  ).map(pos => {
                    const isBuy  = pos.type === 'POSITION_TYPE_BUY'
                    // P&L tick-a-tick para EURUSD da corretora top; demais usam último valor da API
                    const pnl    = (livePrice && /eurusd/i.test(pos.symbol) && pos.rank === 1)
                      ? (isBuy ? 1 : -1) * (livePrice - pos.openPrice) * pos.volume * 100000
                      : (pos.profit ?? 0)
                    const pnlClr = pnl >= 0 ? '#22c55e' : '#ef4444'
                    // Para o "Fechar" passamos o positionId desta corretora;
                    // o backend localiza as posições das demais por símbolo+volume
                    const commission = (pos as any).commission ?? 0
                    const swap      = (pos as any).swap ?? 0
                    const netPnl    = (pos as any).netPnl ?? (pnl + commission + swap)
                    const netClr    = netPnl >= 0 ? '#22c55e' : '#ef4444'
                    return (
                      <tr key={`${pos.brokerId}-${pos.id}`} className="hover:bg-[#161b22] transition-colors">
                        <td className="px-3 py-2">{brokerBadge(pos.brokerId, pos.brokerNome)}</td>
                        <td className="px-3 py-2 font-mono font-bold text-[#f0f6fc]">{pos.symbol}</td>
                        <td className="px-3 py-2">
                          <span className={cn('font-bold', isBuy ? 'text-[#3b82f6]' : 'text-[#f59e0b]')}>
                            {isBuy ? '▲ BUY' : '▼ SELL'}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-[#8b949e]">{Math.abs(pos.volume)}L</td>
                        <td className="px-3 py-2 font-mono text-[#8b949e]">{pos.openPrice.toFixed(5)}</td>
                        <td className="px-3 py-2 font-mono text-[#10b981]">{pos.takeProfit ? pos.takeProfit.toFixed(5) : '—'}</td>
                        <td className="px-3 py-2 font-mono text-[#ef4444]">{pos.stopLoss  ? pos.stopLoss.toFixed(5)  : '—'}</td>
                        <td className="px-3 py-2 font-mono tabular-nums" style={{ color: pnlClr }}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums text-[#ef4444]">
                          {commission === 0 ? <span className="text-[#484f58]">—</span> : `${commission >= 0 ? '+' : ''}${commission.toFixed(2)}`}
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums" style={{ color: swap < 0 ? '#ef4444' : swap > 0 ? '#22c55e' : '#484f58' }}>
                          {swap === 0 ? '—' : `${swap >= 0 ? '+' : ''}${swap.toFixed(2)}`}
                        </td>
                        <td className="px-3 py-2 font-mono font-bold tabular-nums" style={{ color: netClr }}>
                          {netPnl >= 0 ? '+' : ''}{netPnl.toFixed(2)} USD
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => handleClosePosition(pos.id)}
                            className="px-2 py-0.5 rounded text-[9px] font-bold bg-[#ef4444]/15 border border-[#ef4444]/40 text-[#ef4444] hover:bg-[#ef4444]/25 transition-colors whitespace-nowrap"
                            title="Fecha esta posição em todas as corretoras ativas"
                          >
                            × Fechar
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Histórico de trades fechados · Pepperstone (oculto em mobile, acessível pela aba Histórico) */}
        {metaConnected && (
          <div className="hidden md:block shrink-0 rounded-xl border border-[#30363d] bg-[#0b1219] overflow-hidden">

            {/* Cabeçalho */}
            <div className="px-4 py-2.5 border-b border-[#30363d] flex items-center justify-between gap-3">
              <span className="text-[11px] font-bold text-[#f0f6fc] flex items-center gap-1.5 shrink-0">
                <History size={11} className="text-[#26c6da]" />
                Relatório de Operações
              </span>

              {/* Seletor de corretora — botões pill com scroll horizontal */}
              <div className="flex-1 overflow-x-auto min-w-0">
                <div className="flex items-center gap-1 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d] w-fit">
                  <button
                    onClick={() => setHistoryBroker('')}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap',
                      historyBroker === ''
                        ? 'bg-[#26c6da] text-[#0d1117]'
                        : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                    )}
                  >
                    Auto
                  </button>
                  {enabledBrokers.map(b => (
                    <button
                      key={b.id}
                      onClick={() => setHistoryBroker(b.id)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap',
                        historyBroker === b.id
                          ? 'bg-[#26c6da] text-[#0d1117]'
                          : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                      )}
                    >
                      {b.nome}
                    </button>
                  ))}
                </div>
              </div>

              {/* Filtros de período */}
              <div className="flex items-center gap-1 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d] shrink-0">
                {(['today', '7d', '30d', '3m'] as const).map(p => {
                  const labels = { today: 'Hoje', '7d': '7 dias', '30d': '30 dias', '3m': '3 meses' }
                  const active = historyPeriod === p
                  return (
                    <button
                      key={p}
                      onClick={() => setHistoryPeriod(p)}
                      disabled={historyLoading}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all disabled:opacity-50',
                        active
                          ? 'bg-[#26c6da] text-[#0d1117]'
                          : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                      )}
                    >
                      {labels[p]}
                    </button>
                  )
                })}
              </div>
              {historyLoading && (
                <div className="flex items-center gap-1.5 text-[9px] text-[#26c6da] animate-pulse shrink-0">
                  <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10">
                    <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20 6" />
                  </svg>
                  Carregando…
                </div>
              )}
            </div>

            {/* Resumo estatístico — 5 KPIs */}
            {metaHistory.length > 0 && (() => {
              const wins       = metaHistory.filter(d => d.profit > 0).length
              const losses     = metaHistory.filter(d => d.profit < 0).length
              const totalPnl   = metaHistory.reduce((s, d) => s + d.profit, 0)
              const winRate    = (wins / metaHistory.length * 100).toFixed(0)
              const bestTrade  = Math.max(...metaHistory.map(d => d.profit))
              const worstTrade = Math.min(...metaHistory.map(d => d.profit))
              return (
                <div className="grid grid-cols-5 border-b border-[#30363d]">
                  {[
                    { label: 'Operações', value: String(metaHistory.length), sub: `${wins}G · ${losses}P`, color: '#8b949e' },
                    { label: 'Lucro Total', value: `${liveTotalPnl >= 0 ? '+'  : ''}${totalPnl.toFixed(2)}`, sub: 'USD', color: totalPnl >= 0 ? '#22c55e' : '#ef4444' },
                    { label: 'Win Rate', value: `${winRate}%`, sub: `${wins} wins`, color: Number(winRate) >= 50 ? '#22c55e' : '#ef4444' },
                    { label: 'Melhor', value: `+${bestTrade.toFixed(2)}`, sub: 'USD', color: '#22c55e' },
                    { label: 'Pior', value: worstTrade.toFixed(2), sub: 'USD', color: '#ef4444' },
                  ].map((s, i) => (
                    <div key={s.label} className={cn('flex flex-col items-center py-3 px-2', i < 4 && 'border-r border-[#21262d]')}>
                      <span className="text-[8px] text-[#484f58] uppercase tracking-widest mb-1">{s.label}</span>
                      <span className="text-[13px] font-mono font-bold leading-none" style={{ color: s.color }}>{s.value}</span>
                      <span className="text-[8px] text-[#484f58] mt-1">{s.sub}</span>
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Estado vazio */}
            {metaHistory.length === 0 && !historyLoading && (
              <div className="px-4 py-6 text-center">
                <span className="text-[10px] text-[#484f58]">Nenhuma operação fechada no período selecionado</span>
              </div>
            )}

            {/* Tabela de operações agrupada por corretora */}
            {metaHistory.length > 0 && (
              <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                <table className="w-full text-[10px] border-collapse">
                  <thead className="sticky top-0 z-10 bg-[#0d1117]">
                    <tr className="border-b border-[#30363d]">
                      {['Resultado', 'Par', 'Direção', 'Lote', 'Entrada', 'Saída', 'Lucro (USD)', 'Data · Hora'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[8px] font-semibold text-[#484f58] uppercase tracking-widest whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(historyGroups.length > 0 ? historyGroups : [{ rank: 0, brokerId: '', nome: '', trades: metaHistory }]).map(group => (
                      <>
                        {/* Linha-cabeçalho da corretora */}
                        <tr key={`hdr-${group.brokerId}`} className="bg-[#161b22] border-y border-[#21262d]">
                          <td colSpan={8} className="px-3 py-1.5">
                            <span className="flex items-center gap-1.5">
                              {group.rank === 1 && <span className="text-[11px]">🏆</span>}
                              {group.rank > 1 && (
                                <span className="text-[9px] font-bold text-[#484f58]">#{group.rank}</span>
                              )}
                              <span className="text-[10px] font-bold text-[#26c6da]">{group.nome}</span>
                              {group.rank === 1 && (
                                <span className="text-[8px] text-[#484f58]">· #1 do ranking</span>
                              )}
                              <span className="ml-auto text-[8px] text-[#484f58]">{group.trades.length} op.</span>
                            </span>
                          </td>
                        </tr>
                        {/* Aviso quando conta MetaAPI está desconectada */}
                        {group.fetchError && group.trades.length === 0 && (
                          <tr key={`err-${group.brokerId}`}>
                            <td colSpan={8} className="px-3 py-2">
                              <span className="text-[10px] text-amber-400/80">
                                ⚠ Conta desconectada no MetaAPI — reconecte o MetaAPI para ver o histórico desta corretora
                              </span>
                            </td>
                          </tr>
                        )}
                        {/* Trades da corretora */}
                        {group.trades.map(deal => {
                          const isBuy  = deal.direction === 'buy'
                          const isWin  = deal.profit > 0
                          const isLoss = deal.profit < 0
                          const color  = isWin ? '#22c55e' : isLoss ? '#ef4444' : '#8b949e'
                          const dt     = new Date(deal.time)
                          const fDate  = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
                          const fTime  = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                          return (
                            <tr key={deal.id} className="hover:bg-[#161b22] transition-colors divide-y divide-[#21262d]/50" style={{ borderLeft: `2px solid ${color}35` }}>
                              <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold" style={{ background: `${color}15`, color }}>
                                  {isWin ? '✓ TP' : isLoss ? '✕ SL' : '— FEC'}
                                </span>
                              </td>
                              <td className="px-3 py-2 font-semibold text-[#f0f6fc] whitespace-nowrap">{deal.symbol}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <span className={cn('font-bold', isBuy ? 'text-[#3b82f6]' : 'text-[#f59e0b]')}>
                                  {isBuy ? '▲ BUY' : '▼ SELL'}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-[#8b949e] font-mono">{deal.volume}</td>
                              <td className="px-3 py-2 font-mono text-[#8b949e] whitespace-nowrap">{deal.entryPrice?.toFixed(5) ?? '—'}</td>
                              <td className="px-3 py-2 font-mono text-[#8b949e] whitespace-nowrap">{deal.price?.toFixed(5) ?? '—'}</td>
                              <td className="px-3 py-2 font-mono font-bold whitespace-nowrap" style={{ color }}>
                                {deal.profit > 0 ? '+' : ''}{deal.profit.toFixed(2)}
                              </td>
                              <td className="px-3 py-2 text-[#484f58] whitespace-nowrap font-mono">
                                {fDate} <span className="text-[#30363d]">·</span> {fTime}
                              </td>
                            </tr>
                          )
                        })}
                      </>
                    ))}
                  </tbody>
                  {/* Rodapé com totais */}
                  <tfoot className="sticky bottom-0 bg-[#0d1117] border-t border-[#30363d]">
                    <tr>
                      <td colSpan={6} className="px-3 py-2 text-[9px] text-[#484f58]">
                        {metaHistory.length} operações
                      </td>
                      <td className="px-3 py-2 font-mono font-bold text-[10px]" style={{
                        color: metaHistory.reduce((s, d) => s + d.profit, 0) >= 0 ? '#22c55e' : '#ef4444'
                      }}>
                        {(() => { const t = metaHistory.reduce((s, d) => s + d.profit, 0); return `${t >= 0 ? '+' : ''}${t.toFixed(2)}` })()}
                      </td>
                      <td className="px-3 py-2 text-[9px] text-[#484f58]">total</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Rodapé informativo — oculto em mobile */}
        <div className={cn(
          'hidden md:flex shrink-0 items-center gap-3 text-[10px] text-[#484f58] px-1',
          trades.length > 0 && 'text-[#8b949e]',
        )}>
          <span>
            {trades.length > 0
              ? `${trades.length} ordem${trades.length > 1 ? 'ns' : ''} OCO executada${trades.length > 1 ? 's' : ''} no gráfico`
              : 'Arraste as linhas OCO no gráfico e clique COMPRA ou VENDA para executar'}
          </span>
          {srLevels.length > 0 && (
            <span className="ml-auto">
              {srLevels.filter(l => l.type === 'resistance').length} resistências ·{' '}
              {srLevels.filter(l => l.type === 'support').length} suportes detectados
            </span>
          )}
        </div>
      </div>

      {/* ── Sidebar inteligente — oculta em mobile, acessível pela aba Operação ── */}
      <SessionSidebar
        trades={trades}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onUpdate={handleUpdate}
        lastPrice={lastPrice}
        lastCandleTime={lastTime}
        externalEntry={clickedEntry}
        freeMargin={metaAccount?.freeMargin ?? null}
        livePrice={livePrice}
        balance={consolidatedBalance ?? metaAccount?.balance ?? null}
        brokerCount={consolidatedBalance && enabledBrokers.length > 1 ? enabledBrokers.length : undefined}
        discipline={disciplineState}
        rafiValue={currentRafiValue}
        bbExpanding={currentBbExpanding}
        checkin={checkin}
        targets={metaConnected ? targetMetrics : null}
      />

      {/* ── Barra de abas mobile ──────────────────────────────────────── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-[60px] bg-[#161b22] border-t border-[#30363d] flex z-20">
        {([
          { id: 'chart',     Icon: BarChart2, label: 'Gráfico',   badge: 0 },
          { id: 'positions', Icon: Layers,    label: 'Posições',  badge: metaConnected && totalPositionCount > 0 ? totalPositionCount : 0 },
          { id: 'trade',     Icon: Crosshair, label: 'Operação',  badge: 0 },
          { id: 'history',   Icon: History,   label: 'Histórico', badge: 0 },
        ] as Array<{ id: 'chart'|'positions'|'trade'|'history'; Icon: any; label: string; badge: number }>).map(({ id, Icon, label, badge }) => (
          <button
            key={id}
            onClick={() => setMobileTab(id as any)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 relative pt-1"
          >
            <Icon size={20} className={cn(mobileTab === id ? 'text-[#26c6da]' : 'text-[#484f58]')} />
            <span className={cn('text-[9px] font-medium', mobileTab === id ? 'text-[#26c6da]' : 'text-[#484f58]')}>{label}</span>
            {badge ? (
              <span className="absolute top-1.5 left-[calc(50%+6px)] bg-[#22c55e] text-[#0d1117] text-[8px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ── Bottom sheet: Operação ──────────────────────────────────── */}
      <div className={cn(
        'md:hidden fixed bottom-[60px] left-0 right-0 bg-[#161b22] border-t border-[#30363d] rounded-t-2xl z-20 transition-transform duration-300 max-h-[78vh] overflow-y-auto overscroll-contain',
        mobileTab === 'trade' ? 'translate-y-0' : 'translate-y-full pointer-events-none',
      )}>
        <div className="w-10 h-1 bg-[#30363d] rounded-full mx-auto mt-3 mb-1 shrink-0" />
        <TradePanel
          trades={trades}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onUpdate={handleUpdate}
          lastPrice={lastPrice}
          lastCandleTime={lastTime}
          externalEntry={clickedEntry}
          freeMargin={metaAccount?.freeMargin ?? null}
          livePrice={livePrice}
          locked={metaConnected ? targetMetrics.locked : false}
        />
      </div>

      {/* ── Bottom sheet: Posições ──────────────────────────────────── */}
      <div className={cn(
        'md:hidden fixed bottom-[60px] left-0 right-0 bg-[#161b22] border-t border-[#30363d] rounded-t-2xl z-20 transition-transform duration-300 max-h-[78vh] overflow-y-auto overscroll-contain',
        mobileTab === 'positions' ? 'translate-y-0' : 'translate-y-full pointer-events-none',
      )}>
        <div className="w-10 h-1 bg-[#30363d] rounded-full mx-auto mt-3 mb-2 shrink-0" />
        <div className="px-4 py-2 border-b border-[#30363d] flex items-center justify-between">
          <span className="text-[11px] font-semibold text-[#8b949e] uppercase tracking-wider flex items-center gap-1.5">
            Posições Abertas
            {allBrokerPositions.length > 1 && (
              <span className="text-[#484f58] font-normal normal-case text-[10px]">· {allBrokerPositions.length} corretoras</span>
            )}
          </span>
          {(flatBrokerPositions.length > 0 || metaPositions.length > 0) && (
            <span className={cn('text-[11px] font-mono font-bold', liveTotalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
              P&amp;L líq. {liveTotalPnl >= 0 ? '+' : ''}{liveTotalPnl.toFixed(2)} USD
            </span>
          )}
        </div>
        {!metaConnected ? (
          <div className="px-4 py-10 text-center text-[12px] text-[#484f58]">
            Conecte o MetaAPI para ver posições ao vivo
          </div>
        ) : (flatBrokerPositions.length === 0 && metaPositions.length === 0) ? (
          <div className="px-4 py-10 text-center text-[12px] text-[#484f58]">
            Nenhuma posição aberta no momento
          </div>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {(flatBrokerPositions.length > 0
              ? flatBrokerPositions
              : metaPositions.map(p => ({ ...p, brokerId: '', brokerNome: routeBroker?.nome ?? '', rank: 1 }))
            ).map(pos => {
              const isBuy     = pos.type === 'POSITION_TYPE_BUY'
              const pnlColor  = pos.profit >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
              const isEditing = editingPos?.id === pos.id
              return (
                <div key={`${pos.brokerId}-${pos.id}`} className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    {brokerBadge(pos.brokerId, pos.brokerNome)}
                    <span className={cn('font-bold text-sm', isBuy ? 'text-[#22c55e]' : 'text-[#ef4444]')}>
                      {isBuy ? '▲' : '▼'}
                    </span>
                    <span className="font-bold text-sm text-[#f0f6fc]">{pos.symbol}</span>
                    <span className="text-[11px] text-[#8b949e]">{pos.volume}L · {pos.openPrice.toFixed(5)}</span>
                    <span className={cn('font-mono font-bold text-sm ml-auto', pnlColor)}>
                      {pos.profit >= 0 ? '+' : ''}{pos.profit.toFixed(2)} USD
                    </span>
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-3 mb-2 text-[11px]">
                      <span className="text-[#484f58]">SL <span className="font-mono text-[#ef4444]">{pos.stopLoss?.toFixed(5) ?? '—'}</span></span>
                      <span className="text-[#484f58]">TP <span className="font-mono text-[#22c55e]">{pos.takeProfit?.toFixed(5) ?? '—'}</span></span>
                    </div>
                  )}
                  {isEditing && editingPos && (() => {
                    const slVal = parseFloat(editingPos.sl)
                    const tpVal = parseFloat(editingPos.tp)
                    const contractSize = 100_000
                    const slUsd = !isNaN(slVal)
                      ? (isBuy ? slVal - pos.openPrice : pos.openPrice - slVal) * pos.volume * contractSize : null
                    const tpUsd = !isNaN(tpVal)
                      ? (isBuy ? tpVal - pos.openPrice : pos.openPrice - tpVal) * pos.volume * contractSize : null
                    const fmtUsd = (v: number) =>
                      (v >= 0 ? '+' : '') + v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    return (
                      <div className="space-y-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#ef4444] font-semibold w-6">SL</span>
                          <input
                            type="number" step="0.00001" value={editingPos.sl}
                            onChange={e => setEditingPos(p => p ? { ...p, sl: e.target.value } : p)}
                            className="flex-1 px-3 py-2 rounded-lg bg-[#0d1117] border border-[#ef4444]/40 text-[#ef4444] text-[13px] font-mono focus:outline-none"
                          />
                          {slUsd !== null && <span className={cn('text-[12px] font-mono font-bold w-20 text-right', slUsd >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>{fmtUsd(slUsd)}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#22c55e] font-semibold w-6">TP</span>
                          <input
                            type="number" step="0.00001" value={editingPos.tp}
                            onChange={e => setEditingPos(p => p ? { ...p, tp: e.target.value } : p)}
                            className="flex-1 px-3 py-2 rounded-lg bg-[#0d1117] border border-[#22c55e]/40 text-[#22c55e] text-[13px] font-mono focus:outline-none"
                          />
                          {tpUsd !== null && <span className={cn('text-[12px] font-mono font-bold w-20 text-right', tpUsd >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]')}>{fmtUsd(tpUsd)}</span>}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleModifyPosition(pos.id, editingPos.sl, editingPos.tp)}
                            className="flex-1 py-2 rounded-lg text-[12px] font-bold bg-[#22c55e]/15 border border-[#22c55e]/50 text-[#22c55e]"
                          >✓ Confirmar</button>
                          <button
                            onClick={() => setEditingPos(null)}
                            className="flex-1 py-2 rounded-lg text-[12px] font-semibold border border-[#30363d] text-[#484f58]"
                          >✕ Cancelar</button>
                        </div>
                      </div>
                    )
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingPos(isEditing ? null : { id: pos.id, sl: pos.stopLoss?.toFixed(5) ?? '', tp: pos.takeProfit?.toFixed(5) ?? '' })}
                      className={cn(
                        'flex-1 py-2 rounded-lg text-[12px] font-semibold border transition-colors',
                        isEditing ? 'border-[#f59e0b]/50 bg-[#f59e0b]/10 text-[#f59e0b]' : 'border-[#30363d] text-[#484f58]',
                      )}
                    >✎ Editar SL/TP</button>
                    <button
                      onClick={() => handleClosePosition(pos.id)}
                      className="flex-1 py-2 rounded-lg text-[12px] font-semibold border border-[#ef4444]/40 text-[#ef4444]"
                    ><XIcon size={12} className="inline mr-1" />Fechar</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="h-4" />
      </div>

      {/* ── Bottom sheet: Histórico ─────────────────────────────────── */}
      <div className={cn(
        'md:hidden fixed bottom-[60px] left-0 right-0 bg-[#161b22] border-t border-[#30363d] rounded-t-2xl z-20 transition-transform duration-300 max-h-[78vh] overflow-y-auto overscroll-contain',
        mobileTab === 'history' ? 'translate-y-0' : 'translate-y-full pointer-events-none',
      )}>
        <div className="w-10 h-1 bg-[#30363d] rounded-full mx-auto mt-3 mb-2 shrink-0" />
        <div className="px-4 py-2 border-b border-[#30363d] flex items-center justify-between gap-3">
          <span className="text-[12px] font-bold text-[#f0f6fc] flex items-center gap-1.5 shrink-0">
            <History size={12} className="text-[#26c6da]" /> Relatório
          </span>
          {enabledBrokers.length > 0 && (
            <div className="flex-1 overflow-x-auto min-w-0">
              <div className="flex items-center gap-1 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d] w-fit">
                <button
                  onClick={() => setHistoryBroker('')}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap',
                    historyBroker === ''
                      ? 'bg-[#26c6da] text-[#0d1117]'
                      : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                  )}
                >
                  Auto
                </button>
                {enabledBrokers.map(b => (
                  <button
                    key={b.id}
                    onClick={() => setHistoryBroker(b.id)}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap',
                      historyBroker === b.id
                        ? 'bg-[#26c6da] text-[#0d1117]'
                        : 'text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d]',
                    )}
                  >
                    {b.nome}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d] shrink-0">
            {(['today', '7d', '30d', '3m'] as const).map(p => {
              const labels = { today: 'Hoje', '7d': '7d', '30d': '30d', '3m': '3m' }
              return (
                <button
                  key={p}
                  onClick={() => setHistoryPeriod(p)}
                  disabled={historyLoading}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all disabled:opacity-50',
                    historyPeriod === p ? 'bg-[#26c6da] text-[#0d1117]' : 'text-[#484f58] hover:text-[#8b949e]',
                  )}
                >{labels[p]}</button>
              )
            })}
          </div>
        </div>
        {!metaConnected ? (
          <div className="px-4 py-10 text-center text-[12px] text-[#484f58]">Conecte o MetaAPI para ver o histórico</div>
        ) : historyLoading ? (
          <div className="px-4 py-10 text-center text-[12px] text-[#26c6da] animate-pulse">Carregando…</div>
        ) : metaHistory.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-[#484f58]">Nenhuma operação fechada no período</div>
        ) : (
          <>
            {/* KPIs compactos */}
            {(() => {
              const wins     = metaHistory.filter(d => d.profit > 0).length
              const losses   = metaHistory.filter(d => d.profit < 0).length
              const tot      = metaHistory.reduce((s, d) => s + d.profit, 0)
              const wr       = (wins / metaHistory.length * 100).toFixed(0)
              return (
                <div className="grid grid-cols-3 border-b border-[#30363d]">
                  {[
                    { label: 'Operações', val: String(metaHistory.length), sub: `${wins}G · ${losses}P`, c: '#8b949e' },
                    { label: 'Lucro',     val: `${tot >= 0 ? '+' : ''}${tot.toFixed(2)}`, sub: 'USD', c: tot >= 0 ? '#22c55e' : '#ef4444' },
                    { label: 'Win Rate',  val: `${wr}%`, sub: `${wins} wins`, c: Number(wr) >= 50 ? '#22c55e' : '#ef4444' },
                  ].map((s, i) => (
                    <div key={s.label} className={cn('flex flex-col items-center py-3 px-2', i < 2 && 'border-r border-[#21262d]')}>
                      <span className="text-[8px] text-[#484f58] uppercase tracking-widest mb-1">{s.label}</span>
                      <span className="text-[14px] font-mono font-bold leading-none" style={{ color: s.c }}>{s.val}</span>
                      <span className="text-[8px] text-[#484f58] mt-1">{s.sub}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
            {/* Lista de trades */}
            <div className="divide-y divide-[#21262d]">
              {metaHistory.map(deal => {
                const isBuy  = deal.direction === 'buy'
                const isWin  = deal.profit > 0
                const isLoss = deal.profit < 0
                const color  = isWin ? '#22c55e' : isLoss ? '#ef4444' : '#8b949e'
                const dt     = new Date(deal.time)
                const fmtDate = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
                const fmtTime = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                return (
                  <div key={deal.id} className="px-4 py-3 flex items-center gap-3" style={{ borderLeft: `3px solid ${color}40` }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-bold text-[12px] text-[#f0f6fc]">{deal.symbol}</span>
                        <span className={cn('text-[10px] font-bold', isBuy ? 'text-[#3b82f6]' : 'text-[#f59e0b]')}>
                          {isBuy ? '▲ BUY' : '▼ SELL'}
                        </span>
                        <span className="ml-auto text-[11px] font-mono" style={{ color }}>
                          {isWin ? '✓ TP' : isLoss ? '✕ SL' : '— FEC'}
                        </span>
                      </div>
                      <div className="text-[10px] text-[#484f58] font-mono">{fmtDate} {fmtTime} · {deal.volume}L</div>
                    </div>
                    <span className="font-mono font-bold text-[14px] shrink-0" style={{ color }}>
                      {deal.profit > 0 ? '+' : ''}{deal.profit.toFixed(2)}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div className="h-4" />
      </div>

      {/* Feature 5: alertas do bot — posições abertas/fechadas automaticamente */}
      {botAlerts.length > 0 && (
        <div className="fixed top-16 right-4 flex flex-col gap-1.5 z-40 pointer-events-none">
          {botAlerts.map(alert => (
            <div
              key={alert.id}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-semibold shadow-lg',
                alert.kind === 'open'
                  ? 'bg-[#0d1117] border border-[#22c55e]/40 text-[#22c55e]'
                  : 'bg-[#0d1117] border border-[#ef4444]/40 text-[#ef4444]',
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0"
                style={{ background: alert.kind === 'open' ? '#22c55e' : '#ef4444' }} />
              <span>{alert.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Feature 3: toast de feedback ao executar ordem OCO via MetaAPI */}
      {orderToast && (
        <div className={cn(
          'fixed bottom-[76px] md:bottom-6 right-4 md:right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-2xl border text-[11px] font-semibold max-w-xs',
          orderToast.ok
            ? 'bg-[#0d1117] border-[#22c55e]/50 text-[#22c55e]'
            : 'bg-[#0d1117] border-[#ef4444]/50 text-[#ef4444]',
        )}>
          <span className={cn(
            'w-2 h-2 rounded-full inline-block shrink-0',
            orderToast.ok ? 'bg-[#22c55e]' : 'bg-[#ef4444]',
          )} />
          <span>{orderToast.msg}</span>
        </div>
      )}

      {/* IA Suggestion Modal — pop-up de entrada sugerida pela IA */}
      {showIASuggestion && iaSuggestion && (
        <IASuggestionModal
          suggestion={iaSuggestion}
          onAuthorize={async (s) => { await handleIAAuthorize(s) }}
          onDismiss={() => { setShowIASuggestion(false); setIaSuggestion(null) }}
        />
      )}

      {/* Toggle Pausar IA — canto inferior esquerdo, discreto */}
      <button
        onClick={() => setIaWatcherActive(v => !v)}
        className={cn(
          'fixed bottom-[76px] md:bottom-6 left-4 z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[9px] font-mono border transition-all',
          iaWatcherActive
            ? 'bg-[#0d1117] border-[#10b981]/30 text-[#10b981]'
            : 'bg-[#0d1117] border-[#30363d] text-[#484f58]',
        )}
        title={iaWatcherActive ? 'IA ativa — clique para pausar' : 'IA pausada — clique para reativar'}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', iaWatcherActive ? 'bg-[#10b981] animate-pulse' : 'bg-[#484f58]')} />
        {iaWatcherActive ? 'IA ativa' : 'IA pausada'}
      </button>
    </div>
  )
}
