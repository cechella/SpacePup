'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoData, type Timeframe } from '@/lib/demo-data'
import { calcRAFI, calcSRLevels, calcBollingerBands, autoScanBreakouts } from '@/lib/indicators'
import { parseCSV, detectTimeframe, fmtDate, type LoadResult } from '@/lib/csv-loader'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { type OCOState } from '@/components/oco-overlay'
import { cn, formatPrice } from '@/lib/utils'
import { getLotForCapital, getNextTier, calcCapital } from '@/lib/lot-scaling'
import { upsertTrade, fetchTrades, fetchCandles, countCandles } from '@/lib/trades-db'
import { Info, BarChart2, Crosshair, FolderOpen, X as XIcon, Hand, Layers, ScanLine, History, ChevronDown, Trash2, Database } from 'lucide-react'
import type { CandleData } from '@/lib/types'
import { generateTradeSnapshot } from '@/lib/trade-snapshot'

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
function makeOCO(price: number, lot: number, time?: number): OCOState {
  const p    = (v: number) => Math.round(v * 100000) / 100000
  const pv   = lot * 10          // pip value em USD
  const slOff = (5  / pv) * 0.0001  // ~2.5 pips fixos
  const tpOff = (15 / pv) * 0.0001  // ~7.5 pips fixos
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

const STORAGE_KEY     = 'rafi-trade-log'
const CSV_HISTORY_KEY = 'rafi-csv-history'
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
  const fileInputRef        = useRef<HTMLInputElement>(null)
  const historyPanelRef     = useRef<HTMLDivElement>(null)
  const snapshotCaptureRef  = useRef<((entryTime: number, oco?: { entry: number; sl: number; tp: number; direction: 'buy' | 'sell' }) => string | null) | null>(null)

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

  // RAFI sempre positivo: separa por dir do candle
  const strongBullBars = rafiData.filter(p => p.value >= 2.5 && p.dir === 'bull').length
  const strongBearBars = rafiData.filter(p => p.value >= 2.5 && p.dir === 'bear').length

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

  const handleAdd = useCallback((t: ManualTrade) => {
    setTrades(p => [...p, t])
    upsertTrade(t as any).catch((err) => console.error('[Supabase] upsertTrade:', err))
  }, [])
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

    handleAdd({
      id:         `${Date.now()}-oco-${Math.random().toString(36).slice(2, 5)}`,
      direction,
      entry:      p(entry),
      stopLoss:   p(sl),
      takeProfit: p(tp),
      label:      `OCO ${direction === 'buy' ? '▲ COMPRA' : '▼ VENDA'} @ ${formatPrice(entry)} | ${ocoState.lot.toFixed(2)}L`,
      time:       ocoState.entryTime ?? lastTime,
      lot:        ocoState.lot,
      leverage:   ocoState.leverage,
      result:     'pending',
      rafi:       lastRafi?.value,
      rafiDir:    lastRafi?.dir,
      bbWidth,
      snapshot:   snapshotCaptureRef.current?.(ocoState.entryTime ?? lastTime, { entry: p(entry), sl: p(sl), tp: p(tp), direction }) ?? undefined,
    })
    setOcoState(prev => prev ? { ...prev, direction, tp: p(tp), sl: p(sl) } : null)
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
    <div className="flex h-full overflow-hidden">

      {/* ── Área do gráfico ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 p-4 gap-3">

        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-bold text-[#f0f6fc]">Análise RAFI</h1>
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

        {/* Gráfico duplo (candles + RAFI) */}
        <div className="flex-1 min-h-0 rounded-xl border border-[#30363d] overflow-hidden flex flex-col">

          {/* Toolbar do gráfico */}
          <div className="px-4 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between shrink-0">
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

              {/* Timeframe — desabilitado quando CSV carregado */}
              <div className={cn(
                'flex items-center gap-0.5 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d]',
                csvData && 'opacity-40 pointer-events-none',
              )}>
                {TIMEFRAMES.map(t => (
                  <button
                    key={t}
                    onClick={() => { setTf(t); setTrades([]) }}
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

              {/* Botão Carregar CSV + Histórico */}
              <div className="relative flex items-center gap-1" ref={historyPanelRef}>
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
              snapshotCaptureRef={snapshotCaptureRef}
            />
          </div>
        </div>

        {/* Rodapé informativo */}
        <div className={cn(
          'shrink-0 flex items-center gap-3 text-[10px] text-[#484f58] px-1',
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

      {/* ── Painel lateral ──────────────────────────────────────────── */}
      <div className="w-80 shrink-0">
        <TradePanel
          trades={trades}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onUpdate={handleUpdate}
          lastPrice={lastPrice}
          lastCandleTime={lastTime}
          externalEntry={clickedEntry}
        />
      </div>
    </div>
  )
}
