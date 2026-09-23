'use client'

import { useEffect, useRef, useState, useMemo } from 'react'

// ── Escala logarítmica: $100 → $1.000.000 ──────────────────────────────────
const BASE = 100
const GOAL = 1_000_000

export const logPct = (v: number): number => {
  if (v <= BASE) return 0
  if (v >= GOAL) return 100
  return (Math.log(v / BASE) / Math.log(GOAL / BASE)) * 100
}

// ── 9 marcos da jornada ────────────────────────────────────────────────────
const MILESTONES_INT = [
  { cap: 500,       lbl: '$500',   emoji: '💪', name: 'Primeiros $500'  },
  { cap: 1_000,     lbl: '$1K',    emoji: '🎯', name: 'Primeiro milhar' },
  { cap: 2_500,     lbl: '$2.5K',  emoji: '⚡', name: 'Aceleração'      },
  { cap: 5_000,     lbl: '$5K',    emoji: '🔥', name: 'Em chamas'       },
  { cap: 10_000,    lbl: '$10K',   emoji: '🚀', name: 'Decolagem'       },
  { cap: 25_000,    lbl: '$25K',   emoji: '💼', name: 'Profissional'    },
  { cap: 100_000,   lbl: '$100K',  emoji: '🏆', name: '6 dígitos'       },
  { cap: 500_000,   lbl: '$500K',  emoji: '👑', name: 'Meio milhão'     },
  { cap: 1_000_000, lbl: '$1M',    emoji: '💎', name: 'O Milhão'        },
] as const

// Export compatível com admin/page.tsx
export const JOURNEY_MILESTONES = MILESTONES_INT.map((m, i) => ({
  val:     m.cap,
  label:   m.lbl,
  emoji:   m.emoji,
  name:    m.name,
  size:    'full' as 'full' | 'sm' | 'mini',
  pct:     logPct(m.cap),
  dateStr: '',
  above:   i % 2 === 0,
}))

// ── Helpers ────────────────────────────────────────────────────────────────
function daysTo(capital: number, target: number, rate: number): number {
  if (target <= capital) return 0
  return Math.ceil(Math.log(target / capital) / Math.log(1 + rate / 100))
}

