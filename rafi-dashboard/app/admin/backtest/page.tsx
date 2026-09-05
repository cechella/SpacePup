'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Play, Clock, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronUp, RefreshCw, Loader2,
  TrendingUp, TrendingDown, BarChart2, Zap,
} from 'lucide-react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type RunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

interface BacktestRun {
  id:           string
  created_at:   string
  periodo:      string | null
  inicio:       string | null
  fim:          string | null
  capital:      number
  profile:      string
  status:       RunStatus
  config_hash:  string | null
  progress_pct: number
  resultado:    Record<string, unknown> | null
  error_msg:    string | null
  updated_at:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PERIODOS = [
  { id: '1w', label: '1 Semana',  candles: '~2 mil' },
  { id: '1m', label: '1 Mês',    candles: '~9 mil' },
  { id: '3m', label: '3 Meses',  candles: '~27 mil' },
  { id: '6m', label: '6 Meses',  candles: '~54 mil' },
  { id: '1y', label: '1 Ano',    candles: '~108 mil' },
]

function statusLabel(s: RunStatus) {
  switch (s) {
    case 'pending':   return { text: 'Aguardando bot',  color: '#f59e0b', Icon: Clock }
    case 'running':   return { text: 'Executando...',   color: '#3b82f6', Icon: Loader2 }
    case 'done':      return { text: 'Concluído',       color: '#22c55e', Icon: CheckCircle2 }
    case 'error':     return { text: 'Erro',            color: '#ef4444', Icon: XCircle }
    case 'cancelled': return { text: 'Cancelado',       color: '#6b7280', Icon: XCircle }
    default:          return { text: s,                 color: '#6b7280', Icon: AlertCircle }
  }
}

function fmt(v: unknown, decimals = 2): string {
  if (v == null) return '—'
  const n = Number(v)
  return isNaN(n) ? '—' : n.toFixed(decimals)
}

function periodLabel(run: BacktestRun): string {
  if (run.periodo) return PERIODOS.find(p => p.id === run.periodo)?.label ?? run.periodo
  if (run.inicio && run.fim) return `${run.inicio} → ${run.fim}`
  return '—'
}

function dataBr(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

// ─── Componente de run expandido ──────────────────────────────────────────────

function RunDetail({ run }: { run: BacktestRun }) {
  const r = run.resultado as Record<string, number & { por_mes?: Record<string, number> }> | null
  if (!r) return null

  const wr  = Number(r.win_rate_pct)
  const pf  = Number(r.profit_factor)
  const sh  = Number(r.sharpe_ratio)
  const dd  = Number(r.drawdown_max_pct)
  const ret = Number(r.retorno_pct)

  return (
    <div style={{
      marginTop: 16,
      borderTop: '1px solid rgba(255,255,255,0.07)',
      paddingTop: 16,
    }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Win Rate',      value: `${fmt(r.win_rate_pct)}%`,   color: wr >= 55 ? '#22c55e' : '#ef4444' },
          { label: 'Profit Factor', value: fmt(r.profit_factor, 3),     color: pf >= 1.5 ? '#22c55e' : '#ef4444' },
          { label: 'Sharpe Ratio',  value: fmt(r.sharpe_ratio, 3),      color: sh >= 1 ? '#22c55e' : '#f59e0b' },
          { label: 'Drawdown Máx',  value: `${fmt(r.drawdown_max_pct)}%`, color: dd <= 20 ? '#22c55e' : '#ef4444' },
          { label: 'Retorno Total', value: `${ret >= 0 ? '+' : ''}${fmt(r.retorno_pct)}%`, color: ret >= 0 ? '#22c55e' : '#ef4444' },
          { label: 'Capital Final', value: `$${fmt(r.capital_final)}`,  color: '#e2e8f0' },
          { label: 'Trades',        value: String(r.total_trades ?? '—'), color: '#e2e8f0' },
          { label: 'Duração Média', value: `${fmt(r.duracao_media_min, 0)} min`, color: '#94a3b8' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 8,
            padding: '10px 12px',
            border: '1px solid rgba(255,255,255,0.07)',
          }}>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Ganhos vs Perdas */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 10, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ganhos</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#22c55e' }}>{String(r.ganhos ?? '—')}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Média: +${fmt(r.media_ganho_usd)}</div>
        </div>
        <div style={{ flex: 1, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 10, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Perdas</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#ef4444' }}>{String(r.perdas ?? '—')}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Média: −${fmt(r.media_perda_usd)}</div>
        </div>
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expectativa/Trade</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: Number(r.expectancy_usd) >= 0 ? '#22c55e' : '#ef4444' }}>
            {Number(r.expectancy_usd) >= 0 ? '+' : ''}${fmt(r.expectancy_usd)}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Config: {run.config_hash ?? '—'}</div>
        </div>
      </div>

      {/* Por mês */}
      {r.por_mes && Object.keys(r.por_mes as object).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Resultado por Mês</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(r.por_mes as Record<string, number>).map(([mes, val]) => (
              <div key={mes} style={{
                background: Number(val) >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${Number(val) >= 0 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 12,
                color: Number(val) >= 0 ? '#22c55e' : '#ef4444',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {mes}: {Number(val) >= 0 ? '+' : ''}${fmt(val)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fase 1A */}
      <div style={{
        padding: '8px 14px',
        borderRadius: 8,
        background: wr >= 55 && pf >= 1.5 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
        border: `1px solid ${wr >= 55 && pf >= 1.5 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
        fontSize: 12,
        color: wr >= 55 && pf >= 1.5 ? '#22c55e' : '#ef4444',
      }}>
        {wr >= 55 && pf >= 1.5
          ? '✔ METAS FASE 1A ATINGIDAS — WR ≥55% e PF ≥1.5'
          : `✘ Metas Fase 1A não atingidas — WR: ${fmt(r.win_rate_pct)}% (meta ≥55%) | PF: ${fmt(r.profit_factor, 3)} (meta ≥1.5)`}
      </div>
    </div>
  )
}

// ─── Card de run ──────────────────────────────────────────────────────────────

function RunCard({ run, onDelete }: { run: BacktestRun; onDelete?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const { text, color, Icon } = statusLabel(run.status)
  const r = run.resultado as Record<string, number> | null

  return (
    <div style={{
      background: '#111827',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      padding: '14px 18px',
      marginBottom: 8,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
           onClick={() => run.status === 'done' && setExpanded(e => !e)}>

        <Icon size={16} color={color}
              style={run.status === 'running' ? { animation: 'spin 1s linear infinite' } : undefined} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 14 }}>
              {periodLabel(run)}
            </span>
            <span style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 4,
              background: 'rgba(255,255,255,0.07)', color: '#94a3b8',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              {run.profile}
            </span>
            {run.config_hash && (
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>
                cfg:{run.config_hash}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {dataBr(run.created_at)} · Capital: ${run.capital.toFixed(0)}
          </div>
        </div>

        {/* Resultados rápidos */}
        {r && run.status === 'done' && (
          <div style={{ display: 'flex', gap: 16, marginRight: 8 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: Number(r.win_rate_pct) >= 55 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(r.win_rate_pct)}%
              </div>
              <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>WR</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: Number(r.profit_factor) >= 1.5 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(r.profit_factor, 2)}
              </div>
              <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>PF</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
                {String(r.total_trades ?? '—')}
              </div>
              <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>Trades</div>
            </div>
          </div>
        )}

        {/* Status badge */}
        <span style={{ fontSize: 12, color, whiteSpace: 'nowrap', fontWeight: 500 }}>{text}</span>

        {/* Progress bar for running */}
        {run.status === 'running' && (
          <div style={{ width: 80, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${run.progress_pct}%`, height: '100%', background: '#3b82f6', borderRadius: 2, transition: 'width 0.5s ease' }} />
          </div>
        )}

        {/* Cancel pending */}
        {run.status === 'pending' && onDelete && (
          <button onClick={e => { e.stopPropagation(); onDelete() }}
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                           color: '#ef4444', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}>
            Cancelar
          </button>
        )}

        {/* Expand icon */}
        {run.status === 'done' && (
          expanded ? <ChevronUp size={14} color="#64748b" /> : <ChevronDown size={14} color="#64748b" />
        )}
      </div>

      {/* Error message */}
      {run.status === 'error' && run.error_msg && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, fontSize: 12, color: '#ef4444' }}>
          {run.error_msg}
        </div>
      )}

      {/* Detail section */}
      {expanded && run.status === 'done' && <RunDetail run={run} />}
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function BacktestPage() {
  const [runs, setRuns]           = useState<BacktestRun[]>([])
  const [loading, setLoading]     = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')
  const [success, setSuccess]     = useState('')

  const [periodo, setPeriodo]     = useState('1m')
  const [profile, setProfile]     = useState<'simulator' | 'live'>('simulator')
  const [capital, setCapital]     = useState<number>(20)

  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  // Carrega histórico
  const fetchRuns = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/backtest')
      const data = await res.json()
      if (data.runs) setRuns(data.runs)
    } catch { /* silencioso */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchRuns() }, [fetchRuns])

  // Polling automático enquanto há runs pendentes/em execução
  useEffect(() => {
    const active = runs.some(r => r.status === 'pending' || r.status === 'running')
    if (active) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(fetchRuns, 4000)
      }
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [runs, fetchRuns])

  const runAtivo = runs.find(r => r.status === 'pending' || r.status === 'running')

  async function handleSubmit() {
    setError(''); setSuccess('')
    setSubmitting(true)
    try {
      const res  = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodo, profile, capital }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erro ao criar backtest')
      setSuccess(`Backtest criado — o bot irá iniciar em breve (ID: ${data.run_id?.slice(0, 8)}…)`)
      fetchRuns()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel(run_id: string) {
    await fetch('/api/backtest', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id }),
    })
    fetchRuns()
  }

