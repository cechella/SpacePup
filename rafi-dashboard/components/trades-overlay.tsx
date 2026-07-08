'use client'

import { useEffect, useState } from 'react'
import type { ManualTrade } from './trade-panel'

interface Props {
  trades:  ManualTrade[]
  getX:    (time: number)  => number | null
  getY:    (price: number) => number | null
}

export function TradesOverlay({ trades, getX, getY }: Props) {
  // Sync com RAF para reagir a pan/zoom do gráfico
  const [, tick] = useState(0)
  useEffect(() => {
    let id: number
    const loop = () => { tick(n => n + 1); id = requestAnimationFrame(loop) }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none', zIndex: 5 }}>
      {trades.map(trade => {
        const x      = getX(trade.time)
        const yEntry = getY(trade.entry)
        const ySL    = getY(trade.stopLoss)
        const yTP    = getY(trade.takeProfit)

        if (x === null || yEntry === null) return null
        if (x < -40 || x > 99999) return null  // fora da janela

        const isBuy  = trade.direction === 'buy'
        const entryC = isBuy ? '#3b82f6' : '#f59e0b'
        const slC    = '#ef4444'
        const tpC    = '#10b981'
        const resC   = trade.result === 'win'  ? '#10b981'
                     : trade.result === 'loss' ? '#ef4444'
                     : '#484f58'
        const resLabel = trade.result === 'win'  ? 'WIN'
                       : trade.result === 'loss' ? 'LOSS'
                       : '…'

        return (
          <div key={trade.id}>
            {/* Linha vertical tênue no candle de entrada */}
            <div style={{
              position: 'absolute', left: x, top: 0, bottom: 0,
              width: 1, background: `${entryC}22`,
            }} />

            {/* Linha SL horizontal (estica da esquerda até o candle) */}
            {ySL !== null && (
              <div style={{
                position: 'absolute', right: 0, left: x,
                top: ySL, height: 0,
                borderTop: `1px dashed ${slC}55`,
              }} />
            )}

            {/* Linha TP horizontal */}
            {yTP !== null && (
              <div style={{
                position: 'absolute', right: 0, left: x,
                top: yTP, height: 0,
                borderTop: `1px dashed ${tpC}55`,
              }} />
            )}

            {/* Badge de entrada: seta + preço */}
            <div style={{
              position:   'absolute',
              left:       x,
              top:        yEntry,
              transform:  `translate(-50%, ${isBuy ? '-110%' : '10%'})`,
              background: entryC,
              color:      '#0d1117',
              fontSize:   9,
              fontWeight: 900,
              padding:    '1px 5px',
              borderRadius: 3,
              whiteSpace: 'nowrap',
            }}>
              {isBuy ? '▲' : '▼'} {trade.entry.toFixed(5)}
            </div>

            {/* Badge de resultado (WIN/LOSS/…) ao lado do TP */}
            {yTP !== null && (
              <div style={{
                position:   'absolute',
                left:       x + 4,
                top:        yTP,
                transform:  'translateY(-50%)',
                background: `${resC}22`,
                border:     `1px solid ${resC}55`,
                color:      resC,
                fontSize:   8,
                fontWeight: 800,
                padding:    '0px 4px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}>
                {resLabel}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
