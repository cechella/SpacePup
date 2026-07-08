'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { TrendingUp, TrendingDown, X, GripVertical, Move } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OCOState {
  lot:        number
  leverage:   number
  entry:      number
  sl:         number
  tp:         number
  direction:  'buy' | 'sell'
  entryTime?: number   // unix timestamp do candle de entrada
}

function pipValueUSD(lot: number) { return lot * 10 }

// ── Linha arrastável (SL e TP — somente vertical) ───────────────────────────

interface OCOLineProps {
  y:             number
  price:         number
  label:         string
  sublabel?:     string
  lineColor:     string
  isDragging:    boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp:   (e: React.PointerEvent) => void
}

function OCOLine({
  y, price, label, sublabel, lineColor, isDragging,
  onPointerDown, onPointerMove, onPointerUp,
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
      {/* Badge esquerda — arraste vertical */}
      <div
        className={cn(
          'absolute left-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg whitespace-nowrap select-none transition-all',
          isDragging ? 'opacity-100 shadow-xl scale-105' : 'opacity-90 hover:opacity-100 hover:scale-105',
        )}
        style={{
          pointerEvents:   'all',
          backgroundColor: isDragging ? `${lineColor}30` : `${lineColor}1a`,
          border:          `1px solid ${isDragging ? lineColor + '80' : lineColor + '45'}`,
          cursor:          isDragging ? 'ns-resize' : 'ns-resize',
          touchAction:     'none',
          minWidth:        64,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripVertical size={11} style={{ color: lineColor, opacity: 0.6, flexShrink: 0 }} />
        <div className="flex flex-col justify-center">
          <span className="font-mono font-black leading-tight" style={{ color: lineColor, fontSize: 13 }}>
            {label}
          </span>
          {sublabel && (
            <span className="text-[9px] font-medium text-[#8b949e] leading-tight mt-0.5">{sublabel}</span>
          )}
        </div>
      </div>
      {/* Handle direita */}
      <div
        className={cn(
          'absolute right-0 flex items-center gap-1.5 px-2.5 py-2 rounded-l-lg',
          'font-mono text-[11px] font-bold border-l border-t border-b select-none transition-all cursor-ns-resize',
          isDragging ? 'opacity-100 scale-105 shadow-xl' : 'opacity-55 hover:opacity-100 hover:scale-105',
        )}
        style={{
          pointerEvents:   'all',
          backgroundColor: isDragging ? `${lineColor}35` : `${lineColor}1e`,
          borderColor:     `${lineColor}70`,
          color:           lineColor,
          touchAction:     'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripVertical size={12} style={{ opacity: 0.8 }} />
        <div className="flex flex-col items-center" style={{ lineHeight: 1 }}>
          <span style={{ fontSize: 9, opacity: 0.7 }}>↕</span>
          <span style={{ fontSize: 11 }}>{price.toFixed(5)}</span>
        </div>
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
  getX?:        (time: number)  => number | null
  getTime?:     (x: number)     => number | null
  containerRef: React.RefObject<HTMLDivElement>
}

type DragField = 'entry' | 'sl' | 'tp'

export function OCOOverlay({
  state, onChange, onExecute, onClose, getY, getPrice, getX, getTime, containerRef,
}: Props) {
  const [dragging,   setDragging]   = useState<DragField | null>(null)
  const dragFieldRef = useRef<DragField | null>(null)

  const [yPos, setYPos] = useState<{ entry: number|null; sl: number|null; tp: number|null }>({
    entry: null, sl: null, tp: null,
  })
  const [entryX, setEntryX] = useState<number | null>(null)
  const prevY = useRef({ entry: 0, sl: 0, tp: 0 })
  const prevX = useRef(0)

  // Card drag state
  const [cardPos,  setCardPos]  = useState<{ x: number; y: number } | null>(null)
  const cardRef     = useRef<HTMLDivElement>(null)
  const cardDragRef = useRef<{ mx: number; my: number; cx: number; cy: number } | null>(null)

  // Inline edit
  const [editing, setEditing] = useState<'tp' | 'sl' | 'lot' | null>(null)
  const [editVal, setEditVal] = useState('')

  // RAF loop: mantém posições Y e X sincronizadas com scroll/zoom
  useEffect(() => {
    let raf: number
    const tick = () => {
      const e = getY(state.entry)
      const s = getY(state.sl)
      const t = getY(state.tp)
      const movedY =
        Math.abs((e ?? 0) - prevY.current.entry) > 0.4 ||
        Math.abs((s ?? 0) - prevY.current.sl)    > 0.4 ||
        Math.abs((t ?? 0) - prevY.current.tp)    > 0.4
      if (movedY) {
        prevY.current = { entry: e ?? 0, sl: s ?? 0, tp: t ?? 0 }
        setYPos({ entry: e, sl: s, tp: t })
      }

      // Posição X do candle de entrada (para linha vertical e badge)
      if (getX && state.entryTime) {
        const x = getX(state.entryTime)
        if (x !== null && Math.abs(x - prevX.current) > 0.4) {
          prevX.current = x
          setEntryX(x)
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getY, getX, state.entry, state.sl, state.tp, state.entryTime])

  // ── Drag das linhas ──────────────────────────────────────────────────────

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

    if (field === 'entry') {
      // Drag 2D: Y=preço (move tudo), X=tempo (move candle de entrada)
      const np = getPrice(e.clientY - rect.top)
      if (np !== null) {
        const dSL = state.sl - state.entry
        const dTP = state.tp - state.entry
        const newEntry = np
        const newTime  = getTime ? getTime(e.clientX - rect.left) : undefined
        onChange({
          ...state,
          entry:     newEntry,
          sl:        newEntry + dSL,
          tp:        newEntry + dTP,
          entryTime: newTime ?? state.entryTime,
        })
      }
    } else if (field === 'sl') {
      const np = getPrice(e.clientY - rect.top)
      if (np !== null) onChange({ ...state, sl: np })
    } else {
      const np = getPrice(e.clientY - rect.top)
      if (np !== null) onChange({ ...state, tp: np })
    }
  }, [state, getPrice, getTime, onChange, containerRef])

  const endDrag = useCallback(() => {
    dragFieldRef.current = null
    setDragging(null)
  }, [])

  // ── Card drag ────────────────────────────────────────────────────────────

  const startCardDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    let cx: number, cy: number
    if (cardPos) {
      cx = cardPos.x; cy = cardPos.y
    } else if (cardRef.current && containerRef.current) {
      const cRect = containerRef.current.getBoundingClientRect()
      const dRect = cardRef.current.getBoundingClientRect()
      cx = dRect.left - cRect.left
      cy = dRect.top  - cRect.top
    } else { return }
    cardDragRef.current = { mx: e.clientX, my: e.clientY, cx, cy }
  }, [cardPos, containerRef])

  const moveCardDrag = useCallback((e: React.PointerEvent) => {
    if (!cardDragRef.current) return
    const { mx, my, cx, cy } = cardDragRef.current
    setCardPos({ x: cx + (e.clientX - mx), y: cy + (e.clientY - my) })
  }, [])

  const endCardDrag = useCallback(() => { cardDragRef.current = null }, [])

  // ── Edição inline ─────────────────────────────────────────────────────────

  const commitEdit = useCallback((raw: string) => {
    const val = parseFloat(raw.replace(',', '.'))
    if (!isNaN(val) && val > 0) {
      const pv    = pipValueUSD(state.lot)
      const pips  = val / pv
      const off   = Math.round(pips * 0.0001 * 100000) / 100000
      const isBuy = state.direction === 'buy'
      if (editing === 'tp') {
        const newTp = isBuy ? state.entry + off : state.entry - off
        onChange({ ...state, tp: Math.round(newTp * 100000) / 100000 })
      } else if (editing === 'sl') {
        const newSl = isBuy ? state.entry - off : state.entry + off
        onChange({ ...state, sl: Math.round(newSl * 100000) / 100000 })
      }
    }
    setEditing(null); setEditVal('')
  }, [editing, state, onChange])

  // ── Cálculos P&L ─────────────────────────────────────────────────────────

  const pv     = pipValueUSD(state.lot)
  const slPips = Math.round(Math.abs(state.entry - state.sl)   * 10000)
  const tpPips = Math.round(Math.abs(state.tp   - state.entry) * 10000)
  const slUSD  = +(slPips * pv).toFixed(2)
  const tpUSD  = +(tpPips * pv).toFixed(2)
  const rr     = slPips > 0 ? tpPips / slPips : 0
  const isBuy  = state.direction === 'buy'

  const ok     = (y: number | null): y is number => y !== null && y > 8 && y < 9999
  const okX    = (x: number | null): x is number => x !== null && x > 0 && x < 99999

  const cardTop = ok(yPos.entry) ? Math.max(56, yPos.entry - 80) : 100

  // Posição horizontal da entrada: badge flutua junto com o candle
  const badgeX = okX(entryX) ? Math.max(12, entryX - 80) : 12

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none', zIndex: 10 }}>

      {/* Linha vertical do candle de entrada */}
      {okX(entryX) && (
        <div
          className="absolute top-0 bottom-0 w-px"
          style={{
            left:       entryX,
            background: 'rgba(59,130,246,0.25)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Zona vermelha: risco */}
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

      {/* Zona verde: alvo */}
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

      {/* Linha TAKE PROFIT */}
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

      {/* Linha ENTRADA — badge 2D arrastável (cima/baixo = preço; esq/dir = tempo) */}
      {ok(yPos.entry) && (
        <div
          className="absolute left-0 right-0 flex items-center"
          style={{ top: yPos.entry, transform: 'translateY(-50%)', pointerEvents: 'none' }}
        >
          {/* Linha tracejada */}
          <div
            className="absolute left-0 right-0 h-px"
            style={{
              background: `repeating-linear-gradient(90deg,${isBuy ? '#3b82f6' : '#f59e0b'} 0,${isBuy ? '#3b82f6' : '#f59e0b'} 5px,transparent 5px,transparent 11px)`,
              opacity: dragging === 'entry' ? 1 : 0.65,
            }}
          />

          {/* Badge 2D — posição X dinâmica + drag move + close */}
          <div
            className={cn(
              'absolute flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg whitespace-nowrap select-none transition-all',
              dragging === 'entry' ? 'opacity-100 shadow-xl scale-105' : 'opacity-90 hover:opacity-100 hover:scale-105',
            )}
            style={{
              left:            badgeX,
              pointerEvents:   'all',
              backgroundColor: dragging === 'entry' ? `${isBuy ? '#3b82f6' : '#f59e0b'}30` : `${isBuy ? '#3b82f6' : '#f59e0b'}1a`,
              border:          `1px solid ${dragging === 'entry' ? (isBuy ? '#3b82f680' : '#f59e0b80') : (isBuy ? '#3b82f645' : '#f59e0b45')}`,
              cursor:          dragging === 'entry' ? 'move' : 'move',
              touchAction:     'none',
              minWidth:        64,
            }}
            onPointerDown={e => startDrag(e, 'entry')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <Move size={11} style={{ color: isBuy ? '#3b82f6' : '#f59e0b', opacity: 0.7, flexShrink: 0 }} />
            <div className="flex flex-col justify-center">
              <span className="font-mono font-black leading-tight" style={{ color: isBuy ? '#3b82f6' : '#f59e0b', fontSize: 13 }}>
                {state.entry.toFixed(5)}
              </span>
              <span className="text-[9px] font-medium text-[#8b949e] leading-tight mt-0.5">
                {isBuy ? '▲ COMPRA' : '▼ VENDA'} · {state.lot.toFixed(2)}L
                {okX(entryX) ? ' · ✥ mover' : ''}
              </span>
            </div>
            {/* Fechar */}
            <button
              onClick={onClose}
              onPointerDown={e => e.stopPropagation()}
              className="flex items-center justify-center rounded transition-all hover:scale-110 active:scale-95 ml-0.5"
              style={{
                width: 16, height: 16,
                backgroundColor: `${isBuy ? '#3b82f6' : '#f59e0b'}25`,
                border:          `1px solid ${isBuy ? '#3b82f6' : '#f59e0b'}50`,
                color:           isBuy ? '#3b82f6' : '#f59e0b',
                flexShrink:      0,
              }}
              title="Cancelar OCO"
            >
              <X size={9} strokeWidth={3} />
            </button>
          </div>

          {/* Handle direita */}
          <div
            className={cn(
              'absolute right-0 flex items-center gap-1.5 px-2.5 py-2 rounded-l-lg',
              'font-mono text-[11px] font-bold border-l border-t border-b select-none transition-all cursor-move',
              dragging === 'entry' ? 'opacity-100 scale-105 shadow-xl' : 'opacity-55 hover:opacity-100 hover:scale-105',
            )}
            style={{
              pointerEvents:   'all',
              backgroundColor: dragging === 'entry' ? `${isBuy ? '#3b82f6' : '#f59e0b'}35` : `${isBuy ? '#3b82f6' : '#f59e0b'}1e`,
              borderColor:     `${isBuy ? '#3b82f680' : '#f59e0b80'}`,
              color:           isBuy ? '#3b82f6' : '#f59e0b',
              touchAction:     'none',
            }}
            onPointerDown={e => startDrag(e, 'entry')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <Move size={12} style={{ opacity: 0.8 }} />
            <div className="flex flex-col items-center" style={{ lineHeight: 1 }}>
              <span style={{ fontSize: 9, opacity: 0.7 }}>✥ mover</span>
              <span style={{ fontSize: 11 }}>{state.entry.toFixed(5)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Linha STOP LOSS */}
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

      {/* Card de execução — arrastável em 2D */}
      <div
        ref={cardRef}
        className="absolute"
        style={cardPos
          ? { left: cardPos.x, top: cardPos.y, pointerEvents: 'all' }
          : { right: 88, top: cardTop, pointerEvents: 'all' }
        }
      >
        <div
          className="rounded-2xl shadow-2xl overflow-hidden"
          style={{
            width: 200,
            background: 'rgba(10,12,18,0.97)',
            border: '1px solid #30363d',
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Handle de arraste */}
          <div
            className="flex items-center justify-center gap-1 select-none cursor-grab active:cursor-grabbing"
            style={{
              borderBottom: '1px solid #30363d',
              background:   '#161b22',
              padding:      '5px 0',
              touchAction:  'none',
              pointerEvents: 'all',
            }}
            onPointerDown={startCardDrag}
            onPointerMove={moveCardDrag}
            onPointerUp={endCardDrag}
            onPointerCancel={endCardDrag}
          >
            <GripVertical size={11} style={{ color: '#484f58' }} />
            <span style={{ fontSize: 9, color: '#484f58', letterSpacing: '0.8px' }}>MOVER</span>
            <GripVertical size={11} style={{ color: '#484f58' }} />
          </div>

          {/* Stats: GAIN | STOP | R:R */}
          <div className="grid grid-cols-3" style={{ borderBottom: '1px solid #30363d' }}>
            <div
              className="flex flex-col items-center py-2 px-1 cursor-pointer group"
              style={{ borderRight: '1px solid #30363d' }}
              onClick={() => { if (editing !== 'tp') { setEditing('tp'); setEditVal(tpUSD.toFixed(2)) } }}
              title="Clique para definir o ganho em dólares"
            >
              <span className="text-[8px] font-semibold tracking-widest uppercase" style={{ color: '#484f58' }}>
                GAIN <span className="opacity-0 group-hover:opacity-60 transition-opacity" style={{ fontSize: 7 }}>✎</span>
              </span>
              {editing === 'tp' ? (
                <div className="flex items-center mt-0.5" style={{ color: '#4ade80' }}>
                  <span style={{ fontSize: 10 }}>$</span>
                  <input
                    autoFocus
                    className="bg-transparent font-mono font-black text-center outline-none w-12"
                    style={{ fontSize: 12, color: '#4ade80' }}
                    value={editVal}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => commitEdit(editVal)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.preventDefault(); commitEdit(editVal) }
                      if (e.key === 'Escape') { setEditing(null); setEditVal('') }
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                </div>
              ) : (
                <span className="font-mono font-black mt-0.5" style={{ fontSize: 13, color: '#4ade80', letterSpacing: '-0.5px' }}>
                  +${tpUSD.toFixed(2)}
                </span>
              )}
            </div>

            <div
              className="flex flex-col items-center py-2 px-1 cursor-pointer group"
              style={{ borderRight: '1px solid #30363d' }}
              onClick={() => { if (editing !== 'sl') { setEditing('sl'); setEditVal(slUSD.toFixed(2)) } }}
              title="Clique para definir o stop em dólares"
            >
              <span className="text-[8px] font-semibold tracking-widest uppercase" style={{ color: '#484f58' }}>
                STOP <span className="opacity-0 group-hover:opacity-60 transition-opacity" style={{ fontSize: 7 }}>✎</span>
              </span>
              {editing === 'sl' ? (
                <div className="flex items-center mt-0.5" style={{ color: '#f87171' }}>
                  <span style={{ fontSize: 10 }}>$</span>
                  <input
                    autoFocus
                    className="bg-transparent font-mono font-black text-center outline-none w-12"
                    style={{ fontSize: 12, color: '#f87171' }}
                    value={editVal}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => commitEdit(editVal)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.preventDefault(); commitEdit(editVal) }
                      if (e.key === 'Escape') { setEditing(null); setEditVal('') }
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                </div>
              ) : (
                <span className="font-mono font-black mt-0.5" style={{ fontSize: 13, color: '#f87171', letterSpacing: '-0.5px' }}>
                  -${slUSD.toFixed(2)}
                </span>
              )}
            </div>

            <div className="flex flex-col items-center py-2 px-1">
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

          {/* Linha de lote */}
          <div
            className="flex items-center gap-1.5 px-3 py-2"
            style={{ borderBottom: '1px solid #30363d', background: '#0d1117' }}
          >
            <span className="text-[8px] font-semibold tracking-widest uppercase shrink-0" style={{ color: '#484f58' }}>
              LOTE
            </span>
            {editing === 'lot' ? (
              <input
                autoFocus
                className="bg-transparent font-mono font-black text-center outline-none border rounded"
                style={{ width: 52, fontSize: 12, color: '#f0f6fc', border: '1px solid #3b82f680', borderRadius: 4, padding: '1px 4px' }}
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onBlur={() => {
                  const v = parseFloat(editVal.replace(',', '.'))
                  if (!isNaN(v) && v > 0) onChange({ ...state, lot: Math.round(v * 100) / 100 })
                  setEditing(null); setEditVal('')
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const v = parseFloat(editVal.replace(',', '.'))
                    if (!isNaN(v) && v > 0) onChange({ ...state, lot: Math.round(v * 100) / 100 })
                    setEditing(null); setEditVal('')
                  }
                  if (e.key === 'Escape') { setEditing(null); setEditVal('') }
                }}
              />
            ) : (
              <button
                className="font-mono font-black rounded transition-all hover:scale-105"
                style={{ fontSize: 12, color: '#f0f6fc', minWidth: 36, background: '#21262d', border: '1px solid #30363d', padding: '1px 6px' }}
                onClick={() => { setEditing('lot'); setEditVal(state.lot.toFixed(2)) }}
                title="Clique para editar o lote"
              >
                {state.lot.toFixed(2)}
              </button>
            )}
            {([0.01, 0.10, 0.50, 1.00] as number[]).map(l => (
              <button
                key={l}
                onClick={() => onChange({ ...state, lot: l })}
                className="font-mono rounded transition-all hover:scale-105 active:scale-95"
                style={{
                  fontSize: 9, padding: '2px 4px',
                  background: state.lot === l ? '#3b82f620' : 'transparent',
                  border: `1px solid ${state.lot === l ? '#3b82f680' : '#30363d'}`,
                  color: state.lot === l ? '#3b82f6' : '#484f58',
                }}
              >
                {l === 1 ? '1L' : l === 0.5 ? '.5' : l === 0.1 ? '.10' : '.01'}
              </button>
            ))}
          </div>

          {/* Toggle DIREÇÃO */}
          <div className="grid grid-cols-2" style={{ borderBottom: '1px solid #30363d' }}>
            <button
              onClick={() => {
                const { entry, tp, sl } = state
                const tpDist = Math.abs(tp - entry)
                const slDist = Math.abs(sl - entry)
                onChange({ ...state, direction: 'buy', tp: entry + tpDist, sl: entry - slDist })
              }}
              className="flex items-center justify-center gap-1 py-2 select-none transition-all"
              style={{
                borderRight: '1px solid #30363d',
                background:  isBuy ? 'rgba(34,197,94,0.15)' : 'transparent',
                color:       isBuy ? '#4ade80' : '#484f58',
                fontWeight:  isBuy ? 900 : 500,
                fontSize:    10,
              }}
            >
              <TrendingUp size={11} strokeWidth={2.5} />
              COMPRA {isBuy && '●'}
            </button>
            <button
              onClick={() => {
                const { entry, tp, sl } = state
                const tpDist = Math.abs(tp - entry)
                const slDist = Math.abs(sl - entry)
                onChange({ ...state, direction: 'sell', tp: entry - tpDist, sl: entry + slDist })
              }}
              className="flex items-center justify-center gap-1 py-2 select-none transition-all"
              style={{
                background: !isBuy ? 'rgba(239,68,68,0.15)' : 'transparent',
                color:      !isBuy ? '#f87171' : '#484f58',
                fontWeight: !isBuy ? 900 : 500,
                fontSize:   10,
              }}
            >
              <TrendingDown size={11} strokeWidth={2.5} />
              VENDA {!isBuy && '●'}
            </button>
          </div>

          {/* Botões VENDA / COMPRA */}
          <div className="grid grid-cols-2">
            <button
              onClick={() => onExecute('sell')}
              className="flex flex-col items-center justify-center gap-1 py-4 active:scale-95 transition-all select-none"
              style={{ background: 'rgba(239,68,68,0.12)', borderRight: '1px solid #30363d', color: '#f87171' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.25)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.12)')}
            >
              <TrendingDown size={18} strokeWidth={2.5} />
              <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.5px' }}>VENDA</span>
            </button>
            <button
              onClick={() => onExecute('buy')}
              className="flex flex-col items-center justify-center gap-1 py-4 active:scale-95 transition-all select-none"
              style={{ background: 'rgba(34,197,94,0.12)', color: '#4ade80' }}
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
            style={{ borderTop: '1px solid #30363d', padding: '6px 0', fontSize: 10, color: '#484f58' }}
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
