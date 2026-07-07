'use client'

import { useMemo } from 'react'
import dynamic from 'next/dynamic'
import { generateDemoWeek } from '@/lib/demo-data'
import { runRAFI } from '@/lib/rafi'
import { StatsCards } from '@/components/stats-cards'
import { SignalsTable } from '@/components/signals-table'
import { cn, formatUsd } from '@/lib/utils'
import { RefreshCw, Shield, TrendingUp } from 'lucide-react'

const EquityCurve = dynamic(
  () => import('@/components/equity-curve').then(m => m.EquityCurve),
  { ssr: false, loading: () => <div className="w-full h-full animate-pulse bg-[#161b22] rounded" /> },
)

const CAPITAL = 100

export default function ClientDashboard() {
  const candles = useMemo(() => generateDemoWeek(), [])
  const { signals, equityCurve, stats } = useMemo(
    () => runRAFI(candles, { capital: CAPITAL, riskPct: 0.02, rrRatio: 2.0 }),
    [candles],
  )

  const capitalFinal = CAPITAL + stats.netPnlUsd
  const isProfit     = stats.netPnlUsd >= 0

  return (
    <div className="p-5 space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#f0f6fc]">Meu Portfólio</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Estratégia RAFI — EURUSD · Semana demo
          </p>
        </div>

        {/* Capital badge */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] text-[#484f58] uppercase tracking-wide">Capital atual</div>
            <div className={cn('text-xl font-bold mono', isProfit ? 'text-emerald-400' : 'text-red-400')}>
              {formatUsd(capitalFinal)}
            </div>
          </div>
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center',
            isProfit ? 'bg-emerald-500/15 border border-emerald-500/25' : 'bg-red-500/15 border border-red-500/25',
          )}>
            <TrendingUp size={18} className={isProfit ? 'text-emerald-400' : 'text-red-400'} />
          </div>
        </div>
      </div>

      {/* Stats */}
      <StatsCards stats={stats} capital={CAPITAL} />

      {/* Grid: equity + info */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Equity curve */}
        <div className="lg:col-span-2 rounded-xl border border-[#30363d] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
            <span className="text-xs font-medium text-[#f0f6fc]">Evolução do Capital</span>
          </div>
          <div className="h-[220px]">
            <EquityCurve data={equityCurve} initialCapital={CAPITAL} />
          </div>
        </div>

        {/* Risk info */}
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Shield size={14} className="text-[#3b82f6]" />
            <span className="text-xs font-semibold text-[#f0f6fc]">Gestão de Risco</span>
          </div>
          {[
            { label: 'Capital inicial',        value: `$${CAPITAL}` },
            { label: 'Risco por trade',        value: '2% do capital' },
            { label: 'Ratio risco/retorno',    value: '1:2 (R:R)' },
            { label: 'Break-even WR',          value: '~35.5%' },
            { label: 'Drawdown máximo',        value: `${stats.maxDrawdownPct}%` },
            { label: 'Spread incluído',        value: '1.3 pips' },
            { label: 'Trades simultâneos',     value: '1 posição' },
            { label: 'Stop-loss',              value: 'Estrutural (swing)' },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between text-xs">
              <span className="text-[#484f58]">{label}</span>
              <span className="text-[#8b949e] mono">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Trade history */}
      <SignalsTable signals={signals} />
    </div>
  )
}
