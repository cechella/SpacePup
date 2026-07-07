'use client'

import { useState, useEffect } from 'react'
import {
  Plus, Trash2, TrendingUp, TrendingDown, Target, Shield, ChevronRight, MousePointer2,
} from 'lucide-react'
import { cn, formatPrice } from '@/lib/utils'

export interface ManualTrade {
  id:         string
  direction:  'buy' | 'sell'
  entry:      number
  stopLoss:   number
  takeProfit: number
  label:      string
  time:       number
  lot:        number
  leverage:   number
}

interface Props {
  trades:          ManualTrade[]
  onAdd:           (t: ManualTrade) => void
  onRemove:        (id: string) => void
  lastPrice?:      number
  lastCandleTime?: number
  externalEntry?:  number | null
}

const LOT_PRESETS = [0.01, 0.10, 0.50, 1.00]
const LEV_PRESETS = [50, 100, 200, 500]

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
// EURUSD: 1 pip = $10 por lote padrão
function pipValueUSD(lot: number) { return lot * 10 }

export function TradePanel({
  trades, onAdd, onRemove, lastPrice = 0, lastCandleTime, externalEntry,
}: Props) {
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [entry,     setEntry]     = useState('')
  const [sl,        setSl]        = useState('')
  const [tp,        setTp]        = useState('')
  const [label,     setLabel]     = useState('')
  const [lot,       setLot]       = useState('0.01')
  const [leverage,  setLeverage]  = useState('100')

  // Clique no gráfico → preenche entrada automaticamente
  useEffect(() => {
    if (externalEntry != null) setEntry(externalEntry.toFixed(5))
  }, [externalEntry])

  const handleAdd = () => {
    const e   = parseFloat(entry)
    const s   = parseFloat(sl)
    const t   = parseFloat(tp)
    const l   = parseFloat(lot)
    const lev = parseFloat(leverage)
    if (isNaN(e) || isNaN(s) || isNaN(t) || isNaN(l) || isNaN(lev)) return

    onAdd({
      id:         `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction,
      entry:      e,
      stopLoss:   s,
      takeProfit: t,
      label:      label.trim() || `${direction === 'buy' ? 'COMPRA' : 'VENDA'} @ ${formatPrice(e)} | ${l.toFixed(2)}L`,
      time:       lastCandleTime ?? Math.floor(Date.now() / 1000),
      lot:        l,
      leverage:   lev,
    })
    setEntry(''); setSl(''); setTp(''); setLabel('')
  }

  const eNum   = parseFloat(entry)
  const sNum   = parseFloat(sl)
  const tNum   = parseFloat(tp)
  const lNum   = parseFloat(lot)   || 0.01
  const levNum = parseFloat(leverage) || 100

  const hasValues = !isNaN(eNum) && !isNaN(sNum) && !isNaN(tNum)
  const risk      = hasValues ? riskPips(eNum, sNum, direction)   : 0
  const reward    = hasValues ? rewardPips(eNum, tNum, direction) : 0
  const rr        = risk > 0 ? reward / risk : 0
  const pv        = pipValueUSD(lNum)
  const usdRisk   = risk   * pv
  const usdProfit = reward * pv
  const margin    = hasValues && eNum > 0 ? (lNum * 100000 * eNum) / levNum : 0

  return (
    <div className="flex flex-col h-full bg-[#161b22] border-l border-[#30363d]">

      {/* Header */}
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-[#f0f6fc]">Ordem OCO · Treino</span>
        {lastPrice > 0 && (
          <span className="text-[10px] text-[#8b949e] mono">{formatPrice(lastPrice)}</span>
        )}
      </div>

      {/* Formulário com scroll */}
      <div className="flex-shrink-0 p-4 border-b border-[#30363d] space-y-3 overflow-y-auto max-h-[65vh]">

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
              {d === 'buy' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {d === 'buy' ? 'COMPRA' : 'VENDA'}
            </button>
          ))}
        </div>

        {/* Entrada */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Entrada</label>
            <span className="flex items-center gap-1 text-[10px] text-[#484f58]">
              <MousePointer2 size={9} />clique no gráfico
            </span>
          </div>
          <input
            type="number" step="0.00001" value={entry}
            onChange={e => setEntry(e.target.value)}
            placeholder="1.08500"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6]"
          />
        </div>

        {/* Stop Loss */}
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Shield size={9} className="text-red-400" />
            <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Stop Loss</label>
          </div>
          <input
            type="number" step="0.00001" value={sl}
            onChange={e => setSl(e.target.value)}
            placeholder="1.08200"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono placeholder:text-[#484f58] focus:outline-none focus:border-[#ef4444]"
          />
        </div>

        {/* Take Profit */}
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Target size={9} className="text-emerald-400" />
            <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Take Profit</label>
          </div>
          <input
            type="number" step="0.00001" value={tp}
            onChange={e => setTp(e.target.value)}
            placeholder="1.09100"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono placeholder:text-[#484f58] focus:outline-none focus:border-[#10b981]"
          />
        </div>

        {/* Lote */}
        <div className="space-y-1.5">
          <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Lote</label>
          <div className="grid grid-cols-4 gap-1">
            {LOT_PRESETS.map(p => (
              <button key={p}
                onClick={() => setLot(p.toString())}
                className={cn(
                  'py-1.5 rounded text-[10px] font-semibold border transition-all',
                  parseFloat(lot) === p
                    ? 'bg-[#3b82f6]/20 border-[#3b82f6]/40 text-[#3b82f6]'
                    : 'bg-[#0d1117] border-[#30363d] text-[#484f58] hover:text-[#8b949e]',
                )}
              >{p.toFixed(2)}</button>
            ))}
          </div>
          <input
            type="number" step="0.01" min="0.01" value={lot}
            onChange={e => setLot(e.target.value)}
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono focus:outline-none focus:border-[#3b82f6]"
          />
        </div>

        {/* Alavancagem */}
        <div className="space-y-1.5">
          <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Alavancagem</label>
          <div className="grid grid-cols-4 gap-1">
            {LEV_PRESETS.map(p => (
              <button key={p}
                onClick={() => setLeverage(p.toString())}
                className={cn(
                  'py-1.5 rounded text-[10px] font-semibold border transition-all',
                  parseFloat(leverage) === p
                    ? 'bg-[#3b82f6]/20 border-[#3b82f6]/40 text-[#3b82f6]'
                    : 'bg-[#0d1117] border-[#30363d] text-[#484f58] hover:text-[#8b949e]',
                )}
              >{p}×</button>
            ))}
          </div>
          <input
            type="number" step="1" min="1" value={leverage}
            onChange={e => setLeverage(e.target.value)}
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] mono focus:outline-none focus:border-[#3b82f6]"
          />
        </div>

        {/* Rótulo */}
        <div className="space-y-1">
          <label className="text-[10px] text-[#484f58] uppercase tracking-wide">Rótulo (opcional)</label>
          <input
            type="text" value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Ex: Rompimento resistência H1"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-[#f0f6fc] placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6]"
          />
        </div>

        {/* Preview R:R + USD */}
        {hasValues && risk > 0 && (
          <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3 space-y-1.5 text-[10px]">
            <div className="flex justify-between items-center">
              <span className="text-[#484f58]">Risco</span>
              <span className="mono font-semibold">
                <span className="text-red-400">{risk}p</span>
                <span className="text-[#484f58]"> · </span>
                <span className="text-red-300">${usdRisk.toFixed(2)}</span>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[#484f58]">Alvo</span>
              <span className="mono font-semibold">
                <span className="text-emerald-400">{reward}p</span>
                <span className="text-[#484f58]"> · </span>
                <span className="text-emerald-300">${usdProfit.toFixed(2)}</span>
              </span>
            </div>
            <div className="flex justify-between items-center border-t border-[#30363d] pt-1.5">
              <span className="text-[#484f58]">R:R</span>
              <span className={cn('mono font-bold text-[11px]', rr >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
                1:{rr.toFixed(1)}
              </span>
            </div>
            {margin > 0 && (
              <div className="flex justify-between items-center border-t border-[#30363d] pt-1.5">
                <span className="text-[#484f58]">Margem ({levNum}×)</span>
                <span className="mono text-[#8b949e] font-semibold">${margin.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleAdd}
          disabled={!hasValues || risk <= 0}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold bg-[#3b82f6] hover:bg-[#2563eb] text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={12} /> Adicionar Ordem OCO
        </button>
      </div>

      {/* Lista de ordens */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {trades.length === 0 ? (
          <div className="text-center text-[10px] text-[#484f58] pt-8 leading-relaxed">
            Nenhuma ordem OCO anotada.<br />
            Clique no gráfico para definir<br />
            a entrada, depois configure SL e TP.
          </div>
        ) : (
          trades.map(t => {
            const r  = riskPips(t.entry, t.stopLoss, t.direction)
            const w  = rewardPips(t.entry, t.takeProfit, t.direction)
            const pv = pipValueUSD(t.lot)
            const isBuy = t.direction === 'buy'
            return (
              <div key={t.id} className={cn(
                'rounded-xl p-3 border space-y-2',
                isBuy ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20',
              )}>
                <div className="flex items-start justify-between gap-2">
                  <div className={cn('flex items-center gap-1.5 text-xs font-semibold flex-wrap', isBuy ? 'text-emerald-400' : 'text-red-400')}>
                    {isBuy ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {t.direction === 'buy' ? 'COMPRA' : 'VENDA'}
                    <span className="text-[#484f58] font-normal text-[10px]">
                      {t.lot.toFixed(2)}L · {t.leverage}×
                    </span>
                  </div>
                  <button onClick={() => onRemove(t.id)} className="text-[#484f58] hover:text-red-400 transition-colors shrink-0">
                    <Trash2 size={11} />
                  </button>
                </div>

                <p className="text-[10px] text-[#8b949e] leading-tight truncate">{t.label}</p>

                <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                  <div>
                    <div className="text-[#484f58] mb-0.5">Entrada</div>
                    <div className="mono text-[#f0f6fc] font-medium text-[9px]">{formatPrice(t.entry)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-0.5 text-[#484f58] mb-0.5">
                      <Shield size={8} className="text-red-400" />SL
                    </div>
                    <div className="mono text-red-400 font-medium text-[9px]">{formatPrice(t.stopLoss)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-0.5 text-[#484f58] mb-0.5">
                      <Target size={8} className="text-emerald-400" />TP
                    </div>
                    <div className="mono text-emerald-400 font-medium text-[9px]">{formatPrice(t.takeProfit)}</div>
                  </div>
                </div>

                <div className="text-[10px] pt-1 border-t border-[#30363d]/50 space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-[#484f58]">Risco</span>
                    <span className="mono text-red-400">{r}p · <span className="text-red-300">${(r * pv).toFixed(2)}</span></span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#484f58]">Alvo</span>
                    <span className="mono text-emerald-400">{w}p · <span className="text-emerald-300">${(w * pv).toFixed(2)}</span></span>
                  </div>
                  <div className={cn('flex justify-end items-center gap-0.5 font-semibold mono', r > 0 && w / r >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
                    <ChevronRight size={9} />
                    R:R 1:{r > 0 ? (w / r).toFixed(1) : '—'}
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
