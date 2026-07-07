'use client'

import { useEffect, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { EquityPoint } from '@/lib/types'

interface Props { data: EquityPoint[]; initialCapital: number }

export function EquityCurve({ data, initialCapital }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || data.length < 2) return

    let chart: IChartApi
    let ro: ResizeObserver

    const init = async () => {
      const { createChart, ColorType, LineStyle } = await import('lightweight-charts')

      const el = containerRef.current!
      chart = createChart(el, {
        layout: {
          background: { type: ColorType.Solid, color: '#0d1117' },
          textColor: '#8b949e',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: '#1c2128' },
          horzLines: { color: '#1c2128' },
        },
        rightPriceScale: {
          borderColor: '#30363d',
          scaleMargins: { top: 0.1, bottom: 0.05 },
        },
        timeScale: {
          borderColor: '#30363d',
          timeVisible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
        },
        handleScale: false,
        handleScroll: false,
        width:  el.clientWidth,
        height: el.clientHeight,
      })

      const finalValue = data[data.length - 1]?.value ?? initialCapital
      const isProfit   = finalValue >= initialCapital
      const lineColor  = isProfit ? '#10b981' : '#ef4444'
      const areaTop    = isProfit ? '#10b98130' : '#ef444430'

      // Linha de capital inicial (baseline)
      const baseline = chart.addLineSeries({
        color: '#30363d', lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false,
      })
      baseline.setData([
        { time: data[0].time as any, value: initialCapital },
        { time: data[data.length - 1].time as any, value: initialCapital },
      ])

      const area = chart.addAreaSeries({
        lineColor,
        topColor:    areaTop,
        bottomColor: '#0d1117',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'Capital',
      })
      area.setData(data as any)

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
    return () => { ro?.disconnect(); chart?.remove(); chartRef.current = null }
  }, [data, initialCapital])

  return <div ref={containerRef} className="w-full h-full" />
}
