'use client'

import { useState, useEffect, useMemo } from 'react'

const LOT_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00]
const COMM_PER  = 0.35
const MISSAO_KEY = 'rafi-missao-hoje-date'

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
  balance:      number | null
  brokerCount?: number
  dailyTarget?: number
  brokerNames?: string[]
  // P&L atual do dia para detectar meta já cumprida
  todayPnl?:    number
  iaPnl?:       number
}

export function MissaoHojePopup({
  balance,
  brokerCount = 4,
  dailyTarget = 7.0,
  brokerNames = ['IC Markets', 'Exness', 'Pepperstone', 'Tickmill'],
  todayPnl = 0,
  iaPnl    = 0,
}: Props) {
  const [visible,   setVisible]   = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // Verifica no mount se o usuário já confirmou hoje (fuso BRT)
  useEffect(() => {
    try {
      if (localStorage.getItem(MISSAO_KEY) === brtDateStr()) setDismissed(true)
    } catch {}
  }, [])

  // Exibe assim que o saldo consolidado carregar e o usuário não tiver confirmado ainda
  useEffect(() => {
    if (dismissed || !balance || balance <= 0) return
    setVisible(true)
  }, [balance, dismissed])

  const data = useMemo(() => {
    if (!balance || balance <= 0) return null
    const n       = Math.max(brokerCount, 1)
    const goal    = balance * (dailyTarget / 100)
    const per     = goal / n
    const lot1    = suggestLot(per)
    const pips1   = Math.round((per + COMM_PER) / (lot1 * 10))
    const tgt1    = per + COMM_PER
    const total1  = tgt1 * n
    const per2    = per / 2
    const lot2    = suggestLot(per2)
    const pips2   = Math.round((per2 + COMM_PER) / (lot2 * 10))
    const tgt2    = per2 + COMM_PER
    const total2  = tgt2 * n * 2
    const losslim = balance * 0.05
    const goal_usd = goal
    return { n, goal, goal_usd, per, lot1, pips1, tgt1, total1, per2, lot2, pips2, tgt2, total2, losslim }
  }, [balance, brokerCount, dailyTarget])

  // Detecta se a meta diária já foi cumprida e por quem
  const metaGoal     = data?.goal_usd ?? 0
  const metaCumprida = metaGoal > 0 && todayPnl >= metaGoal
  const humanPnl     = todayPnl - iaPnl
  const metBy: 'ia' | 'human' | 'combined' | null = !metaCumprida ? null
    : iaPnl >= metaGoal                         ? 'ia'
    : humanPnl >= metaGoal                      ? 'human'
    : 'combined'

  function confirm() {
    try { localStorage.setItem(MISSAO_KEY, brtDateStr()) } catch {}
    setDismissed(true)
    setVisible(false)
  }

  function fechar() {
    setVisible(false)
  }

  if (!visible || !data) return null

  const f  = (v: number) => v.toFixed(2).replace('.', ',')
  const fl = (v: number) => v.toFixed(2) + 'L'

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center p-4"
      style={{ background: 'rgba(7,10,15,0.82)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="w-full max-w-[490px] rounded-2xl overflow-hidden"
        style={{
          background:  '#0f1824',
          border:      '1px solid rgba(226,176,74,0.28)',
          boxShadow:   '0 0 64px rgba(226,176,74,0.06), 0 32px 80px rgba(0,0,0,0.72)',
        }}
      >
        {/* Barra dourada no topo */}
        <div style={{ height: 2, background: 'linear-gradient(90deg,#e2b04a,rgba(226,176,74,.05))' }} />

        {/* Header */}
        <div className="flex items-center gap-2.5 px-[18px] py-3 border-b" style={{ borderColor: '#1c3050' }}>
          <span className="text-[19px] leading-none">🎯</span>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#e2b04a', marginBottom: 2 }}>
              Briefing diário
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#ddeeff' }}>Missão de Hoje</div>
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#e2b04a', background: 'rgba(226,176,74,.10)', border: '1px solid rgba(226,176,74,.28)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
            {fmtBrtDate()}
          </div>
        </div>

        {/* Capital consolidado */}
        <div className="flex items-center justify-between px-[18px] py-[10px] border-b" style={{ borderColor: '#1c3050', background: 'rgba(38,198,218,.04)' }}>
          <div className="flex flex-col gap-0.5">
            <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: '0.13em', textTransform: 'uppercase', color: '#26c6da', opacity: 0.7 }}>
              Capital consolidado
            </span>
            <span style={{ fontSize: 9, color: '#7a96b8' }}>{brokerNames.join(' · ')}</span>
          </div>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#7a96b8', marginRight: 3, verticalAlign: 'super' }}>USD</span>
            <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-0.02em', color: '#26c6da', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 24px rgba(38,198,218,.25)' }}>
              {f(balance ?? 0)}
            </span>
          </div>
        </div>

        {/* Status strip */}
        <div className="flex items-center justify-between px-[18px] py-1.5 border-b" style={{ borderColor: '#1c3050', background: metaCumprida ? 'rgba(0,230,118,.10)' : 'rgba(0,230,118,.04)' }}>
          <div className="flex items-center gap-1.5">
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#00e676', boxShadow: '0 0 6px #00e676' }} />
            <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#00e676' }}>
              {metaCumprida ? 'Meta do dia cumprida ✓' : 'Operações liberadas'}
            </span>
          </div>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>
            {metaCumprida
              ? `+$${f(todayPnl)} hoje`
              : `+0,0% · meta +${dailyTarget}%`}
          </span>
        </div>

        {/* Body — modo "meta cumprida" vs modo "plano de missão" */}
        {metaCumprida ? (
          /* ── META JÁ CUMPRIDA ── */
          <div className="px-[18px] py-4 flex flex-col gap-3">
            <div className="rounded-[12px] flex flex-col items-center gap-2 py-5" style={{ background: 'rgba(0,230,118,.06)', border: '1px solid rgba(0,230,118,.22)' }}>
              <span style={{ fontSize: 36 }}>
                {metBy === 'ia' ? '🤖' : metBy === 'combined' ? '🤝' : '🏆'}
              </span>
              <div style={{ fontSize: 18, fontWeight: 900, color: '#00e676', textAlign: 'center', letterSpacing: '-0.01em' }}>
                {metBy === 'ia'
                  ? 'IA cumpriu a meta!'
                  : metBy === 'combined'
                  ? 'Equipe perfeita!'
                  : 'Meta cumprida!'}
              </div>
              <div style={{ fontSize: 10, color: '#7a96b8', textAlign: 'center', lineHeight: 1.5, maxWidth: 290 }}>
                {metBy === 'ia'
                  ? 'A IA Autônoma trabalhou enquanto você dormia. O dia já está vencido 🌙'
                  : metBy === 'combined'
                  ? 'Você e a IA Autônoma juntos superaram a meta do dia.'
                  : 'Excelente sessão, Vinícius. Meta do dia atingida!'}
              </div>
            </div>

            {/* P&L breakdown */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-[10px] px-3 py-2.5 flex flex-col gap-0.5" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total hoje</span>
                <span style={{ fontSize: 15, fontWeight: 900, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>+${f(todayPnl)}</span>
              </div>
              <div className="rounded-[10px] px-3 py-2.5 flex flex-col gap-0.5" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>🤖 IA</span>
                <span style={{ fontSize: 15, fontWeight: 900, color: '#4499ff', fontVariantNumeric: 'tabular-nums' }}>+${f(iaPnl)}</span>
              </div>
              <div className="rounded-[10px] px-3 py-2.5 flex flex-col gap-0.5" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.08em' }}>👤 Trader</span>
                <span style={{ fontSize: 15, fontWeight: 900, fontVariantNumeric: 'tabular-nums', color: humanPnl >= 0 ? '#e2b04a' : '#ef4444' }}>{humanPnl >= 0 ? '+' : ''}${f(humanPnl)}</span>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg px-[11px] py-2" style={{ border: '1px solid rgba(239,68,68,.20)', background: 'rgba(239,68,68,.04)' }}>
              <span style={{ fontSize: 7.5, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.07em' }}>⚠ Limite perda (5%)</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>−${f(data.losslim)}</span>
            </div>
          </div>
        ) : (
          /* ── PLANO DE MISSÃO ── */
          <div className="px-[18px] py-3 flex flex-col gap-3">

            {/* Hero — alvo total do dia */}
            <div>
              <div style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#334455', marginBottom: 5 }}>
                🏆 Plano para hoje · +{dailyTarget}%
              </div>
              <div className="flex items-baseline gap-1 mb-1">
                <span style={{ fontSize: 11, fontWeight: 700, color: '#7a96b8' }}>$</span>
                <span style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1, color: '#4499ff', textShadow: '0 0 28px rgba(68,153,255,.28)', fontVariantNumeric: 'tabular-nums' }}>
                  {f(data.goal)}
                </span>
              </div>
              <div style={{ fontSize: 9.5, color: '#7a96b8', lineHeight: 1.45 }}>
                Ganhe{' '}
                <strong style={{ color: '#ddeeff' }}>${f(data.goal)} no total</strong>
                {' = '}
                <strong style={{ color: '#ddeeff' }}>${f(data.per)} por corretora</strong>
                {' '}({data.n} ativas)
              </div>
            </div>

            {/* Cenários: 1 Trade vs 2 Trades */}
            <div className="grid grid-cols-2 gap-2">

              {/* 1 Trade (recomendado) */}
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

            {/* Resumo: meta total e limite de perda */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between rounded-lg px-[11px] py-2" style={{ border: '1px solid #1c3050', background: '#0a1016' }}>
                <span style={{ fontSize: 7.5, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Meta total ({dailyTarget}%)</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#00e676', fontVariantNumeric: 'tabular-nums' }}>+${f(data.goal)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg px-[11px] py-2" style={{ border: '1px solid rgba(239,68,68,.20)', background: 'rgba(239,68,68,.04)' }}>
                <span style={{ fontSize: 7.5, fontWeight: 700, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.07em' }}>⚠ Limite perda (5%)</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>−${f(data.losslim)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Botões */}
        <div className="px-[18px] pb-[15px] flex flex-col gap-2">
          <button
            onClick={confirm}
            className="w-full rounded-[10px] flex items-center justify-center gap-2 transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
            style={{
              padding:       13,
              border:        'none',
              cursor:        'pointer',
              fontFamily:    'inherit',
              fontSize:      13,
              fontWeight:    800,
              letterSpacing: '0.03em',
              background:    metaCumprida
                ? 'linear-gradient(135deg,#00e676,#00b854)'
                : 'linear-gradient(135deg,#e2b04a,#bf8820)',
              color:         '#0a0700',
            }}
          >
            {metaCumprida
              ? (metBy === 'ia' ? '🤖  Dia livre — boa IA!' : '✓  Dia encerrado!')
              : '✓  Entendi, vou lá vencer'}
          </button>
          <button
            onClick={fechar}
            className="w-full rounded-[10px] flex items-center justify-center transition-all hover:opacity-70"
            style={{
              padding:       9,
              border:        '1px solid #1c3050',
              cursor:        'pointer',
              fontFamily:    'inherit',
              fontSize:      11,
              fontWeight:    600,
              background:    'transparent',
              color:         '#4a6080',
            }}
          >
            Fechar
          </button>
        </div>

        <div className="text-center px-[18px] pb-3" style={{ fontSize: 8.5, color: '#334455', lineHeight: 1.5 }}>
          {metaCumprida
            ? 'Meta confirmada não aparecerá mais hoje.'
            : <>Confirme o plano para não aparecer mais hoje.{' '}<strong style={{ color: '#7a96b8' }}>Fechar</strong>{' '}volta a cada atualização.</>}
        </div>
      </div>
    </div>
  )
}
