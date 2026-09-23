'use client'

import { useState, useEffect, useMemo } from 'react'

const LOT_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00]
const COMM_PER  = 0.35
const MISSAO_IA_KEY = 'rafi-missao-ia-date'

function suggestLot(tgt: number): number {
  for (const lot of LOT_STEPS) {
    const p = (tgt + COMM_PER) / (lot * 10)
    if (p >= 4 && p <= 80) return lot
  }
  return 0.10
}

function brtDateStr() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function fmtBrtDate(): string {
  const brt    = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const days   = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  return `${days[brt.getUTCDay()]}, ${brt.getUTCDate()} ${months[brt.getUTCMonth()]} ${brt.getUTCFullYear()}`
}

interface Props {
  balance:       number | null
  brokerCount?:  number
  brokerNames?:  string[]
  dailyPct?:     number   // meta_diaria_pct (padrão 7)
  weeklyPct?:    number   // meta_semanal_pct (padrão 25)
  pnlHoje?:      number   // P&L IA hoje
  pnlSemana?:    number   // P&L IA esta semana
  iaAtiva?:      boolean
}

export function MissaoIAPopup({
  balance,
  brokerCount  = 4,
  brokerNames  = ['IC Markets', 'Exness', 'Pepperstone', 'Tickmill'],
  dailyPct     = 7,
  weeklyPct    = 25,
  pnlHoje      = 0,
  pnlSemana    = 0,
  iaAtiva      = true,
}: Props) {
  const [visible,   setVisible]   = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(MISSAO_IA_KEY) === brtDateStr()) setDismissed(true)
    } catch {}
  }, [])

  useEffect(() => {
    if (dismissed || !balance || balance <= 0) return
    setVisible(true)
  }, [balance, dismissed])

  const data = useMemo(() => {
    if (!balance || balance <= 0) return null
    const n        = Math.max(brokerCount, 1)
    const goal     = balance * (dailyPct / 100)
    const goalWeek = balance * (weeklyPct / 100)
    const per      = goal / n
    const lot1     = suggestLot(per)
    const pips1    = Math.round((per + COMM_PER) / (lot1 * 10))
    const tgt1     = per + COMM_PER
    const total1   = tgt1 * n
    const per2     = per / 2
    const lot2     = suggestLot(per2)
    const pips2    = Math.round((per2 + COMM_PER) / (lot2 * 10))
    const tgt2     = per2 + COMM_PER
    const total2   = tgt2 * n * 2
    const losslim  = balance * 0.05
    return { n, goal, goalWeek, per, lot1, pips1, tgt1, total1, per2, lot2, pips2, tgt2, total2, losslim }
  }, [balance, brokerCount, dailyPct, weeklyPct])

  const metaDiariaUsd  = data?.goal     ?? 0
  const metaSemanaUsd  = data?.goalWeek ?? 0
  const metaDiaCumprida = metaDiariaUsd > 0 && pnlHoje  >= metaDiariaUsd
  const metaSemanaCumprida = metaSemanaUsd > 0 && pnlSemana >= metaSemanaUsd

  function confirm() {
    try { localStorage.setItem(MISSAO_IA_KEY, brtDateStr()) } catch {}
    setDismissed(true)
    setVisible(false)
  }

  if (!visible || !data) return null

  const f  = (v: number) => v.toFixed(2).replace('.', ',')
  const fl = (v: number) => v.toFixed(2) + 'L'

  // ── Estado 3: meta semanal cumprida ───────────────────────────────────────
  if (metaSemanaCumprida) {
    return (
      <div className="fixed inset-0 z-[9997] flex items-center justify-center p-4"
        style={{ background: 'rgba(7,10,15,0.82)', backdropFilter: 'blur(4px)' }}>
        <div className="w-full max-w-[440px] rounded-2xl overflow-hidden"
          style={{ background: '#0f1824', border: '1px solid rgba(68,153,255,0.28)', boxShadow: '0 0 64px rgba(68,153,255,0.08), 0 32px 80px rgba(0,0,0,0.72)' }}>
          <div style={{ height: 2, background: 'linear-gradient(90deg,#4499ff,rgba(68,153,255,.05))' }} />
          <div className="px-[18px] py-4 flex flex-col items-center gap-3 text-center">
            <span style={{ fontSize: 40 }}>🏆</span>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#4499ff', letterSpacing: '-0.01em' }}>Semana cumprida pela IA!</div>
            <div style={{ fontSize: 10, color: '#7a96b8', lineHeight: 1.6 }}>
              A IA atingiu a meta semanal e parou automaticamente.<br />
              Retoma na próxima segunda-feira 00:00 BRT.
            </div>
            <div className="w-full rounded-lg px-4 py-2 flex justify-between" style={{ background: 'rgba(68,153,255,.08)', border: '1px solid rgba(68,153,255,.20)' }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Semana IA</span>
              <span style={{ fontSize: 14, fontWeight: 900, color: '#4499ff', fontVariantNumeric: 'tabular-nums' }}>
                +${f(pnlSemana)} / ${f(metaSemanaUsd)} ✓
              </span>
            </div>
            <button onClick={confirm}
              className="w-full rounded-[10px] transition-all hover:opacity-90 hover:-translate-y-px"
              style={{ padding: 13, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 800, letterSpacing: '0.03em', background: 'linear-gradient(135deg,#4499ff,#2277dd)', color: '#fff' }}>
              🤖 Perfeito — descansando até segunda!
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Estado 2: meta diária cumprida ───────────────────────────────────────
  if (metaDiaCumprida) {
    return (
      <div className="fixed inset-0 z-[9997] flex items-center justify-center p-4"
        style={{ background: 'rgba(7,10,15,0.82)', backdropFilter: 'blur(4px)' }}>
        <div className="w-full max-w-[440px] rounded-2xl overflow-hidden"
          style={{ background: '#0f1824', border: '1px solid rgba(68,153,255,0.28)', boxShadow: '0 0 64px rgba(68,153,255,0.08), 0 32px 80px rgba(0,0,0,0.72)' }}>
          <div style={{ height: 2, background: 'linear-gradient(90deg,#4499ff,rgba(68,153,255,.05))' }} />

          {/* Header */}
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-b" style={{ borderColor: '#1c3050' }}>
            <span style={{ fontSize: 19 }}>🤖</span>
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#4499ff', marginBottom: 2 }}>Briefing IA</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#ddeeff' }}>META CUMPRIDA ✓</div>
            </div>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#4499ff', background: 'rgba(68,153,255,.10)', border: '1px solid rgba(68,153,255,.28)', borderRadius: 20, padding: '3px 10px' }}>
              {fmtBrtDate()}
            </div>
          </div>

          <div className="px-[18px] py-4 flex flex-col gap-3">
            <div className="rounded-[12px] flex flex-col items-center gap-2 py-5" style={{ background: 'rgba(68,153,255,.06)', border: '1px solid rgba(68,153,255,.22)' }}>
              <span style={{ fontSize: 36 }}>🤖</span>
              <div style={{ fontSize: 18, fontWeight: 900, color: '#4499ff', textAlign: 'center' }}>IA cumpriu a meta do dia!</div>
              <div style={{ fontSize: 10, color: '#7a96b8', textAlign: 'center', lineHeight: 1.5, maxWidth: 290 }}>
                A IA trabalhou enquanto você dormia. O dia já está vencido 🌙<br />
                Todas as posições foram encerradas automaticamente.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-[10px] px-3 py-2.5 flex flex-col gap-0.5" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>🤖 IA hoje</span>
                <span style={{ fontSize: 15, fontWeight: 900, color: '#4499ff', fontVariantNumeric: 'tabular-nums' }}>+${f(pnlHoje)}</span>
              </div>
              <div className="rounded-[10px] px-3 py-2.5 flex flex-col gap-0.5" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Semana IA</span>
                <span style={{ fontSize: 15, fontWeight: 900, color: '#7a96b8', fontVariantNumeric: 'tabular-nums' }}>+${f(pnlSemana)} / ${f(metaSemanaUsd)}</span>
              </div>
            </div>
          </div>

          <div className="px-[18px] pb-4">
            <button onClick={confirm}
              className="w-full rounded-[10px] transition-all hover:opacity-90 hover:-translate-y-px"
              style={{ padding: 13, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 800, letterSpacing: '0.03em', background: 'linear-gradient(135deg,#00e676,#00b854)', color: '#0a0700' }}>
              🤖 Perfeito — IA arrasou!
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Estado 1: operando (meta não atingida) ────────────────────────────────
  const progDia = Math.min(Math.max(pnlHoje / metaDiariaUsd * 100, 0), 100)
  const progSem = Math.min(Math.max(pnlSemana / metaSemanaUsd * 100, 0), 100)

  return (
    <div className="fixed inset-0 z-[9997] flex items-center justify-center p-4"
      style={{ background: 'rgba(7,10,15,0.82)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-[490px] rounded-2xl overflow-hidden"
        style={{ background: '#0f1824', border: '1px solid rgba(68,153,255,0.28)', boxShadow: '0 0 64px rgba(68,153,255,0.06), 0 32px 80px rgba(0,0,0,0.72)' }}>
        <div style={{ height: 2, background: 'linear-gradient(90deg,#4499ff,rgba(68,153,255,.05))' }} />

        {/* Header */}
        <div className="flex items-center gap-2.5 px-[18px] py-3 border-b" style={{ borderColor: '#1c3050' }}>
          <span style={{ fontSize: 19 }}>🤖</span>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#4499ff', marginBottom: 2 }}>Briefing IA</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#ddeeff' }}>Missão Autônoma</div>
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#4499ff', background: 'rgba(68,153,255,.10)', border: '1px solid rgba(68,153,255,.28)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
            {fmtBrtDate()}
          </div>
        </div>

        {/* Capital */}
        <div className="flex items-center justify-between px-[18px] py-[10px] border-b" style={{ borderColor: '#1c3050', background: 'rgba(68,153,255,.04)' }}>
          <div className="flex flex-col gap-0.5">
            <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: '#4499ff', opacity: 0.7 }}>Capital consolidado</span>
            <span style={{ fontSize: 9, color: '#7a96b8' }}>{brokerNames.join(' · ')}</span>
          </div>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#7a96b8', marginRight: 3, verticalAlign: 'super' }}>USD</span>
            <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-0.02em', color: '#4499ff', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 24px rgba(68,153,255,.25)' }}>
              {f(balance ?? 0)}
            </span>
          </div>
        </div>

        {/* Status strip */}
        <div className="flex items-center justify-between px-[18px] py-1.5 border-b" style={{ borderColor: '#1c3050', background: 'rgba(68,153,255,.03)' }}>
          <div className="flex items-center gap-1.5">
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: iaAtiva ? '#4499ff' : '#ef4444', boxShadow: iaAtiva ? '0 0 6px #4499ff' : '0 0 6px #ef4444' }} />
            <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: iaAtiva ? '#4499ff' : '#ef4444' }}>
              {iaAtiva ? 'Operando nos horários programados' : 'IA desativada'}
            </span>
          </div>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: '#4499ff', fontVariantNumeric: 'tabular-nums' }}>
            meta +{dailyPct}% dia · +{weeklyPct}% semana
          </span>
        </div>

        {/* Plano */}
        <div className="px-[18px] py-3 flex flex-col gap-3">
          {/* Hero */}
          <div>
            <div style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#334455', marginBottom: 5 }}>
              🏆 Plano para hoje · +{dailyPct}%
            </div>
            <div className="flex items-baseline gap-1 mb-1">
              <span style={{ fontSize: 11, fontWeight: 700, color: '#7a96b8' }}>$</span>
              <span style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1, color: '#4499ff', textShadow: '0 0 28px rgba(68,153,255,.28)', fontVariantNumeric: 'tabular-nums' }}>
                {f(data.goal)}
              </span>
            </div>
            <div style={{ fontSize: 9.5, color: '#7a96b8', lineHeight: 1.45 }}>
              Ganhe <strong style={{ color: '#ddeeff' }}>${f(data.goal)} no total</strong> = <strong style={{ color: '#ddeeff' }}>${f(data.per)} por corretora</strong> ({data.n} ativas)
            </div>
          </div>

          {/* 1 Trade vs 2 Trades */}
          <div className="grid grid-cols-2 gap-2">
            {/* 1 Trade */}
            <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid #4499ff' }}>
              <div className="flex items-center gap-1.5 px-[11px] py-[7px]" style={{ background: 'rgba(68,153,255,.10)' }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: '#4499ff' }}>1 Trade</span>
                <span style={{ fontSize: 7, fontWeight: 800, background: '#4499ff', color: '#000', borderRadius: 3, padding: '1px 4px' }}>REC</span>
              </div>
              <div className="px-[11px] py-[9px] flex flex-col gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Lote</span>
                  <span style={{ fontSize: 18, fontWeight: 900, lineHeight: 1, color: '#4499ff', fontVariantNumeric: 'tabular-nums' }}>{fl(data.lot1)}</span>
                </div>
                <div style={{ height: 1, background: '#1c3050' }} />
                <div className="flex flex-col gap-0.5">
                  <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Alvo / corretora</span>
                  <span style={{ fontSize: 15, fontWeight: 900, lineHeight: 1, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>${f(data.tgt1)}</span>
                  <span style={{ fontSize: 8, color: '#334455', marginTop: 1 }}>≈ {data.pips1} pips</span>
                </div>
                <div style={{ fontSize: 8, fontWeight: 700, color: '#7a96b8' }}>Total: <span style={{ color: '#ddeeff' }}>${f(data.total1)}</span></div>
              </div>
            </div>

            {/* 2 Trades */}
            <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid #1c3050' }}>
              <div className="flex items-center gap-1.5 px-[11px] py-[7px]" style={{ background: 'rgba(255,255,255,.02)' }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: '#7a96b8' }}>2 Trades</span>
              </div>
              <div className="px-[11px] py-[9px] flex flex-col gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Lote</span>
                  <span style={{ fontSize: 18, fontWeight: 900, lineHeight: 1, color: '#7a96b8', fontVariantNumeric: 'tabular-nums' }}>{fl(data.lot2)}</span>
                </div>
                <div style={{ height: 1, background: '#1c3050' }} />
                <div className="flex flex-col gap-0.5">
                  <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Alvo / corretora</span>
                  <span style={{ fontSize: 15, fontWeight: 900, lineHeight: 1, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>${f(data.tgt2)}</span>
                  <span style={{ fontSize: 8, color: '#334455', marginTop: 1 }}>≈ {data.pips2} pips</span>
                </div>
                <div style={{ fontSize: 8, fontWeight: 700, color: '#7a96b8' }}>/trade: <span style={{ color: '#ddeeff' }}>${f(data.total2 / 2)}</span></div>
              </div>
            </div>
          </div>

          {/* Meta + limite de perda */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center justify-between rounded-lg px-[11px] py-2" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
              <span style={{ fontSize: 7.5, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Meta total ({dailyPct}%)</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>+${f(data.goal)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg px-[11px] py-2" style={{ border: '1px solid rgba(239,68,68,.20)', background: 'rgba(239,68,68,.04)' }}>
              <span style={{ fontSize: 7.5, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.07em' }}>⚠ Limite perda (5%)</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>−${f(data.losslim)}</span>
            </div>
          </div>

          {/* Progresso da semana */}
          <div className="rounded-lg px-3 py-2.5 space-y-2" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
            <div className="flex justify-between items-center">
              <span style={{ fontSize: 8, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Progresso da semana</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: progSem >= 100 ? '#00e676' : '#7a96b8', fontVariantNumeric: 'tabular-nums' }}>
                ${f(pnlSemana)} de ${f(metaSemanaUsd)} ({weeklyPct}%)
              </span>
            </div>
            <div style={{ height: 4, background: '#1c3050', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progSem}%`, height: '100%', background: progSem >= 100 ? '#00e676' : '#4499ff', borderRadius: 2, transition: 'width 0.4s' }} />
            </div>
            <div className="flex justify-between items-center">
              <span style={{ fontSize: 8, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Progresso de hoje</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: progDia >= 100 ? '#00e676' : '#7a96b8', fontVariantNumeric: 'tabular-nums' }}>
                ${f(pnlHoje)} de ${f(data.goal)} ({dailyPct}%)
              </span>
            </div>
            <div style={{ height: 4, background: '#1c3050', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progDia}%`, height: '100%', background: progDia >= 100 ? '#00e676' : '#4499ff', borderRadius: 2, transition: 'width 0.4s' }} />
            </div>
          </div>

          {/* Aviso de parada automática */}
          <div style={{ fontSize: 8.5, color: '#334455', textAlign: 'center', lineHeight: 1.5, borderTop: '1px solid #1c3050', paddingTop: 8 }}>
            Ao atingir qualquer meta, a IA <strong style={{ color: '#4499ff' }}>fecha todas as posições e para automaticamente</strong>.
          </div>
        </div>

        {/* Botões */}
        <div className="px-[18px] pb-4 flex flex-col gap-2">
          <button onClick={confirm}
            className="w-full rounded-[10px] flex items-center justify-center gap-2 transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
            style={{ padding: 13, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 800, letterSpacing: '0.03em', background: 'linear-gradient(135deg,#4499ff,#2277dd)', color: '#fff' }}>
            ✓ Entendido
          </button>
          <button onClick={() => setVisible(false)}
            className="w-full rounded-[10px] flex items-center justify-center transition-all hover:opacity-70"
            style={{ padding: 9, border: '1px solid #1c3050', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, background: 'transparent', color: '#4a6080' }}>
            Fechar
          </button>
        </div>

        <div className="text-center px-[18px] pb-3" style={{ fontSize: 8.5, color: '#334455', lineHeight: 1.5 }}>
          Confirme para não aparecer mais hoje. <strong style={{ color: '#7a96b8' }}>Fechar</strong> volta a cada atualização.
        </div>
      </div>
    </div>
  )
}
