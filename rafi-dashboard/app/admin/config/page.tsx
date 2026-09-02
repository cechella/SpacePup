'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supa = typeof window !== 'undefined'
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  : null

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg: '#070c14', s1: '#0d1927', s2: '#0a1520', s3: '#1a2d42', bd: '#1e3448',
  cy: '#00d9ff', gr: '#00e676', re: '#ff4757', am: '#ffb300', bl: '#4b8ef5',
  tx: '#b8d4e8', t2: '#5a7d96', t3: '#2d4a60',
  cya: '#00d9ff12', gra: '#00e67612', rea: '#ff475712', ama: '#ffb30012',
}

// ── Defaults replicam exatamente o backtest vencedor ─────────────────────────
const DEFAULTS = {
  forca_limiar:           2.50,
  rafi_periodo:           14,
  sr_lookback:            50,
  swing_stop_lookback:    150,
  ma_rapida:              20,
  ma_lenta:               50,
  ma_threshold:           0.0003,
  bb_filtro_ativo:        true,
  bb_limiar_estreita:     0.0012,
  bb_periodo:             8,
  bb_desvios:             2.0,
  risco_por_trade:        0.02,
  ratio_risco_retorno:    1.5,
  max_trades_simultaneos: 1,
  risco_maximo_diario:    9.0,
}

type Config = typeof DEFAULTS

// ── Grupos de parâmetros ─────────────────────────────────────────────────────
const GRUPOS: { label: string; cor: string; campos: { key: keyof Config; label: string; desc: string; tipo: 'float' | 'int' | 'bool'; min?: number; max?: number; step?: number }[] }[] = [
  {
    label: 'Índice de Força RAFI', cor: C.cy,
    campos: [
      { key: 'forca_limiar',        label: 'RAFI Limiar',    desc: 'Mínimo para entrada (2.50 = backtest)',     tipo: 'float', min: 0.5, max: 5,   step: 0.05 },
      { key: 'rafi_periodo',        label: 'RAFI Período',   desc: 'Janela de cálculo do índice de força',      tipo: 'int',   min: 3,   max: 50          },
    ],
  },
  {
    label: 'Tendência M5', cor: C.bl,
    campos: [
      { key: 'ma_rapida',           label: 'MA Rápida',      desc: 'Período da média móvel rápida',             tipo: 'int',   min: 5,   max: 50          },
      { key: 'ma_lenta',            label: 'MA Lenta',       desc: 'Período da média móvel lenta',              tipo: 'int',   min: 10,  max: 200         },
      { key: 'ma_threshold',        label: 'MA Threshold',   desc: 'Diferença mínima MA rápida−lenta (pip)',    tipo: 'float', min: 0,   max: 0.01, step: 0.0001 },
    ],
  },
  {
    label: 'Suporte & Resistência', cor: C.am,
    campos: [
      { key: 'sr_lookback',         label: 'S/R Lookback',   desc: 'Candles para detectar máximos/mínimos',    tipo: 'int',   min: 10,  max: 200         },
      { key: 'swing_stop_lookback', label: 'Swing Stop',     desc: 'Candles para posicionar stop-loss',        tipo: 'int',   min: 20,  max: 500         },
    ],
  },
  {
    label: 'Bandas de Bollinger', cor: C.gr,
    campos: [
      { key: 'bb_filtro_ativo',     label: 'Filtro Ativo',   desc: 'Exige squeeze → abertura antes de entrar', tipo: 'bool'                              },
      { key: 'bb_limiar_estreita',  label: 'Limiar Squeeze', desc: 'Largura máxima para considerar squeeze',   tipo: 'float', min: 0,   max: 0.01, step: 0.0001 },
      { key: 'bb_periodo',          label: 'Período',        desc: 'Janela das Bandas de Bollinger',           tipo: 'int',   min: 5,   max: 50          },
      { key: 'bb_desvios',          label: 'Desvios',        desc: 'Número de desvios padrão',                 tipo: 'float', min: 1,   max: 4,    step: 0.1  },
    ],
  },
  {
    label: 'Gestão de Risco', cor: C.re,
    campos: [
      { key: 'risco_por_trade',        label: 'Risco/Trade',       desc: '% do capital arriscado por trade',       tipo: 'float', min: 0.005, max: 0.1,  step: 0.005 },
      { key: 'ratio_risco_retorno',    label: 'R:R',               desc: 'Razão risco:retorno mínima (1.5 = padrão)', tipo: 'float', min: 1, max: 5, step: 0.1 },
      { key: 'max_trades_simultaneos', label: 'Máx. Posições',     desc: 'Trades simultâneos permitidos',          tipo: 'int',   min: 1,     max: 5           },
      { key: 'risco_maximo_diario',    label: 'Perda Máx. Diária', desc: '% de perda diária para parar o bot',     tipo: 'float', min: 1,     max: 20,   step: 0.5 },
    ],
  },
]

