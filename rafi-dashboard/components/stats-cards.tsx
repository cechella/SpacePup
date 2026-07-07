import { cn, formatPct, formatUsd } from '@/lib/utils'
import type { BacktestStats } from '@/lib/types'
import { TrendingUp, TrendingDown, Target, BarChart2, Activity, Zap } from 'lucide-react'

interface Props { stats: BacktestStats; capital: number }

export function StatsCards({ stats, capital }: Props) {
  const returnPct = stats.netPnlUsd / (capital - stats.netPnlUsd) * 100

  const cards = [
    {
      label: 'Win Rate',
      value: formatPct(stats.winRate),
      sub:   `${stats.wins}V / ${stats.losses}P de ${stats.totalTrades} trades`,
      color: stats.winRate >= 50 ? 'green' : 'red',
      icon:  Target,
    },
    {
      label: 'Profit Factor',
      value: stats.profitFactor.toFixed(3),
      sub:   `Expect. ${stats.expectancyPips > 0 ? '+' : ''}${stats.expectancyPips}p/trade`,
      color: stats.profitFactor >= 1.5 ? 'green' : stats.profitFactor >= 1.0 ? 'yellow' : 'red',
      icon:  BarChart2,
    },
    {
      label: 'Resultado',
      value: formatUsd(stats.netPnlUsd),
      sub:   `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% sobre capital`,
      color: stats.netPnlUsd >= 0 ? 'green' : 'red',
      icon:  stats.netPnlUsd >= 0 ? TrendingUp : TrendingDown,
    },
    {
      label: 'Drawdown Máx.',
      value: formatUsd(-stats.maxDrawdownUsd),
      sub:   `${stats.maxDrawdownPct.toFixed(1)}% do pico`,
      color: stats.maxDrawdownPct <= 15 ? 'green' : stats.maxDrawdownPct <= 30 ? 'yellow' : 'red',
      icon:  Activity,
    },
    {
      label: 'Média Ganho',
      value: `+${stats.avgWinPips}p`,
      sub:   `Média perda: -${stats.avgLossPips}p`,
      color: stats.avgWinPips > stats.avgLossPips ? 'green' : 'yellow',
      icon:  Zap,
    },
  ]

  const colorMap = {
    green:  { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400' },
    red:    { bg: 'bg-red-500/10',     border: 'border-red-500/20',     text: 'text-red-400'     },
    yellow: { bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   text: 'text-amber-400'   },
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map(({ label, value, sub, color, icon: Icon }) => {
        const c = colorMap[color as keyof typeof colorMap]
        return (
          <div
            key={label}
            className={cn(
              'rounded-xl border p-4 flex flex-col gap-2',
              'bg-[#161b22]', c.border,
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#8b949e] font-medium tracking-wide uppercase">
                {label}
              </span>
              <div className={cn('p-1.5 rounded-lg', c.bg)}>
                <Icon size={13} className={c.text} />
              </div>
            </div>
            <div className={cn('text-2xl font-bold mono', c.text)}>{value}</div>
            <div className="text-xs text-[#484f58]">{sub}</div>
          </div>
        )
      })}
    </div>
  )
}
