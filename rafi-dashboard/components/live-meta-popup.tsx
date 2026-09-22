'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  pct:           number
  pnl:           number
  bal:           number
  target:        number
  positionCount: number
  brokerCount:   number
  currency:      string
  closing:       boolean
  closed:        boolean
  onCloseAll:    () => void
  onDismiss:     () => void
}

const TIMEOUT_SEC = 60

export function LiveMetaPopup({
  pct, pnl, bal, target, positionCount, brokerCount,
  currency, closing, closed, onCloseAll, onDismiss,
}: Props) {
  const [remaining, setRemaining] = useState(TIMEOUT_SEC)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)

  // Countdown — fecha automaticamente ao chegar em zero
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current!); onDismiss(); return 0 }
        return r - 1
      })
    }, 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [onDismiss])

  // Para o timer quando o usuário interage
  function stopTimer() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }

  // Confetti canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    let W = canvas.width  = canvas.offsetWidth
    let H = canvas.height = canvas.offsetHeight

    const COLORS = ['#00e676','#f5b80a','#4499ff','#00b0ff','#e0f5e9','#a0cfff','#ffe57f']
    type Particle = { x:number; y:number; vx:number; vy:number; rot:number; rotV:number; size:number; color:string; shape:'rect'|'circle'; life:number; decay:number }
    let particles: Particle[] = []
    let lastSpawn = 0

    function spawn(n: number) {
      for (let i = 0; i < n; i++) {
        particles.push({
          x: W * (0.3 + Math.random() * 0.4),
          y: H * 0.2,
          vx: (Math.random() - 0.5) * 5,
          vy: -(Math.random() * 7 + 3),
          rot: Math.random() * Math.PI * 2,
          rotV: (Math.random() - 0.5) * 0.25,
          size: Math.random() * 6 + 3,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          shape: Math.random() > 0.5 ? 'rect' : 'circle',
          life: 1,
          decay: Math.random() * 0.009 + 0.004,
        })
      }
    }

    function loop(ts: number) {
      ctx.clearRect(0, 0, W, H)
      if (ts - lastSpawn > 700) { spawn(18); lastSpawn = ts }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.rot += p.rotV
        p.life -= p.decay
        if (p.life <= 0) { particles.splice(i, 1); continue }
        ctx.save()
        ctx.globalAlpha = p.life
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
        else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill() }
        ctx.restore()
      }
      animFrameRef.current = requestAnimationFrame(loop)
    }

    spawn(50)
    animFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [])

  const pctLabel  = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  const pnlLabel  = `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`
  const arc       = 2 * Math.PI * 9  // r=9
  const arcOffset = arc * (1 - remaining / TIMEOUT_SEC)

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-4"
      style={{ background: 'rgba(8,13,20,0.82)', backdropFilter: 'blur(6px)' }}>

      {/* Confetti layer */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 0 }}
      />

      <div
        className="relative z-10 w-full max-w-[460px] rounded-3xl overflow-hidden"
        style={{
          background: '#0d1421',
          border: '1px solid #2a4a6a',
          boxShadow: '0 0 0 1px rgba(0,230,118,0.08), 0 32px 80px rgba(0,0,0,0.7), 0 0 60px rgba(0,230,118,0.06)',
          animation: 'lmPopIn 0.45s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>

        {/* Glow strip topo */}
        <div style={{
          height: 3,
          background: 'linear-gradient(90deg,transparent,#00e676,#f5b80a,#00e676,transparent)',
          backgroundSize: '200% 100%',
          animation: 'lmGlow 2.5s linear infinite',
        }} />

        <div className="p-7 flex flex-col gap-5">

          {/* Header */}
          <div className="flex flex-col items-center gap-2.5 text-center">
            <div style={{ fontSize: 48, lineHeight: 1, animation: 'lmRocket 1.8s ease-in-out infinite alternate', filter: 'drop-shadow(0 0 16px rgba(0,230,118,0.5))' }}>
              🚀
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold tracking-widest uppercase"
              style={{ background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)', color: '#00e676' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#00e676', boxShadow: '0 0 8px #00e676', display: 'inline-block', animation: 'lmBlink 1s step-end infinite' }} />
              Meta Diária Atingida
            </div>
            <div className="text-[18px] font-bold text-[#f0f6fc] leading-tight">
              Você bateu o alvo de hoje!
            </div>
          </div>

          {/* Hero % */}
          <div className="text-center rounded-2xl py-5"
            style={{ background: 'rgba(0,230,118,0.07)', border: '1px solid rgba(0,230,118,0.25)' }}>
            <div className="text-[10px] font-semibold tracking-widest uppercase text-[#7a96b8] mb-1">
              Rentabilidade do dia
            </div>
            <div className="font-mono font-black tabular-nums leading-none"
              style={{ fontSize: 64, color: '#00e676', textShadow: '0 0 40px rgba(0,230,118,0.4)', animation: 'lmPulse 2s ease-in-out infinite' }}>
              {pctLabel}
            </div>
            <div className="text-[11px] text-[#7a96b8] mt-1">
              Capital: <span className="text-[#f0f6fc] font-semibold">{currency} {bal.toFixed(2)}</span>
              &nbsp;·&nbsp; P&L: <span className="text-[#00e676] font-semibold">{pnlLabel}</span>
            </div>
          </div>

          {/* Aviso spread */}
          <div className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[10px] leading-relaxed"
            style={{ background: 'rgba(245,184,10,0.08)', border: '1px solid rgba(245,184,10,0.2)', color: '#f5b80a' }}>
            <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚡</span>
            <span>
              Encerrar todas envia ordens a mercado para{' '}
              <strong>{brokerCount} {brokerCount === 1 ? 'corretora' : 'corretoras'}</strong>{' '}
              ({positionCount} {positionCount === 1 ? 'posição' : 'posições'}).{' '}
              Verifique o spread antes de confirmar.
            </span>
          </div>

          {/* Botões */}
          <div className="flex flex-col gap-2.5">
            <button
              disabled={closing || closed}
              onClick={() => { stopTimer(); onCloseAll() }}
              className={cn(
                'w-full py-3.5 rounded-2xl text-[13px] font-black flex items-center justify-center gap-2 transition-all',
                closed
                  ? 'cursor-default'
                  : closing
                  ? 'cursor-not-allowed opacity-70'
                  : 'hover:opacity-90 active:scale-[0.98]',
              )}
              style={{
                background: closed ? '#00b060' : '#00e676',
                color: '#040a09',
                boxShadow: closed ? 'none' : '0 0 24px rgba(0,230,118,0.3)',
              }}
            >
              {closed ? (
                <>✅ Posições encerradas — Capital protegido!</>
              ) : closing ? (
                <><span className="w-3.5 h-3.5 rounded-full border-2 border-[#04090908] border-t-[#040a09] animate-spin inline-block" /> Enviando ordens de fechamento…</>
              ) : (
                <>🏁 Encerrar Todas — Proteger {pnlLabel}</>
              )}
            </button>

            {!closed && (
              <button
                disabled={closing}
                onClick={() => { stopTimer(); onDismiss() }}
                className="w-full py-3 rounded-2xl text-[12px] font-medium text-[#7a96b8] border border-[#1a2d45] hover:border-[#2a4a6a] hover:text-[#f0f6fc] transition-all disabled:opacity-40"
              >
                Continuar operando com cautela →
              </button>
            )}
          </div>

          {/* Timer */}
          {!closed && (
            <div className="flex items-center justify-center gap-2 text-[10px] text-[#3a5470]">
              <svg width="22" height="22" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="9" fill="none" stroke="#1a2d45" strokeWidth="2" />
                <circle cx="12" cy="12" r="9" fill="none" stroke="#3a5470" strokeWidth="2"
                  strokeDasharray={`${arc}`} strokeDashoffset={`${arcOffset}`}
                  strokeLinecap="round" transform="rotate(-90 12 12)" />
              </svg>
              Este aviso fecha em {remaining}s automaticamente
            </div>
          )}

        </div>
      </div>

      <style>{`
        @keyframes lmPopIn  { from { opacity:0; transform:scale(0.88) translateY(20px) } to { opacity:1; transform:scale(1) translateY(0) } }
        @keyframes lmGlow   { from { background-position:200% 0 } to { background-position:-200% 0 } }
        @keyframes lmRocket { from { transform:translateY(0) rotate(-5deg) } to { transform:translateY(-10px) rotate(5deg) } }
        @keyframes lmPulse  { 0%,100% { text-shadow:0 0 40px rgba(0,230,118,.4) } 50% { text-shadow:0 0 70px rgba(0,230,118,.7) } }
        @keyframes lmBlink  { 50% { opacity:0 } }
      `}</style>
    </div>
  )
}
