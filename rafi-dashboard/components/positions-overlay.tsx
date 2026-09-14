'use client'

import { useEffect, useState, useRef } from 'react'

export interface LivePosition {
  id:         string
  type:       string   // 'POSITION_TYPE_BUY' | 'POSITION_TYPE_SELL'
  volume:     number
  openPrice:  number
  stopLoss:   number
  takeProfit: number
  profit:     number
  symbol:     string
}

interface Props {
  positions:    LivePosition[]
  livePrice?:   number | null
  getY:         (price: number) => number | null
  getPrice:     (y: number)     => number | null
  onModify:     (id: string, sl: number, tp: number) => void
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function PositionsOverlay({ positions, livePrice, getY, getPrice, onModify, containerRef }: Props) {
  const [, tick] = useState(0)
  const draggingRef = useRef<{
    posId: string; which: 'sl' | 'tp'
    origSL: number; origTP: number
  } | null>(null)
  const [dragState, setDragState] = useState<{ posId: string; which: 'sl' | 'tp'; price: number } | null>(null)

  // RAF loop: re-renderiza ao pan/zoom para manter linhas alinhadas
  useEffect(() => {
    let id: number
    const loop = () => { tick(n => n + 1); id = requestAnimationFrame(loop) }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])

  const handlePointerDown = (
    e: React.PointerEvent,
    posId: string,
    which: 'sl' | 'tp',
    origSL: number,
    origTP: number,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    draggingRef.current = { posId, which, origSL, origTP }
    setDragState({ posId, which, price: which === 'sl' ? origSL : origTP })
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current || !containerRef.current) return
    const rect  = containerRef.current.getBoundingClientRect()
    const price = getPrice(e.clientY - rect.top)
    if (price === null) return
    setDragState({ posId: draggingRef.current.posId, which: draggingRef.current.which, price })
  }

  const handlePointerUp = () => {
    if (!draggingRef.current || !dragState) return
    const { posId, which, origSL, origTP } = draggingRef.current
    const rounded = (v: number) => Math.round(v * 100000) / 100000
    const newSL = rounded(which === 'sl' ? dragState.price : origSL)
    const newTP = rounded(which === 'tp' ? dragState.price : origTP)
    onModify(posId, newSL, newTP)
    draggingRef.current = null
    setDragState(null)
  }

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ zIndex: 10 }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {positions.map(pos => {
        const isBuy      = pos.type === 'POSITION_TYPE_BUY'
        const entryColor = isBuy ? '#3b82f6' : '#f59e0b'
        const tpColor    = '#10b981'
        const slColor    = '#ef4444'

        // Considera drag em curso
        const draggingSL = dragState?.posId === pos.id && dragState.which === 'sl'
        const draggingTP = dragState?.posId === pos.id && dragState.which === 'tp'
        const effectiveSL = draggingSL ? dragState.price : pos.stopLoss
        const effectiveTP = draggingTP ? dragState.price : pos.takeProfit

        const yEntry = getY(pos.openPrice)
        const ySL    = pos.stopLoss   ? getY(effectiveSL) : null
        const yTP    = pos.takeProfit ? getY(effectiveTP)  : null

        if (yEntry === null) return null

        // P&L em tempo real (calculado pelo preço ao vivo, não espera poll de 5s)
        const price  = livePrice ?? pos.openPrice
        const rawPnl = (isBuy ? 1 : -1) * (price - pos.openPrice) * pos.volume * 100000
        const pnl    = isNaN(rawPnl) ? pos.profit : rawPnl
        const pnlClr = pnl >= 0 ? '#22c55e' : '#ef4444'
        const pnlStr = `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`

        return (
          <div key={pos.id}>
            {/* ── Linha de ENTRADA ── */}
            <div style={{
              position: 'absolute', left: 0, right: 0, top: yEntry,
              height: 0, borderTop: `1.5px dashed ${entryColor}`,
              pointerEvents: 'none',
            }} />

            {/* Label de entrada: direção + P&L ao vivo */}
            <div style={{
              position:   'absolute', left: 8, top: yEntry,
              transform:  'translateY(-50%)',
              background: `${entryColor}22`,
              border:     `1px solid ${entryColor}66`,
              color:      entryColor,
              fontSize:   10, fontWeight: 700,
              padding:    '2px 7px', borderRadius: 4,
              whiteSpace: 'nowrap', fontFamily: 'monospace',
              pointerEvents: 'none',
            }}>
              {isBuy ? '▲ BUY' : '▼ SELL'} {pos.volume}L{' '}
              <span style={{ color: pnlClr }}>{pnlStr}</span>
            </div>

            {/* Preço de entrada (lado direito) */}
            <div style={{
              position: 'absolute', right: 88, top: yEntry,
              transform: 'translateY(-50%)',
              color: `${entryColor}cc`, fontSize: 9,
              fontFamily: 'monospace', fontWeight: 600,
              pointerEvents: 'none',
            }}>
              {pos.openPrice.toFixed(5)}
            </div>

            {/* ── Linha TP (arrastável) ── */}
            {yTP !== null && (
              <>
                <div style={{
                  position: 'absolute', left: 0, right: 0, top: yTP,
                  height: 0, borderTop: `1.5px dashed ${tpColor}`,
                  pointerEvents: 'none',
                }} />
                <div
                  style={{
                    position:   'absolute', left: 8, top: yTP,
                    transform:  'translateY(-50%)',
                    background: `${tpColor}22`,
                    border:     `1px solid ${tpColor}`,
                    color:      tpColor,
                    fontSize: 9, fontWeight: 700,
                    padding: '2px 5px', borderRadius: 3,
                    whiteSpace: 'nowrap', fontFamily: 'monospace',
                    cursor: 'ns-resize', userSelect: 'none',
                    pointerEvents: 'all',
                  }}
                  onPointerDown={e => handlePointerDown(e, pos.id, 'tp', pos.stopLoss, pos.takeProfit)}
                >
                  TP {effectiveTP.toFixed(5)}
                </div>
              </>
            )}

            {/* ── Linha SL (arrastável) ── */}
            {ySL !== null && (
              <>
                <div style={{
                  position: 'absolute', left: 0, right: 0, top: ySL,
                  height: 0, borderTop: `1.5px dashed ${slColor}`,
                  pointerEvents: 'none',
                }} />
                <div
                  style={{
                    position:   'absolute', left: 8, top: ySL,
                    transform:  'translateY(-50%)',
                    background: `${slColor}22`,
                    border:     `1px solid ${slColor}`,
                    color:      slColor,
                    fontSize: 9, fontWeight: 700,
                    padding: '2px 5px', borderRadius: 3,
                    whiteSpace: 'nowrap', fontFamily: 'monospace',
                    cursor: 'ns-resize', userSelect: 'none',
                    pointerEvents: 'all',
                  }}
                  onPointerDown={e => handlePointerDown(e, pos.id, 'sl', pos.stopLoss, pos.takeProfit)}
                >
                  SL {effectiveSL.toFixed(5)}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
