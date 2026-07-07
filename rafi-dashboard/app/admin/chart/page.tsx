'use client'

import { useState, useMemo, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoData, type Timeframe } from '@/lib/demo-data'
import { calcRAFI, calcSRLevels, calcBollingerBands } from '@/lib/indicators'
import { TradePanel, type ManualTrade } from '@/components/trade-panel'
import { cn, formatPrice } from '@/lib/utils'
import { Info, BarChart2 } from 'lucide-react'

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

export default function ChartPage() {
  const [trades, setTrades] = useState<ManualTrade[]>([])
  const [tf, setTf]         = useState<Timeframe>('M5')

  const candles  = useMemo(() => generateDemoData(tf),          [tf])
  const rafiData = useMemo(() => calcRAFI(candles),             [candles])
  const srLevels = useMemo(() => calcSRLevels(candles),         [candles])
  const bbBands  = useMemo(() => calcBollingerBands(candles),   [candles])

  const lastCandle = candles[candles.length - 1]
  const lastPrice  = lastCandle?.close ?? 0
  const lastTime   = lastCandle?.time  ?? 0

  const strongBullBars = rafiData.filter(p => p.value >=  2.5).length
  const strongBearBars = rafiData.filter(p => p.value <= -2.5).length

  const handleAdd    = useCallback((t: ManualTrade) => setTrades(p => [...p, t]),    [])
  const handleRemove = useCallback((id: string)     => setTrades(p => p.filter(t => t.id !== id)), [])

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
                <span className="w-2.5 h-2.5 rounded-sm bg-[#f59e0b] inline-block" />
                <span className="text-[#f59e0b]">RAFI &gt; +2.5</span>
                <span className="text-[#484f58]">({strongBullBars}×)</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#ef4444] inline-block" />
                <span className="text-[#ef4444]">RAFI &lt; -2.5</span>
                <span className="text-[#484f58]">({strongBearBars}×)</span>
              </span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-[#484f58]">
              <Info size={10} />
              Arraste para navegar · scroll para zoom
            </div>
          </div>

          {/* Chart: flex-1 preenche o espaço restante */}
          <div className="flex-1 min-h-0">
            <RAFIChart
              candles={candles}
              rafiData={rafiData}
              srLevels={srLevels}
              trades={trades}
              bbBands={bbBands}
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
              ? `${trades.length} trade${trades.length > 1 ? 's' : ''} anotado${trades.length > 1 ? 's' : ''} no gráfico`
              : 'Adicione trades no painel lateral para visualizá-los no gráfico com entrada, SL e TP'}
          </span>
          {srLevels.length > 0 && (
            <span className="ml-auto">
              {srLevels.filter(l => l.type === 'resistance').length} resistências ·{' '}
              {srLevels.filter(l => l.type === 'support').length} suportes detectados
            </span>
          )}
        </div>
      </div>

      {/* ── Painel de anotação ──────────────────────────────────────── */}
      <div className="w-72 shrink-0">
        <TradePanel
          trades={trades}
          onAdd={handleAdd}
          onRemove={handleRemove}
          lastPrice={lastPrice}
          lastCandleTime={lastTime}
        />
      </div>
    </div>
  )
}
