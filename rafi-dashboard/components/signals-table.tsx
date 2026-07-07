import { cn, formatPrice, formatTime, formatPips } from '@/lib/utils'
import type { TradeSignal } from '@/lib/types'
import { ArrowUpCircle, ArrowDownCircle, CheckCircle2, XCircle, Clock } from 'lucide-react'

interface Props { signals: TradeSignal[] }

export function SignalsTable({ signals }: Props) {
  const reversed = [...signals].reverse()

  return (
    <div className="rounded-xl border border-[#30363d] bg-[#161b22] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#f0f6fc]">Histórico de Trades</h3>
        <span className="text-xs text-[#8b949e]">{signals.length} trades</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#21262d] text-[#8b949e]">
              <th className="px-4 py-2.5 text-left font-medium">#</th>
              <th className="px-4 py-2.5 text-left font-medium">Entrada</th>
              <th className="px-4 py-2.5 text-left font-medium">Direção</th>
              <th className="px-4 py-2.5 text-right font-medium">Preço</th>
              <th className="px-4 py-2.5 text-right font-medium">SL</th>
              <th className="px-4 py-2.5 text-right font-medium">TP</th>
              <th className="px-4 py-2.5 text-right font-medium">Risco</th>
              <th className="px-4 py-2.5 text-right font-medium">Resultado</th>
              <th className="px-4 py-2.5 text-center font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {reversed.map((s, idx) => {
              const isWin  = s.outcome === 'win'
              const isLoss = s.outcome === 'loss'
              const isOpen = s.outcome === 'open'
              const isBuy  = s.direction === 'buy'

              return (
                <tr
                  key={s.id}
                  className={cn(
                    'border-b border-[#21262d] last:border-0 hover:bg-[#1c2128] transition-colors',
                    isWin  && 'bg-emerald-500/5',
                    isLoss && 'bg-red-500/5',
                  )}
                >
                  <td className="px-4 py-3 text-[#484f58] mono">{signals.length - idx}</td>
                  <td className="px-4 py-3 text-[#8b949e]">{formatTime(s.time)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {isBuy
                        ? <ArrowUpCircle size={13} className="text-emerald-400" />
                        : <ArrowDownCircle size={13} className="text-red-400" />}
                      <span className={cn(
                        'font-semibold',
                        isBuy ? 'text-emerald-400' : 'text-red-400',
                      )}>
                        {isBuy ? 'COMPRA' : 'VENDA'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right mono text-[#f0f6fc]">
                    {formatPrice(s.entry)}
                  </td>
                  <td className="px-4 py-3 text-right mono text-red-400">
                    {formatPrice(s.stopLoss)}
                  </td>
                  <td className="px-4 py-3 text-right mono text-emerald-400">
                    {formatPrice(s.takeProfit)}
                  </td>
                  <td className="px-4 py-3 text-right mono text-[#8b949e]">
                    {s.riskPips}p
                  </td>
                  <td className={cn(
                    'px-4 py-3 text-right mono font-semibold',
                    isWin  ? 'text-emerald-400' :
                    isLoss ? 'text-red-400'     :
                    'text-[#8b949e]',
                  )}>
                    {isOpen ? '—' : formatPips(s.pnlPips)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {isWin  && <CheckCircle2   size={15} className="text-emerald-400 mx-auto" />}
                    {isLoss && <XCircle        size={15} className="text-red-400     mx-auto" />}
                    {isOpen && <Clock          size={15} className="text-amber-400   mx-auto" />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {signals.length === 0 && (
          <div className="py-12 text-center text-[#484f58] text-sm">
            Nenhum trade encontrado com os parâmetros atuais
          </div>
        )}
      </div>
    </div>
  )
}
