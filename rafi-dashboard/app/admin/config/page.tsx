'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@supabase/supabase-js'

const supa = typeof window !== 'undefined'
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  : null

const C = {
  bg: '#070c14', s1: '#0d1927', s2: '#0a1520', s3: '#1a2d42', bd: '#1e3448',
  cy: '#00d9ff', gr: '#00e676', re: '#ff4757', am: '#ffb300', bl: '#4b8ef5',
  tx: '#b8d4e8', t2: '#5a7d96', t3: '#2d4a60',
}

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
  ratio_risco_retorno:    1.5,
  max_trades_simultaneos: 1,
}
type Config = typeof DEFAULTS

// Tabela de escalonamento de lotes (hardcoded no risk_manager.py — não é configurável)
const FAIXAS_LOTE = [
  { min:      0, max:    40, lote:   0.10, pip: '$1/pip'    },
  { min:     40, max:    80, lote:   0.20, pip: '$2/pip'    },
  { min:     80, max:   150, lote:   0.40, pip: '$4/pip'    },
  { min:    150, max:   200, lote:   0.70, pip: '$7/pip'    },
  { min:    200, max:   400, lote:   1.00, pip: '$10/pip'   },
  { min:    400, max:   800, lote:   2.00, pip: '$20/pip'   },
  { min:    800, max:  1500, lote:   4.00, pip: '$40/pip'   },
  { min:   1500, max:  3000, lote:   8.00, pip: '$80/pip'   },
  { min:   3000, max:  6000, lote:  15.00, pip: '$150/pip'  },
  { min:   6000, max: 10000, lote:  30.00, pip: '$300/pip'  },
  { min:  10000, max: 20000, lote:  50.00, pip: '$500/pip'  },
  { min:  20000, max: Infinity, lote: 100.00, pip: '$1k/pip' },
]

const GRUPOS: {
  label: string; cor: string
  campos: { key: keyof Config; label: string; desc: string; tipo: 'float'|'int'|'bool'; min?: number; max?: number; step?: number }[]
}[] = [
  { label: 'Índice de Força RAFI', cor: C.cy, campos: [
    { key: 'forca_limiar',       label: 'RAFI Limiar',    desc: 'Mínimo para entrada (2.50 = backtest)',      tipo: 'float', min: 0.5,   max: 5,    step: 0.05   },
    { key: 'rafi_periodo',       label: 'RAFI Período',   desc: 'Janela de cálculo do índice de força',       tipo: 'int',   min: 3,     max: 50              },
  ]},
  { label: 'Tendência M5', cor: C.bl, campos: [
    { key: 'ma_rapida',          label: 'MA Rápida',      desc: 'Período da média móvel rápida',              tipo: 'int',   min: 5,     max: 50              },
    { key: 'ma_lenta',           label: 'MA Lenta',       desc: 'Período da média móvel lenta',               tipo: 'int',   min: 10,    max: 200             },
    { key: 'ma_threshold',       label: 'MA Threshold',   desc: 'Diferença mínima MA rápida−lenta (pip)',     tipo: 'float', min: 0,     max: 0.01, step: 0.0001 },
  ]},
  { label: 'Suporte & Resistência', cor: C.am, campos: [
    { key: 'sr_lookback',        label: 'S/R Lookback',   desc: 'Candles para detectar máximos/mínimos',     tipo: 'int',   min: 10,    max: 200             },
    { key: 'swing_stop_lookback',label: 'Swing Stop',     desc: 'Candles para posicionar stop-loss',         tipo: 'int',   min: 20,    max: 500             },
  ]},
  { label: 'Bandas de Bollinger', cor: C.gr, campos: [
    { key: 'bb_filtro_ativo',    label: 'Filtro Ativo',   desc: 'Exige squeeze → abertura antes de entrar',  tipo: 'bool'                                    },
    { key: 'bb_limiar_estreita', label: 'Limiar Squeeze', desc: 'Largura máxima para considerar squeeze',    tipo: 'float', min: 0,     max: 0.01, step: 0.0001 },
    { key: 'bb_periodo',         label: 'Período',        desc: 'Janela das Bandas de Bollinger',            tipo: 'int',   min: 5,     max: 50              },
    { key: 'bb_desvios',         label: 'Desvios',        desc: 'Número de desvios padrão',                  tipo: 'float', min: 1,     max: 4,    step: 0.1  },
  ]},
  { label: 'Execução', cor: C.re, campos: [
    { key: 'ratio_risco_retorno',    label: 'R:R',           desc: 'Razão risco:retorno (1.5 = backtest)',  tipo: 'float', min: 1, max: 5, step: 0.1 },
    { key: 'max_trades_simultaneos', label: 'Máx. Posições', desc: 'Trades simultâneos permitidos',        tipo: 'int',   min: 1, max: 5            },
  ]},
]

