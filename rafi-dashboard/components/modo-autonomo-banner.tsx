'use client'

import { Bot, Square, Clock, TrendingUp, TrendingDown, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AutonomoTrade {
  id:        string
  direction: 'buy' | 'sell'
  entry:     number
  lot:       number
  prob:      number
  pnl?:      number
  status:    'open' | 'win' | 'loss'
  hora:      string
}

interface Props {
  capital:     number
  metaAlvo:    number    // ex: 7 (%)
  pnlHoje:     number    // P&L acumulado das trades autônomas hoje (em $)
  sessaoAtiva: 'Londres' | 'NY' | 'aguardando'
  trades:      AutonomoTrade[]
  onPausar:    () => void
}

function sessaoInfo(sessao: string) {
  if (sessao === 'Londres') return { cor: '#4499ff', horario: '08:00–12:00 UTC' }
  if (sessao === 'NY')      return { cor: '#aa55ff', horario: '13:00–17:00 UTC' }
  return { cor: '#484f58', horario: 'Próxima: Londres 08:00 UTC' }
}

export function ModoAutonomoBanner({ capital, metaAlvo, pnlHoje, sessaoAtiva, trades, onPausar }: Props) {
  const metaUsd  = capital * (metaAlvo / 100)
  const pct      = metaUsd > 0 ? Math.min(Math.round(pnlHoje / metaUsd * 100), 100) : 0
  const sess     = sessaoInfo(sessaoAtiva)
  const atingiu  = pct >= 100

  return (
    <div className={cn(
      'w-full border-b px-4 py-2.5 flex items-center gap-4 flex-wrap',
      atingiu
        ? 'bg-[#10b981]/10 border-[#10b981]/30'
        : 'bg-[#161b22] border-[#f59e0b]/25',
    )}>

      {/* Indicador */}
      <div className="flex items-center gap-2 shrink-0">
        <span className={cn(
          'w-2 h-2 rounded-full shrink-0',
          atingiu ? 'bg-[#10b981]' : 'bg-[#f59e0b] animate-pulse',
        )} />
        <Bot size={14} className={atingiu ? 'text-[#10b981]' : 'text-[#f59e0b]'} />
        <span className={cn('text-xs font-black', atingiu ? 'text-[#10b981]' : 'text-[#f59e0b]')}>
          {atingiu ? 'META ATINGIDA' : 'IA OPERANDO'}
        </span>
      </div>

      {/* Progresso da meta */}
      <div className="flex items-center gap-2 min-w-[140px]">
        <div className="flex-1 h-1.5 bg-[#21262d] rounded-full overflow-hidden min-w-[60px]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: pct >= 100 ? '#10b981' : '#f59e0b' }}
          />
        </div>
        <span className="text-[9px] font-mono text-[#8b949e] shrink-0">
          {pnlHoje >= 0 ? '+' : ''}{pnlHoje.toFixed(2)}$ / {metaAlvo}%
        </span>
      </div>

      {/* Sessão */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Clock size={11} style={{ color: sess.cor }} />
        <span className="text-[9px] font-mono" style={{ color: sess.cor }}>
          {sessaoAtiva === 'aguardando' ? 'Aguardando sessão' : sessaoAtiva}
        </span>
        <span className="text-[8px] text-[#484f58]">{sess.horario}</span>
      </div>

      {/* Mini histórico de trades autônomos */}
      {trades.length > 0 && (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
          {trades.slice(-4).map(t => (
            <span key={t.id}
              className="text-[8px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
              style={{
                background: t.status === 'win' ? '#10b98115' : t.status === 'loss' ? '#ef444415' : '#3b82f615',
                border: `1px solid ${t.status === 'win' ? '#10b98130' : t.status === 'loss' ? '#ef444430' : '#3b82f630'}`,
                color: t.status === 'win' ? '#10b981' : t.status === 'loss' ? '#ef4444' : '#3b82f6',
              }}>
              {t.direction === 'buy'
                ? <TrendingUp size={8} />
                : <TrendingDown size={8} />}
              {t.hora}
              {t.status === 'open' && <span className="animate-pulse">·</span>}
              {t.pnl != null && ` ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}`}
            </span>
          ))}
        </div>
      )}

      {/* Pausar */}
      {!atingiu && (
        <button
          onClick={onPausar}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/25 text-[#ef4444] text-[9px] font-bold hover:bg-[#ef4444]/20 transition-all shrink-0"
        >
          <Square size={10} /> Pausar IA
        </button>
      )}

      {atingiu && (
        <div className="flex items-center gap-1.5 text-[9px] text-[#10b981] font-bold shrink-0">
          <CheckCircle size={12} /> Operações encerradas por hoje
        </div>
      )}
    </div>
  )
}
