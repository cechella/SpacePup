'use client'

import { useEffect, useRef, useState } from 'react'
import { Brain, TrendingUp, TrendingDown, X, Zap, CheckCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface IASuggestion {
  direction:     'buy' | 'sell'
  entry:         number
  stopLoss:      number
  takeProfit:    number
  lot:           number
  rr:            string
  slPips:        number
  tpPips:        number
  probability:   number   // 0–100
  similar_count: number
  wins:          number
  motivo:        string
  recentes:      Array<{ result: string; rafi: string; hora: string }>
  confiante:     boolean  // true = ≥65%; false = 55–64% (modelo inicial)
  capital:       number
}

interface Props {
  suggestion: IASuggestion
  onAuthorize: (s: IASuggestion) => void
  onDismiss: () => void
  timeoutSec?: number
}

const EXPIRE_SEC = 45

export function IASuggestionModal({ suggestion: s, onAuthorize, onDismiss, timeoutSec = EXPIRE_SEC }: Props) {
  const [remaining, setRemaining] = useState(timeoutSec)
  const [sending, setSending]     = useState(false)
  const [sent, setSent]           = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current!); onDismiss(); return 0 }
        return r - 1
      })
    }, 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [onDismiss])

  async function handleAuthorize() {
    if (sending || sent) return
    if (intervalRef.current) clearInterval(intervalRef.current)
    setSending(true)
    await onAuthorize(s)
    setSending(false)
    setSent(true)
    setTimeout(onDismiss, 2500)
  }

  const pctBar  = Math.round((remaining / timeoutSec) * 100)
  const dirColor = s.direction === 'buy' ? '#3b82f6' : '#f59e0b'
  const probColor = s.probability >= 75 ? '#10b981' : s.probability >= 65 ? '#10b981' : '#f59e0b'

  return (
    <div
      className="fixed top-4 right-4 z-[200] w-[320px] rounded-2xl shadow-2xl border overflow-hidden animate-in slide-in-from-right-4 duration-300"
      style={{ background: '#161b22', borderColor: `${dirColor}50` }}
    >
      {/* Timer bar */}
      <div className="h-1 bg-[#21262d]">
        <div
          className="h-full transition-all duration-1000"
          style={{ width: `${pctBar}%`, background: remaining > 15 ? dirColor : '#ef4444' }}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <Brain size={16} style={{ color: dirColor }} />
          <span className="text-xs font-black text-[#f0f6fc] tracking-wide">IA SUGERE ENTRADA</span>
          {!s.confiante && (
            <span className="text-[8px] font-mono bg-[#f59e0b]/10 border border-[#f59e0b]/30 text-[#f59e0b] px-1.5 py-0.5 rounded">
              modelo inicial
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-[#484f58]">{remaining}s</span>
          <button onClick={onDismiss} className="text-[#484f58] hover:text-[#8b949e] transition-colors">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Direção + Probabilidade */}
      <div className="flex items-center justify-between px-4 pb-3 border-b border-[#30363d]">
        <div className="flex items-center gap-2">
          {s.direction === 'buy'
            ? <span className="flex items-center gap-1 text-base font-black" style={{ color: dirColor }}>
                <TrendingUp size={18} /> BUY
              </span>
            : <span className="flex items-center gap-1 text-base font-black" style={{ color: dirColor }}>
                <TrendingDown size={18} /> SELL
              </span>
          }
          <span className="text-[10px] text-[#484f58] font-mono">EURUSD</span>
        </div>
        <div className="text-right">
          <div className="text-2xl font-black font-mono leading-none" style={{ color: probColor }}>
            {s.probability}%
          </div>
          <div className="text-[8px] text-[#484f58]">P(sucesso)</div>
        </div>
      </div>

      {/* Parâmetros */}
      <div className="px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] font-mono border-b border-[#30363d]">
        <div className="flex justify-between">
          <span className="text-[#484f58]">Entrada</span>
          <span className="text-[#f0f6fc] font-bold">{s.entry.toFixed(5)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#484f58]">R:R</span>
          <span className="text-[#f0f6fc] font-bold">1:{s.rr}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#484f58]">Stop</span>
          <span className="text-[#ef4444] font-bold">{s.stopLoss.toFixed(5)} (–{s.slPips}p)</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#484f58]">Lote</span>
          <span className="text-[#f0f6fc] font-bold">{s.lot.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#484f58]">Alvo</span>
          <span className="text-[#10b981] font-bold">{s.takeProfit.toFixed(5)} (+{s.tpPips}p)</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#484f58]">Risco</span>
          <span className="text-[#f0f6fc]">1% · ${(s.capital * 0.01).toFixed(0)}</span>
        </div>
      </div>

      {/* Contexto — por que a IA sugere */}
      <div className="px-4 py-2.5 border-b border-[#30363d]">
        <div className="flex items-start gap-1.5">
          <Zap size={10} className="text-[#f59e0b] mt-0.5 shrink-0" />
          <p className="text-[9px] text-[#8b949e] leading-relaxed">{s.motivo}</p>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.recentes.map((r, i) => (
            <span key={i}
              className="text-[8px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: r.result === 'win' ? '#10b98115' : '#ef444415',
                border: `1px solid ${r.result === 'win' ? '#10b98130' : '#ef444430'}`,
                color: r.result === 'win' ? '#10b981' : '#ef4444',
              }}>
              {r.result === 'win' ? 'W' : 'L'} RAFI {r.rafi}
            </span>
          ))}
        </div>
      </div>

      {/* Botões */}
      <div className="px-4 py-3 flex gap-2">
        <button
          onClick={onDismiss}
          disabled={sending || sent}
          className="flex-1 py-2 rounded-lg text-xs font-semibold border border-[#30363d] text-[#8b949e] hover:border-[#484f58] hover:text-[#f0f6fc] transition-all"
        >
          Ignorar
        </button>
        <button
          onClick={handleAuthorize}
          disabled={sending || sent}
          className={cn(
            'flex-[2] py-2 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-1.5',
            sent
              ? 'bg-[#10b981] text-white'
              : sending
              ? 'bg-[#30363d] text-[#484f58] cursor-not-allowed'
              : 'text-white hover:opacity-90 active:scale-[0.98]',
          )}
          style={!sent && !sending ? { background: dirColor } : undefined}
        >
          {sent
            ? <><CheckCircle size={12} /> Ordens enviadas!</>
            : sending
            ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Enviando…</>
            : <><Zap size={12} /> Autorizar e Enviar</>
          }
        </button>
      </div>

      {/* Aviso se modelo inicial */}
      {!s.confiante && (
        <div className="px-4 pb-3">
          <div className="flex items-center gap-1.5 text-[8px] text-[#f59e0b]">
            <AlertTriangle size={9} />
            <span>Modelo inicial — confiança cresce com mais trades rotulados</span>
          </div>
        </div>
      )}
    </div>
  )
}
