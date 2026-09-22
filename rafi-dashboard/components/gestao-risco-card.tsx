'use client'

import { useMemo } from 'react'

interface Props {
  /** P&L % do dia ao vivo (fechado + flutuante). Negativo = perda. */
  dailyPct:    number
  /** P&L $ do dia ao vivo (fechado + flutuante). */
  dailyPnl:    number
  /** Capital total consolidado em USD. */
  capital:     number
  /** Número de corretoras ativas. */
  numBrokers:  number
  /** Meta diária (default 7.0) */
  DAILY_TARGET?: number
  /** Limite máximo de perda (default 5.0) */
  MAX_LOSS?: number
}

const COMM_PER = 0.35  // comissão estimada por corretora por trade

function suggestLot(targetPerBroker: number): number {
  // EURUSD: 0.01L = $0.10/pip → lotSize × 10 = $/pip
  for (const lot of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00]) {
    const pipsNeeded = (targetPerBroker + COMM_PER) / (lot * 10)
    if (pipsNeeded >= 4 && pipsNeeded <= 80) return lot
  }
  return 0.10
}

function fmtLot(lot: number): string {
  return lot.toFixed(2) + 'L'
}

export function GestaoRiscoCard({
  dailyPct,
  dailyPnl,
  capital,
  numBrokers,
  DAILY_TARGET = 7.0,
  MAX_LOSS = 5.0,
}: Props) {
  const brokers = Math.max(numBrokers, 1)

  // Estado do semáforo
  const state: 'safe' | 'warn' | 'danger' = useMemo(() => {
    if (dailyPct <= -MAX_LOSS)           return 'danger'
    if (dailyPct <= -(MAX_LOSS * 0.80))  return 'warn'
    return 'safe'
  }, [dailyPct, MAX_LOSS])

  // Barra de perda diária (0% a MAX_LOSS%)
  const lossAbs     = Math.max(-dailyPct, 0)
  const barWidth    = Math.min((lossAbs / MAX_LOSS) * 100, 100)

  // Recuperação: quanto falta para bater DAILY_TARGET
  const targetPnl   = capital * (DAILY_TARGET / 100)
  const gapTotal    = targetPnl - dailyPnl      // total a ganhar (recupera perda + bate meta)
  const perBroker   = gapTotal / brokers        // alvo líquido por corretora

  // Cenário 1 trade
  const lot1   = suggestLot(perBroker)
  const tgt1   = perBroker + COMM_PER
  const pip1   = Math.round(tgt1 / (lot1 * 10))
  const tot1   = tgt1 * brokers

  // Cenário 2 trades
  const perHalf  = gapTotal / 2 / brokers
  const lot2     = suggestLot(perHalf)
  const tgt2     = perHalf + COMM_PER
  const pip2     = Math.round(tgt2 / (lot2 * 10))
  const tot2     = tgt2 * brokers

  const colors = {
    safe:   { dot: '#00e676', label: '#00e676', border: 'rgba(0,230,118,.25)',  bg: 'rgba(0,230,118,.04)' },
    warn:   { dot: '#f59e0b', label: '#f59e0b', border: 'rgba(245,158,11,.4)',  bg: 'rgba(245,158,11,.04)' },
    danger: { dot: '#ef4444', label: '#ef4444', border: 'rgba(239,68,68,.5)',   bg: 'rgba(239,68,68,.06)' },
  }[state]

  const stateLabel = state === 'safe' ? 'CONTROLADO' : state === 'warn' ? 'EM RISCO' : 'PARAR DE OPERAR'

  const barBg = state === 'safe'
    ? '#00e676'
    : state === 'warn'
    ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
    : '#ef4444'

  const maxLossAbs  = capital * (MAX_LOSS / 100)
  const remaining   = maxLossAbs - Math.max(-dailyPnl, 0)

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>

      {/* Status strip */}
      <div className="px-3 py-2 flex items-center justify-between gap-2" style={{ background: colors.bg }}>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: colors.dot,
              boxShadow: `0 0 6px ${colors.dot}`,
              animation: state !== 'safe' ? 'riskBlink 1s step-end infinite' : undefined,
            }}
          />
          <span className="text-[9px] font-bold tracking-wide" style={{ color: colors.label }}>
            {stateLabel}
          </span>
        </div>
        <span className="text-[11px] font-mono font-bold" style={{ color: colors.label }}>
          {dailyPct >= 0 ? '+' : ''}{dailyPct.toFixed(1)}% / {MAX_LOSS.toFixed(1)}%
        </span>
      </div>

      {/* Barra de perda diária */}
      <div className="px-3 pt-2 pb-1">
        <div className="h-[3px] rounded-full overflow-hidden" style={{ background: '#131f2e' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${barWidth}%`, background: barBg }}
          />
        </div>
        <div className="flex justify-between mt-1" style={{ fontSize: 8, color: '#334455' }}>
          <span>0%</span>
          <span>Limite: {MAX_LOSS}%</span>
        </div>
      </div>

      {/* HERO: meta de recuperação */}
      <div className="px-3 pb-3 pt-1">
        <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#334455', marginBottom: 6 }}>
          🏆 Seu plano para a vitória · +{DAILY_TARGET}%
        </div>

        {gapTotal <= 0 ? (
          /* Já atingiu a meta */
          <div
            className="rounded-lg px-3 py-2.5 text-center"
            style={{ background: 'rgba(0,230,118,.07)', border: '1px solid rgba(0,230,118,.2)' }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: '#00e676' }}>✓ Meta de +{DAILY_TARGET}% atingida!</div>
            <div style={{ fontSize: 9, color: '#7a96b8', marginTop: 2 }}>Proteja o lucro e não abra novos trades.</div>
          </div>
        ) : (
          <>
            {/* Número herói */}
            <div className="flex items-baseline gap-1 mb-1">
              <span style={{ fontSize: 11, fontWeight: 700, color: '#7a96b8', marginBottom: 3 }}>$</span>
              <span
                style={{
                  fontFamily: "'Space Grotesk', monospace",
                  fontSize: 36,
                  fontWeight: 900,
                  lineHeight: 1,
                  letterSpacing: '-0.02em',
                  color: '#4499ff',
                  textShadow: '0 0 24px rgba(68,153,255,.35)',
                }}
              >
                {gapTotal.toFixed(2)}
              </span>
            </div>
            <div style={{ fontSize: 9, color: '#7a96b8', marginBottom: 10 }}>
              Ganhe <span style={{ color: '#ddeeff', fontWeight: 600 }}>${gapTotal.toFixed(2)} no total</span>
              {' = '}<span style={{ color: '#ddeeff', fontWeight: 600 }}>${perBroker.toFixed(2)} por corretora</span>
              {' ('}${brokers} ativas)
            </div>

            {/* Cenários */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>

              {/* 1 TRADE */}
              <div
                className="rounded-lg overflow-hidden"
                style={{ border: '1px solid #4499ff', background: 'rgba(68,153,255,.05)' }}
              >
                <div
                  className="px-2.5 py-1.5 flex items-center gap-1.5"
                  style={{ background: 'rgba(68,153,255,.1)' }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#4499ff' }}>1 Trade</span>
                  <span
                    style={{
                      fontSize: 7, fontWeight: 800, background: '#4499ff', color: '#000',
                      padding: '1px 4px', borderRadius: 3,
                    }}
                  >
                    REC
                  </span>
                </div>
                <div className="px-2.5 py-2 flex flex-col gap-2">
                  <div>
                    <div style={{ fontSize: 7, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Lote</div>
                    <div style={{ fontFamily: "'Space Grotesk', monospace", fontSize: 18, fontWeight: 800, color: '#4499ff', lineHeight: 1 }}>
                      {fmtLot(lot1)}
                    </div>
                  </div>
                  <div style={{ height: 1, background: '#1c3050' }} />
                  <div>
                    <div style={{ fontSize: 7, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Alvo / corretora</div>
                    <div style={{ fontFamily: "'Space Grotesk', monospace", fontSize: 16, fontWeight: 800, color: '#00e676', lineHeight: 1 }}>
                      ${tgt1.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 8, color: '#334455', marginTop: 1 }}>≈ {pip1} pips</div>
                  </div>
                  <div style={{ fontSize: 8, fontWeight: 600, color: '#7a96b8' }}>
                    Total: <span style={{ color: '#ddeeff' }}>${tot1.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* 2 TRADES */}
              <div
                className="rounded-lg overflow-hidden"
                style={{ border: '1px solid #1c3050', background: 'transparent' }}
              >
                <div
                  className="px-2.5 py-1.5"
                  style={{ background: 'rgba(255,255,255,.02)' }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#7a96b8' }}>2 Trades</span>
                </div>
                <div className="px-2.5 py-2 flex flex-col gap-2">
                  <div>
                    <div style={{ fontSize: 7, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Lote</div>
                    <div style={{ fontFamily: "'Space Grotesk', monospace", fontSize: 18, fontWeight: 800, color: '#7a96b8', lineHeight: 1 }}>
                      {fmtLot(lot2)}
                    </div>
                  </div>
                  <div style={{ height: 1, background: '#1c3050' }} />
                  <div>
                    <div style={{ fontSize: 7, color: '#334455', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Alvo / corretora</div>
                    <div style={{ fontFamily: "'Space Grotesk', monospace", fontSize: 16, fontWeight: 800, color: '#00e676', lineHeight: 1 }}>
                      ${tgt2.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 8, color: '#334455', marginTop: 1 }}>≈ {pip2} pips</div>
                  </div>
                  <div style={{ fontSize: 8, fontWeight: 600, color: '#7a96b8' }}>
                    /trade: <span style={{ color: '#ddeeff' }}>${tot2.toFixed(2)}</span>
                  </div>
                </div>
              </div>

            </div>
          </>
        )}
      </div>

      {/* Aviso contextual — apenas warn/danger */}
      {state !== 'safe' && (
        <div
          className="mx-3 mb-3 rounded-lg px-2.5 py-2 flex items-start gap-1.5 text-[9px] leading-relaxed"
          style={
            state === 'warn'
              ? { background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.2)', color: '#f59e0b' }
              : { background: 'rgba(239,68,68,.07)', border: '1px solid rgba(239,68,68,.2)', color: '#ef4444' }
          }
        >
          <span style={{ flexShrink: 0, marginTop: 1 }}>{state === 'warn' ? '⚠️' : '🚫'}</span>
          {state === 'warn' ? (
            <span>
              A <strong>${remaining.toFixed(2)}</strong> do limite.{' '}
              <strong>Próximo stop → PARA DE OPERAR.</strong> Reduza o lote.
            </span>
          ) : (
            <span>
              <strong>Limite de {MAX_LOSS}% atingido.</strong> Encerre posições e não abra novos trades hoje.
            </span>
          )}
        </div>
      )}

      <style>{`@keyframes riskBlink { 50% { opacity: 0.3; } }`}</style>
    </div>
  )
}
