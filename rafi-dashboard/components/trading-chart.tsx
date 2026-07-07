'use client'

import { useEffect, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { CandleData, TradeSignal, LinePoint } from '@/lib/types'

interface Props {
  candles:    CandleData[]
  signals:    TradeSignal[]
  ma20:       LinePoint[]
  ma50:       LinePoint[]
}

export function TradingChart({ candles, signals, ma20, ma50 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    let chart: IChartApi
    let ro: ResizeObserver

    const init = async () => {
      const {
        createChart, ColorType, CrosshairMode, LineStyle,
      } = await import('lightweight-charts')

      const el = containerRef.current!
      chart = createChart(el, {
        layout: {
          background: { type: ColorType.Solid, color: '#0d1117' },
          textColor: '#8b949e',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: '#1c2128' },
          horzLines: { color: '#1c2128' },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: '#3b82f640', style: LineStyle.Dashed, width: 1 },
          horzLine: { color: '#3b82f640', style: LineStyle.Dashed, width: 1 },
        },
        rightPriceScale: {
          borderColor: '#30363d',
          scaleMargins: { top: 0.08, bottom: 0.08 },
        },
        timeScale: {
          borderColor: '#30363d',
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
        },
        width:  el.clientWidth,
        height: el.clientHeight,
      })

      // ── Candlesticks ────────────────────────────────────────────────────────
      const candle = chart.addCandlestickSeries({
        upColor:      '#10b981',
        downColor:    '#ef4444',
        borderVisible: false,
        wickUpColor:   '#10b981',
        wickDownColor: '#ef4444',
      })
      candle.setData(candles as any)

      // ── MA20 ────────────────────────────────────────────────────────────────
      if (ma20.length) {
        const ma20s = chart.addLineSeries({
          color: '#3b82f6', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: true,
          title: 'MA20',
        })
        ma20s.setData(ma20 as any)
      }

      // ── MA50 ────────────────────────────────────────────────────────────────
      if (ma50.length) {
        const ma50s = chart.addLineSeries({
          color: '#f59e0b', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: true,
          title: 'MA50',
        })
        ma50s.setData(ma50 as any)
      }

      // ── Marcadores de entrada ────────────────────────────────────────────────
      const markers = signals.map(s => ({
        time: s.time as any,
        position: s.direction === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
        color:
          s.outcome === 'win'  ? '#10b981' :
          s.outcome === 'loss' ? '#ef4444' :
          '#f59e0b',
        shape:  s.direction === 'buy' ? 'arrowUp' as const : 'arrowDown' as const,
        text:
          s.direction === 'buy'
            ? `▲ BUY ${s.riskPips}p SL→TP${(s.riskPips * 2).toFixed(0)}p`
            : `▼ SELL ${s.riskPips}p SL→TP${(s.riskPips * 2).toFixed(0)}p`,
        size: 2,
      }))
      candle.setMarkers(markers)

      // ── Linhas de SL e TP por sinal ──────────────────────────────────────────
      for (const sig of signals) {
        const endTime = sig.exitTime ?? candles[candles.length - 1].time
        const twoPoints = (val: number) => [
          { time: sig.time as any, value: val },
          { time: endTime as any,  value: val },
        ]

        // TP — verde tracejado
        const tp = chart.addLineSeries({
          color: '#10b98170', lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false,
        })
        tp.setData(twoPoints(sig.takeProfit))

        // SL — vermelho tracejado
        const sl = chart.addLineSeries({
          color: '#ef444470', lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false,
        })
        sl.setData(twoPoints(sig.stopLoss))

        // Entrada — branco fino
        const en = chart.addLineSeries({
          color: '#ffffff30', lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false, lastValueVisible: false,
        })
        en.setData(twoPoints(sig.entry))
      }

      chart.timeScale().fitContent()
      chartRef.current = chart

      ro = new ResizeObserver(() => {
        const el = containerRef.current
        if (el && chartRef.current) {
          chartRef.current.applyOptions({ width: el.clientWidth, height: el.clientHeight })
        }
      })
      ro.observe(el)
    }

    init()

    return () => {
      ro?.disconnect()
      chart?.remove()
      chartRef.current = null
    }
  }, [candles, signals, ma20, ma50])

  return <div ref={containerRef} className="w-full h-full" />
}