function fmtDate(days: number): string {
  return new Date(Date.now() + days * 864e5).toLocaleDateString('pt-BR', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ── CSS animations (injetado como <style>) ────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap');

@keyframes ign-plasma {
  from { background-position: 0% 0; }
  to   { background-position: -300% 0; }
}
@keyframes ign-burn {
  0%,100% { transform:translate(-50%,-50%) scale(1);    box-shadow:0 0 12px 5px rgba(255,230,100,.9),0 0 32px 12px rgba(240,180,41,.45),0 0 64px 24px rgba(240,180,41,.18); }
  50%      { transform:translate(-50%,-50%) scale(1.22); box-shadow:0 0 20px 8px rgba(255,255,220,1),0 0 52px 18px rgba(240,180,41,.55),0 0 96px 34px rgba(240,180,41,.22); }
}
@keyframes ign-float {
  0%,100% { transform:translateX(-50%) translateY(0);   }
  50%      { transform:translateX(-50%) translateY(-5px); }
}
@keyframes ign-next-ring {
  0%,100% { box-shadow:0 0 0 0 rgba(29,233,182,.75),0 0 10px 4px rgba(29,233,182,.28); border-color:rgba(29,233,182,.75); }
  50%      { box-shadow:0 0 0 11px rgba(29,233,182,0),0 0 20px 7px rgba(29,233,182,.18); border-color:rgba(29,233,182,1); }
}
@keyframes ign-supernova {
  0%,100% { box-shadow:0 0 18px 8px rgba(253,211,77,.75),0 0 44px 16px rgba(240,180,41,.42),0 0 88px 34px rgba(240,180,41,.16); transform:translate(-50%,-50%) scale(1);    }
  50%      { box-shadow:0 0 28px 14px rgba(255,255,200,1),0 0 68px 26px rgba(240,180,41,.55),0 0 130px 52px rgba(240,180,41,.2);   transform:translate(-50%,-50%) scale(1.12); }
}
@keyframes ign-twinkle {
  0%,100% { opacity:.06; }
  50%      { opacity:.28; }
}
@keyframes ign-urge {
  0%,100% { box-shadow:0 0 0 0 rgba(251,146,60,.55),0 0 8px 2px rgba(251,146,60,.2);  }
  50%      { box-shadow:0 0 0 9px rgba(251,146,60,0),0 0 16px 5px rgba(251,146,60,.15); }
}
@keyframes ign-fadein {
  from { opacity:0; transform:translateY(14px); }
  to   { opacity:1; transform:translateY(0); }
}
.ign-ms:hover .ign-tip { opacity:1 !important; }
.ign-node:hover { transform:scale(1.28) !important; }
@media (prefers-reduced-motion: reduce) {
  .ign-fill,.ign-burn,.ign-nowlabel,.ign-nextring,.ign-urgepulse,.ign-supernova { animation:none !important; }
}
`

// ── Componente ─────────────────────────────────────────────────────────────
export function EpicJourneyBar({ capital }: { capital: number }) {
  const [rate, setRate] = useState(1.5)

  const tubeRef   = useRef<HTMLDivElement>(null)
  const fillRef   = useRef<HTMLDivElement>(null)
  const burnRef   = useRef<HTMLDivElement>(null)
  const lineRef   = useRef<HTMLDivElement>(null)
  const labelRef  = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const starsRef  = useRef<HTMLDivElement>(null)
  const rafRef    = useRef<number>(0)

  const curPct  = useMemo(() => logPct(capital), [capital])
  const nextMS  = MILESTONES_INT.find(m => m.cap > capital)
  const nextCap = nextMS?.cap

  const nextDays = nextMS ? daysTo(capital, nextMS.cap, rate) : 0
  const goalDays = daysTo(capital, GOAL, rate)

  const fmtNum  = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtRate = (r: number) => r.toFixed(1).replace('.', ',')

  // Gera campo de estrelas no fundo escuro do tubo
  useEffect(() => {
    if (!starsRef.current) return
    let h = ''
    for (let i = 0; i < 65; i++) {
      const x  = (Math.random() * 100).toFixed(1)
      const y  = (Math.random() * 100).toFixed(1)
      const s  = (0.5 + Math.random() * 1.2).toFixed(1)
      const dl = (Math.random() * 7).toFixed(1)
      const dr = (3 + Math.random() * 6).toFixed(1)
      h += `<div style="position:absolute;left:${x}%;top:${y}%;width:${s}px;height:${s}px;border-radius:50%;background:#7faac4;animation:ign-twinkle ${dr}s ${dl}s ease-in-out infinite;opacity:.06"></div>`
    }
    starsRef.current.innerHTML = h
  }, [])

  // Anima a barra até a posição atual com delay de entrada
  useEffect(() => {
    const t = setTimeout(() => {
      if (fillRef.current)  fillRef.current.style.width = curPct + '%'
      if (burnRef.current)  burnRef.current.style.left  = curPct + '%'
      if (lineRef.current)  lineRef.current.style.left  = curPct + '%'
      if (labelRef.current) {
        const safe = Math.max(9, Math.min(curPct, 87))
        labelRef.current.style.left       = safe + '%'
        labelRef.current.style.transition = 'left 1.9s cubic-bezier(.4,0,.2,1)'
      }
    }, 120)
    return () => clearTimeout(t)
  }, [curPct])

  // Sistema de partículas (canvas)
  useEffect(() => {
    const canvas = canvasRef.current
    const tube   = tubeRef.current
    if (!canvas || !tube) return

    canvas.width  = tube.offsetWidth
    canvas.height = tube.offsetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W  = canvas.width
    const H  = canvas.height
    const fw = W * curPct / 100

    interface P { x:number; y:number; vx:number; vy:number; life:number; max:number; r:number }
    const mkP = (rnd: boolean): P => ({
      x:    Math.random() * fw * 0.9,
      y:    rnd ? Math.random() * H : H * (0.55 + Math.random() * 0.45),
      vx:   (Math.random() - 0.42) * 0.38,
      vy:   -(Math.random() * 0.72 + 0.16),
      life: rnd ? Math.random() * 0.5 : 0,
      max:  0.6 + Math.random() * 0.85,
      r:    0.75 + Math.random() * 1.9,
    })
    const pts: P[] = Array.from({ length: 36 }, () => mkP(true))

    const draw = () => {
      ctx.clearRect(0, 0, W, H)
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy; p.life += 0.0065
        if (p.life > p.max || p.x < 0 || p.x > fw + 3 || p.y < -4)
          Object.assign(p, mkP(false))
        const t = p.life / p.max
        const a = t < 0.2 ? t / 0.2 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * (1 - t * 0.18), 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,245,200,${(a * 0.62).toFixed(2)})`
        ctx.fill()
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    const onResize = () => {
      if (canvas && tube) { canvas.width = tube.offsetWidth; canvas.height = tube.offsetHeight }
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
    }
  }, [curPct])

  return (
    <div style={{
      maxWidth: '100%',
      background: 'linear-gradient(155deg,#0b1828 0%,#060e1b 100%)',
      border: '1px solid #132130',
      borderRadius: 24,
      padding: '28px 32px 24px',
      position: 'relative',
      overflow: 'hidden',
      marginBottom: 14,
      fontFamily: "'Space Grotesk', system-ui, sans-serif",
      animation: 'ign-fadein .65s cubic-bezier(.4,0,.2,1) both',
    }}>
      <style>{CSS}</style>

      {/* Reflexo ambiente */}
      <div style={{ position:'absolute', left:0, right:0, top:'50%', height:260, marginTop:-60, pointerEvents:'none',
        background:'radial-gradient(ellipse 55% 60% at 17% 50%,rgba(240,180,41,.08) 0%,transparent 65%),radial-gradient(ellipse 20% 50% at 100% 50%,rgba(29,233,182,.04) 0%,transparent 68%)' }} />

      {/* ── Hero row ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center', gap:16, marginBottom:18 }}>
        {/* Capital atual */}
        <div>
          <div style={{ fontSize:'.56rem', fontWeight:700, letterSpacing:'.2em', textTransform:'uppercase', color:'#334d65', marginBottom:4 }}>
            RAFI · Capital Atual
          </div>
          <div style={{ fontFamily:"'Syne',sans-serif", fontSize:'2.85rem', fontWeight:800, lineHeight:1,
            color:'#f0b429', fontVariantNumeric:'tabular-nums', textShadow:'0 0 40px rgba(240,180,41,.28)' }}>
            ${Math.floor(capital).toLocaleString('pt-BR')}
            <span style={{ fontSize:'1.75rem', opacity:.6 }}>
              ,{String(Math.round((capital % 1) * 100)).padStart(2, '0')}
            </span>
          </div>
          <div style={{ fontSize:'.64rem', color:'#5a7a9a', marginTop:4 }}>Consolidado · 4 corretoras</div>
        </div>

        {/* % da jornada */}
        <div style={{ textAlign:'center' }}>
          <div style={{ fontFamily:"'Syne',sans-serif", fontSize:'3.6rem', fontWeight:800, lineHeight:1,
            background:'linear-gradient(135deg,#fff8c0 0%,#fde68a 22%,#f59e0b 58%,#d97706 100%)',
            WebkitBackgroundClip:'text', backgroundClip:'text', WebkitTextFillColor:'transparent',
            fontVariantNumeric:'tabular-nums' }}>
            {curPct.toFixed(1).replace('.', ',')}%
          </div>
          <div style={{ fontSize:'.57rem', color:'#334d65', letterSpacing:'.14em', textTransform:'uppercase', marginTop:3 }}>
            da jornada · escala log
          </div>
        </div>

        {/* Meta final */}
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:'.56rem', fontWeight:700, letterSpacing:'.2em', textTransform:'uppercase', color:'#334d65', marginBottom:4 }}>
            Meta Final
          </div>
          <div style={{ fontFamily:"'Syne',sans-serif", fontSize:'1.5rem', fontWeight:700,
            color:'rgba(255,255,255,.18)', fontVariantNumeric:'tabular-nums' }}>
            $1.000.000
          </div>
          <div style={{ fontSize:'.63rem', color:'#5a7a9a', marginTop:4 }}>
            {goalDays.toLocaleString('pt-BR')} dias · {fmtDate(goalDays)}
          </div>
        </div>
      </div>

      {/* ── Faixa de urgência ── */}
      {nextMS && (
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
          background:'rgba(240,180,41,.055)', border:'1px solid rgba(240,180,41,.2)',
          borderRadius:10, padding:'8px 14px', marginBottom:18, fontSize:'.68rem' }}>
          <span style={{ fontSize:'.95rem', flexShrink:0 }}>⚡</span>
          <span style={{ color:'#5a7a9a' }}>
            Faltam{' '}
            <strong style={{ color:'#f0b429' }}>${fmtNum(nextMS.cap - capital)}</strong>
            {' '}para {nextMS.lbl} — sua próxima marca
          </span>
          <span style={{ marginLeft:'auto', color:'#1de9b6', fontWeight:700 }}>
            ~{nextDays} dias com {fmtRate(rate)}%/dia
          </span>
        </div>
      )}

      {/* ── Trilha ── */}
      <div style={{ position:'relative', paddingTop:50, paddingBottom:42 }}>

        {/* Label flutuante "Você está aqui" */}
        <div ref={labelRef} className="ign-nowlabel" style={{
          position:'absolute', top:0, zIndex:12, whiteSpace:'nowrap',
          left:'0%', animation:'ign-float 3.4s ease-in-out infinite',
        }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:6,
            background:'rgba(5,16,30,.92)', border:'1.5px solid rgba(240,180,41,.6)',
            borderRadius:24, padding:'5px 14px', fontSize:'.67rem', fontWeight:700,
            color:'#fcd34d', backdropFilter:'blur(6px)',
            boxShadow:'0 4px 20px rgba(240,180,41,.22),0 2px 8px rgba(0,0,0,.4)' }}>
            📍 Você está aqui · ${fmtNum(capital)}
          </div>
          <div style={{ display:'block', margin:'0 auto', width:0, height:0,
            borderLeft:'5px solid transparent', borderRight:'5px solid transparent',
            borderTop:'6px solid rgba(240,180,41,.5)' }} />
        </div>

        {/* O tubo */}
        <div ref={tubeRef} style={{
          position:'relative', height:68, borderRadius:34,
          background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.055)',
          boxShadow:'inset 0 3px 10px rgba(0,0,0,.65),inset 0 -1px 2px rgba(255,255,255,.04)',
          overflow:'visible',
        }}>
          {/* Estrelas (fundo escuro) */}
          <div ref={starsRef} style={{ position:'absolute', inset:0, borderRadius:34, overflow:'hidden', pointerEvents:'none', zIndex:1 }} />

          {/* Barra de plasma (overflow:hidden para clipar) */}
          <div style={{ position:'absolute', inset:0, borderRadius:34, overflow:'hidden', zIndex:2 }}>
            <div ref={fillRef} className="ign-fill" style={{
              position:'absolute', top:0, left:0, bottom:0,
              borderRadius:34, width:'0%',
              transition:'width 1.9s cubic-bezier(.4,0,.2,1)',
              background:'linear-gradient(90deg,#7c2d12 0%,#9a3412 10%,#b45309 22%,#d97706 38%,#f59e0b 56%,#fbbf24 72%,#fde68a 87%,#fffbeb 96%,#ffffff 100%)',
              backgroundSize:'300% 100%', animation:'ign-plasma 4.2s linear infinite',
              boxShadow:'inset 0 2px 0 rgba(255,255,255,.22),inset 0 -2px 0 rgba(0,0,0,.28)',
            }} />
          </div>

          {/* Canvas de partículas */}
          <canvas ref={canvasRef} style={{ position:'absolute', inset:0, borderRadius:34, pointerEvents:'none', zIndex:3 }} />

          {/* Ponta em brasa */}
          <div ref={burnRef} className="ign-burn" style={{
            position:'absolute', top:'50%', width:32, height:32, borderRadius:'50%',
            background:'radial-gradient(circle,#fff 0%,#fde68a 28%,rgba(240,180,41,0) 70%)',
            zIndex:6, animation:'ign-burn 1.9s ease-in-out infinite',
            transform:'translate(-50%,-50%)', left:'0%',
            transition:'left 1.9s cubic-bezier(.4,0,.2,1)',
          }} />

          {/* Linha vertical "agora" */}
          <div ref={lineRef} style={{
            position:'absolute', top:-50, bottom:0, width:1.5,
            transform:'translateX(-50%)', left:'0%',
            background:'linear-gradient(to bottom,rgba(255,255,255,0) 0%,rgba(255,255,255,.55) 28%,rgba(255,255,255,.8) 55%,rgba(255,255,255,.12) 100%)',
            zIndex:5, pointerEvents:'none',
            transition:'left 1.9s cubic-bezier(.4,0,.2,1)',
          }} />

          {/* Marcos de milestone */}
          {MILESTONES_INT.map(m => {
            const pct     = logPct(m.cap)
            const isGoal  = m.cap === GOAL
            const reached = m.cap <= capital
            const isNext  = m.cap === nextCap
            const isUrge  = !reached && !isNext && m.cap <= capital * 1.3

            const days = daysTo(capital, m.cap, rate)

            const nodeStyle: React.CSSProperties = isGoal ? {
              width:46, height:46, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.3rem',
              cursor:'pointer', position:'relative', transition:'transform .2s',
              background:'radial-gradient(circle,rgba(253,211,77,.22) 0%,rgba(240,180,41,.03) 100%)',
              border:'2.5px solid rgba(253,211,77,.78)',
              animation:'ign-supernova 2.4s ease-in-out infinite',
            } : reached ? {
              width:30, height:30, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.86rem',
              cursor:'pointer', position:'relative', transition:'transform .2s',
              background:'rgba(240,180,41,.16)', border:'2px solid rgba(240,180,41,.65)',
              boxShadow:'0 0 10px rgba(240,180,41,.32)',
            } : isNext ? {
              width:30, height:30, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.86rem',
              cursor:'pointer', position:'relative', transition:'transform .2s',
              background:'rgba(29,233,182,.08)', border:'2px solid rgba(29,233,182,.8)',
              animation:'ign-next-ring 2s ease-in-out infinite',
            } : isUrge ? {
              width:30, height:30, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.86rem',
              cursor:'pointer', position:'relative', transition:'transform .2s',
              background:'rgba(251,146,60,.1)', border:'2px solid rgba(251,146,60,.75)',
              animation:'ign-urge 1.8s ease-in-out infinite',
            } : {
              width:30, height:30, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.76rem',
              cursor:'pointer', position:'relative', transition:'transform .2s',
              background:'rgba(255,255,255,.03)', border:'1.5px solid rgba(255,255,255,.1)',
              opacity:0.42,
            }

            const lblColor = reached ? '#f0b429' : isNext ? '#1de9b6' : isUrge ? '#fb923c' : '#334d65'

            return (
              <div key={m.cap} className="ign-ms" style={{
                position:'absolute', top:'50%', left:`${pct}%`, zIndex:8,
                transform:'translate(-50%,-50%)',
              }}>
                {/* Tooltip ao hover */}
                <div className="ign-tip" style={{
                  position:'absolute', bottom:'calc(50% + 20px)', left:'50%',
                  transform:'translateX(-50%)',
                  background:'rgba(5,14,26,.96)', border:'1px solid #132130',
                  borderRadius:10, padding:'8px 12px', whiteSpace:'nowrap',
                  pointerEvents:'none', opacity:0, transition:'opacity .18s',
                  zIndex:20, boxShadow:'0 8px 30px rgba(0,0,0,.6)',
                }}>
                  <div style={{ fontSize:'.68rem', fontWeight:700, color:'#ddeeff', marginBottom:3 }}>
                    {m.emoji} {m.name}
                  </div>
                  {reached
                    ? <div style={{ fontSize:'.63rem', color:'#f0b429' }}>✓ Concluído</div>
                    : <>
                        <div style={{ fontSize:'.63rem', color:'#1de9b6' }}>{fmtDate(days)}</div>
                        <div style={{ fontSize:'.59rem', color:'#5a7a9a', marginTop:2 }}>
                          {days} dias · {rate}%/dia
                        </div>
                      </>
                  }
                </div>

                {/* Nó */}
                <div className="ign-node" style={nodeStyle}>{m.emoji}</div>

                {/* Rótulo abaixo */}
                <div style={{
                  position:'absolute', top:'calc(50% + 20px)', left:'50%',
                  transform:'translateX(-50%)',
                  fontFamily:"'Space Mono',monospace", fontSize:'.5rem', fontWeight:700,
                  whiteSpace:'nowrap', textAlign:'center', color:lblColor,
                  pointerEvents:'none', lineHeight:1.3,
                }}>
                  {m.lbl}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Seletor de rendimento ── */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginTop:6 }}>
        <span style={{ fontSize:'.57rem', fontWeight:700, letterSpacing:'.14em', textTransform:'uppercase', color:'#334d65' }}>
          Rendimento/dia:
        </span>
        {[0.5, 1.5, 3.0].map(r => (
          <button key={r} onClick={() => setRate(r)} style={{
            padding:'4px 12px', borderRadius:20, fontSize:'.64rem', fontWeight:600,
            border:   rate === r ? '1px solid rgba(29,233,182,.42)' : '1px solid #132130',
            background: rate === r ? 'rgba(29,233,182,.1)' : 'transparent',
            color:      rate === r ? '#1de9b6' : '#5a7a9a',
            cursor:'pointer', transition:'all .2s',
            fontFamily:"'Space Grotesk',system-ui,sans-serif",
          }}>
            {fmtRate(r)}%{rate === r ? ' ✓' : ''}
          </button>
        ))}
        <div style={{ marginLeft:'auto', fontSize:'.67rem', color:'#5a7a9a', fontVariantNumeric:'tabular-nums' }}>
          {nextMS && (
            <>
              {nextMS.emoji} próxima:{' '}
              <strong style={{ color:'#1de9b6', fontWeight:700 }}>
                {nextMS.lbl} em {nextDays} dias
              </strong>
              {' '}· {fmtDate(nextDays)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
