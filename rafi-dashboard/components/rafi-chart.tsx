'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { CandleData } from '@/lib/types'
import { applyRAFICandleColors } from '@/lib/indicators'
import type { RAFIPoint, SRLevel, BBBands } from '@/lib/indicators'
import type { ManualTrade } from './trade-panel'
import { OCOOverlay, type OCOState } from './oco-overlay'
import { TradesOverlay } from './trades-overlay'
import { PositionsOverlay, type LivePosition } from './positions-overlay'

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
  // Preço ao vivo para P&L nos badges/tabela (estado React ~300ms)
  livePrice?:         number | null
  // Ref direto (RAF legado — mantido para overlay P&L)
  livePriceRef?:      React.MutableRefObject<number | null>
  // Callback imperativo: page.tsx preenche; SSE chama direto, sem React
  chartUpdateCandleRef?: React.MutableRefObject<((price: number) => void) | null>
  // Posições abertas ao vivo (MetaAPI)
  positions?:         LivePosition[]
  onModifyPosition?:  (id: string, sl: number, tp: number) => void
  // Ref para captura focada no candle de entrada com overlay OCO desenhado
  snapshotCaptureRef?: React.MutableRefObject<((entryTime: number, oco?: { entry: number; sl: number; tp: number; direction: 'buy' | 'sell' }) => string | null) | null>
}