// Chaves numéricas para comparação
const CHAVES_NUMERICAS = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k as keyof Config] === 'number') as (keyof Config)[]
const CHAVES_BOOL      = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k as keyof Config] === 'boolean') as (keyof Config)[]

function camposDivergindo(sim: Config, live: Config): Set<keyof Config> {
  const diverge = new Set<keyof Config>()
  CHAVES_NUMERICAS.forEach(k => { if (Math.abs((sim[k] as number) - (live[k] as number)) > 1e-9) diverge.add(k) })
  CHAVES_BOOL.forEach(k => { if (sim[k] !== live[k]) diverge.add(k) })
  return diverge
}

export default function ConfigPage() {
  const [simCfg,  setSimCfg]  = useState<Config>({ ...DEFAULTS })
  const [liveCfg, setLiveCfg] = useState<Config>({ ...DEFAULTS })
  const [simSaving,  setSimSaving]  = useState(false)
  const [liveSaving, setLiveSaving] = useState(false)
  const [simSaved,   setSimSaved]   = useState(false)
  const [liveSaved,  setLiveSaved]  = useState(false)
  const [simLastSaved,  setSimLastSaved]  = useState<string | null>(null)
  const [liveLastSaved, setLiveLastSaved] = useState<string | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [syncing,  setSyncing]  = useState(false)
  const [syncDone, setSyncDone] = useState(false)

  useEffect(() => {
    if (!supa) return
    ;(async () => {
      try {
        const { data } = await supa.from('rafi_bot_config').select('*').in('profile', ['simulator', 'live'])
        if (data) {
          const sim  = data.find(r => r.profile === 'simulator')
          const live = data.find(r => r.profile === 'live')
          if (sim)  { setSimCfg({ ...DEFAULTS, ...sim });  setSimLastSaved(sim.updated_at) }
          if (live) { setLiveCfg({ ...DEFAULTS, ...live }); setLiveLastSaved(live.updated_at) }
        }
      } catch { setError('Tabela rafi_bot_config não encontrada — execute o SQL no Supabase') }
      setLoading(false)
    })()
  }, [])

  const divergindo = useMemo(() => camposDivergindo(simCfg, liveCfg), [simCfg, liveCfg])
  const emSincronia = divergindo.size === 0

  const salvar = async (profile: 'simulator' | 'live', cfg: Config) => {
    if (!supa) return
    const setSaving = profile === 'simulator' ? setSimSaving : setLiveSaving
    const setSaved  = profile === 'simulator' ? setSimSaved  : setLiveSaved
    const setLast   = profile === 'simulator' ? setSimLastSaved : setLiveLastSaved
    setSaving(true)
    try {
      const ts = new Date().toISOString()
      await supa.from('rafi_bot_config').upsert({ ...cfg, profile, updated_at: ts }, { onConflict: 'profile' })
      setLast(ts); setSaved(true); setTimeout(() => setSaved(false), 3000)
    } catch (e) { setError(`Erro ao salvar: ${e}`) }
    setSaving(false)
  }

  const sincronizarLive = async () => {
    setSyncing(true)
    setLiveCfg({ ...simCfg })
    await salvar('live', simCfg)
    setSyncing(false); setSyncDone(true)
    setTimeout(() => setSyncDone(false), 3000)
  }

  const card: React.CSSProperties = { background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 8, overflow: 'hidden' }

  if (loading) return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: C.t2, fontFamily: 'system-ui' }}>
      Carregando configurações...
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.tx, fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.bd}`, padding: '16px 28px',
        background: C.s1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.tx }}>⚙ Configurações do Bot</div>
          <div style={{ fontSize: 10, color: C.t2, marginTop: 2 }}>
            Salvo no Supabase · bot ao vivo lê o perfil <span style={{ color: C.gr, fontFamily: 'monospace' }}>'live'</span> a cada ciclo M5
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 10, color: C.am, background: `${C.am}10`,
            border: `1px solid ${C.am}30`, borderRadius: 6, padding: '6px 12px' }}>⚠ {error}</div>
        )}
      </div>

      {/* Barra de sincronia */}
      <div style={{ margin: '14px 28px 0', padding: '12px 18px', borderRadius: 8,
        background: emSincronia ? `${C.gr}10` : `${C.re}10`,
        border: `1px solid ${emSincronia ? C.gr : C.re}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>{emSincronia ? '✅' : '⚠️'}</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: emSincronia ? C.gr : C.re }}>
              {emSincronia ? 'Em sincronia — Simulador = Bot ao Vivo' : `${divergindo.size} parâmetro${divergindo.size > 1 ? 's' : ''} diferente${divergindo.size > 1 ? 's' : ''} entre os perfis`}
            </div>
            <div style={{ fontSize: 9, color: C.t2, marginTop: 2 }}>
              {emSincronia
                ? 'O bot ao vivo usa exatamente os mesmos parâmetros da simulação'
                : 'Campos destacados em vermelho divergem — use o botão para igualar'}
            </div>
          </div>
        </div>
        {!emSincronia && (
          <button onClick={sincronizarLive} disabled={syncing}
            style={{ padding: '9px 18px', border: `1px solid ${C.gr}50`,
              background: syncDone ? `${C.gr}25` : `${C.gr}15`, color: C.gr,
              fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
              cursor: syncing ? 'not-allowed' : 'pointer', borderRadius: 6,
              whiteSpace: 'nowrap', transition: 'all 0.2s' }}>
            {syncing ? '⏳ Sincronizando...' : syncDone ? '✓ Sincronizado!' : '⇒ Copiar Simulador → Ao Vivo'}
          </button>
        )}
      </div>

      {/* Referência backtest */}
      <div style={{ margin: '10px 28px 0', padding: '8px 16px', borderRadius: 6,
        background: `${C.bl}08`, border: `1px solid ${C.bl}20`,
        display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11 }}>ℹ</span>
        <span style={{ fontSize: 9, color: C.t2, fontFamily: 'monospace' }}>
          Backtest vencedor: RAFI≥2.50 · período=14 · S/R=50c · SwingStop=150c · R:R=1.5 · Risco=2%
        </span>
        <span style={{ fontSize: 9, color: C.gr, fontWeight: 700, marginLeft: 4 }}>→ 59 trades · 69% WR · +$3.769</span>
      </div>

      {/* Grid dos dois perfis */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: '16px 28px' }}>
        {([
          { profile: 'simulator' as const, title: 'Simulador',   accent: C.am, icon: '🔬', cfg: simCfg,  setCfg: setSimCfg,  saving: simSaving,  saved: simSaved,  lastSaved: simLastSaved  },
          { profile: 'live'      as const, title: 'Bot ao Vivo', accent: C.gr, icon: '🤖', cfg: liveCfg, setCfg: setLiveCfg, saving: liveSaving, saved: liveSaved, lastSaved: liveLastSaved },
        ]).map(({ profile, title, accent, icon, cfg, setCfg, saving, saved, lastSaved }) => (
          <div key={profile} style={{ ...card, display: 'flex', flexDirection: 'column' }}>

            {/* Card header */}
            <div style={{ padding: '14px 20px', borderBottom: `2px solid ${accent}30`,
              background: `linear-gradient(135deg, ${accent}10 0%, transparent 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: accent }}>{title}</div>
                  <div style={{ fontSize: 9, color: C.t2, marginTop: 1 }}>
                    {profile === 'live' ? 'Bot ao vivo na XM — lido a cada ciclo M5' : 'Usado apenas no backtest local'}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {lastSaved && <div style={{ fontSize: 8, color: C.t3 }}>
                  Salvo {new Date(lastSaved).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, justifyContent: 'flex-end' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent }} />
                  <span style={{ fontSize: 8, color: accent, fontWeight: 700 }}>
                    {profile === 'live' ? 'AO VIVO' : 'SIMULAÇÃO'}
                  </span>
                </div>
              </div>
            </div>

            {/* Campos agrupados */}
            <div style={{ padding: '14px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
              {GRUPOS.map(grupo => (
                <div key={grupo.label}>
                  <div style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.12em', color: grupo.cor,
                    borderBottom: `1px solid ${grupo.cor}20`, paddingBottom: 5, marginBottom: 10 }}>
                    {grupo.label}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {grupo.campos.map(campo => {
                      const difere = divergindo.has(campo.key)
                      return (
                        <div key={campo.key} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                          padding: '5px 8px', borderRadius: 5,
                          background: difere ? `${C.re}08` : 'transparent',
                          border: `1px solid ${difere ? C.re + '30' : 'transparent'}`,
                          transition: 'all 0.3s',
                        }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 10, color: C.tx, fontWeight: 600 }}>{campo.label}</span>
                              {difere && <span style={{ fontSize: 7, color: C.re, fontWeight: 800,
                                background: `${C.re}15`, padding: '1px 5px', borderRadius: 3 }}>DIFERENTE</span>}
                            </div>
                            <div style={{ fontSize: 8, color: C.t2, marginTop: 1 }}>{campo.desc}</div>
                          </div>
                          {campo.tipo === 'bool' ? (
                            <button onClick={() => setCfg(prev => ({ ...prev, [campo.key]: !prev[campo.key] }))}
                              style={{ width: 42, height: 22, borderRadius: 11, border: 'none',
                                cursor: 'pointer', background: cfg[campo.key] ? C.gr : C.t3,
                                position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                              <span style={{ position: 'absolute', top: 2,
                                left: cfg[campo.key] ? 21 : 2,
                                width: 18, height: 18, borderRadius: '50%',
                                background: '#fff', transition: 'left 0.2s' }} />
                            </button>
                          ) : (
                            <input type="number"
                              value={cfg[campo.key] as number}
                              min={campo.min} max={campo.max} step={campo.step ?? 1}
                              onChange={e => {
                                const v = campo.tipo === 'int' ? parseInt(e.target.value) : parseFloat(e.target.value)
                                if (!isNaN(v)) setCfg(prev => ({ ...prev, [campo.key]: v }))
                              }}
                              style={{ width: 88, padding: '4px 8px', textAlign: 'right',
                                background: difere ? `${C.re}12` : C.s2,
                                border: `1px solid ${difere ? C.re + '50' : C.bd}`,
                                color: difere ? C.re : accent,
                                fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                                borderRadius: 4, outline: 'none', flexShrink: 0, transition: 'all 0.3s' }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Tabela de crescimento de lote */}
            <div style={{ margin: '0 20px 14px', borderRadius: 6, overflow: 'hidden', border: `1px solid ${C.bd}` }}>
              <div style={{ padding: '7px 12px', background: `${C.am}15`, borderBottom: `1px solid ${C.am}20`,
                fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.am }}>
                Crescimento de Lote — Capital → Lote Automático
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, fontFamily: 'monospace' }}>
                  <thead>
                    <tr style={{ background: C.s2 }}>
                      {['Capital', 'Lote', 'Pip value'].map(h => (
                        <th key={h} style={{ padding: '4px 10px', color: C.t2, fontWeight: 600,
                          textAlign: 'left', borderBottom: `1px solid ${C.bd}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {FAIXAS_LOTE.map((f, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : `${C.s2}80` }}>
                        <td style={{ padding: '3px 10px', color: C.t2 }}>
                          ${f.min.toLocaleString()}{f.max === Infinity ? '+' : `–$${f.max.toLocaleString()}`}
                        </td>
                        <td style={{ padding: '3px 10px', color: C.am, fontWeight: 700 }}>{f.lote.toFixed(2)}L</td>
                        <td style={{ padding: '3px 10px', color: C.t2 }}>{f.pip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '5px 12px', fontSize: 7, color: C.t3, borderTop: `1px solid ${C.bd}` }}>
                Lote sobe automaticamente com o capital — hardcoded em risk_manager.py
              </div>
            </div>

            {/* Botão salvar */}
            <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.bd}` }}>
              <button onClick={() => salvar(profile, cfg)} disabled={saving}
                style={{ width: '100%', padding: '11px 0',
                  background: saved ? `${C.gr}20` : `${accent}18`,
                  border: `1px solid ${saved ? C.gr : accent}50`,
                  color: saved ? C.gr : accent,
                  fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                  cursor: saving ? 'not-allowed' : 'pointer', borderRadius: 5, transition: 'all 0.3s' }}>
                {saving ? '⏳ Salvando...' : saved ? '✓ SALVO' : `💾 SALVAR ${title.toUpperCase()}`}
              </button>
              {profile === 'live' && (
                <div style={{ fontSize: 8, color: C.t2, textAlign: 'center', marginTop: 6 }}>
                  Reinicie o bot no VPS para aplicar imediatamente
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
