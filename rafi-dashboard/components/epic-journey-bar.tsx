'use client'

import { useMemo } from 'react'

const LOG_MIN = 2
const LOG_MAX = 6

export const logPct = (val: number) =>
  ((Math.log10(Math.max(val, 100)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100

interface JourneyMS {
  val: number; pct: number; label: string
  size: 'full' | 'sm' | 'mini'; emoji: string; dateStr: string; above: boolean
}

export const JOURNEY_MILESTONES: JourneyMS[] = [
  { val: 100,     pct: 0,    label: '$100',    size: 'full', emoji: '✅', dateStr: '',            above: false },
  { val: 1000,    pct: 25,   label: '$1.000',  size: 'full', emoji: '🎯', dateStr: '15 Out 2026', above: true  },
  { val: 5000,    pct: 42.5, label: '$5.000',  size: 'full', emoji: '🚀', dateStr: '17 Nov 2026', above: false },
  { val: 10000,   pct: 50,   label: '$10K',    size: 'full', emoji: '💰', dateStr: '01 Dez 2026', above: true  },
  { val: 30000,   pct: 61.9, label: '$30K',    size: 'sm',   emoji: '📈', dateStr: '~05 Jan',     above: false },
  { val: 50000,   pct: 67.5, label: '$50K',    size: 'sm',   emoji: '📈', dateStr: '~14 Jan',     above: true  },
  { val: 100000,  pct: 75,   label: '$100K',   size: 'full', emoji: '🏆', dateStr: '02 Fev 2027', above: false },
  { val: 150000,  pct: 79.4, label: '$150K',   size: 'mini', emoji: '',   dateStr: '',            above: true  },
  { val: 200000,  pct: 82.5, label: '$200K',   size: 'mini', emoji: '',   dateStr: '',            above: false },
  { val: 300000,  pct: 86.9, label: '$300K',   size: 'mini', emoji: '',   dateStr: '',            above: true  },
  { val: 500000,  pct: 92.5, label: '$500K',   size: 'mini', emoji: '',   dateStr: '',            above: false },
  { val: 700000,  pct: 96.1, label: '$700K',   size: 'mini', emoji: '',   dateStr: '',            above: true  },
  { val: 1000000, pct: 100,  label: '$1M',     size: 'full', emoji: '💎', dateStr: '~Abr 2027',   above: true  },
]

const NODE_SIZES = { full: 44, sm: 30, mini: 16 }

const fBRL = (v: number) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function EpicJourneyBar({ capital }: { capital: number }) {
  const curPos = useMemo(() => logPct(capital), [capital])

  const nextIdx = JOURNEY_MILESTONES.findIndex(m => capital < m.val)
  const nextMS  = nextIdx >= 0 ? JOURNEY_MILESTONES[nextIdx] : JOURNEY_MILESTONES[JOURNEY_MILESTONES.length - 1]

  return (
    <div style={{
      background: '#06101e', border: '1px solid #142840',
      borderRadius: 18, padding: '28px 40px 24px',
      marginBottom: 14, position: 'relative', overflow: 'visible',
    }}>
      <style>{`
        @keyframes gf{0%{background-position:300% 0}100%{background-position:-300% 0}}
        @keyframes re{0%{opacity:.8;transform:translate(-50%,-50%) scale(.85)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.1)}}
        @keyframes cp{0%,100%{box-shadow:0 0 24px rgba(240,192,64,.7),0 0 48px rgba(240,192,64,.35)}50%{box-shadow:0 0 36px rgba(240,192,64,.9),0 0 70px rgba(240,192,64,.5)}}
        @keyframes nc{0%,100%{box-shadow:0 0 24px rgba(0,229,255,.45),0 6px 20px rgba(0,0,0,.5)}50%{box-shadow:0 0 40px rgba(0,229,255,.65),0 6px 20px rgba(0,0,0,.5)}}
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase', color: '#5878a0', marginBottom: 4 }}>
            Jornada para o Milhão · 13 marcos · escala logarítmica
          </div>
          <div style={{ fontSize: 17, fontWeight: 900, color: '#c8e2ff', lineHeight: 1.4 }}>
            De <span style={{ color: '#f0c040' }}>${fBRL(capital)}</span> até{' '}
            <span style={{ color: '#f0c040' }}>$1.000.000</span>
            &nbsp;·&nbsp; próximo:{' '}
            <span style={{ color: '#00e5ff' }}>
              {nextMS.label}{nextMS.dateStr ? ` em ${nextMS.dateStr}` : ''}
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: '#f0c040', letterSpacing: '-.04em', lineHeight: 1, textShadow: '0 0 30px rgba(240,192,64,.3)', fontVariantNumeric: 'tabular-nums' }}>
            {curPos.toFixed(1)}%
          </div>
          <div style={{ fontSize: 9, color: '#5878a0', marginTop: 2 }}>da jornada concluída</div>
        </div>
      </div>

      {/* Track container */}
      <div style={{ position: 'relative', paddingTop: 72, paddingBottom: 76 }}>
        {/* Ambient glow */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
          height: 60, pointerEvents: 'none', borderRadius: 30,
          background: `radial-gradient(ellipse 22% 80% at ${curPos}% 50%, rgba(240,192,64,.09) 0%, transparent 70%)`,
        }} />

        {/* Rail */}
        <div style={{
          height: 22, borderRadius: 11, position: 'relative', overflow: 'visible',
          background: 'linear-gradient(to bottom,#07192e 0%,#040e1c 100%)',
          boxShadow: '0 6px 24px rgba(0,0,0,.8),inset 0 2px 6px rgba(0,0,0,.6),0 0 0 1px rgba(0,30,60,.8)',
        }}>

          {/* Gold fill */}
          <div style={{
            position: 'absolute', left: 0, top: 0, height: '100%', width: `${curPos}%`,
            borderRadius: '11px 3px 3px 11px',
            background: 'linear-gradient(90deg,#8b5e00 0%,#c88a00 20%,#f0c040 55%,#ffe585 75%,#f0c040 90%,#ffe585 100%)',
            backgroundSize: '300% 100%', animation: 'gf 3s linear infinite',
            boxShadow: '0 0 20px rgba(240,192,64,.8),0 0 40px rgba(240,192,64,.5),inset 0 3px 0 rgba(255,255,255,.4)',
          }} />

          {/* Milestone nodes */}
          {JOURNEY_MILESTONES.map((ms, i) => {
            const isDone = capital >= ms.val
            const isNext = !isDone && i === nextIdx
            const sz     = NODE_SIZES[ms.size]
            const half   = sz / 2

            const nodeSt: React.CSSProperties = {
              width: sz, height: sz, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: ms.size === 'mini' ? 8 : ms.size === 'sm' ? 13 : 19,
              position: 'relative', zIndex: 1,
              border: isDone ? '2.5px solid #00e676'
                : isNext ? '2.5px solid #00e5ff'
                : ms.size === 'mini' ? '1.5px solid rgba(30,52,80,.5)'
                : `2px solid #1e3450`,
              background: isDone ? 'rgba(0,230,118,.08)'
                : isNext ? 'rgba(0,229,255,.06)'
                : 'rgba(9,24,40,.8)',
              boxShadow: isDone ? '0 0 20px rgba(0,230,118,.4),0 6px 20px rgba(0,0,0,.5)'
                : isNext ? '0 0 24px rgba(0,229,255,.45),0 6px 20px rgba(0,0,0,.5)'
                : '0 6px 20px rgba(0,0,0,.6)',
              ...(isNext ? { animation: 'nc 2s ease-in-out infinite' } : {}),
            }

            const valColor = isDone ? '#00e676' : isNext ? '#00e5ff' : ms.size === 'mini' ? 'rgba(30,52,80,.8)' : '#1e3450'
            const dateColor = isDone ? 'rgba(0,230,118,.4)' : isNext ? 'rgba(0,229,255,.55)' : 'rgba(20,40,64,.9)'

            const wrapOpacity = isDone || isNext ? 1
              : ms.size === 'mini' ? 0.45
              : ms.size === 'sm'   ? 0.5
              : 0.6

            const labelBlock = (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: ms.size === 'mini' ? 8 : ms.size === 'sm' ? 9 : 10, fontWeight: 900, color: valColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                  {ms.label}
                </span>
                {ms.size !== 'mini' && ms.dateStr && (
                  <span style={{ fontSize: ms.size === 'sm' ? 7 : 8, color: dateColor }}>
                    {ms.dateStr}
                  </span>
                )}
                {isNext && (
                  <span style={{ fontSize: 7, fontWeight: 900, background: '#00e5ff', color: '#001a22', borderRadius: 4, padding: '1px 6px', marginTop: 1, letterSpacing: '.06em' }}>
                    PRÓXIMO
                  </span>
                )}
              </div>
            )

            return (
              <div key={ms.val} style={{
                position: 'absolute', left: `${ms.pct}%`, top: '50%',
                transform: 'translate(-50%,-50%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                zIndex: 5, opacity: wrapOpacity,
              }}>
                {/* Label above */}
                {ms.above && (
                  <div style={{ position: 'absolute', bottom: `${half + 12}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    {labelBlock}
                    <div style={{ width: 1, height: ms.size === 'mini' ? 6 : 10, background: '#142840' }} />
                  </div>
                )}

                {/* Node */}
                <div style={nodeSt}>
                  {ms.size === 'mini'
                    ? <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#1e3450', display: 'block' }} />
                    : ms.emoji}
                </div>

                {/* Label below */}
                {!ms.above && (
                  <div style={{ position: 'absolute', top: `${half + 12}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <div style={{ width: 1, height: ms.size === 'mini' ? 6 : 10, background: '#142840' }} />
                    {labelBlock}
                  </div>
                )}
              </div>
            )
          })}

          {/* Current position marker */}
          <div style={{ position: 'absolute', top: '50%', left: `${curPos}%`, transform: 'translate(-50%,-50%)', zIndex: 10 }}>
            {/* Callout bubble */}
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 22px)', left: '50%', transform: 'translateX(-50%)',
              background: '#f0c040', color: '#060300',
              fontSize: 10, fontWeight: 900, padding: '6px 14px',
              borderRadius: 8, whiteSpace: 'nowrap', lineHeight: 1,
              boxShadow: '0 6px 24px rgba(240,192,64,.45)',
            }}>
              🚀 Você está aqui · ${fBRL(capital)}
              <span style={{
                position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                display: 'block', width: 0, height: 0,
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid #f0c040',
              }} />
            </div>
            {/* Expanding rings */}
            {[54, 78, 104].map((size, i) => (
              <div key={size} style={{
                position: 'absolute', width: size, height: size, borderRadius: '50%',
                top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                border: '1.5px solid rgba(240,192,64,.4)',
                animation: `re 2.8s ease-out infinite`, animationDelay: `${i * 0.7}s`,
              }} />
            ))}
            {/* Core */}
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              background: 'rgba(240,192,64,.15)', border: '2.5px solid #f0c040',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, lineHeight: 1, position: 'relative', zIndex: 2,
              animation: 'cp 2s ease-in-out infinite',
            }}>
              🔥
            </div>
          </div>

        </div>{/* /rail */}
      </div>{/* /track */}
    </div>
  )
}
