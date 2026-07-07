'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoData, type Timeframe } from '@/lib/demo-data'
import { calcRAFI, calcSRLevels, calcBollingerBands } from '@/lib/indicators'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { type OCOState } from '@/components/oco-overlay'
import { cn, formatPrice } from '@/lib/utils'
import { Info, BarChart2, Crosshair } from 'lucide-react'

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

// Defaults OCO: 0.20L, SL=$5, TP=$15
const OCO_LOT      = 0.20
const OCO_LEVERAGE = 1000
const OCO_PV       = OCO_LOT * 10          // $2/pip
const OCO_SL_OFF   = (5  / OCO_PV) * 0.0001  // 2.5 pips = 0.00025
const OCO_TP_OFF   = (15 / OCO_PV) * 0.0001  // 7.5 pips = 0.00075

function makeOCO(price: number): OCOState {
  const p = (v: number) => Math.round(v * 100000) / 100000
  return {
    lot:       OCO_LOT,
    leverage:  OCO_LEVERAGE,
    direction: 'buy',
    entry:     p(price),
    sl:        p(price - OCO_SL_OFF),
    tp:        p(price + OCO_TP_OFF),
  }
}

const STORAGE_KEY = 'rafi-trade-log'

export default function ChartPage() {
  const [trades,       setTrades]       = useState<ManualTrade[]>([])
  const [tf,           setTf]           = useState<Timeframe>('M5')
  const [clickedEntry, setClickedEntry] = useState<number | null>(null)
  const [ocoState,     setOcoState]     = useState<OCOState | null>(null)
  const [ocoVisible,   setOcoVisible]   = useState(true)

  // Carrega trades salvos do localStorage na inicialização
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) setTrades(parsed)
      }
    } catch {}
  }, [])

  // Salva trades no localStorage sempre que mudam
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)) } catch {}
  }, [trades])

  const candles  = useMemo(() => generateDemoData(tf),        [tf])
  const rafiData = useMemo(() => calcRAFI(candles),           [candles])
  const srLevels = useMemo(() => calcSRLevels(candles),       [candles])
  const bbBands  = useMemo(() => calcBollingerBands(candles), [candles])

  const lastCandle = candles[candles.length - 1]
  const lastPrice  = lastCandle?.close ?? 0
  const lastTime   = lastCandle?.time  ?? 0

  // RAFI sempre positivo: separa por dir do candle
  const strongBullBars = rafiData.filter(p => p.value >= 2.5 && p.dir === 'bull').length
  const strongBearBars = rafiData.filter(p => p.value >= 2.5 && p.dir === 'bear').length

  // Inicializa/reseta OCO quando o timeframe muda (lastPrice muda junto)
  useEffect(() => {
    if (lastPrice > 0) {
      setOcoState(makeOCO(lastPrice))
      setOcoVisible(true)
    }
  }, [lastPrice])

  const handleAdd    = useCallback((t: ManualTrade) => setTrades(p => [...p, t]),    [])
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
      time:       lastTime,
      lot:        ocoState.lot,
      leverage:   ocoState.leverage,
      result:     'pending',
      rafi:       lastRafi?.value,
      rafiDir:    lastRafi?.dir,
      bbWidth,
    })
    setOcoState(prev => prev ? { ...prev, direction, tp: p(tp), sl: p(sl) } : null)
  }, [ocoState, lastTime, rafiData, bbBands, handleAdd])

  const handleOCOClose = useCallback(() => setOcoVisible(false), [])

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Área do gráfico ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 p-4 gap-3">

        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-bold text-[#f0f6fc]">Análise RAFI</h1>
            <p className="text-xs text-[#8b949e] mt-0.5">
              EURUSD · {tf} · Semana demo
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
              <div className="flex items-center gap-0.5 bg-[#0d1117] rounded-lg p-0.5 border border-[#30363d]">
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

              <span className="text-[#30363d]">|</span>
              <span className="text-[#f0f6fc] font-medium">EURUSD {tf}</span>
              <span className="text-[#484f58]">{candles.length} candles</span>

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

              {/* Botão OCO */}
              <button
                onClick={() => {
                  if (!ocoVisible && ocoState) {
                    setOcoVisible(true)
                  } else if (!ocoVisible) {
                    setOcoState(makeOCO(lastPrice))
                    setOcoVisible(true)
                  } else {
                    setOcoVisible(false)
                  }
                }}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-all',
                  ocoVisible
                    ? 'bg-[#f59e0b]/15 border-[#f59e0b]/40 text-[#f59e0b]'
                    : 'text-[#484f58] border-[#30363d] hover:text-[#8b949e] hover:bg-[#21262d]',
                )}
              >
                <Crosshair size={10} />
                OCO
                {ocoVisible && <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] inline-block" />}
              </button>
            </div>

            <div className="flex items-center gap-1 text-[10px] text-[#484f58]">
              <Info size={10} />
              Arraste para navegar · scroll para zoom
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
              onPriceClick={setClickedEntry}
              ocoState={ocoVisible ? ocoState : null}
              onOCOChange={setOcoState}
              onOCOExecute={handleOCOExecute}
              onOCOClose={handleOCOClose}
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
