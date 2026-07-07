'use client'

import { useEffect, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { CandleData, LinePoint } from '@/lib/types'
import type { RAFIPoint, SRLevel } from '@/lib/indicators'
import type { ManualTrade } from './trade-panel'

interface Props {
  candles:  CandleData[]
  rafiData: RAFIPoint[]
  srLevels: SRLevel[]
  trades:   ManualTrade[]
  ma20?:    LinePoint[]
  ma50?:    LinePoint[]
}

export function RAFIChart({ candles, rafiData, srLevels, trades, ma20 = [], ma50 = [] }: Props) {
  const mainRef = useRef<HTMLDivElement>(null)
  const rafiRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mainRef.current || !rafiRef.current || candles.length === 0) return

    let mChart: IChartApi
    let rChart: IChartApi
    let roMain: ResizeObserver
    let roRafi: ResizeObserver

    const init = async () => {
      const { createChart, ColorType, CrosshairMode, LineStyle } = await import('lightweight-charts')

      const mainEl = mainRef.current!
      const rafiEl = rafiRef.current!

      const sharedLayout = {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#8b949e',
        fontSize: 11,
      }
      const sharedGrid = {
        vertLines: { color: '#1c2128' },
        horzLines: { color: '#1c2128' },
      }
      const sharedCrosshair = {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#3b82f640', style: LineStyle.Dashed, width: 1 as const },
        horzLine: { color: '#3b82f640', style: LineStyle.Dashed, width: 1 as const },
      }

      // ── Gráfico principal (candlestick) ──────────────────────────────────
      mChart = createChart(mainEl, {
        layout:    sharedLayout,
        grid:      sharedGrid,
        crosshair: sharedCrosshair,
        rightPriceScale: {
          borderColor: '#30363d',
          scaleMargins: { top: 0.08, bottom: 0.08 },
        },
        timeScale: {
          borderColor:     '#30363d',
          timeVisible:     true,
          secondsVisible:  false,
          visible:         false,  // eixo de tempo só no painel RAFI abaixo
        },
        width:  mainEl.clientWidth  || 600,
        height: mainEl.clientHeight || 300,
      })

      const candleSeries = mChart.addCandlestickSeries({
        upColor:      '#10b981',
        downColor:    '#ef4444',
        borderVisible: false,
        wickUpColor:   '#10b981',
        wickDownColor: '#ef4444',
      })
      candleSeries.setData(candles as any)

      if (ma20.length) {
        mChart
          .addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(ma20 as any)
      }
      if (ma50.length) {
        mChart
          .addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(ma50 as any)
      }

      // Níveis de suporte/resistência
      for (const lvl of srLevels) {
        candleSeries.createPriceLine({
          price:             lvl.price,
          color:             lvl.type === 'resistance' ? '#ef444448' : '#10b98148',
          lineWidth:         1,
          lineStyle:         LineStyle.Dotted,
          axisLabelVisible:  false,
          title:             '',
        })
      }

      // Marcadores e linhas de trade manual
      if (trades.length > 0) {
        const lastTime = candles[candles.length - 1].time
        const markers = trades.map((t, i) => ({
          time:     (lastTime - (trades.length - 1 - i) * 300) as any,
          position: t.direction === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
          color:    t.direction === 'buy' ? '#10b981' : '#ef4444',
          shape:    t.direction === 'buy' ? 'arrowUp' as const : 'arrowDown' as const,
          text:     t.direction.toUpperCase(),
          size:     2,
        }))
        candleSeries.setMarkers(markers)

        for (const t of trades) {
          const dirColor = t.direction === 'buy' ? '#10b981' : '#ef4444'
          candleSeries.createPriceLine({
            price: t.entry, color: `${dirColor}99`, lineWidth: 2,
            lineStyle: LineStyle.Solid, axisLabelVisible: true,
            title: `${t.direction === 'buy' ? '▲' : '▼'} Entry`,
          })
          candleSeries.createPriceLine({
            price: t.stopLoss, color: '#ef444490', lineWidth: 1,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL',
          })
          candleSeries.createPriceLine({
            price: t.takeProfit, color: '#10b98190', lineWidth: 1,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP',
          })
        }
      }

      mChart.timeScale().fitContent()

      // ── Gráfico RAFI (histograma) ─────────────────────────────────────────
      rChart = createChart(rafiEl, {
        layout:    sharedLayout,
        grid:      sharedGrid,
        crosshair: sharedCrosshair,
        rightPriceScale: {
          borderColor:  '#30363d',
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderColor:    '#30363d',
          timeVisible:    true,
          secondsVisible: false,
          fixLeftEdge:    true,
          fixRightEdge:   true,
        },
        width:  rafiEl.clientWidth  || 600,
        height: rafiEl.clientHeight || 120,
      })

      const histSeries = rChart.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      })
      histSeries.setData(rafiData as any)

      histSeries.createPriceLine({ price:  2.5, color: '#f59e0b80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: '+2.5' })
      histSeries.createPriceLine({ price: -2.5, color: '#ef444480', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: '-2.5' })
      histSeries.createPriceLine({ price:  0,   color: '#8b949e30', lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: false, title: '' })

      rChart.timeScale().fitContent()

      // ── Sincroniza escalas de tempo ───────────────────────────────────────
      let syncing = false
      mChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range) return
        syncing = true
        rChart.timeScale().setVisibleLogicalRange(range)
        syncing = false
      })
      rChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range) return
        syncing = true
        mChart.timeScale().setVisibleLogicalRange(range)
        syncing = false
      })

      // ── ResizeObserver ────────────────────────────────────────────────────
      roMain = new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) mChart?.applyOptions({ width, height })
      })
      roRafi = new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) rChart?.applyOptions({ width, height })
      })
      roMain.observe(mainEl)
      roRafi.observe(rafiEl)
    }

    init()

    return () => {
      roMain?.disconnect()
      roRafi?.disconnect()
      mChart?.remove()
      rChart?.remove()
    }
  }, [candles, rafiData, srLevels, trades, ma20, ma50])

  return (
    <div className="flex flex-col h-full">
      <div ref={mainRef} className="flex-[7] min-h-0" />
      <div className="h-px bg-[#30363d] shrink-0" />
      <div ref={rafiRef} className="flex-[3] min-h-0" />
    </div>
  )
}
