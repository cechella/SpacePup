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
    draggingRef.current = { posId, which, origSL, origTP }
    setDragState({ posId, which, price: which === 'sl' ? origSL : origTP })

    // Rastreia no window para não bloquear eventos do gráfico quando não está arrastando
    const onMove = (ev: PointerEvent) => {
      if (!containerRef.current) return
      const rect  = containerRef.current.getBoundingClientRect()
      const price = getPrice(ev.clientY - rect.top)
      if (price === null) return
      setDragState({ posId, which, price })
    }
    const onUp = () => {
      setDragState(prev => {
        if (!prev || !draggingRef.current) return null
        const { origSL, origTP } = draggingRef.current
        const rounded = (v: number) => Math.round(v * 100000) / 100000
        const newSL = rounded(which === 'sl' ? prev.price : origSL)
        const newTP = rounded(which === 'tp' ? prev.price : origTP)
        onModify(posId, newSL, newTP)
        draggingRef.current = null
        return null
      })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
  }

  return (
    // pointerEvents: none no container — o gráfico recebe pinch/pan livremente
    // Apenas os badges SL/TP têm pointerEvents: all
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ zIndex: 10, pointerEvents: 'none' }}
    >
      {positions.map(pos => {
        const isBuy      = pos.type === 'POSITION_TYPE_BUY'
        const entryColor = isBuy ? '#3b82f6' : '#f59e0b'
        const tpColor    = '#10b981'
        const slColor    = '#ef4444'

        // Considera drag em curso
        const draggingSL  = dragState?.posId === pos.id && dragState.which === 'sl'
        const draggingTP  = dragState?.posId === pos.id && dragState.which === 'tp'
        const effectiveSL = draggingSL ? dragState.price : pos.stopLoss
        const effectiveTP = draggingTP ? dragState.price : pos.takeProfit

        const yEntry = getY(pos.openPrice)
        const ySL    = pos.stopLoss   ? getY(effectiveSL) : null
        const yTP    = pos.takeProfit ? getY(effectiveTP)  : null

        if (yEntry === null) return null

        // P&L em tempo real (linha de entrada)
        const price  = livePrice ?? pos.openPrice
        const rawPnl = (isBuy ? 1 : -1) * (price - pos.openPrice) * pos.volume * 100000
        const pnl    = isNaN(rawPnl) ? pos.profit : rawPnl
        const pnlClr = pnl >= 0 ? '#22c55e' : '#ef4444'
        const pnlStr = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`

        // Valor projetado em dólares se bater no TP ou SL
        const dir      = isBuy ? 1 : -1
        const tpDollar = dir * (effectiveTP - pos.openPrice) * pos.volume * 100000
        const slDollar = dir * (effectiveSL - pos.openPrice) * pos.volume * 100000
        const fmt      = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`

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

            {/* ── Linha TP ── */}
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
                    pointerEvents: 'all', touchAction: 'none',
                  }}
                  onPointerDown={e => handlePointerDown(e, pos.id, 'tp', pos.stopLoss, pos.takeProfit)}
                >
                  TP {effectiveTP.toFixed(5)}&nbsp;&nbsp;
                  <span style={{ color: tpDollar >= 0 ? '#10b981' : '#ef4444' }}>{fmt(tpDollar)}</span>
                </div>
              </>
            )}

            {/* ── Linha SL ── */}
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
                    pointerEvents: 'all', touchAction: 'none',
                  }}
                  onPointerDown={e => handlePointerDown(e, pos.id, 'sl', pos.stopLoss, pos.takeProfit)}
                >
                  SL {effectiveSL.toFixed(5)}&nbsp;&nbsp;
                  <span style={{ color: slDollar >= 0 ? '#10b981' : '#ef4444' }}>{fmt(slDollar)}</span>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
