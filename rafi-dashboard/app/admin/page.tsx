'use client'

import { useState, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoWeek } from '@/lib/demo-data'
import { runRAFI } from '@/lib/rafi'
import { StatsCards } from '@/components/stats-cards'
import { SignalsTable } from '@/components/signals-table'
import { cn, formatPrice } from '@/lib/utils'
import { RefreshCw, Info, ChevronDown } from 'lucide-react'

// Chart só carrega no cliente (window dependency)
const TradingChart = dynamic(
  () => import('@/components/trading-chart').then(m => m.TradingChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
)
const EquityCurve = dynamic(
  () => import('@/components/equity-curve').then(m => m.EquityCurve),
  { ssr: false, loading: () => <div className="w-full h-full animate-pulse bg-[#161b22] rounded" /> },
)

function ChartSkeleton() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-[#0d1117] rounded-xl">
      <div className="flex flex-col items-center gap-3 text-[#484f58]">
        <RefreshCw size={20} className="animate-spin" />
        <span className="text-sm">Carregando gráfico…</span>
      </div>
    </div>
  )
}

// Parâmetros configuráveis da estratégia
const DEFAULT_CFG = {
  srLookback:        50,
  swingStopLookback: 150,
  maFast:            20,
  maSlow:            50,
  maThreshold:       0.0003,
  rrRatio:           2.0,
  spreadPips:        1.3,
  riskPct:           0.02,
  capital:           100,
}

export default function AdminDashboard() {
  const [cfg, setCfg] = useState(DEFAULT_CFG)
  const [showParams, setShowParams] = useState(false)

  const candles = useMemo(() => generateDemoWeek(), [])

  const { signals, ma20, ma50, equityCurve, stats } = useMemo(
    () => runRAFI(candles, cfg),
    [candles, cfg],
  )

  const lastPrice = candles[candles.length - 1]?.close ?? 0
  const firstTs   = candles[0]?.time ?? 0
  const lastTs    = candles[candles.length - 1]?.time ?? 0
  const dateRange = `${new Date(firstTs * 1000).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })} → ${new Date(lastTs * 1000).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}`

  return (
    <div className="flex flex-col h-full p-5 gap-4">

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-[#f0f6fc]">Dashboard RAFI</h1>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-[#8b949e]">EURUSD · M5 · {dateRange}</span>
            <span className="text-xs bg-[#21262d] border border-[#30363d] px-2 py-0.5 rounded-full text-[#8b949e] mono">
              {formatPrice(lastPrice)}
            </span>
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Demo ativo
            </span>
          </div>
        </div>

        <button
          onClick={() => setShowParams(p => !p)}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-xs border transition-all',
            showParams
              ? 'bg-[#3b82f6]/15 border-[#3b82f6]/30 text-[#3b82f6]'
              : 'bg-[#161b22] border-[#30363d] text-[#8b949e] hover:text-[#f0f6fc]',
          )}
        >
          Parâmetros
          <ChevronDown size={12} className={cn('transition-transform', showParams && 'rotate-180')} />
        </button>
      </div>

      {/* Painel de parâmetros */}
      {showParams && (
        <div className="shrink-0 rounded-xl border border-[#30363d] bg-[#161b22] p-4">
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3">
            {[
              { key: 'srLookback',        label: 'SR Lookback',   step: 10, min: 10,   max: 200,  dec: 0 },
              { key: 'swingStopLookback', label: 'Swing Stop',    step: 10, min: 20,   max: 500,  dec: 0 },
              { key: 'maFast',            label: 'MA Rápida',     step: 1,  min: 5,    max: 50,   dec: 0 },
              { key: 'maSlow',            label: 'MA Lenta',      step: 5,  min: 20,   max: 200,  dec: 0 },
              { key: 'maThreshold',       label: 'MA Threshold',  step: 0.0001, min: 0, max: 0.002, dec: 4 },
              { key: 'rrRatio',           label: 'R:R Ratio',     step: 0.5, min: 1,   max: 5,    dec: 1 },
              { key: 'spreadPips',        label: 'Spread (pips)', step: 0.1, min: 0.5, max: 3,    dec: 1 },
              { key: 'riskPct',           label: 'Risco %',       step: 0.01, min: 0.01, max: 0.20, dec: 2 },
              { key: 'capital',           label: 'Capital $',     step: 50, min: 50,   max: 10000, dec: 0 },
            ].map(({ key, label, step, min, max, dec }) => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-[10px] text-[#484f58] uppercase tracking-wide">{label}</label>
                <input
                  type="number"
                  step={step}
                  min={min}
                  max={max}
                  value={cfg[key as keyof typeof cfg]}
                  onChange={e => setCfg(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-[#f0f6fc] mono focus:outline-none focus:border-[#3b82f6]"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5 mt-3 text-[10px] text-[#484f58]">
            <Info size={11} />
            Altere qualquer parâmetro — o backtest recalcula automaticamente.
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="shrink-0">
        <StatsCards stats={stats} capital={cfg.capital} />
      </div>

      {/* Gráfico principal */}
      <div className="flex-1 min-h-0 rounded-xl border border-[#30363d] overflow-hidden" style={{ minHeight: 380 }}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
          <div className="flex items-center gap-4 text-xs">
            <span className="text-[#f0f6fc] font-medium">EURUSD M5</span>
            <span className="flex items-center gap-1 text-[#3b82f6]">
              <span className="w-3 h-0.5 bg-[#3b82f6] inline-block" />MA{cfg.maFast}
            </span>
            <span className="flex items-center gap-1 text-[#f59e0b]">
              <span className="w-3 h-0.5 bg-[#f59e0b] inline-block" />MA{cfg.maSlow}
            </span>
            <span className="flex items-center gap-1 text-[#10b981]">
              <span className="w-3 h-0.5 bg-[#10b981] border-dashed inline-block" />Take Profit
            </span>
            <span className="flex items-center gap-1 text-[#ef4444]">
              <span className="w-3 h-0.5 bg-[#ef4444] border-dashed inline-block" />Stop Loss
            </span>
          </div>
          <span className="text-[10px] text-[#484f58]">{signals.length} sinais</span>
        </div>
        <div className="h-[calc(100%-41px)]">
          <TradingChart candles={candles} signals={signals} ma20={ma20} ma50={ma50} />
        </div>
      </div>

      {/* Bottom row: equity + tabela */}
      <div className="shrink-0 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Equity curve */}
        <div className="lg:col-span-1 rounded-xl border border-[#30363d] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between">
            <span className="text-xs font-medium text-[#f0f6fc]">Curva de Capital</span>
            <span className={cn(
              'text-xs mono font-semibold',
              stats.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400',
            )}>
              ${(cfg.capital + stats.netPnlUsd).toFixed(2)}
            </span>
          </div>
          <div className="h-[180px]">
            <EquityCurve data={equityCurve} initialCapital={cfg.capital} />
          </div>
        </div>

        {/* Tabela de trades */}
        <div className="lg:col-span-2">
          <SignalsTable signals={signals} />
        </div>
      </div>
    </div>
  )
}