  const periodoInfo = PERIODOS.find(p => p.id === periodo)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 960, margin: '0 auto' }}>

      {/* CSS para animação de spin */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <BarChart2 size={22} color="#3b82f6" />
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Backtest</h1>
          </div>
          <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
            Dispara backtests pelo admin — o bot na VM executa e salva os resultados aqui.
          </p>
        </div>
        <button onClick={fetchRuns} disabled={loading}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                         background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                         borderRadius: 8, color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
          Atualizar
        </button>
      </div>

      {/* Aviso: bot precisa estar rodando */}
      <div style={{
        background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
        borderRadius: 10, padding: '12px 16px', marginBottom: 20,
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#fbbf24',
      }}>
        <Zap size={15} />
        O bot precisa estar <strong>RODANDO na VM</strong> para executar o backtest.
        O run fica com status "Aguardando bot" até o próximo ciclo M5 do executor.
      </div>

      {/* Run ativo (status banner) */}
      {runAtivo && (
        <div style={{
          background: runAtivo.status === 'running' ? 'rgba(59,130,246,0.1)' : 'rgba(251,191,36,0.08)',
          border: `1px solid ${runAtivo.status === 'running' ? 'rgba(59,130,246,0.4)' : 'rgba(251,191,36,0.3)'}`,
          borderRadius: 10, padding: '14px 18px', marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <Loader2 size={18} color={runAtivo.status === 'running' ? '#3b82f6' : '#fbbf24'}
                   style={{ animation: 'spin 1s linear infinite' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 14 }}>
              {runAtivo.status === 'running' ? 'Backtest em execução' : 'Backtest aguardando o bot'}
              {' '}— {periodLabel(runAtivo)}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {runAtivo.progress_pct}% concluído
            </div>
          </div>
          <div style={{ width: 120, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${runAtivo.progress_pct}%`, height: '100%',
              background: runAtivo.status === 'running' ? '#3b82f6' : '#fbbf24',
              borderRadius: 3, transition: 'width 0.5s ease',
            }} />
          </div>
        </div>
      )}

      {/* Formulário */}
      <div style={{
        background: '#111827', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12, padding: '20px 24px', marginBottom: 24,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase',
                      letterSpacing: '0.08em', marginBottom: 16 }}>
          Novo Backtest
        </div>

        {/* Período */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Período histórico</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PERIODOS.map(p => (
              <button key={p.id} onClick={() => setPeriodo(p.id)}
                      style={{
                        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
                        fontSize: 13, transition: 'all 0.15s',
                        background: periodo === p.id ? '#3b82f6' : 'rgba(255,255,255,0.05)',
                        border: `1px solid ${periodo === p.id ? '#3b82f6' : 'rgba(255,255,255,0.1)'}`,
                        color: periodo === p.id ? '#fff' : '#94a3b8',
                      }}>
                {p.label}
                <span style={{ fontSize: 10, opacity: 0.7, display: 'block' }}>{p.candles}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Perfil + Capital */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Config a usar</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['simulator', 'live'] as const).map(p => (
                <button key={p} onClick={() => setProfile(p)}
                        style={{
                          flex: 1, padding: '9px 14px', borderRadius: 8, cursor: 'pointer',
                          fontWeight: 600, fontSize: 13,
                          background: profile === p ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${profile === p ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)'}`,
                          color: profile === p ? '#93c5fd' : '#64748b',
                        }}>
                  {p === 'simulator' ? '🧪 Simulador' : '🤖 Bot ao Vivo'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: '1 1 140px' }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Capital inicial (USD)</div>
            <input
              type="number" min={1} step={1}
              value={capital}
              onChange={e => setCapital(Number(e.target.value))}
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0', fontSize: 14, outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Resumo + botão */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontSize: 12, color: '#64748b' }}>
            Vai buscar {periodoInfo?.candles} candles M5 do MT5 · perfil <strong style={{ color: '#94a3b8' }}>{profile}</strong> · capital ${capital}
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting || !!runAtivo}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 22px', borderRadius: 8, cursor: submitting || runAtivo ? 'not-allowed' : 'pointer',
              background: submitting || runAtivo ? 'rgba(59,130,246,0.3)' : '#3b82f6',
              border: 'none', color: '#fff', fontWeight: 700, fontSize: 14,
              opacity: submitting || runAtivo ? 0.7 : 1,
            }}>
            {submitting
              ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
              : <Play size={15} />}
            {submitting ? 'Criando…' : runAtivo ? 'Aguardando conclusão' : '▶ Executar Backtest'}
          </button>
        </div>

        {/* Feedback */}
        {error   && <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 12, color: '#ef4444' }}>{error}</div>}
        {success && <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, fontSize: 12, color: '#22c55e' }}>{success}</div>}
      </div>

      {/* Histórico */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase',
                      letterSpacing: '0.08em', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={14} /> Histórico de Runs
          {runs.length > 0 && (
            <span style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 12, padding: '1px 8px', fontSize: 11, fontWeight: 500, color: '#94a3b8' }}>
              {runs.length}
            </span>
          )}
        </div>

        {runs.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#374151', fontSize: 14 }}>
            Nenhum backtest executado ainda.<br />
            <span style={{ fontSize: 12 }}>Execute o primeiro usando o formulário acima.</span>
          </div>
        )}

        {runs.map(run => (
          <RunCard
            key={run.id}
            run={run}
            onDelete={run.status === 'pending' ? () => handleCancel(run.id) : undefined}
          />
        ))}
      </div>
    </div>
  )
}
