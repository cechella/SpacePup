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
  freeMargin?:        number | null
  // Ref para captura focada no candle de entrada com overlay OCO desenhado
  snapshotCaptureRef?: React.MutableRefObject<((entryTime: number, oco?: { entry: number; sl: number; tp: number; direction: 'buy' | 'sell' }) => string | null) | null>
  // Alinhar à esquerda (Shift MT5): últimos candles + 15 barras vazias à direita
  shiftRangeRef?:  React.MutableRefObject<(() => void) | null>
  // Alinhar à direita: última barra na borda direita (sem espaço)
  alignRightRef?:  React.MutableRefObject<(() => void) | null>
}

export function RAFIChart({
  candles, rafiData, srLevels, trades, bbBands, onPriceClick, panMode,
  ocoState, onOCOChange, onOCOExecute, onOCOClose, livePrice, livePriceRef,
  chartUpdateCandleRef, positions, onModifyPosition, snapshotCaptureRef, freeMargin,
  shiftRangeRef, alignRightRef,
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
  const currentBarRef      = useRef<{ time: number; open: number; high: number; low: number } | null>(null)
  // ID do RAF loop do tick ao vivo
  const rafIdRef           = useRef<number>(0)
  // Ref local sincronizado com livePrice (estado React provado que atualiza via P&L)
  const innerPriceRef      = useRef<number | null>(null)
  // Série do histograma RAFI — atualizada tick a tick junto com o candle ao vivo
  const histSeriesRef      = useRef<any>(null)
  // Preserva o range visível entre reinicializações do gráfico (evita shift a cada recarga)
  const savedRangeRef      = useRef<{ from: number; to: number } | null>(null)
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => { onPriceClickRef.current = onPriceClick }, [onPriceClick])
  useEffect(() => { positionsRef.current = positions }, [positions])
  useEffect(() => { candlesRef.current = candles }, [candles])
  // Mantém innerPriceRef sincronizado com livePrice — mesmo caminho que atualiza o P&L
  useEffect(() => { innerPriceRef.current = livePrice ?? null }, [livePrice])

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
    let rangeTimerId: ReturnType<typeof setTimeout> | null = null

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
          // rightOffset removido: causava auto-scroll quando a barra ao vivo era adicionada,
          // sobrescrevendo o setVisibleLogicalRange. A margem direita é controlada
          // exclusivamente pelo setVisibleLogicalRange({ to: candles.length + 15 }).
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

      // Linha de preço ao vivo — sempre visível independente de zoom/pan na barra
      const liveLine = candleSeries.createPriceLine({
        price:            0.0,
        color:            '#26c6da',
        lineWidth:        1,
        lineStyle:        LineStyle.Dashed,
        axisLabelVisible: true,
        title:            '',
      })

      // Lógica compartilhada: calcula dados da barra ao vivo e chama candleSeries.update()
      // Usada tanto pelo RAF (~60fps) quanto pelo callback direto do SSE (~300ms)
      const applyLiveTick = (price: number) => {
        const cands = candlesRef.current
        if (cands.length === 0) return

        const last       = cands[cands.length - 1]
        const tfSec      = cands.length > 1
          ? Math.round(Math.abs((cands[cands.length - 1].time as any) - (cands[cands.length - 2].time as any)))
          : 300
        const lastBarTime = last.time as unknown as number
        // Tempo da barra ao vivo alinhado ao grid do timeframe (igual MT5):
        // floor(nowSec / tfSec) * tfSec = timestamp de abertura da barra atual.
        // Funciona para ambos os casos:
        //   (a) MetaAPI retornou a barra atual como último dado → liveBarTime === lastBarTime
        //   (b) MetaAPI retornou a última barra fechada → liveBarTime === lastBarTime + tfSec
        // +10800 = UTC+3 (Pepperstone broker time), igual ao offset dos candles da API
        const BROKER_OFFSET = 3 * 3600
        const nowSec      = Math.floor(Date.now() / 1000)
        const liveBarTime = Math.floor(nowSec / tfSec) * tfSec + BROKER_OFFSET

        // Se a barra virou (nova barra abriu), reseta o acumulador da barra ao vivo.
        // Sem este reset, o código atualizaria a barra fechada anterior indefinidamente.
        if (currentBarRef.current && currentBarRef.current.time !== liveBarTime) {
          currentBarRef.current = null
        }

        const b = currentBarRef.current
        if (!b) {
          // Primeira atualização: se continuamos a barra atual usa o open real; se é barra nova
          // usa o close do último candle fechado como open.
          const liveOpen = liveBarTime === lastBarTime ? last.open : last.close
          currentBarRef.current = {
            time: liveBarTime,
            open: liveOpen,
            high: Math.max(liveOpen, price),
            low:  Math.min(liveOpen, price),
          }
        } else {
          // Tick subsequente: apenas atualiza high/low/close
          currentBarRef.current = {
            ...b,
            high: Math.max(b.high, price),
            low:  Math.min(b.low, price),
          }
        }
        const nb     = currentBarRef.current!
        const isBull = price >= nb.open

        try {
          candleSeries.update({
            time:      nb.time as any,
            open:      nb.open,
            high:      nb.high,
            low:       nb.low,
            close:     price,
            color:     isBull ? '#10b981' : '#ef4444',
            wickColor: isBull ? '#10b981' : '#ef4444',
          })
        } catch (err) {
          // Pode falhar se o gráfico já foi destruído pelo cleanup — ignorar silenciosamente
          return
        }

        // Linha de preço ao vivo: atualiza sempre, visível independente da barra estar na tela
        liveLine.applyOptions({ price })

        // Atualiza o histograma RAFI da barra ao vivo com a mesma fórmula de calcRAFI
        if (histSeriesRef.current) {
          const dir  = price >= nb.open ? 'bull' : 'bear'
          const mom  = Math.abs((price - prevCloseForLive) / (prevCloseForLive || 1)) * 100
          const body = Math.abs(price - nb.open)
          const amp  = atrApproxForLive > 0 ? body / atrApproxForLive : 0
          const magnitude  = Math.min(5, mom * 25 + amp * 3)
          const rafiValue  = dir === 'bull' ? magnitude : -magnitude
          try {
            const rangeAntes = mChart.timeScale().getVisibleLogicalRange()
            // Bloqueia propagação rChart→mChart antes do update: o tracking mode
            // do rChart pode disparar de forma assíncrona (próximo frame de animação),
            // e sem este guard o range errado sobrescreveria a restauração síncrona.
            suppressRChartSync = true
            histSeriesRef.current.update({ time: nb.time as any, value: rafiValue, color: '#f59e0b' })
            // Restauração síncrona (cobre o caso em que o auto-scroll já disparou)
            if (rangeAntes && !syncing) {
              syncing = true
              mChart.timeScale().setVisibleLogicalRange(rangeAntes)
              syncing = false
            }
            // Restauração assíncrona após 2 frames (cobre o tracking mode assíncrono do rChart)
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                try {
                  if (rangeAntes) {
                    syncing = true
                    mChart.timeScale().setVisibleLogicalRange(rangeAntes)
                    rChart.timeScale().setVisibleLogicalRange(rangeAntes)
                    savedRangeRef.current = { from: rangeAntes.from, to: rangeAntes.to }
                    syncing = false
                  }
                } catch {}
                suppressRChartSync = false
              })
            })
          } catch {}
        }

        // Sem scroll aqui — setVisibleLogicalRange no init já inclui o slot da barra ao vivo
        // (índice 100, within [20, 105]). Qualquer scrollTo* movia o viewport de volta para
        // uma posição errada a cada tick, fazendo a barra parecer "congelada".
      }

      // Caminho 1: callback direto — o SSE chama chartUpdateCandleRef.current(mid) a cada ~300ms.
      // Este é o caminho PRIMÁRIO: funciona porque o SSE é o mesmo que atualiza o P&L.
      currentBarRef.current = null
      if (chartUpdateCandleRef) {
        chartUpdateCandleRef.current = (price: number) => applyLiveTick(price)
      }

      // Caminho 2: RAF loop a ~60fps lendo innerPriceRef (sincronizado com livePrice via useEffect).
      // Garante atualização suave mesmo durante zoom/pan/touch (fora do scheduler React).
      let lastRafPrice: number | null = null
      const liveLoop = () => {
        const price = innerPriceRef.current
        if (price !== null && price !== lastRafPrice) {
          lastRafPrice = price
          applyLiveTick(price)
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

      // Mostra sempre os últimos 80 candles + 15 barras de espaço para a barra ao vivo.
      // NÃO chamar scrollToRealTime() — esse método usa o relógio do sistema e empurra
      // a janela para o horário atual (~15h UTC), deixando os candles históricos e a
      // barra ao vivo completamente fora da tela quando os dados têm gap de horas.
      // Se o gráfico já foi exibido antes, restaura o range salvo para não deslocar
      // a visão quando uma nova barra abre e os candles são recarregados.
      // Valida o range: se os índices salvos estiverem fora dos limites do novo dataset
      // (ex.: Supabase→MetaAPI muda de 1440 para 100 candles), ignora e usa o padrão.
      const _saved = savedRangeRef.current
      const validSaved = _saved !== null
        && _saved.to   <= candles.length + 20   // índice de fim dentro dos dados (+margem live)
        && _saved.from >= -candles.length        // índice de início razoável
      const initialFrom = validSaved ? _saved!.from : Math.max(0, candles.length - 75)
      const initialTo   = validSaved ? _saved!.to   : candles.length + 15
      mChart.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })

      // Expõe função de shift para o botão na toolbar (igual ao MT5):
      // reposiciona o gráfico mostrando os últimos candles + espaço à direita.
      if (shiftRangeRef) {
        shiftRangeRef.current = () => {
          try {
            const defaultFrom = Math.max(0, candles.length - 75)
            const defaultTo   = candles.length + 15
            savedRangeRef.current = { from: defaultFrom, to: defaultTo }
            mChart.timeScale().setVisibleLogicalRange({ from: defaultFrom, to: defaultTo })
            rChart.timeScale().setVisibleLogicalRange({ from: defaultFrom, to: defaultTo })
          } catch {}
        }
      }

      // Alinhar à direita: última barra na borda direita, sem espaço vazio
      if (alignRightRef) {
        alignRightRef.current = () => {
          try {
            const from = Math.max(0, candles.length - 90)
            const to   = candles.length
            savedRangeRef.current = { from, to }
            mChart.timeScale().setVisibleLogicalRange({ from, to })
            rChart.timeScale().setVisibleLogicalRange({ from, to })
          } catch {}
        }
      }

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
          // fixRightEdge/fixLeftEdge removidos: com eles ativos, ao adicionar a barra ao vivo
          // via histSeries.update() o lightweight-charts auto-scrollava o rChart, disparando
          // subscribeVisibleLogicalRangeChange e propagando o range errado para o mChart,
          // deslocando toda a visão para a direita a cada nova barra.
        },
        width:  rafiEl.clientWidth  || 600,
        height: rafiEl.clientHeight || 120,
      })

      const histSeries = rChart.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      })
      histSeries.setData(rafiData as any)
      histSeriesRef.current = histSeries

      // Pré-computa base para cálculo RAFI ao vivo (mesma fórmula de calcRAFI)
      const rafiPeriod       = 3
      const prevCloseForLive = candles.length > rafiPeriod
        ? candles[candles.length - rafiPeriod].close
        : candles[candles.length - 1].close
      // ATR aproximado: média de TR dos últimos 15 candles
      const atrSlice     = candles.slice(-15)
      const trVals       = atrSlice.map((c, i, arr) => {
        if (i === 0) return c.high - c.low
        const p = arr[i - 1]
        return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
      })
      const atrApproxForLive = trVals.reduce((s, t) => s + t, 0) / (trVals.length || 1)

      // RAFI > 0 = entrada válida; RAFI >= 2.5 = força forte
      histSeries.createPriceLine({ price:  2.5, color: '#f59e0b50', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      histSeries.createPriceLine({ price: -2.5, color: '#f59e0b50', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      histSeries.createPriceLine({ price:  0,   color: '#8b949e30', lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: false, title: '' })

      // Alinha o gráfico RAFI ao mesmo intervalo do gráfico principal — NÃO usar
      // fitContent() aqui. O fitContent define um range diferente (todos os dados) e,
      // quando o ResizeObserver dispara com as dimensões reais do container, o gráfico
      // recalcula a partir do fitContent e propaga esse range via subscribeVisibleLogicalRangeChange
      // para o gráfico principal, sobrescrevendo o setVisibleLogicalRange definido acima.
      rChart.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })

      // Sincroniza escalas de tempo
      let syncing = false
      // Suprime a propagação rChart→mChart por 2 frames após histSeries.update(),
      // pois o tracking mode do lightweight-charts pode disparar assincronamente.
      let suppressRChartSync = false
      // Flags: durante resize de cada painel, bloqueia propagação bidirecional.
      // Sem esses guards, o ResizeObserver recalcula o range a partir do rightOffset e
      // propaga para o outro gráfico, desfazendo o setVisibleLogicalRange inicial.
      let mChartResizing = false
      let rChartResizing = false
      // Após o primeiro resize do mChart (quando o DOM mede as dimensões reais),
      // re-aplica o range inicial para garantir a posição correta.
      let initialRangeApplied = false

      mChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        // Salva o range atual para restaurar na próxima reinicialização do gráfico
        if (range) savedRangeRef.current = { from: range.from, to: range.to }
        if (syncing || !range || mChartResizing) return
        syncing = true; rChart.timeScale().setVisibleLogicalRange(range); syncing = false
      })
      rChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range || rChartResizing || suppressRChartSync) return
        syncing = true; mChart.timeScale().setVisibleLogicalRange(range); syncing = false
      })

      roMain = new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) {
          mChartResizing = true
          mChart?.applyOptions({ width, height })
          mChartResizing = false
          // Re-aplica o range uma única vez após o primeiro resize real do container
          // (evita que rightOffset recalcule e reposicione o viewport)
          if (!initialRangeApplied) {
            initialRangeApplied = true
            mChart?.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })
            rChart?.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })
          }
        }
      })
      roRafi = new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) {
          // Bloqueia propagação: resize do painel RAFI não deve mover o viewport principal
          rChartResizing = true
          rChart?.applyOptions({ width, height })
          rChartResizing = false
        }
      })
      roMain.observe(mainEl)
      roRafi.observe(rafiEl)

      // Garantia final: re-aplica o range após o DOM e todos os ResizeObservers
      // terem se resolvido. Cobre o caso em que o lightweight-charts entrega o evento
      // de visibleLogicalRangeChange de forma assíncrona (pós-requestAnimationFrame),
      // o que tornaria os flags mChartResizing/rChartResizing ineficazes no momento
      // em que o evento realmente dispara.
      rangeTimerId = setTimeout(() => {
        rangeTimerId = null
        try {
          mChart.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })
          rChart.timeScale().setVisibleLogicalRange({ from: initialFrom, to: initialTo })
        } catch {}
      }, 400)
    }

    init()

    return () => {
      if (rangeTimerId !== null) clearTimeout(rangeTimerId)
      cancelAnimationFrame(rafIdRef.current)
      if (chartUpdateCandleRef) chartUpdateCandleRef.current = null
      if (shiftRangeRef) shiftRangeRef.current = null
      if (alignRightRef) alignRightRef.current = null
      setChartReady(false)
      candleSeriesRef.current = null
      histSeriesRef.current   = null
      roMain?.disconnect()
      roRafi?.disconnect()
      mChart?.remove()
      rChart?.remove()
    }
  }, [candles, rafiData, srLevels, bbBands])

  // Atualiza marcadores de trades sem reinicializar o gráfico.
  // Separado do efeito principal para que carregamentos assíncronos (Supabase)
  // não destruam e recriem o gráfico — o que reiniciaria o viewport.
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    if (trades.length === 0) {
      series.setMarkers([])
      return
    }
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
    try { series.setMarkers(markers) } catch {}
  }, [trades, chartReady])


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
            freeMargin={freeMargin}
            livePrice={livePrice}
          />
        )}
      </div>
      <div className="h-px bg-[#30363d] shrink-0" />
      <div ref={rafiRef} className="flex-[3] min-h-0" />
    </div>
  )
}
