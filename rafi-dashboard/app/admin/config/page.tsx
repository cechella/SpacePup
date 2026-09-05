'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
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
  // MODO PADRÃO: autoscan — otimizado em 26 anos, config hash 445d1535
  // WR 74.4% | PF 2.164 | Sharpe 3.42 — NUNCA alterar sem validação em backtest
  estrategia_modo:           'autoscan', // 'rafi' | 'autoscan'
  forca_limiar:              2.50,
  rafi_periodo:              14,
  sr_lookback:               10,        // OTIMIZADO 10 candles (era 50) — 26 anos OOS
  swing_stop_lookback:       150,
  ma_rapida:                 20,
  ma_lenta:                  50,
  ma_threshold:              0.0003,
  bb_filtro_ativo:           true,
  bb_limiar_estreita:        0.0016,    // OTIMIZADO (era 0.0012)
  bb_periodo:                6,         // OTIMIZADO: BB(6) — 26 anos, 2.916 combinações (era 10)
  bb_desvios:                2.0,
  ratio_risco_retorno:       1.3,       // OTIMIZADO (era 1.5) — R:R=1.3 maximiza WR
  max_trades_simultaneos:    1,
  // Parâmetros exclusivos do modo Autoscan (réplica do browser)
  autoscan_min_breakout:     0.00005,   // OTIMIZADO 5 pips — filtra rompimentos fracos (CHAVE do WR 74%)
  autoscan_min_gap_candles:  5,         // OTIMIZADO: 5 candles = 25 min (era 8 = 40 min) — 26 anos OOS
  autoscan_stop_offset:      0.00010,   // OTIMIZADO 1 pip buffer (era 1.5 pip)
  bb_squeeze_expansao_min:   1.05,      // BB deve expandir ≥ 5% vs candle anterior
}
type Config = typeof DEFAULTS

const FAIXAS_LOTE = [
  { min:      0, max:    40, lote:   0.10, pip: '$1/pip'   },
  { min:     40, max:    80, lote:   0.20, pip: '$2/pip'   },
  { min:     80, max:   150, lote:   0.40, pip: '$4/pip'   },
  { min:    150, max:   200, lote:   0.70, pip: '$7/pip'   },
  { min:    200, max:   400, lote:   1.00, pip: '$10/pip'  },
  { min:    400, max:   800, lote:   2.00, pip: '$20/pip'  },
  { min:    800, max:  1500, lote:   4.00, pip: '$40/pip'  },
  { min:   1500, max:  3000, lote:   8.00, pip: '$80/pip'  },
  { min:   3000, max:  6000, lote:  15.00, pip: '$150/pip' },
  { min:   6000, max: 10000, lote:  30.00, pip: '$300/pip' },
  { min:  10000, max: 20000, lote:  50.00, pip: '$500/pip' },
  { min:  20000, max: Infinity, lote: 100.00, pip: '$1k/pip' },
]

