'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { TrendingUp, TrendingDown, X, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OCOState {
  lot:      number
  leverage: number
  entry:    number
  sl:       number
  tp:       number
  direction: 'buy' | 'sell'
}

function pipValueUSD(lot: number) { return lot * 10 }

// ── Linha arrastável ────────────────────────────────────────────────────────

interface OCOLineProps {
  y:             number
  price:         number
  leftLabel:     string
  leftSub:       string
  lineColor:     string
  isDragging:    boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp:   (e: React.PointerEvent) => void
}

function OCOLine({
  y, price, leftLabel, leftSub, lineColor,
  isDragging, onPointerDown, onPointerMove, onPointerUp,
}: OCOLineProps) {
  return (
    <div
      className="absolute left-0 right-0 flex items-center"
      style={{ top: y, transform: 'translateY(-50%)', pointerEvents: 'none' }}
    >
      {/* Linha tracejada horizontal */}
      <div
        className="flex-1 h-px"
        style={{
          background: `repeating-linear-gradient(90deg,${lineColor} 0,${lineColor} 6px,transparent 6px,transparent 12px)`,
          opacity: isDragging ? 1 : 0.7,
        }}
      />

      {/* Badge informativo — esquerda */}
      <div
        className="absolute left-3 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-semibold border backdrop-blur-sm whitespace-nowrap"
        style={{
          pointerEvents: 'none',
          backgroundColor: `${lineColor}18`,
          borderColor:     `${lineColor}55`,
          color:           lineColor,
        }}
      >
        {leftLabel}
        {leftSub && <span className="text-[#8b949e] font-normal">{leftSub}</span>}
      </div>

      {/* Handle de arraste — direita */}
      <div
        className={cn(
          'absolute right-0 flex items-center gap-1.5 px-2 py-1 rounded-l-md text-[10px] font-mono font-bold',
          'border-l border-t border-b cursor-ns-resize select-none transition-opacity',
          isDragging ? 'opacity-100 shadow-lg' : 'opacity-55 hover:opacity-100',
        )}
        style={{
          pointerEvents:   'all',
          backgroundColor: `${lineColor}22`,
          borderColor:     `${lineColor}80`,
          color:           lineColor,
          touchAction:     'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripVertical size={9} />
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
  const [dragging,  setDragging]  = useState<DragField | null>(null)
  const dragFieldRef = useRef<DragField | null>(null)

  // Y pixels — atualizados via RAF para acompanhar scroll/zoom
  const [yPos, setYPos] = useState<{ entry: number|null; sl: number|null; tp: number|null }>({
    entry: null, sl: null, tp: null,
  })
  const prevY = useRef({ entry: 0, sl: 0, tp: 0 })

  useEffect(() => {
    let raf: number
    const tick = () => {
      const e = getY(state.entry)
      const s = getY(state.sl)
      const t = getY(state.tp)
      const moved =
        Math.abs((e ?? 0) - prevY.current.entry) > 0.5 ||
        Math.abs((s ?? 0) - prevY.current.sl) > 0.5 ||
        Math.abs((t ?? 0) - prevY.current.tp) > 0.5
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
    const y    = e.clientY - rect.top
    const np   = getPrice(y)
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

  const pv     = pipValueUSD(state.lot)
  const slPips = Math.round(Math.abs(state.entry - state.sl)   * 10000)
  const tpPips = Math.round(Math.abs(state.tp   - state.entry) * 10000)
  const slUSD  = +(slPips * pv).toFixed(2)
  const tpUSD  = +(tpPips * pv).toFixed(2)
  const rr     = slPips > 0 ? tpPips / slPips : 0
  const isBuy  = state.direction === 'buy'

  const ok = (y: number | null): y is number => y !== null && y > 8 && y < 9999

  // Posição vertical do card de ação — flutua perto da linha de entrada
  const cardTop = ok(yPos.entry)
    ? Math.max(60, yPos.entry - 72)
    : 100

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>

      {/* Zona de risco (SL→Entry) */}
      {ok(yPos.entry) && ok(yPos.sl) && (
        <div
          className="absolute left-0 right-0"
          style={{
            top:    Math.min(yPos.entry, yPos.sl),
            height: Math.abs(yPos.entry - yPos.sl),
            backgroundColor: '#ef44441a',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Zona de alvo (Entry→TP) */}
      {ok(yPos.entry) && ok(yPos.tp) && (
        <div
          className="absolute left-0 right-0"
          style={{
            top:    Math.min(yPos.entry, yPos.tp),
            height: Math.abs(yPos.entry - yPos.tp),
            backgroundColor: '#22c55e14',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Linha TP */}
      {ok(yPos.tp) && (
        <OCOLine
          y={yPos.tp}
          price={state.tp}
          leftLabel={`TP  +$${tpUSD}  ${tpPips}p`}
          leftSub={rr > 0 ? `  R:R 1:${rr.toFixed(1)}` : ''}
          lineColor="#22c55e"
          isDragging={dragging === 'tp'}
          onPointerDown={e => startDrag(e, 'tp')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Linha Entrada */}
      {ok(yPos.entry) && (
        <OCOLine
          y={yPos.entry}
          price={state.entry}
          leftLabel={`${isBuy ? '▲ COMPRA' : '▼ VENDA'}  ${state.lot.toFixed(2)}L`}
          leftSub={`  ${state.leverage}×`}
          lineColor={isBuy ? '#3b82f6' : '#f59e0b'}
          isDragging={dragging === 'entry'}
          onPointerDown={e => startDrag(e, 'entry')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Linha SL */}
      {ok(yPos.sl) && (
        <OCOLine
          y={yPos.sl}
          price={state.sl}
          leftLabel={`SL  -$${slUSD}  ${slPips}p`}
          leftSub=""
          lineColor="#ef4444"
          isDragging={dragging === 'sl'}
          onPointerDown={e => startDrag(e, 'sl')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}

      {/* Card de ação flutuante */}
      <div
        className="absolute right-24"
        style={{ top: cardTop, pointerEvents: 'all' }}
      >
        <div className="bg-[#0d1117]/95 backdrop-blur-sm border border-[#30363d] rounded-2xl p-3 shadow-2xl w-[168px] space-y-2.5">

          {/* Mini resumo */}
          <div className="text-[10px] space-y-1 pb-2 border-b border-[#30363d]">
            <div className="flex justify-between">
              <span className="text-[#484f58]">Risco</span>
              <span className="mono text-red-400 font-semibold">{slPips}p · <span className="text-red-300">${slUSD}</span></span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#484f58]">Alvo</span>
              <span className="mono text-emerald-400 font-semibold">{tpPips}p · <span className="text-emerald-300">${tpUSD}</span></span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#484f58]">R:R</span>
              <span className={cn('mono font-bold', rr >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
                1:{rr.toFixed(1)}
              </span>
            </div>
          </div>

          {/* Botões execução */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onExecute('sell')}
              className="flex items-center justify-center gap-1 py-2.5 rounded-xl text-[11px] font-bold bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/35 active:scale-95 transition-all"
            >
              <TrendingDown size={10} />VENDA
            </button>
            <button
              onClick={() => onExecute('buy')}
              className="flex items-center justify-center gap-1 py-2.5 rounded-xl text-[11px] font-bold bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/35 active:scale-95 transition-all"
            >
              <TrendingUp size={10} />COMPRA
            </button>
          </div>

          {/* Cancelar */}
          <button
            onClick={onClose}
            className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] border border-[#30363d] transition-all"
          >
            <X size={9} />Cancelar OCO
          </button>
        </div>
      </div>
    </div>
  )
}
