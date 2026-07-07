'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { TrendingUp, TrendingDown, X, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OCOState {
  lot:       number
  leverage:  number
  entry:     number
  sl:        number
  tp:        number
  direction: 'buy' | 'sell'
}

function pipValueUSD(lot: number) { return lot * 10 }

// ── Linha arrastável ────────────────────────────────────────────────────────

interface OCOLineProps {
  y:             number
  price:         number
  label:         string        // ex: "+$15.00" | "1.03540" | "-$5.00"
  sublabel?:     string        // linha secundária menor
  lineColor:     string
  isDragging:    boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp:   (e: React.PointerEvent) => void
}

function OCOLine({
  y, price, label, sublabel, lineColor,
  isDragging, onPointerDown, onPointerMove, onPointerUp,
}: OCOLineProps) {
  return (
    <div
      className="absolute left-0 right-0 flex items-center"
      style={{ top: y, transform: 'translateY(-50%)', pointerEvents: 'none' }}
    >
      {/* Linha tracejada */}
      <div
        className="absolute left-0 right-0 h-px"
        style={{
          background: `repeating-linear-gradient(90deg,${lineColor} 0,${lineColor} 5px,transparent 5px,transparent 11px)`,
          opacity: isDragging ? 1 : 0.65,
        }}
      />

      {/* Badge principal — esquerda */}
      <div
        className="absolute left-3 flex flex-col justify-center px-3 py-1 rounded-lg whitespace-nowrap"
        style={{
          pointerEvents:   'none',
          backgroundColor: `${lineColor}1a`,
          border:          `1px solid ${lineColor}45`,
          minWidth:        64,
        }}
      >
        <span
          className="font-mono font-black leading-tight"
          style={{ color: lineColor, fontSize: 13 }}
        >
          {label}
        </span>
        {sublabel && (
          <span className="text-[9px] font-medium text-[#8b949e] leading-tight mt-0.5">
            {sublabel}
          </span>
        )}
      </div>

      {/* Handle de arraste — direita */}
      <div
        className={cn(
          'absolute right-0 flex items-center gap-1 px-2 py-1.5 rounded-l-lg',
          'font-mono text-[11px] font-bold border-l border-t border-b',
          'cursor-ns-resize select-none transition-all',
          isDragging ? 'opacity-100 scale-105 shadow-xl' : 'opacity-50 hover:opacity-100',
        )}
        style={{
          pointerEvents:   'all',
          backgroundColor: `${lineColor}1e`,
          borderColor:     `${lineColor}70`,
          color:           lineColor,
          touchAction:     'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripVertical size={10} />
        {price.toFixed(5)}
      </div>
    </div>
  )
}

// ── Overlay completo ────────────────────────────────────────────────────────

interface Props {
  state:        OCOState
  onChange:     (s: OCOState) => void
  onExecute:    (dir: 'buy' | 'sell') => void
  onClose:      () => void
  getY:         (price: number) => number | null
  getPrice:     (y: number)     => number | null
  containerRef: React.RefObject<HTMLDivElement>
}

type DragField = 'entry' | 'sl' | 'tp'

export function OCOOverlay({
  state, onChange, onExecute, onClose, getY, getPrice, containerRef,
}: Props) {
  const [dragging, setDragging] = useState<DragField | null>(null)
  const dragFieldRef = useRef<DragField | null>(null)

  const [yPos, setYPos] = useState<{ entry: number|null; sl: number|null; tp: number|null }>({
    entry: null, sl: null, tp: null,
  })
  const prevY = useRef({ entry: 0, sl: 0, tp: 0 })

  // RAF loop: mantém Y sincronizado com scroll/zoom do gráfico
  useEffect(() => {
    let raf: number
    const tick = () => {
      const e = getY(state.entry)
      const s = getY(state.sl)
      const t = getY(state.tp)
      const moved =
        Math.abs((e ?? 0) - prevY.current.entry) > 0.4 ||
        Math.abs((s ?? 0) - prevY.current.sl)    > 0.4 ||
        Math.abs((t ?? 0) - prevY.current.tp)    > 0.4
      if (moved) {
        prevY.current = { entry: e ?? 0, sl: s ?? 0, tp: t ?? 0 }
        setYPos({ entry: e, sl: s, tp: t })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getY, state.entry, state.sl, state.tp])

  const startDrag = useCallback((e: React.PointerEvent, field: DragField) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragFieldRef.current = field
    setDragging(field)
  }, [])

  const moveDrag = useCallback((e: React.PointerEvent) => {
    const field = dragFieldRef.current
    if (!field || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const np   = getPrice(e.clientY - rect.top)
    if (np === null) return
    const s = { ...state }
    if (field === 'entry') {
      const dSL = state.sl - state.entry
      const dTP = state.tp - state.entry
      s.entry = np; s.sl = np + dSL; s.tp = np + dTP
    } else if (field === 'sl') {
      s.sl = np
    } else {
      s.tp = np
    }
    onChange(s)
  }, [state, getPrice, onChange, containerRef])

  const endDrag = useCallback(() => {
    dragFieldRef.current = null
    setDragging(null)
  }, [])

  // Cálculos P&L
  const pv     = pipValueUSD(state.lot)
  const slPips = Math.round(Math.abs(state.entry - state.sl)   * 10000)
  const tpPips = Math.round(Math.abs(state.tp   - state.entry) * 10000)
  const slUSD  = +(slPips * pv).toFixed(2)
  const tpUSD  = +(tpPips * pv).toFixed(2)
  const rr     = slPips > 0 ? tpPips / slPips : 0
  const isBuy  = state.direction === 'buy'

  const ok = (y: number | null): y is number => y !== null && y > 8 && y < 9999

  const cardTop = ok(yPos.entry) ? Math.max(56, yPos.entry - 80) : 100

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none', zIndex: 10 }}>

      {/* Zona vermelha: risco (SL → Entrada) */}
      {ok(yPos.entry) && ok(yPos.sl) && (
        <div
          className="absolute left-0 right-0"
          style={{
            top:             Math.min(yPos.entry, yPos.sl),
            height:          Math.abs(yPos.entry - yPos.sl),
            backgroundColor: '#ef44441c',
            pointerEvents:   'none',
          }}
        />
      )}

      {/* Zona verde: alvo (Entrada → TP) */}
      {ok(yPos.entry) && ok(yPos.tp) && (
        <div
          className="absolute left-0 right-0"
          style={{
            top:             Math.min(yPos.entry, yPos.tp),
            height:          Math.abs(yPos.entry - yPos.tp),
            backgroundColor: '#22c55e16',
            pointerEvents:   'none',
          }}
        />
      )}

      {/* Linha TAKE PROFIT — mostra ganho em dólares */}
      {ok(yPos.tp) && (
        <OCOLine
          y={yPos.tp}
          price={state.tp}
          label={`+$${tpUSD.toFixed(2)}`}
          sublabel={rr > 0 ? `ALVO · R:R 1:${rr.toFixed(1)}` : 'ALVO'}
          lineColor="#22c55e"
          isDragging={dragging === 'tp'}
          onPointerDown={e => startDrag(e, 'tp')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Linha ENTRADA — mostra o preço de entrada */}
      {ok(yPos.entry) && (
        <OCOLine
          y={yPos.entry}
          price={state.entry}
          label={state.entry.toFixed(5)}
          sublabel={`${isBuy ? '▲ COMPRA' : '▼ VENDA'} · ${state.lot.toFixed(2)}L · ${state.leverage}×`}
          lineColor={isBuy ? '#3b82f6' : '#f59e0b'}
          isDragging={dragging === 'entry'}
          onPointerDown={e => startDrag(e, 'entry')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Linha STOP LOSS — mostra perda em dólares */}
      {ok(yPos.sl) && (
        <OCOLine
          y={yPos.sl}
          price={state.sl}
          label={`-$${slUSD.toFixed(2)}`}
          sublabel="STOP LOSS"
          lineColor="#ef4444"
          isDragging={dragging === 'sl'}
          onPointerDown={e => startDrag(e, 'sl')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Card de execução flutuante */}
      <div
        className="absolute right-[88px]"
        style={{ top: cardTop, pointerEvents: 'all' }}
      >
        <div
          className="rounded-2xl shadow-2xl overflow-hidden"
          style={{
            width: 192,
            background: 'rgba(10,12,18,0.97)',
            border: '1px solid #30363d',
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Stats: GAIN | STOP | R:R */}
          <div className="grid grid-cols-3" style={{ borderBottom: '1px solid #30363d' }}>
            <div className="flex flex-col items-center py-2.5 px-1" style={{ borderRight: '1px solid #30363d' }}>
              <span className="text-[8px] font-semibold tracking-widest uppercase" style={{ color: '#484f58' }}>GAIN</span>
              <span className="font-mono font-black mt-0.5" style={{ fontSize: 13, color: '#4ade80', letterSpacing: '-0.5px' }}>
                +${tpUSD.toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col items-center py-2.5 px-1" style={{ borderRight: '1px solid #30363d' }}>
              <span className="text-[8px] font-semibold tracking-widest uppercase" style={{ color: '#484f58' }}>STOP</span>
              <span className="font-mono font-black mt-0.5" style={{ fontSize: 13, color: '#f87171', letterSpacing: '-0.5px' }}>
                -${slUSD.toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col items-center py-2.5 px-1">
              <span className="text-[8px] font-semibold tracking-widest uppercase" style={{ color: '#484f58' }}>R:R</span>
              <span
                className="font-mono font-black mt-0.5"
                style={{
                  fontSize: 13,
                  color: rr >= 2 ? '#4ade80' : rr >= 1.5 ? '#fbbf24' : '#f87171',
                  letterSpacing: '-0.5px',
                }}
              >
                {rr.toFixed(1)}×
              </span>
            </div>
          </div>

          {/* Botões VENDA / COMPRA */}
          <div className="grid grid-cols-2">
            <button
              onClick={() => onExecute('sell')}
              className="flex flex-col items-center justify-center gap-1 py-4 active:scale-95 transition-all select-none"
              style={{
                background: 'rgba(239,68,68,0.12)',
                borderRight: '1px solid #30363d',
                color: '#f87171',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.25)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.12)')}
            >
              <TrendingDown size={18} strokeWidth={2.5} />
              <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.5px' }}>VENDA</span>
            </button>
            <button
              onClick={() => onExecute('buy')}
              className="flex flex-col items-center justify-center gap-1 py-4 active:scale-95 transition-all select-none"
              style={{
                background: 'rgba(34,197,94,0.12)',
                color: '#4ade80',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(34,197,94,0.25)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(34,197,94,0.12)')}
            >
              <TrendingUp size={18} strokeWidth={2.5} />
              <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.5px' }}>COMPRA</span>
            </button>
          </div>

          {/* Cancelar */}
          <button
            onClick={onClose}
            className="w-full flex items-center justify-center gap-1.5 select-none transition-colors"
            style={{
              borderTop: '1px solid #30363d',
              padding: '6px 0',
              fontSize: 10,
              color: '#484f58',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#8b949e'; (e.currentTarget as HTMLElement).style.background = '#21262d' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#484f58'; (e.currentTarget as HTMLElement).style.background = '' }}
          >
            <X size={10} />
            <span>Cancelar OCO</span>
          </button>
        </div>
      </div>
    </div>
  )
}