export function RAFIChart({
  candles, rafiData, srLevels, trades, bbBands, onPriceClick, panMode,
  ocoState, onOCOChange, onOCOExecute, onOCOClose, livePrice, livePriceRef,
  chartUpdateCandleRef, positions, onModifyPosition, snapshotCaptureRef,
}: Props) {
  const mainRef         = useRef<HTMLDivElement>(null)
  const mainWrapperRef  = useRef<HTMLDivElement>(null)
  const rafiRef         = useRef<HTMLDivElement>(null)
  const onPriceClickRef = useRef(onPriceClick)
  const candleSeriesRef = useRef<any>(null)
  const chartRef        = useRef<any>(null)
  const positionsRef    = useRef(positions)
  const candlesRef      = useRef(candles)
  const yScaleRef       = useRef<{ top: number; bottom: number }>({ top: 0.12, bottom: 0.12 })
  // Rastreia a barra atual em andamento (não retornada pelo getHistoricalCandles)
  const currentBarRef   = useRef<{ time: number; open: number; high: number; low: number } | null>(null)
  // ID do RAF loop do tick ao vivo
  const rafIdRef        = useRef<number>(0)
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => { onPriceClickRef.current = onPriceClick }, [onPriceClick])
  useEffect(() => { positionsRef.current = positions }, [positions])
  useEffect(() => { candlesRef.current = candles }, [candles])

  // Faixa arrastável de escala Y — funciona no mobile sem depender do lightweight-charts
  const handleYScaleTouch = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    const startY   = e.touches[0].clientY
    const startTop = yScaleRef.current.top
    const startBot = yScaleRef.current.bottom

    const onMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return
      const dy     = ev.touches[0].clientY - startY
      // Arrastar pra cima → mais espaço (escala mais elástica)
      // Arrastar pra baixo → menos espaço (zoom in)
      const delta  = dy / 300
      const top    = Math.min(0.45, Math.max(0.02, startTop + delta))
      const bottom = Math.min(0.45, Math.max(0.02, startBot + delta))
      yScaleRef.current = { top, bottom }
      chartRef.current?.applyOptions({ rightPriceScale: { scaleMargins: { top, bottom } } })
    }
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend',  onEnd)
    }
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend',  onEnd)
  }, [])

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
          scaleMargins: { top: 0.12, bottom: 0.12 },
          minimumWidth: 80,
        },
        handleScale: {
          axisPressedMouseMove: { price: true, time: true },
          pinch: true,
          mouseWheel: true,
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

      // RAF loop: atualiza o candle ao vivo a cada frame do display (~60fps).
      // Usa candleSeries DIRETAMENTE (sem ref intermediário) e lê livePriceRef.current
      // a cada frame — totalmente fora do scheduler do React, funciona durante zoom/pan/touch.
      currentBarRef.current = null
      let lastRafPrice: number | null = null
      const liveLoop = () => {
        const price = livePriceRef?.current ?? null
        if (price !== null && price !== lastRafPrice) {
          lastRafPrice = price
          const cands = candlesRef.current
          if (cands.length > 0) {
            const last = cands[cands.length - 1]
            const tfSec = cands.length > 1
              ? Math.round(Math.abs((cands[cands.length - 1].time as any) - (cands[cands.length - 2].time as any)))
              : 300
            const nowSec         = Math.floor(Date.now() / 1000)
            const currentBarTime = Math.floor(nowSec / tfSec) * tfSec
            const lastBarTime    = last.time as unknown as number

            let barTime: number, barOpen: number, barHigh: number, barLow: number
            if (currentBarTime <= lastBarTime) {
              currentBarRef.current = null
              barTime = lastBarTime; barOpen = last.open
              barHigh = Math.max(last.high, price); barLow = Math.min(last.low, price)
            } else {
              const b = currentBarRef.current
              if (!b || b.time !== currentBarTime) {
                currentBarRef.current = { time: currentBarTime, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price) }
              } else {
                currentBarRef.current = { ...b, high: Math.max(b.high, price), low: Math.min(b.low, price) }
              }
              const nb = currentBarRef.current!
              barTime = nb.time; barOpen = nb.open; barHigh = nb.high; barLow = nb.low
            }
            const isBull = price >= barOpen
            try {
              candleSeries.update({
                time: barTime as any,
                open: barOpen, high: barHigh, low: barLow, close: price,
                color:     isBull ? '#10b981' : '#ef4444',
                wickColor: isBull ? '#10b981' : '#ef4444',
              })
            } catch {}
          }
        }
        rafIdRef.current = requestAnimationFrame(liveLoop)
      }
      rafIdRef.current = requestAnimationFrame(liveLoop)

      // Expõe função de captura focada no candle de entrada (usado pelo OCO execute)
      if (snapshotCaptureRef) {
        snapshotCaptureRef.current = (entryTime: number, oco?: { entry: number; sl: number; tp: number; direction: 'buy' | 'sell' }) => {
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

            // Overlay das linhas OCO desenhadas diretamente no thumbnail
            if (oco) {
              const scaleY = H_out / src.height
              const xEntry = ((Math.round(x) - sx) / sw) * W_out

              const priceToY = (price: number): number | null => {
                const yRaw = candleSeries.priceToCoordinate(price)
                return yRaw !== null ? Math.round(yRaw * scaleY) : null
              }

              const drawHLine = (price: number, color: string, label: string) => {
                const y = priceToY(price)
                if (y === null || y < 0 || y > H_out) return
                ctx.save()
                ctx.setLineDash([5, 3])
                ctx.strokeStyle = color
                ctx.lineWidth = 1.5
                ctx.globalAlpha = 0.9
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W_out, y); ctx.stroke()
                // Label à direita
                ctx.globalAlpha = 1
                ctx.setLineDash([])
                ctx.font = 'bold 10px monospace'
                ctx.fillStyle = color
                ctx.textAlign = 'right'
                ctx.fillText(label, W_out - 4, y - 3)
                ctx.restore()
              }

              // Linha vertical no candle de entrada
              ctx.save()
              ctx.setLineDash([3, 3])
              ctx.strokeStyle = '#3b82f6'
              ctx.lineWidth = 1
              ctx.globalAlpha = 0.6
              ctx.beginPath(); ctx.moveTo(xEntry, 0); ctx.lineTo(xEntry, H_out); ctx.stroke()
              ctx.restore()

              drawHLine(oco.entry, '#3b82f6', `E ${oco.entry.toFixed(5)}`)
              drawHLine(oco.tp,    '#10b981', `TP ${oco.tp.toFixed(5)}`)
              drawHLine(oco.sl,    '#ef4444', `SL ${oco.sl.toFixed(5)}`)
            }

            return thumb.toDataURL('image/jpeg', 0.82)
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

      // Mostra sempre os últimos 80 candles (legível em desktop e mobile)
      mChart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - 80),
        to:   candles.length + 5,
      })
      mChart.timeScale().scrollToRealTime()

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
      histSeries.createPriceLine({ price:  2.5, color: '#f59e0b80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: '+2.5' })
      histSeries.createPriceLine({ price: -2.5, color: '#f59e0b80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: '-2.5' })
      histSeries.createPriceLine({ price:  0,   color: '#8b949e30', lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: false, title: '' })

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
      cancelAnimationFrame(rafIdRef.current)
      setChartReady(false)
      candleSeriesRef.current = null
      roMain?.disconnect()
      roRafi?.disconnect()
      mChart?.remove()
      rChart?.remove()
    }
  }, [candles, rafiData, srLevels, trades, bbBands])

  // O tick ao vivo é tratado pelo RAF loop dentro do init() acima.
  // chartUpdateCandleRef não precisa mais atualizar o gráfico diretamente —
  // o RAF lê livePriceRef.current a cada frame; manter o callback como no-op
  // para não quebrar a interface com page.tsx.
  useEffect(() => {
    if (!chartUpdateCandleRef) return
    chartUpdateCandleRef.current = () => {}
    return () => { if (chartUpdateCandleRef) chartUpdateCandleRef.current = null }
  }, [chartUpdateCandleRef])


  return (
    <div className="flex flex-col h-full">
      {/* Área principal — relative para o overlay OCO */}
      <div
        className="flex-[7] min-h-0 relative"
        ref={mainWrapperRef}
        style={{ cursor: panMode ? 'grab' : 'crosshair' }}
      >
        {/* Faixa arrastável de escala Y (mobile) — borda direita */}
        {chartReady && (
          <div
            onTouchStart={handleYScaleTouch}
            style={{
              position: 'absolute', right: 0, top: '15%', bottom: '15%',
              width: 36, zIndex: 20,
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 3,
              cursor: 'ns-resize', touchAction: 'none', userSelect: 'none',
            }}
            title="Arraste pra cima/baixo para ajustar a escala"
          >
            <div style={{ width: 2, height: 18, background: '#3b82f655', borderRadius: 2 }} />
            <span style={{ fontSize: 10, color: '#3b82f688', lineHeight: 1, fontFamily: 'monospace' }}>↕</span>
            <div style={{ width: 2, height: 18, background: '#3b82f655', borderRadius: 2 }} />
          </div>
        )}
        <div ref={mainRef} className="absolute inset-0" />
        {chartReady && trades.length > 0 && (
          <TradesOverlay trades={trades} getX={getX} getY={getY} />
        )}
        {chartReady && positions && positions.length > 0 && (
          <PositionsOverlay
            positions={positions}
            livePrice={livePrice}
            getY={getY}
            getPrice={getPrice}
            onModify={onModifyPosition ?? (() => {})}
            containerRef={mainRef}
          />
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
