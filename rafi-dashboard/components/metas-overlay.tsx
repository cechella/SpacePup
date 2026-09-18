'use client'

import { useEffect, useRef } from 'react'

interface Props {
  type:       'daily' | 'weekly'
  dailyPct:   number
  dailyPnl:   number
  weeklyPct:  number
  weeklyPnl:  number
  daysHit:    number   // quantos dias da semana já bateram a meta
  currency:   string
  onClose:    () => void
}

export function MetasOverlay({
  type, dailyPct, dailyPnl, weeklyPct, weeklyPnl, daysHit, currency, onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Partículas de confetti
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width  = canvas.offsetWidth
    canvas.height = canvas.offsetHeight

    const colors = type === 'weekly'
      ? ['#ffcc44', '#ffd700', '#ff9900', '#00e676', '#4499ff']
      : ['#00e676', '#4499ff', '#26c6da', '#ffcc44', '#aa55ff']

    const particles = Array.from({ length: 60 }, () => ({
      x:    Math.random() * canvas.width,
      y:    Math.random() * canvas.height * 0.5,
      vx:   (Math.random() - 0.5) * 1.5,
      vy:   Math.random() * 1.5 + 0.5,
      r:    Math.random() * 4 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      rot:  Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.1,
    }))

    let raf: number
    function draw() {
      if (!ctx || !canvas) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of particles) {
        ctx.save()
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = p.color
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r)
        ctx.restore()
        p.x  += p.vx
        p.y  += p.vy
        p.rot += p.rotV
        p.vy += 0.02
        if (p.y > canvas.height) {
          p.y = -10
          p.alpha -= 0.008
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [type])

  const isWeekly  = type === 'weekly'
  const pct       = isWeekly ? weeklyPct : dailyPct
  const pnl       = isWeekly ? weeklyPnl : dailyPnl
  const emoji     = isWeekly ? '🏆' : '🚀'
  const title     = isWeekly ? 'META DA SEMANA' : 'META DO DIA'
  const subtitle  = isWeekly
    ? 'Semana extraordinária, Vinícius. Capital protegido.'
    : 'Excelente sessão, Vinícius. Hora de descansar.'
  const btnLabel  = isWeekly ? '🏁 Encerrar semana' : '✓ Encerrar sessão do dia'
  const lockMsg   = isWeekly
    ? 'Operações bloqueadas até segunda-feira'
    : 'Operações bloqueadas até amanhã · retoma às 00:00'
  const accentColor = isWeekly ? '#ffcc44' : '#00e676'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      <div
        className="relative z-10 w-[340px] rounded-2xl border bg-[#0d1117] p-7 shadow-2xl text-center"
        style={{ borderColor: `${accentColor}40` }}
      >
        <div className="text-5xl mb-4">{emoji}</div>

        <div className="text-[13px] font-bold tracking-widest uppercase text-[#7a96b8] mb-1">
          {title}
        </div>
        <div
          className="text-[22px] font-black tracking-widest uppercase mb-2"
          style={{ color: accentColor }}
        >
          CUMPRIDA!
        </div>
        <div className="text-[11px] text-[#7a96b8] mb-5">{subtitle}</div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 mb-5">
          <div className="bg-[#0f1824] rounded-xl px-3 py-2.5 border border-[#1c3050]">
            <div className="text-[15px] font-black font-mono" style={{ color: accentColor }}>
              +{pct.toFixed(1)}%
            </div>
            <div className="text-[8px] text-[#334455] uppercase tracking-wide mt-0.5">
              {isWeekly ? 'lucro semana' : 'lucro hoje'}
            </div>
          </div>
          <div className="bg-[#0f1824] rounded-xl px-3 py-2.5 border border-[#1c3050]">
            <div className="text-[15px] font-black font-mono text-[#00e676]">
              {currency} {pnl.toFixed(0)}
            </div>
            <div className="text-[8px] text-[#334455] uppercase tracking-wide mt-0.5">em conta</div>
          </div>
          <div className="bg-[#0f1824] rounded-xl px-3 py-2.5 border border-[#1c3050]">
            {isWeekly ? (
              <>
                <div className="text-[15px] font-black font-mono text-[#4499ff]">
                  {daysHit} dias ✅
                </div>
                <div className="text-[8px] text-[#334455] uppercase tracking-wide mt-0.5">semana</div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-black font-mono text-[#4499ff]">
                  {weeklyPct.toFixed(1)}% / 25%
                </div>
                <div className="text-[8px] text-[#334455] uppercase tracking-wide mt-0.5">semanal</div>
              </>
            )}
          </div>
        </div>

        {/* Botão */}
        <button
          onClick={onClose}
          className="w-full py-3 rounded-xl text-[12px] font-bold transition-all border"
          style={{
            background: `${accentColor}18`,
            borderColor: `${accentColor}50`,
            color: accentColor,
          }}
        >
          {btnLabel}
        </button>
        <div className="text-[9px] text-[#334455] mt-2">{lockMsg}</div>
      </div>
    </div>
  )
}
