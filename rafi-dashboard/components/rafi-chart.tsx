'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { CandleData } from '@/lib/types'
import { applyRAFICandleColors } from '@/lib/indicators'
import type { RAFIPoint, SRLevel, BBBands } from '@/lib/indicators'
import type { ManualTrade } from './trade-panel'
import { OCOOverlay, type OCOState } from './oco-overlay'
import { TradesOverlay } from './trades-overlay'

interface Props {
  candles:            CandleData[]
  rafiData:           RAFIPoint[]
  srLevels:           SRLevel[]
  trades:             ManualTrade[]
  bbBands?:           BBBands
  onPriceClick?:      (price: number, time?: number) => void
  panMode?:           boolean
  ocoState?:          OCOState | null
  onOCOChange?:       (s: OCOState) => void
  onOCOExecute?:      (dir: 'buy' | 'sell') => void
  onOCOClose?:        () => void
  // Ref para captura focada no candle de entrada
  snapshotCaptureRef?: React.MutableRefObject<((entryTime: number) => string | null) | null>
}

export function RAFIChart({
  candles, rafiData, srLevels, trades, bbBands, onPriceClick, panMode,
  ocoState, onOCOChange, onOCOExecute, onOCOClose, snapshotCaptureRef,
}: Props) {
  const mainRef         = useRef<HTMLDivElement>(null)
  const mainWrapperRef  = useRef<HTMLDivElement>(null)
  const rafiRef         = useRef<HTMLDivElement>(null)
  const onPriceClickRef = useRef(onPriceClick)
  const candleSeriesRef = useRef<any>(null)
  const chartRef        = useRef<any>(null)
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => { onPriceClickRef.current = onPriceClick }, [onPriceClick])

  // Funções estáveis para conversão preço ↔ Y e tempo ↔ X
  const getY     = useCallback((price: number): number | null =>
    candleSeriesRef.current?.priceToCoordinate(price) ?? null, [])
  const getPrice = useCallback((y: number): number | null =>
    candleSeriesRef.current?.coordinateToPrice(y) ?? null, [])
  const getX     = useCallback((time: number): number | null => {
    try { return chartRef.current?.timeScale().timeToCoordinate(time as any) ?? null } catch { return null }
  }, [])
  const getTime  = useCallback((x: number): number | null => {
    try {
      const t = chartRef.current?.timeScale().coordinateToTime(x as any)
      return t !== undefined && t !== null ? Number(t) : null
    } catch { return null }
  }, [])

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

      // ── Gráfico principal ────────────────────────────────────────────────
      mChart = createChart(mainEl, {
        layout:    sharedLayout,
        grid:      sharedGrid,
        crosshair: sharedCrosshair,
        localization: {
          priceFormatter: (p: number) => p.toFixed(5),
        },
        rightPriceScale: {
          borderColor:  '#30363d',
          scaleMargins: { top: 0.08, bottom: 0.08 },
          minimumWidth: 80,
        },
        timeScale: {
          borderColor:    '#30363d',
          timeVisible:    true,
          secondsVisible: false,
          visible:        false,
        },
        width:  mainEl.clientWidth  || 600,
        height: mainEl.clientHeight || 300,
      })

      const candleSeries = mChart.addCandlestickSeries({
        upColor:       '#10b981',
        downColor:     '#ef4444',
        borderVisible: false,
        wickUpColor:   '#10b981',
        wickDownColor: '#ef4444',
      })
      candleSeries.setData(applyRAFICandleColors(candles, rafiData) as any)

      candleSeriesRef.current = candleSeries
      chartRef.current        = mChart
      setChartReady(true)

      // Expõe função de captura focada no candle de entrada (usado pelo OCO execute)
      if (snapshotCaptureRef) {
        snapshotCaptureRef.current = (entryTime: number) => {
          try {
            const x = mChart.timeScale().timeToCoordinate(entryTime as any)
            if (x === null || x === undefined) return null
            const canvases = Array.from(mainEl.querySelectorAll('canvas'))
            if (!canvases.length) return null
            const src = canvases.reduce((a, b) => a.height >= b.height ? a : b)
            // Recorte: janela de 500px centrada no candle de entrada
            const W_out = 480, H_out = 180
            const half  = 250
            const sx    = Math.max(0, Math.round(x) - half)
            const sw    = Math.min(500, src.width - sx)
            const thumb = document.createElement('canvas')
            thumb.width = W_out; thumb.height = H_out
            const ctx = thumb.getContext('2d')
            if (!ctx) return null
            ctx.drawImage(src, sx, 0, sw, src.height, 0, 0, W_out, H_out)
            return thumb.toDataURL('image/jpeg', 0.75)
          } catch { return null }
        }
      }

      // Clique no gráfico → captura preço E tempo do candle
      mChart.subscribeClick((param) => {
        if (!param.point) return
        const price = candleSeries.coordinateToPrice(param.point.y)
        const time  = param.time !== undefined ? Number(param.time) : undefined
        if (price !== null) onPriceClickRef.current?.(price, time)
      })

      // Bandas de Bollinger (8p, 2σ)
      if (bbBands) {
        const bbOpts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, color: '#26c6da' }
        mChart.addLineSeries(bbOpts).setData(bbBands.upper as any)
        mChart.addLineSeries(bbOpts).setData(bbBands.lower as any)
      }

      // Níveis S/R
      for (const lvl of srLevels) {
        candleSeries.createPriceLine({
          price:            lvl.price,
          color:            lvl.type === 'resistance' ? '#ef444448' : '#10b98148',
          lineWidth:        1,
          lineStyle:        LineStyle.Dotted,
          axisLabelVisible: false,
          title:            '',
        })
      }

      // Marcadores de trades: seta no candle correto (tempo real do trade)
      if (trades.length > 0) {
        const markers = trades
          .filter(t => t.time > 0)
          .map(t => ({
            time:     t.time as any,
            position: t.direction === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
            color:    t.direction === 'buy' ? '#3b82f6' : '#f59e0b',
            shape:    t.direction === 'buy' ? 'arrowUp' as const : 'arrowDown' as const,
            text:     '',
            size:     2,
          }))
        candleSeries.setMarkers(markers)
      }

      mChart.timeScale().fitContent()

      // ── Gráfico RAFI ─────────────────────────────────────────────────────
      rChart = createChart(rafiEl, {
        layout:    sharedLayout,
        grid:      sharedGrid,
        crosshair: sharedCrosshair,
        rightPriceScale: {
          borderColor:  '#30363d',
          scaleMargins: { top: 0.12, bottom: 0.12 },
          minimumWidth: 80,
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
      // RAFI > 0 = entrada válida; RAFI >= 2.5 = força forte
      histSeries.createPriceLine({ price: 2.5, color: '#f59e0b80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: 'forte' })
      histSeries.createPriceLine({ price: 0,   color: '#8b949e30', lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: false, title: '' })

      rChart.timeScale().fitContent()

      // Sincroniza escalas de tempo
      let syncing = false
      mChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range) return
        syncing = true; rChart.timeScale().setVisibleLogicalRange(range); syncing = false
      })
      rChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range) return
        syncing = true; mChart.timeScale().setVisibleLogicalRange(range); syncing = false
      })

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
      setChartReady(false)
      candleSeriesRef.current = null
      roMain?.disconnect()
      roRafi?.disconnect()
      mChart?.remove()
      rChart?.remove()
    }
  }, [candles, rafiData, srLevels, trades, bbBands])


  return (
    <div className="flex flex-col h-full">
      {/* Área principal — relative para o overlay OCO */}
      <div
        className="flex-[7] min-h-0 relative"
        ref={mainWrapperRef}
        style={{ cursor: panMode ? 'grab' : 'crosshair' }}
      >
        <div ref={mainRef} className="absolute inset-0" />
        {chartReady && trades.length > 0 && (
          <TradesOverlay trades={trades} getX={getX} getY={getY} />
        )}
        {ocoState && chartReady && (
          <OCOOverlay
            state={ocoState}
            onChange={onOCOChange  ?? (() => {})}
            onExecute={onOCOExecute ?? (() => {})}
            onClose={onOCOClose    ?? (() => {})}
            getY={getY}
            getPrice={getPrice}
            getX={getX}
            getTime={getTime}
            containerRef={mainRef}
          />
        )}
      </div>
      <div className="h-px bg-[#30363d] shrink-0" />
      <div ref={rafiRef} className="flex-[3] min-h-0" />
    </div>
  )
}