// ── Componente de perfil ──────────────────────────────────────────────────────
function PerfilCard({
  profile, title, accent, icon, cfg, onChange, onSave, saving, saved, lastSaved,
}: {
  profile: string; title: string; accent: string; icon: string
  cfg: Config; onChange: (k: keyof Config, v: unknown) => void
  onSave: () => void; saving: boolean; saved: boolean; lastSaved: string | null
}) {
  const card: React.CSSProperties = {
    background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 8, overflow: 'hidden',
  }
  const lbl: React.CSSProperties = {
    fontSize: 8, fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.12em', color: C.t2, marginBottom: 10,
  }

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: `2px solid ${accent}30`,
        background: `linear-gradient(135deg, ${accent}10 0%, transparent 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>{icon}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: accent, letterSpacing: '0.06em' }}>{title}</div>
            <div style={{ fontSize: 9, color: C.t2, marginTop: 2 }}>
              {profile === 'live' ? 'Usado pelo bot ao vivo na XM' : 'Usado apenas no backtest'}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {lastSaved && (
            <div style={{ fontSize: 8, color: C.t3 }}>
              Salvo {new Date(lastSaved).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%',
              background: profile === 'live' ? C.gr : C.am }} />
            <span style={{ fontSize: 8, color: profile === 'live' ? C.gr : C.am, fontWeight: 700 }}>
              {profile === 'live' ? 'AO VIVO' : 'SIMULAÇÃO'}
            </span>
          </div>
        </div>
      </div>

      {/* Fields */}
      <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {GRUPOS.map(grupo => (
          <div key={grupo.label}>
            <div style={{ ...lbl, color: grupo.cor, borderBottom: `1px solid ${grupo.cor}20`, paddingBottom: 6, marginBottom: 12 }}>
              {grupo.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {grupo.campos.map(campo => (
                <div key={campo.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.tx, fontWeight: 600 }}>{campo.label}</div>
                    <div style={{ fontSize: 9, color: C.t2, marginTop: 1 }}>{campo.desc}</div>
                  </div>
                  {campo.tipo === 'bool' ? (
                    <button
                      onClick={() => onChange(campo.key, !cfg[campo.key])}
                      style={{
                        width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                        background: cfg[campo.key] ? C.gr : C.t3,
                        position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 3,
                        left: cfg[campo.key] ? 22 : 3,
                        width: 18, height: 18, borderRadius: '50%',
                        background: '#fff', transition: 'left 0.2s',
                      }} />
                    </button>
                  ) : (
                    <input
                      type="number"
                      value={cfg[campo.key] as number}
                      min={campo.min}
                      max={campo.max}
                      step={campo.step ?? 1}
                      onChange={e => {
                        const v = campo.tipo === 'int'
                          ? parseInt(e.target.value)
                          : parseFloat(e.target.value)
                        if (!isNaN(v)) onChange(campo.key, v)
                      }}
                      style={{
                        width: 90, padding: '5px 10px', textAlign: 'right',
                        background: C.s2, border: `1px solid ${C.bd}`,
                        color: accent, fontSize: 13, fontWeight: 700,
                        fontFamily: 'monospace', borderRadius: 4, outline: 'none',
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Save button */}
      <div style={{ padding: '14px 20px', borderTop: `1px solid ${C.bd}` }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            width: '100%', padding: '12px 0',
            background: saved ? `${C.gr}20` : `${accent}20`,
            border: `1px solid ${saved ? C.gr : accent}60`,
            color: saved ? C.gr : accent,
            fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
            cursor: saving ? 'not-allowed' : 'pointer', borderRadius: 6,
            transition: 'all 0.3s',
          }}
        >
          {saving ? '⏳ Salvando...' : saved ? '✓ SALVO COM SUCESSO' : `💾 SALVAR ${title.toUpperCase()}`}
        </button>
        {profile === 'live' && (
          <div style={{ fontSize: 9, color: C.t2, textAlign: 'center', marginTop: 8 }}>
            O bot lê esta configuração ao iniciar cada ciclo M5
          </div>
        )}
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function ConfigPage() {
  const [simCfg,  setSimCfg]  = useState<Config>({ ...DEFAULTS })
  const [liveCfg, setLiveCfg] = useState<Config>({ ...DEFAULTS })
  const [simSaving,  setSimSaving]  = useState(false)
  const [liveSaving, setLiveSaving] = useState(false)
  const [simSaved,   setSimSaved]   = useState(false)
  const [liveSaved,  setLiveSaved]  = useState(false)
  const [simLastSaved,  setSimLastSaved]  = useState<string | null>(null)
  const [liveLastSaved, setLiveLastSaved] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!supa) return
    ;(async () => {
      try {
        const { data } = await supa
          .from('rafi_bot_config')
          .select('*')
          .in('profile', ['simulator', 'live'])
        if (data) {
          const sim  = data.find(r => r.profile === 'simulator')
          const live = data.find(r => r.profile === 'live')
          if (sim)  { setSimCfg({ ...DEFAULTS, ...sim });  setSimLastSaved(sim.updated_at)  }
          if (live) { setLiveCfg({ ...DEFAULTS, ...live }); setLiveLastSaved(live.updated_at) }
        }
      } catch { setError('Tabela rafi_bot_config não encontrada — será criada ao salvar') }
      setLoading(false)
    })()
  }, [])

  const salvar = async (profile: 'simulator' | 'live', cfg: Config) => {
    if (!supa) return
    const setSaving = profile === 'simulator' ? setSimSaving  : setLiveSaving
    const setSaved  = profile === 'simulator' ? setSimSaved   : setLiveSaved
    const setLast   = profile === 'simulator' ? setSimLastSaved : setLiveLastSaved
    setSaving(true)
    try {
      const ts = new Date().toISOString()
      await supa.from('rafi_bot_config').upsert(
        { ...cfg, profile, updated_at: ts },
        { onConflict: 'profile' },
      )
      setLast(ts)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: unknown) {
      setError(`Erro ao salvar: ${e}`)
    }
    setSaving(false)
  }

  const mono: React.CSSProperties = { fontFamily: 'monospace' }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.tx, fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.bd}`, padding: '18px 28px',
        background: C.s1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.tx, letterSpacing: '0.02em' }}>
            ⚙ Configurações do Bot
          </div>
          <div style={{ fontSize: 10, color: C.t2, marginTop: 3 }}>
            Parâmetros salvos no Supabase · o bot ao vivo lê em cada ciclo M5
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 10, color: C.am, background: `${C.am}10`,
            border: `1px solid ${C.am}30`, borderRadius: 6, padding: '6px 12px', maxWidth: 300 }}>
            ⚠ {error}
          </div>
        )}
      </div>

      {/* Aviso sobre defaults */}
      <div style={{ margin: '16px 28px 0', padding: '10px 16px',
        background: `${C.bl}10`, border: `1px solid ${C.bl}25`, borderRadius: 6,
        display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 14 }}>ℹ</span>
        <div>
          <span style={{ fontSize: 10, color: C.bl, fontWeight: 700 }}>Backtest vencedor: </span>
          <span style={{ fontSize: 10, color: C.t2, ...mono }}>
            RAFI≥2.50 · período=14 · S/R=50c · Swing Stop=150c · R:R=1.5 · Risco=2%
          </span>
          <span style={{ fontSize: 10, color: C.t2 }}> — 59 trades · 69% WR · +$3.769</span>
        </div>
      </div>

      {/* Dois perfis lado a lado */}
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: C.t2, fontSize: 12 }}>
          Carregando configurações...
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: '20px 28px' }}>
          <PerfilCard
            profile="simulator"
            title="Simulador"
            accent={C.am}
            icon="🔬"
            cfg={simCfg}
            onChange={(k, v) => setSimCfg(prev => ({ ...prev, [k]: v }))}
            onSave={() => salvar('simulator', simCfg)}
            saving={simSaving}
            saved={simSaved}
            lastSaved={simLastSaved}
          />
          <PerfilCard
            profile="live"
            title="Bot ao Vivo"
            accent={C.gr}
            icon="🤖"
            cfg={liveCfg}
            onChange={(k, v) => setLiveCfg(prev => ({ ...prev, [k]: v }))}
            onSave={() => salvar('live', liveCfg)}
            saving={liveSaving}
            saved={liveSaved}
            lastSaved={liveLastSaved}
          />
        </div>
      )}
    </div>
  )
}
