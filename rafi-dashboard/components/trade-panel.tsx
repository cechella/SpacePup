'use client'

import { useState } from 'react'
import {
  Plus, Trash2, TrendingUp, TrendingDown, Target, Shield, ChevronRight,
} from 'lucide-react'
import { cn, formatPrice } from '@/lib/utils'

export interface ManualTrade {
  id:         string
  direction:  'buy' | 'sell'
  entry:      number
  stopLoss:   number
  takeProfit: number
  label:      string
  time:       number   // Unix timestamp (usado para o marcador no gráfico)
}

interface Props {
  trades:          ManualTrade[]
  onAdd:           (t: ManualTrade) => void
  onRemove:        (id: string) => void
  lastPrice?:      number
  lastCandleTime?: number
}

function riskPips(e: number, s: number, dir: 'buy' | 'sell') {
  return dir === 'buy'
    ? Math.round((e - s) * 10000)
    : Math.round((s - e) * 10000)
}
function rewardPips(e: number, t: number, dir: 'buy' | 'sell') {
  return dir === 'buy'
    ? Math.round((t - e) * 10000)
    : Math.round((e - t) * 10000)
}

export function TradePanel({ trades, onAdd, onRemove, lastPrice = 0, lastCandleTime }: Props) {
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [entry,  setEntry]  = useState('')
  const [sl,     setSl]     = useState('')
  const [tp,     setTp]     = useState('')
  const [label,  setLabel]  = useState('')

  const handleAdd = () => {
    const e = parseFloat(entry)
    const s = parseFloat(sl)
    const t = parseFloat(tp)
    if (isNaN(e) || isNaN(s) || isNaN(t)) return

    onAdd({
      id:         `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction,
      entry:      e,
      stopLoss:   s,
      takeProfit: t,
      label:      label.trim() || `${direction.toUpperCase()} @ ${formatPrice(e)}`,
      time:       lastCandleTime ?? Math.floor(Date.now() / 1000),
    })
    setEntry(''); setSl(''); setTp(''); setLabel('')
  }

  const eNum = parseFloat(entry)
  const sNum = parseFloat(sl)
  const tNum = parseFloat(tp)
  const hasValues = !isNaN(eNum) && !isNaN(sNum) && !isNaN(tNum)
  const risk   = hasValues ? riskPips(eNum, sNum, direction)   : 0
  const reward = hasValues ? rewardPips(eNum, tNum, direction) : 0
  const rr     = risk > 0 ? reward / risk : 0

  return (
    <div className="flex flex-col h-full bg-[#161b22] border-l border-[#30363d]">

      {/* Header */}
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between">
        <span className="text-xs font-semibold text-[#f0f6fc]">Anotação de Trades</span>
        {lastPrice > 0 && (
          <span className="text-[10px] text-[#484f58] mono">{formatPrice(lastPrice)}</span>
        )}
      </div>

      {/* Formulário */}
      <div className="p-4 border-b border-[#30363d] space-y-3">

        {/* Direção */}
        <div className="grid grid-cols-2 gap-2">
          {(['buy', 'sell'] as const).map(d => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={cn(
                'flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border transition-all',
                direction === d
                  ? d === 'buy'
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                    : 'bg-red-500/20 border-red-500/40 text-red-400'
                  : 'bg-[#0d1117] border-[#30363d] text-[#484f58] hover:text-[#8b949e]',
              )}
            >
              {d === 'buy'
                ? <TrendingUp  size={12} />
                : <TrendingDown size={12} />}
              {d === 'buy' ? 'COMPRA' : 'VENDA'}
            </button>
          ))}
        </div>

        {/* Preços */}
        {[
          { label: 'Entrada',     value: entry,  set: setEntry, hint: '1.08500' },
          { label: 'Stop Loss',   value: sl,     set: setSl,    hint: '1.08200' },
          { label: 'Take Profit', value: tp,     set: setTp,    hint: '1.09100' },
        ].map(({ label, value, set, hint }) => (
          <div key={label} className="flex flex-col gap-1">
            <label className="text-[10px] text-[#484f58] uppercase tracking-wide">{label}</label>
            <input
              type="number"
              step="0.00001"
              value={value}
              onChange={e => set(e.target.value)}
              placeholder={hint}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6]"
            />
          </div>
        ))}

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Rótulo (opcional)</label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Ex: Rompimento resistência H1"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6]"
          />
        </div>

        {/* Preview R:R */}
        {hasValues && risk > 0 && (
          <div className="flex items-center justify-between text-[10px] bg-[#0d1117] rounded-lg px-3 py-2 border border-[#30363d]">
            <span className="text-[#484f58]">Risco</span>
            <span className="text-red-400 mono font-semibold">{risk}p</span>
            <span className="text-[#484f58]">Alvo</span>
            <span className="text-emerald-400 mono font-semibold">{reward}p</span>
            <span className="text-[#484f58]">R:R</span>
            <span className={cn('mono font-bold', rr >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
              1:{rr.toFixed(1)}
            </span>
          </div>
        )}

        <button
          onClick={handleAdd}
          disabled={!hasValues || risk <= 0}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold bg-[#3b82f6] hover:bg-[#2563eb] text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={12} /> Adicionar ao Gráfico
        </button>
      </div>

      {/* Lista de trades */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {trades.length === 0 ? (
          <div className="text-center text-[10px] text-[#484f58] pt-8 leading-relaxed">
            Nenhum trade anotado.<br />
            Preencha o formulário acima e clique<br />
            em &quot;Adicionar ao Gráfico&quot;.
          </div>
        ) : (
          trades.map(t => {
            const r = riskPips(t.entry, t.stopLoss, t.direction)
            const w = rewardPips(t.entry, t.takeProfit, t.direction)
            const isBuy = t.direction === 'buy'
            return (
              <div
                key={t.id}
                className={cn(
                  'rounded-xl p-3 border space-y-2',
                  isBuy
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : 'bg-red-500/5 border-red-500/20',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className={cn('flex items-center gap-1.5 text-xs font-semibold', isBuy ? 'text-emerald-400' : 'text-red-400')}>
                    {isBuy ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {t.direction.toUpperCase()}
                  </div>
                  <button
                    onClick={() => onRemove(t.id)}
                    className="text-[#484f58] hover:text-red-400 transition-colors shrink-0"
                    aria-label="Remover trade"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>

                <p className="text-[10px] text-[#8b949e] leading-tight">{t.label}</p>

                <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                  <div>
                    <div className="text-[#484f58] mb-0.5">Entrada</div>
                    <div className="mono text-[#f0f6fc] font-medium">{formatPrice(t.entry)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-0.5 text-[#484f58] mb-0.5">
                      <Shield size={8} className="text-red-400" />SL
                    </div>
                    <div className="mono text-red-400 font-medium">{formatPrice(t.stopLoss)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-0.5 text-[#484f58] mb-0.5">
                      <Target size={8} className="text-emerald-400" />TP
                    </div>
                    <div className="mono text-emerald-400 font-medium">{formatPrice(t.takeProfit)}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[10px] pt-0.5">
                  <span className="text-[#484f58]">
                    Risco <span className="text-red-400 mono">{r}p</span>
                    {' → '}
                    Alvo <span className="text-emerald-400 mono">{w}p</span>
                  </span>
                  <div className={cn('flex items-center gap-0.5 font-semibold mono', r > 0 && w / r >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
                    <ChevronRight size={9} />
                    1:{r > 0 ? (w / r).toFixed(1) : '—'}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