const GRUPOS: {
  label: string; cor: string
  // Campos que vêm desativados por padrão conforme o modo selecionado
  camposOffPorModo?: { autoscan?: (keyof Config)[]; rafi?: (keyof Config)[] }
  campos: { key: keyof Config; label: string; desc: string; tipo: 'float'|'int'|'bool'; min?: number; max?: number; step?: number }[]
}[] = [
  { label: 'Índice de Força RAFI', cor: C.cy,
    camposOffPorModo: { autoscan: ['forca_limiar', 'rafi_periodo'] },
    campos: [
    { key: 'forca_limiar',       label: 'RAFI Limiar',    desc: 'Mínimo para entrada (2.50 = backtest)',    tipo: 'float', min: 0.5,  max: 5,    step: 0.05   },
    { key: 'rafi_periodo',       label: 'RAFI Período',   desc: 'Janela de cálculo do índice de força',     tipo: 'int',   min: 3,    max: 50              },
  ]},
  { label: 'Tendência M5', cor: C.bl,
    camposOffPorModo: { autoscan: ['ma_rapida', 'ma_lenta', 'ma_threshold'] },
    campos: [
    { key: 'ma_rapida',          label: 'MA Rápida',      desc: 'Período da média móvel rápida',            tipo: 'int',   min: 5,    max: 50              },
    { key: 'ma_lenta',           label: 'MA Lenta',       desc: 'Período da média móvel lenta',             tipo: 'int',   min: 10,   max: 200             },
    { key: 'ma_threshold',       label: 'MA Threshold',   desc: 'Diferença mínima MA rápida−lenta (pip)',   tipo: 'float', min: 0,    max: 0.01, step: 0.0001 },
  ]},
  { label: 'Suporte & Resistência', cor: C.am, campos: [
    { key: 'sr_lookback',        label: 'S/R Lookback',   desc: 'OTIMIZADO 10 candles — 26 anos 1.9M candles OOS WR=68.1% (era 15)', tipo: 'int', min: 5, max: 200 },
    { key: 'swing_stop_lookback',label: 'Swing Stop',     desc: 'Candles para posicionar stop-loss (apenas modo rafi)',     tipo: 'int', min: 20, max: 500 },
  ]},
  { label: 'Bandas de Bollinger', cor: C.gr, campos: [
    { key: 'bb_filtro_ativo',    label: 'Filtro Ativo',   desc: 'Exige squeeze → abertura antes de entrar',tipo: 'bool'                                   },
    { key: 'bb_limiar_estreita', label: 'Limiar Squeeze', desc: 'OTIMIZADO 0.0016 — squeeze mais restrito filtra lateralidade (era 0.0012)', tipo: 'float', min: 0, max: 0.01, step: 0.0001 },
    { key: 'bb_periodo',         label: 'Período',        desc: 'OTIMIZADO BB(6) — 26 anos 1.9M candles OOS WR=68.1% (era 10)',          tipo: 'int',   min: 3, max: 50              },
    { key: 'bb_desvios',         label: 'Desvios',        desc: 'Número de desvios padrão',                 tipo: 'float', min: 1,    max: 4,    step: 0.1  },
  ]},
  { label: 'Autoscan — Rompimento', cor: C.am,
    camposOffPorModo: { rafi: ['autoscan_min_breakout', 'autoscan_min_gap_candles', 'autoscan_stop_offset', 'bb_squeeze_expansao_min'] },
    campos: [
    { key: 'autoscan_min_breakout',    label: 'Min. Rompimento',    desc: 'OTIMIZADO 5 pips (0.00005) — filtra rompimentos fracos; CHAVE do WR 69%', tipo: 'float', min: 0, max: 0.001, step: 0.00001 },
    { key: 'autoscan_min_gap_candles', label: 'Gap Mín. (candles)', desc: 'OTIMIZADO 5 candles = 25 min (era 8=40 min) — 26 anos OOS',                  tipo: 'int',   min: 1, max: 50              },
    { key: 'autoscan_stop_offset',     label: 'Buffer Stop (pip)',  desc: 'OTIMIZADO 1 pip (0.00010) — stop mais curto reduz risco por trade',            tipo: 'float', min: 0, max: 0.001, step: 0.00005 },
    { key: 'bb_squeeze_expansao_min',  label: 'Expansão BB mín.',   desc: 'BB deve crescer este % vs candle anterior (1.05=5%)',   tipo: 'float', min: 1, max: 2,    step: 0.01   },
  ]},
  { label: 'Execução', cor: C.re, campos: [
    { key: 'ratio_risco_retorno',    label: 'R:R',           desc: 'OTIMIZADO 1.3 — mais wins, WR 69.2% OOS (era 1.5)', tipo: 'float', min: 1, max: 5, step: 0.1 },
    { key: 'max_trades_simultaneos', label: 'Máx. Posições', desc: 'Trades simultâneos permitidos',       tipo: 'int',   min: 1, max: 5            },
  ]},
]

// Campos desativados por padrão para cada modo
function camposOffPadrao(modo: string): Set<keyof Config> {
  const off = new Set<keyof Config>()
  GRUPOS.forEach(g => {
    const lista = g.camposOffPorModo?.[modo as 'autoscan' | 'rafi']
    lista?.forEach(k => off.add(k))
  })
  return off
}

const CHAVES_NUMERICAS = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k as keyof Config] === 'number') as (keyof Config)[]
const CHAVES_BOOL      = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k as keyof Config] === 'boolean') as (keyof Config)[]
const CHAVES_STR       = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k as keyof Config] === 'string') as (keyof Config)[]

function camposDivergindo(sim: Config, live: Config): Set<keyof Config> {
  const diverge = new Set<keyof Config>()
  CHAVES_NUMERICAS.forEach(k => { if (Math.abs((sim[k] as number) - (live[k] as number)) > 1e-9) diverge.add(k) })
  CHAVES_BOOL.forEach(k => { if (sim[k] !== live[k]) diverge.add(k) })
  CHAVES_STR.forEach(k => { if (sim[k] !== live[k]) diverge.add(k) })
  return diverge
}

// Modal de confirmação para salvar o bot ao vivo
function ModalConfirmacao({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [input, setInput] = useState('')
  const ok = input.trim().toUpperCase() === 'CONFIRMAR'
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(7,12,20,0.88)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: C.s1, border: `1px solid ${C.re}50`, borderRadius: 10,
        padding: 28, maxWidth: 380, width: '90%', boxShadow: `0 0 40px ${C.re}20` }}>
        <div style={{ fontSize: 22, textAlign: 'center', marginBottom: 12 }}>⚠️</div>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.re, textAlign: 'center', marginBottom: 8 }}>
          Salvar Bot ao Vivo?
        </div>
        <div style={{ fontSize: 10, color: C.t2, textAlign: 'center', marginBottom: 20, lineHeight: 1.6 }}>
          Esta ação altera os parâmetros que o bot usa em dinheiro real na XM.<br />
          Digite <span style={{ color: C.am, fontFamily: 'monospace', fontWeight: 700 }}>CONFIRMAR</span> para continuar.
        </div>
        <input
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && ok) onConfirm() }}
          placeholder="Digite CONFIRMAR"
          style={{ width: '100%', padding: '8px 12px', background: C.s2, border: `1px solid ${ok ? C.gr : C.bd}`,
            color: ok ? C.gr : C.tx, fontSize: 12, fontFamily: 'monospace', fontWeight: 700,
            borderRadius: 5, outline: 'none', boxSizing: 'border-box', textAlign: 'center',
            marginBottom: 16, transition: 'border-color 0.2s' }}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel}
            style={{ flex: 1, padding: '9px 0', background: 'transparent', border: `1px solid ${C.bd}`,
              color: C.t2, fontSize: 10, fontWeight: 700, cursor: 'pointer', borderRadius: 5 }}>
            Cancelar
          </button>
          <button onClick={onConfirm} disabled={!ok}
            style={{ flex: 1, padding: '9px 0',
              background: ok ? `${C.gr}20` : `${C.t3}20`,
              border: `1px solid ${ok ? C.gr : C.t3}50`,
              color: ok ? C.gr : C.t3, fontSize: 10, fontWeight: 800,
              cursor: ok ? 'pointer' : 'not-allowed', borderRadius: 5, transition: 'all 0.2s' }}>
            ✓ Confirmar
          </button>
        </div>
      </div>
    </div>
  )
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

  // Status do bot ao vivo — para mostrar config_hash e confirmar que a config chegou
  const [botStatus, setBotStatus] = useState<{ config_hash?: string; status?: string; balance?: number; updated_at?: string } | null>(null)
  // Hash do config live calculado server-side (mesmo algoritmo que o bot) — substitui o hardcoded
  const [liveHashSupabase, setLiveHashSupabase] = useState<string | null>(null)

  // Cadeados — ambos bloqueados por padrão
  const [simLocked,  setSimLocked]  = useState(true)
  const [liveLocked, setLiveLocked] = useState(true)

  // Campos desativados por perfil (toggle por parâmetro individual)
  // Começa com os defaults de cada modo e o usuário pode mudar manualmente
  const [simCamposOff,  setSimCamposOff]  = useState<Set<keyof Config>>(() => camposOffPadrao(DEFAULTS.estrategia_modo))
  const [liveCamposOff, setLiveCamposOff] = useState<Set<keyof Config>>(() => camposOffPadrao(DEFAULTS.estrategia_modo))

  // Quando o modo muda, reaplica os defaults (mantendo overrides manuais futuros)
  useEffect(() => { setSimCamposOff(camposOffPadrao(simCfg.estrategia_modo))  }, [simCfg.estrategia_modo])
  useEffect(() => { setLiveCamposOff(camposOffPadrao(liveCfg.estrategia_modo)) }, [liveCfg.estrategia_modo])

  // Modal de confirmação para salvar ao vivo
  const [showModal, setShowModal] = useState(false)

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
      // Busca status do bot para exibir config_hash e confirmar que a config chegou
      try {
        const { data: st } = await supa.from('rafi_bot_status').select('config_hash,status,balance,updated_at').order('updated_at', { ascending: false }).limit(1)
        if (st?.[0]) setBotStatus(st[0])
      } catch { /* silencioso — bot pode estar offline */ }
      // Busca hash do config live calculado server-side (mesmo algoritmo que o bot)
      try {
        const res = await fetch('/api/config')
        const apiData = await res.json()
        if (apiData.live_hash) setLiveHashSupabase(apiData.live_hash)
      } catch { /* silencioso */ }
      setLoading(false)
    })()
  }, [])

  const divergindo  = useMemo(() => camposDivergindo(simCfg, liveCfg), [simCfg, liveCfg])
  const emSincronia = divergindo.size === 0

  const salvarDb = async (profile: 'simulator' | 'live', cfg: Config) => {
    const setSaving = profile === 'simulator' ? setSimSaving : setLiveSaving
    const setSaved  = profile === 'simulator' ? setSimSaved  : setLiveSaved
    const setLast   = profile === 'simulator' ? setSimLastSaved : setLiveLastSaved
    const setLocked = profile === 'simulator' ? setSimLocked : setLiveLocked
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, cfg }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setLast(data.updated_at); setSaved(true); setLocked(true)  // re-bloqueia após salvar
      setTimeout(() => setSaved(false), 3000)
    } catch (e) { setError(`Erro ao salvar: ${e}`) }
    setSaving(false)
  }

  const tentarSalvar = (profile: 'simulator' | 'live', cfg: Config) => {
    if (profile === 'live') {
      setShowModal(true)  // exige confirmação para bot ao vivo
    } else {
      salvarDb('simulator', cfg)
    }
  }

  const confirmarSalvarLive = () => {
    setShowModal(false)
    salvarDb('live', liveCfg)
  }

  const sincronizarLive = async () => {
    setSyncing(true)
    setLiveCfg({ ...simCfg })
    await salvarDb('live', simCfg)
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

      {showModal && (
        <ModalConfirmacao
          onConfirm={confirmarSalvarLive}
          onCancel={() => setShowModal(false)}
        />
      )}

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.bd}`, padding: '16px 28px',
        background: C.s1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.tx }}>⚙ Configurações do Bot</div>
          <div style={{ fontSize: 10, color: C.t2, marginTop: 2 }}>
            Salvo no Supabase · bot ao vivo lê o perfil{' '}
            <span style={{ color: C.gr, fontFamily: 'monospace' }}>'live'</span> a cada inicialização
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
              {emSincronia
                ? 'Em sincronia — Simulador = Bot ao Vivo'
                : `${divergindo.size} parâmetro${divergindo.size > 1 ? 's' : ''} diferente${divergindo.size > 1 ? 's' : ''} entre os perfis`}
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
          Otimizador IA · Autoscan · S/R=15 · BB(10) · R:R=1.3 · breakout=5pip · squeeze=0.0016 · stop=1pip
        </span>
        <span style={{ fontSize: 9, color: C.gr, fontWeight: 700, marginLeft: 4 }}>→ 4.430 trades · 69.5% WR · PF 2.59 · 70/71 semanas lucrativas</span>
      </div>

      {/* ── Snapshot: O que o bot vai ler (leitura do Supabase live + status) ── */}
      {(() => {
        const hashSalvo = liveHashSupabase
        const hashAtual = botStatus?.config_hash?.replace('cfg:', '') ?? null
        const hashOk    = hashSalvo !== null && hashAtual === hashSalvo
        const secsOff   = botStatus?.updated_at
          ? Math.floor((Date.now() - new Date(botStatus.updated_at).getTime()) / 1000)
          : null
        const online = secsOff !== null && secsOff < 420

        // Parâmetros do perfil live que o bot vai ler — ordem de prioridade do código
        const snap = [
          { k: 'estrategia_modo',          v: String(liveCfg.estrategia_modo),       obrigatorio: true },
          { k: 'bb_periodo',                v: String(liveCfg.bb_periodo),             obrigatorio: true },
          { k: 'bb_limiar_estreita',        v: String(liveCfg.bb_limiar_estreita),     obrigatorio: true },
          { k: 'bb_squeeze_expansao_min',   v: String(liveCfg.bb_squeeze_expansao_min),obrigatorio: true },
          { k: 'bb_desvios',                v: String(liveCfg.bb_desvios),             obrigatorio: false },
          { k: 'bb_filtro_ativo',           v: String(liveCfg.bb_filtro_ativo),        obrigatorio: false },
          { k: 'sr_lookback',               v: String(liveCfg.sr_lookback),            obrigatorio: true },
          { k: 'autoscan_min_breakout',     v: String(liveCfg.autoscan_min_breakout),  obrigatorio: liveCfg.estrategia_modo === 'autoscan' },
          { k: 'autoscan_min_gap_candles',  v: String(liveCfg.autoscan_min_gap_candles), obrigatorio: liveCfg.estrategia_modo === 'autoscan' },
          { k: 'autoscan_stop_offset',      v: String(liveCfg.autoscan_stop_offset),   obrigatorio: liveCfg.estrategia_modo === 'autoscan' },
          { k: 'ratio_risco_retorno',       v: String(liveCfg.ratio_risco_retorno),    obrigatorio: true },
          { k: 'max_trades_simultaneos',    v: String(liveCfg.max_trades_simultaneos), obrigatorio: true },
          ...(liveCfg.estrategia_modo === 'rafi' ? [
            { k: 'forca_limiar',       v: String(liveCfg.forca_limiar),      obrigatorio: true },
            { k: 'ma_rapida',          v: String(liveCfg.ma_rapida),         obrigatorio: false },
            { k: 'ma_lenta',           v: String(liveCfg.ma_lenta),          obrigatorio: false },
            { k: 'swing_stop_lookback',v: String(liveCfg.swing_stop_lookback),obrigatorio: false },
          ] : []),
        ]

        // Comprimento do parâmetro mais longo para alinhamento monospaced
        const maxLen = Math.max(...snap.map(s => s.k.length))
        const pad = (s: string) => s.padEnd(maxLen, ' ')

        return (
          <div style={{ margin: '8px 28px 0', padding: '16px 20px', borderRadius: 8,
            background: C.s1, border: `1px solid ${hashOk ? C.gr + '30' : C.am + '30'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.tx }}>
                  Config Snapshot — O que o bot vai ler
                </div>
                <div style={{ fontSize: 9, color: C.t2, marginTop: 2 }}>
                  Valores do perfil <span style={{ color: C.gr, fontFamily: 'monospace' }}>live</span> no Supabase · prioridade sobre config.yaml · obrigatório atualizar bot ao mudar
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Hash do Supabase live */}
                <div style={{ padding: '5px 12px', borderRadius: 5, fontFamily: 'monospace',
                  fontSize: 10, fontWeight: 700, border: `1px solid ${C.bd}`,
                  background: C.s2, color: C.t2 }}>
                  Salvo: <span style={{ color: C.am }}>cfg:{hashSalvo ?? '…'}</span>
                </div>
                {/* Hash do bot ao vivo */}
                <div style={{ padding: '5px 12px', borderRadius: 5, fontFamily: 'monospace',
                  fontSize: 10, fontWeight: 700,
                  border: `1px solid ${hashOk ? C.gr + '50' : C.re + '50'}`,
                  background: hashOk ? `${C.gr}10` : `${C.re}10`,
                  color: hashOk ? C.gr : C.re }}>
                  Bot: {hashAtual ? `cfg:${hashAtual}` : online ? 'aguardando' : 'offline'}
                  {hashOk && ' ✓ IGUAL'}
                  {!hashOk && hashAtual && ' ✗ DIFERENTE — reinicie o bot'}
                </div>
              </div>
            </div>

            {/* Alerta: hash não bate */}
            {hashAtual && hashSalvo && !hashOk && (
              <div style={{ padding: '8px 12px', borderRadius: 5, marginBottom: 12,
                background: `${C.re}10`, border: `1px solid ${C.re}30`,
                fontSize: 9, color: C.re, lineHeight: 1.7 }}>
                ⚠ O bot ao vivo está rodando com uma config diferente.<br/>
                Supabase: cfg:{hashSalvo} · Bot ativo: cfg:{hashAtual}<br/>
                Reinicie o bot na VM para aplicar a config atual.
              </div>
            )}

            {/* Alerta: modo errado */}
            {liveCfg.estrategia_modo !== 'autoscan' && (
              <div style={{ padding: '8px 12px', borderRadius: 5, marginBottom: 12,
                background: `${C.am}10`, border: `1px solid ${C.am}30`,
                fontSize: 9, color: C.am, lineHeight: 1.7 }}>
                ⚠ Modo selecionado: <strong>{liveCfg.estrategia_modo}</strong>. O backtest vencedor (WR 74.4% / PF 2.164) usou <strong>autoscan</strong>.<br/>
                Mude para autoscan no card "Bot ao Vivo" acima e salve antes de reiniciar.
              </div>
            )}

            {/* Bloco monospaced com todos os parâmetros */}
            <div style={{ background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 6,
              padding: '14px 16px', fontFamily: 'monospace', fontSize: 10, lineHeight: 1.9,
              overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
              <div style={{ color: C.t3, marginBottom: 4 }}>
                {'# ═══════════════════════════════════════════════════'}
              </div>
              <div style={{ color: C.t3 }}>
                {'# CONFIG LIVE — Supabase rafi_bot_config (profile=\'live\')'}
              </div>
              <div style={{ color: C.t3, marginBottom: 8 }}>
                {'# ═══════════════════════════════════════════════════'}
              </div>
              {snap.map(({ k, v, obrigatorio }) => (
                <div key={k} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: obrigatorio ? C.cy : C.t2, minWidth: `${maxLen + 2}ch` }}>
                    {pad(k)}
                  </span>
                  <span style={{ color: C.t3 }}>{'='}</span>
                  <span style={{ color: C.am, fontWeight: 700 }}>{v}</span>
                </div>
              ))}
              <div style={{ color: C.t3, marginTop: 8 }}>
                {'# ═══════════════════════════════════════════════════'}
              </div>
              <div style={{ color: C.t3 }}>{'# Tabela de lote (hardcoded em risk_manager.py):'}</div>
              {FAIXAS_LOTE.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: C.t2, minWidth: `${maxLen + 2}ch` }}>
                    {pad(`lote_faixa_${i + 1}`)}
                  </span>
                  <span style={{ color: C.t3 }}>{'='}</span>
                  <span style={{ color: C.gr }}>
                    ${f.min.toLocaleString()}{f.max === Infinity ? '+' : `–$${f.max.toLocaleString()}`} → {f.lote.toFixed(2)}L ({f.pip})
                  </span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 8, fontSize: 8, color: C.t3, lineHeight: 1.7 }}>
              Campos em <span style={{ color: C.cy }}>ciano</span> = obrigatórios para o modo selecionado ·
              Campos em <span style={{ color: C.t2 }}>cinza</span> = opcionais/ignorados neste modo ·
              Salve "Bot ao Vivo" e reinicie o bot na VM para aplicar · o hash do bot deve igualar ao do Supabase
            </div>
          </div>
        )
      })()}

      {/* Grid dos dois perfis */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: '16px 28px' }}>
        {([
          {
            profile: 'simulator' as const, title: 'Simulador', accent: C.am, icon: '🔬',
            cfg: simCfg, setCfg: setSimCfg, saving: simSaving, saved: simSaved,
            lastSaved: simLastSaved, locked: simLocked, setLocked: setSimLocked,
          },
          {
            profile: 'live' as const, title: 'Bot ao Vivo', accent: C.gr, icon: '🤖',
            cfg: liveCfg, setCfg: setLiveCfg, saving: liveSaving, saved: liveSaved,
            lastSaved: liveLastSaved, locked: liveLocked, setLocked: setLiveLocked,
          },
        ]).map(({ profile, title, accent, icon, cfg, setCfg, saving, saved, lastSaved, locked, setLocked }) => (
          <div key={profile} style={{ ...card, display: 'flex', flexDirection: 'column' }}>

            {/* Card header */}
            <div style={{ padding: '14px 20px', borderBottom: `2px solid ${locked ? C.bd : accent}40`,
              background: locked
                ? `linear-gradient(135deg, ${C.s2} 0%, transparent 100%)`
                : `linear-gradient(135deg, ${accent}10 0%, transparent 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: locked ? C.t2 : accent }}>{title}</div>
                  <div style={{ fontSize: 9, color: C.t3, marginTop: 1 }}>
                    {profile === 'live' ? 'Bot ao vivo na XM — lido a cada inicialização' : 'Usado apenas no backtest local'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {lastSaved && (
                  <div style={{ fontSize: 8, color: C.t3, textAlign: 'right' }}>
                    Salvo {new Date(lastSaved).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                {/* Botão cadeado */}
                <button
                  onClick={() => setLocked(!locked)}
                  title={locked ? 'Clique para desbloquear edição' : 'Clique para bloquear'}
                  style={{ display: 'flex', alignItems: 'center', gap: 5,
                    padding: '5px 10px', borderRadius: 5, border: `1px solid ${locked ? C.am + '60' : C.gr + '40'}`,
                    background: locked ? `${C.am}12` : `${C.gr}10`,
                    color: locked ? C.am : C.gr, fontSize: 10, fontWeight: 700,
                    cursor: 'pointer', transition: 'all 0.2s', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 13 }}>{locked ? '🔒' : '🔓'}</span>
                  <span>{locked ? 'Bloqueado' : 'Editando'}</span>
                </button>
              </div>
            </div>

            {/* Aviso quando bloqueado */}
            {locked && (
              <div style={{ margin: '10px 20px 0', padding: '8px 12px', borderRadius: 5,
                background: `${C.am}08`, border: `1px solid ${C.am}20`,
                display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12 }}>🔒</span>
                <span style={{ fontSize: 9, color: C.am }}>
                  Configuração protegida — clique em <strong>Bloqueado</strong> para habilitar edição
                </span>
              </div>
            )}

            {/* Campos agrupados */}
            <div style={{ padding: '14px 20px', flex: 1, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 18,
              opacity: locked ? 0.55 : 1, pointerEvents: locked ? 'none' : 'auto',
              transition: 'opacity 0.2s' }}>

              {/* ── Seletor de modo da estratégia ── */}
              <div>
                <div style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.12em', color: C.cy,
                  borderBottom: `1px solid ${C.cy}20`, paddingBottom: 5, marginBottom: 10 }}>
                  Modo da Estratégia
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  {(['rafi', 'autoscan'] as const).map(modo => {
                    const ativo = cfg.estrategia_modo === modo
                    const modoColor = modo === 'rafi' ? C.bl : C.am
                    return (
                      <button key={modo}
                        onClick={() => setCfg(prev => ({ ...prev, estrategia_modo: modo }))}
                        style={{ flex: 1, padding: '7px 10px', borderRadius: 5,
                          background: ativo ? `${modoColor}18` : C.s2,
                          border: `1px solid ${ativo ? modoColor + '60' : C.bd}`,
                          color: ativo ? modoColor : C.t2,
                          fontSize: 9, fontWeight: 700, cursor: 'pointer',
                          transition: 'all 0.2s', letterSpacing: '0.05em' }}>
                        {modo === 'rafi' ? '⚙️ RAFI (filtros completos)' : '⚡ Autoscan (browser)'}
                      </button>
                    )
                  })}
                </div>
                {cfg.estrategia_modo === 'autoscan' && (
                  <div style={{ padding: '5px 10px', borderRadius: 4,
                    background: `${C.am}08`, border: `1px solid ${C.am}20`,
                    fontSize: 8, color: C.am, lineHeight: 1.7 }}>
                    ⚡ Sem RAFI · sem MA trend · sem sessão · stop 1.5 pip fixo<br/>
                    Recomendado: S/R Lookback = 20 · Swing Stop irrelevante
                  </div>
                )}
              </div>

              {(() => {
                const camposOff    = profile === 'simulator' ? simCamposOff  : liveCamposOff
                const setCamposOff = profile === 'simulator' ? setSimCamposOff : setLiveCamposOff
                const toggleCampo  = (key: keyof Config) => {
                  if (locked) return
                  setCamposOff(prev => {
                    const next = new Set(prev)
                    next.has(key) ? next.delete(key) : next.add(key)
                    return next
                  })
                }
                return GRUPOS.map(grupo => (
                <div key={grupo.label}>
                  <div style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.12em', color: grupo.cor,
                    borderBottom: `1px solid ${grupo.cor}20`, paddingBottom: 5, marginBottom: 10 }}>
                    {grupo.label}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {grupo.campos.map(campo => {
                      const difere     = divergindo.has(campo.key)
                      const desativado = camposOff.has(campo.key)
                      const ativo      = !desativado
                      return (
                        <div key={campo.key} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 8px', borderRadius: 5,
                          background: ativo && difere ? `${C.re}08` : 'transparent',
                          border: `1px solid ${ativo && difere ? C.re + '30' : 'transparent'}`,
                          transition: 'all 0.3s',
                        }}>
                          {/* Toggle slider ativar/desativar — igual ao Filtro Ativo */}
                          <button
                            onClick={() => toggleCampo(campo.key)}
                            disabled={locked}
                            title={ativo ? 'Clique para desativar' : 'Clique para ativar'}
                            style={{ width: 34, height: 18, borderRadius: 9, border: 'none', padding: 0,
                              flexShrink: 0, cursor: locked ? 'default' : 'pointer',
                              background: ativo ? C.gr : C.t3,
                              position: 'relative', transition: 'background 0.25s' }}>
                            <span style={{ position: 'absolute', top: 2,
                              left: ativo ? 17 : 2,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left 0.25s',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                          </button>

                          {/* Label + desc */}
                          <div style={{ flex: 1, opacity: desativado ? 0.4 : 1, transition: 'opacity 0.25s' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 10, color: C.tx, fontWeight: 600 }}>{campo.label}</span>
                              {desativado && <span style={{ fontSize: 6, color: C.t2, fontWeight: 700,
                                background: `${C.t3}50`, padding: '1px 5px', borderRadius: 3,
                                letterSpacing: '0.08em' }}>INATIVO</span>}
                              {ativo && difere && <span style={{ fontSize: 7, color: C.re, fontWeight: 800,
                                background: `${C.re}15`, padding: '1px 5px', borderRadius: 3 }}>DIFERENTE</span>}
                            </div>
                            <div style={{ fontSize: 8, color: C.t2, marginTop: 1 }}>{campo.desc}</div>
                          </div>

                          {/* Valor do campo */}
                          {campo.tipo === 'bool' ? (
                            <button
                              onClick={() => { if (ativo && !locked) setCfg(prev => ({ ...prev, [campo.key]: !prev[campo.key] })) }}
                              style={{ width: 42, height: 22, borderRadius: 11, border: 'none',
                                cursor: desativado || locked ? 'default' : 'pointer',
                                background: cfg[campo.key] ? C.gr : C.t3,
                                opacity: desativado ? 0.35 : 1,
                                position: 'relative', transition: 'all 0.2s', flexShrink: 0 }}>
                              <span style={{ position: 'absolute', top: 2,
                                left: cfg[campo.key] ? 21 : 2,
                                width: 18, height: 18, borderRadius: '50%',
                                background: '#fff', transition: 'left 0.2s' }} />
                            </button>
                          ) : (
                            <input type="number"
                              value={cfg[campo.key] as number}
                              disabled={desativado || locked}
                              min={campo.min} max={campo.max} step={campo.step ?? 1}
                              onChange={e => {
                                const v = campo.tipo === 'int' ? parseInt(e.target.value) : parseFloat(e.target.value)
                                if (!isNaN(v)) setCfg(prev => ({ ...prev, [campo.key]: v }))
                              }}
                              style={{ width: 88, padding: '4px 8px', textAlign: 'right',
                                background: desativado ? C.s2 : difere ? `${C.re}12` : C.s2,
                                border: `1px solid ${desativado ? C.t3 : difere ? C.re + '50' : C.bd}`,
                                color: desativado ? C.t3 : difere ? C.re : accent,
                                opacity: desativado ? 0.35 : 1,
                                fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                                borderRadius: 4, outline: 'none', flexShrink: 0, transition: 'all 0.3s' }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))
              })()}
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
                Hardcoded em risk_manager.py · sobe automaticamente com o capital
              </div>
            </div>

            {/* Botão salvar */}
            <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.bd}` }}>
              <button
                onClick={() => tentarSalvar(profile, cfg)}
                disabled={saving || locked}
                style={{ width: '100%', padding: '11px 0',
                  background: locked ? `${C.t3}15` : saved ? `${C.gr}20` : `${accent}18`,
                  border: `1px solid ${locked ? C.t3 : saved ? C.gr : accent}50`,
                  color: locked ? C.t3 : saved ? C.gr : accent,
                  fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                  cursor: locked || saving ? 'not-allowed' : 'pointer',
                  borderRadius: 5, transition: 'all 0.3s' }}>
                {locked ? '🔒 BLOQUEADO' : saving ? '⏳ Salvando...' : saved ? '✓ SALVO' : `💾 SALVAR ${title.toUpperCase()}`}
              </button>
              {profile === 'live' && !locked && (
                <div style={{ fontSize: 8, color: C.am, textAlign: 'center', marginTop: 6 }}>
                  ⚠ Será solicitada confirmação · Reinicie o bot no VPS para aplicar
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
