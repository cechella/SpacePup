'use client'

import { useEffect, useState, useCallback } from 'react'
import { Globe, RefreshCw, Settings, Eye, EyeOff, Lock, Power } from 'lucide-react'

// ── Paleta ──────────────────────────────────────────────────────────────────
const C = {
  bg:  '#070c14',
  s1:  '#0d1927',
  s2:  '#0a1520',
  s3:  '#1a2d42',
  bd:  '#1e3448',
  cy:  '#00d9ff',
  gr:  '#00e676',
  re:  '#ff4757',
  am:  '#ffb300',
  bl:  '#4b8ef5',
  tx:  '#b8d4e8',
  t2:  '#5a7d96',
  t3:  '#2d4a60',
}

interface Broker {
  id:                  string
  nome:                string
  servidor:            string
  login:               number
  simbolo:             string
  enabled:             boolean
  saldo:               number
  posicoes:            number
  pnl_hoje:            number
  status_text:         string
  updated_at:          string
  mt5_login?:          number | null
  mt5_servidor?:       string | null
  mt5_simbolo?:        string | null
  mt5_path?:           string | null
  mt5_senha?:          string | null
  metaapi_account_id?: string | null
  // Campos de saúde (broker_health_engine)
  health_score?:       number | null
  health_estado?:      string | null
  circuit_breaker?:    string | null
  broker_priority?:    number | null
  motivo_estado?:      string | null
}

interface LiveData {
  balance:   number
  equity:    number
  todayPnl:  number
  connected: boolean
}

interface CredForm {
  mt5_login:          string
  mt5_senha:          string
  mt5_servidor:       string
  mt5_simbolo:        string
  mt5_path:           string
  metaapi_account_id: string
}

interface FaixaLote {
  ordem:       number
  lote:        number
  capital_min: number
  capital_max: number | null
}

interface RankedBroker {
  id:             string
  nome:           string
  symbol:         string
  estado:         string
  estadoLabel:    string
  circuitBreaker: string
  healthScore:    number
  priority:       number
  eligible:       boolean
  rank:           number
  reason:         string
}

// ── Logo por corretora ───────────────────────────────────────────────────
const LOGOS: Record<string, { label: string; cor: string; bg: string; bd: string }> = {
  xm:             { label: 'XM',  cor: C.am, bg: '#1f1508', bd: '#3d2a10' },
  pepperstone:    { label: 'PP',  cor: C.bl, bg: '#0d1a28', bd: '#1a2a44' },
  exness:         { label: 'EX',  cor: C.cy, bg: '#0a1a20', bd: '#1a3040' },
  tickmill:       { label: 'TK',  cor: '#f97316', bg: '#1a0f00', bd: '#3a1f00' },
  fusion_markets: { label: 'FM',  cor: '#a855f7', bg: '#150d27', bd: '#2d1a4a' },
  forex_com:      { label: 'FX',  cor: '#22c55e', bg: '#0a1f12', bd: '#1a3d22' },
}
function getLogo(id: string) {
  return LOGOS[id] ?? { label: id.slice(0,2).toUpperCase(), cor: C.t2, bg: C.s3, bd: C.bd }
}

const MT5_PATHS: Record<string, string> = {
  pepperstone:    "C:\\Program Files\\MetaTrader 5\\terminal64.exe",
  exness:         "C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe",
  tickmill:       "C:\\Program Files\\MetaTrader 5 Tickmill\\terminal64.exe",
  fusion_markets: "C:\\Program Files\\MetaTrader 5 FusionMarkets\\terminal64.exe",
  forex_com:      "C:\\Program Files\\MetaTrader 5 FOREX.com\\terminal64.exe",
}

function lotePorSaldo(saldo: number, faixas: FaixaLote[]): string {
  if (!faixas.length) return '0.10'
  const f = faixas.find((x) =>
    saldo >= x.capital_min && (x.capital_max === null || saldo < x.capital_max)
  )
  return f ? f.lote.toFixed(2) : '0.10'
}

// ── Componente principal ─────────────────────────────────────────────────
export default function BrokersPage() {
  const [brokers, setBrokers]   = useState<Broker[]>([])
  const [loading, setLoading]   = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState('')
  const [liveData, setLiveData] = useState<Record<string, LiveData>>({})
  const [liveLoading, setLiveLoading] = useState(false)
  const [mapiStatus, setMapiStatus]   = useState<'idle' | 'loading'>('idle')
  const [mapiActive, setMapiActive]   = useState<boolean | null>(null)

  // Dados dinâmicos do Supabase
  const [faixas,      setFaixas]      = useState<FaixaLote[]>([])
  const [ranking,     setRanking]     = useState<RankedBroker[]>([])
  const [rankLoading, setRankLoading] = useState(true)

  // Modal de credenciais
  const [credBroker, setCredBroker] = useState<Broker | null>(null)
  const [credForm,   setCredForm]   = useState<CredForm>({ mt5_login: '', mt5_senha: '', mt5_servidor: '', mt5_simbolo: '', mt5_path: '', metaapi_account_id: '' })
  const [credSaving, setCredSaving] = useState(false)
  const [credOk,     setCredOk]     = useState(false)
  const [showSenha,  setShowSenha]  = useState(false)

  const fetchLiveData = useCallback(async (brokerList: Broker[]) => {
    setLiveLoading(true)
    const results: Record<string, LiveData> = {}

    await Promise.allSettled(
      brokerList.map(async (b) => {
        const hasMetaApi = b.metaapi_account_id || b.id === 'pepperstone'
        if (!hasMetaApi) return
        const qp = b.metaapi_account_id ? `?accountId=${b.metaapi_account_id}` : ''
        try {
          const [accRes, pnlRes] = await Promise.all([
            fetch(`/api/metaapi/account${qp}`).then(r => r.json()),
            fetch(`/api/metaapi/today-pnl${qp}`).then(r => r.json()),
          ])
          if (accRes.balance !== undefined) {
            results[b.id] = {
              balance:   accRes.balance  ?? 0,
              equity:    accRes.equity   ?? 0,
              todayPnl:  pnlRes.todayPnl ?? 0,
              connected: true,
            }
          }
        } catch {
          results[b.id] = { balance: 0, equity: 0, todayPnl: 0, connected: false }
        }
      })
    )

    setLiveData(results)
    setLiveLoading(false)
    // Considera ativo se ao menos 1 conta respondeu com saldo
    const anyConnected = Object.values(results).some(r => r.connected)
    setMapiActive(anyConnected)
  }, [])

  const fetchBrokers = useCallback(async () => {
    try {
      const res  = await fetch('/api/brokers')
      const json = await res.json()
      if (json.brokers) {
        setBrokers(json.brokers)
        setLastUpdate(new Date().toLocaleTimeString('pt-BR'))
        fetchLiveData(json.brokers)
      }
    } catch {
      // silencioso
    } finally {
      setLoading(false)
    }
  }, [fetchLiveData])

  // Busca faixas de lote do Supabase uma vez ao montar
  useEffect(() => {
    fetch('/api/admin/save-faixa').then(r => r.json()).catch(() => ({}))
      .then((res: { faixas?: FaixaLote[] }) => { if (res.faixas?.length) setFaixas(res.faixas) })
  }, [])

  // Busca ranking dinâmico das corretoras a cada 30s
  useEffect(() => {
    const fetchRanking = async () => {
      try {
        const res = await fetch('/api/brokers/ranking')
        const json = await res.json()
        if (json.brokers) setRanking(json.brokers)
      } catch { /* silencioso */ } finally { setRankLoading(false) }
    }
    fetchRanking()
    const iv = setInterval(fetchRanking, 30_000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    fetchBrokers()
    const iv = setInterval(fetchBrokers, 5000)
    return () => clearInterval(iv)
  }, [fetchBrokers])

  const abrirCred = (broker: Broker) => {
    setCredBroker(broker)
    setCredOk(false)
    setShowSenha(false)
    setCredForm({
      mt5_login:          String(broker.mt5_login ?? broker.login ?? ''),
      mt5_senha:          '',
      mt5_servidor:       broker.mt5_servidor ?? broker.servidor ?? '',
      mt5_simbolo:        broker.mt5_simbolo  ?? broker.simbolo  ?? '',
      mt5_path:           broker.mt5_path     ?? MT5_PATHS[broker.id] ?? '',
      metaapi_account_id: broker.metaapi_account_id ?? '',
    })
  }

  const salvarCred = async () => {
    if (!credBroker) return
    setCredSaving(true)
    try {
      const body: Record<string, unknown> = {
        id:                  credBroker.id,
        mt5_login:           credForm.mt5_login    ? Number(credForm.mt5_login) : null,
        mt5_servidor:        credForm.mt5_servidor || null,
        mt5_simbolo:         credForm.mt5_simbolo  || null,
        mt5_path:            credForm.mt5_path     || null,
        metaapi_account_id:  credForm.metaapi_account_id || null,
      }
      if (credForm.mt5_senha) body.mt5_senha = credForm.mt5_senha
      await fetch('/api/brokers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setCredOk(true)
      await fetchBrokers()
      setTimeout(() => setCredBroker(null), 1500)
    } finally {
      setCredSaving(false)
    }
  }

  const toggleMetaApi = async () => {
    const acao = mapiActive ? 'undeploy' : 'deploy'
    setMapiStatus('loading')
    try {
      await fetch(`/api/metaapi/${acao}`, { method: 'POST' })
      setMapiActive(!mapiActive)
      // Rebusca saldos após toggle
      await fetchBrokers()
    } finally {
      setMapiStatus('idle')
    }
  }

  const toggle = async (broker: Broker) => {
    setToggling(broker.id)
    try {
      await fetch('/api/brokers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: broker.id, enabled: !broker.enabled }),
      })
      await fetchBrokers()
    } finally {
      setToggling(null)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '28px 24px', fontFamily: 'monospace' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.t2, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>
            <Globe size={13} />
            RAFI COMMAND · CORRETORAS
          </div>
          <div style={{ color: C.t2, fontSize: 11 }}>
            Toggle Liga/Desliga por corretora — bot lê do Supabase na inicialização
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {liveLoading && (
            <span style={{ fontSize: 9, color: C.cy }}>● buscando saldos ao vivo...</span>
          )}
          {!liveLoading && Object.keys(liveData).length > 0 && (
            <span style={{ fontSize: 9, color: C.gr }}>● MetaAPI ao vivo</span>
          )}
          {lastUpdate && (
            <span style={{ color: C.t3, fontSize: 10 }}>atualizado {lastUpdate}</span>
          )}
          <button
            onClick={toggleMetaApi}
            disabled={mapiStatus === 'loading'}
            title={mapiActive === false ? 'Ligar MetaAPI (deploy contas)' : 'Desligar MetaAPI (undeploy contas)'}
            style={{
              background:    mapiActive ? '#0d2010' : C.s1,
              border:        `1px solid ${mapiActive ? C.gr : C.bd}`,
              color:         mapiActive ? C.gr : C.t2,
              padding:       '6px 10px',
              borderRadius:  6,
              cursor:        mapiStatus === 'loading' ? 'wait' : 'pointer',
              display:       'flex',
              alignItems:    'center',
              gap:           5,
              fontSize:      11,
              opacity:       mapiStatus === 'loading' ? 0.6 : 1,
              transition:    'all .2s',
            }}
          >
            <Power size={11} />
            {mapiStatus === 'loading'
              ? 'aguarde...'
              : mapiActive
                ? 'MetaAPI ON'
                : mapiActive === false
                  ? 'MetaAPI OFF'
                  : 'MetaAPI'}
          </button>
          <button
            onClick={fetchBrokers}
            style={{ background: 'transparent', border: `1px solid ${C.bd}`, color: C.t2, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
          >
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
      </div>

      {/* Notice */}
      <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderLeft: `3px solid ${C.bl}`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.t2, marginBottom: 20, lineHeight: 1.6 }}>
        <strong style={{ color: C.bl }}>Como funciona:</strong> cada corretora tem um toggle Liga/Desliga independente.
        Múltiplas podem estar ativas ao mesmo tempo — para rodar simultâneas, inicie dois processos no VPS:
        <code style={{ color: C.tx, marginLeft: 6 }}>py -m src.executor --broker exness</code> e
        <code style={{ color: C.tx, marginLeft: 6 }}>py -m src.executor --broker pepperstone</code>
      </div>

      {/* Broker cards */}
      {loading ? (
        <div style={{ color: C.t2, fontSize: 12, textAlign: 'center', padding: 40 }}>Carregando corretoras...</div>
      ) : brokers.length === 0 ? (
        <div style={{ color: C.t2, fontSize: 12, textAlign: 'center', padding: 40 }}>
          Tabela rafi_brokers não encontrada. Execute o SQL de criação no Supabase.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 28 }}>
          {brokers.map((b) => (
            <BrokerCard key={b.id} broker={b} faixas={faixas} live={liveData[b.id]} onToggle={toggle} toggling={toggling === b.id} onCred={abrirCred} />
          ))}
        </div>
      )}

      {/* Ranking dinâmico das corretoras */}
      <BrokerRanking ranking={ranking} loading={rankLoading} />

      {/* Modal de credenciais MT5 */}
      {credBroker && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCredBroker(null)}>
          <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 12, width: 420, padding: 24 }}
            onClick={e => e.stopPropagation()}>

            {/* Header modal */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <Lock size={14} color={C.cy} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.tx, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Conexão MT5 — {credBroker.nome}
              </span>
            </div>

            {[
              { label: 'Login MT5',          key: 'mt5_login',          type: 'number', placeholder: credBroker.login?.toString() ?? '12345678' },
              { label: 'Servidor',           key: 'mt5_servidor',       type: 'text',   placeholder: credBroker.servidor ?? 'Broker-Live01' },
              { label: 'Símbolo',            key: 'mt5_simbolo',        type: 'text',   placeholder: credBroker.simbolo ?? 'EURUSD' },
              { label: 'MT5 Path',           key: 'mt5_path',           type: 'text',   placeholder: MT5_PATHS[credBroker.id] ?? '' },
              { label: 'MetaAPI Account ID', key: 'metaapi_account_id', type: 'text',   placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
            ].map(({ label, key, type, placeholder }) => (
              <div key={key} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>{label}</div>
                <input
                  type={type}
                  placeholder={placeholder}
                  value={(credForm as unknown as Record<string, string>)[key]}
                  onChange={e => setCredForm(f => ({ ...f, [key as keyof CredForm]: e.target.value }))}
                  style={{ width: '100%', boxSizing: 'border-box', background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 6, padding: '8px 10px', color: C.tx, fontSize: 12, fontFamily: 'monospace' }}
                />
              </div>
            ))}

            {/* Senha com show/hide */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>
                Senha MT5 <span style={{ color: C.t3 }}>(deixe em branco para não alterar)</span>
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showSenha ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={credForm.mt5_senha}
                  onChange={e => setCredForm(f => ({ ...f, mt5_senha: e.target.value }))}
                  style={{ width: '100%', boxSizing: 'border-box', background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 6, padding: '8px 36px 8px 10px', color: C.tx, fontSize: 12, fontFamily: 'monospace' }}
                />
                <button onClick={() => setShowSenha(v => !v)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: C.t2 }}>
                  {showSenha ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Botões */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setCredBroker(null)}
                style={{ flex: 1, padding: '9px 0', background: C.s3, border: `1px solid ${C.bd}`, borderRadius: 7, color: C.t2, fontSize: 12, cursor: 'pointer' }}>
                Cancelar
              </button>
              <button onClick={salvarCred} disabled={credSaving}
                style={{ flex: 2, padding: '9px 0', background: credOk ? C.gr : C.bl, border: 'none', borderRadius: 7, color: '#fff', fontSize: 12, fontWeight: 700, cursor: credSaving ? 'wait' : 'pointer', opacity: credSaving ? 0.7 : 1 }}>
                {credOk ? '✓ Salvo!' : credSaving ? 'Salvando...' : 'Salvar Credenciais'}
              </button>
            </div>

            <div style={{ marginTop: 12, fontSize: 10, color: C.t3, lineHeight: 1.5 }}>
              🔒 Salvo via service role — senha nunca exposta no dashboard. Bot lê no próximo restart.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Card individual de corretora ──────────────────────────────────────────
function BrokerCard({ broker, faixas, live, onToggle, toggling, onCred }: {
  broker: Broker
  faixas: FaixaLote[]
  live?: LiveData
  onToggle: (b: Broker) => void
  toggling: boolean
  onCred: (b: Broker) => void
}) {
  const logo   = getLogo(broker.id)
  const active = broker.enabled
  const displayBalance = live?.connected ? live.balance : (broker.saldo ?? 0)
  const displayPnl     = live?.connected ? live.todayPnl : (broker.pnl_hoje ?? 0)
  const pnlColor = displayPnl > 0 ? C.gr : displayPnl < 0 ? C.re : C.tx

  return (
    <div style={{
      background: C.s1,
      border: `1px solid ${active ? C.gr : C.bd}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'border-color .2s',
    }}>
      <div style={{ height: 3, background: active ? C.gr : C.bd }} />

      <div style={{ padding: 16 }}>
        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: logo.bg, border: `1px solid ${logo.bd}`,
              color: logo.cor, fontSize: 11, fontWeight: 700,
            }}>
              {logo.label}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: C.tx }}>{broker.nome}</div>
              <div style={{ fontSize: 10, color: C.t2, marginTop: 2 }}>
                {broker.servidor} · #{broker.login}
              </div>
            </div>
          </div>

          {/* Toggle */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: active ? C.gr : C.t2 }}>
              {active ? 'ATIVA' : 'INATIVA'}
            </span>
            <button
              onClick={() => !toggling && onToggle(broker)}
              disabled={toggling}
              title={active ? `Desativar ${broker.nome}` : `Ativar ${broker.nome}`}
              style={{
                width: 40, height: 22, borderRadius: 11, border: 'none',
                cursor: toggling ? 'wait' : 'pointer',
                background: active ? C.gr : C.s3,
                position: 'relative', transition: 'background .2s',
                opacity: toggling ? 0.6 : 1,
              }}
            >
              <span style={{
                position: 'absolute', top: 3, width: 16, height: 16, borderRadius: '50%',
                background: '#fff', transition: 'left .2s',
                left: active ? 21 : 3,
              }} />
            </button>
          </div>
        </div>

        {/* Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
          <Metric
            label={live?.connected ? 'Saldo ●' : 'Saldo'}
            value={`$${displayBalance.toFixed(2)}`}
            color={live?.connected ? C.cy : active ? C.gr : C.tx}
          />
          <Metric label="Posições"  value={active ? String(broker.posicoes ?? 0) : '—'} />
          <Metric
            label={live?.connected ? 'P&L Hoje ●' : 'P&L Hoje'}
            value={active || live?.connected ? `${displayPnl >= 0 ? '+' : ''}$${displayPnl.toFixed(2)}` : '—'}
            color={active || live?.connected ? pnlColor : C.t2}
          />
        </div>

        {/* Health Score — exibido quando o bot está populando dados */}
        {broker.health_estado && broker.health_estado !== 'STANDBY' || (broker.health_score ?? 0) > 0 ? (
          <div style={{ marginBottom: 12, padding: '10px 12px', background: C.s2, borderRadius: 8, border: `1px solid ${C.bd}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.t2 }}>Health Score</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Circuit Breaker */}
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: broker.circuit_breaker === 'OPEN' ? 'rgba(239,68,68,.15)' : 'rgba(0,230,118,.1)',
                  color: broker.circuit_breaker === 'OPEN' ? C.re : C.gr,
                  border: `1px solid ${broker.circuit_breaker === 'OPEN' ? 'rgba(239,68,68,.3)' : 'rgba(0,230,118,.2)'}`,
                }}>
                  CB {broker.circuit_breaker === 'OPEN' ? 'ABERTO' : 'FECHADO'}
                </span>
                {/* Estado */}
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: broker.health_estado === 'ACTIVE' ? 'rgba(0,230,118,.1)'
                    : broker.health_estado === 'ACTIVE_REDUCED' ? 'rgba(255,179,0,.1)'
                    : broker.health_estado === 'QUARANTINED' ? 'rgba(239,68,68,.1)'
                    : 'rgba(90,125,150,.08)',
                  color: broker.health_estado === 'ACTIVE' ? C.gr
                    : broker.health_estado === 'ACTIVE_REDUCED' ? C.am
                    : broker.health_estado === 'QUARANTINED' ? C.re : C.t2,
                  border: `1px solid ${broker.health_estado === 'ACTIVE' ? 'rgba(0,230,118,.2)' : C.bd}`,
                }}>
                  {(broker.health_estado ?? 'STANDBY').replace('_', ' ')}
                </span>
              </div>
            </div>
            {/* Barra de score */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: (broker.health_score ?? 0) >= 80 ? C.gr : (broker.health_score ?? 0) >= 65 ? C.am : C.t2, fontVariantNumeric: 'tabular-nums', minWidth: 36 }}>
                {(broker.health_score ?? 0) > 0 ? Math.round(broker.health_score ?? 0) : '—'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ height: 6, background: C.s3, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    width: `${Math.min(broker.health_score ?? 0, 100)}%`,
                    background: (broker.health_score ?? 0) >= 80 ? C.gr : (broker.health_score ?? 0) >= 65 ? C.am : C.re,
                    transition: 'width .4s ease',
                  }} />
                </div>
                <div style={{ fontSize: 9, color: C.t3, marginTop: 3 }}>
                  {broker.motivo_estado ?? (broker.health_score ?? 0) === 0 ? 'Aguardando dados do bot' : ''}
                </div>
              </div>
            </div>
          </div>
        ) : broker.enabled ? (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: C.s2, borderRadius: 6, border: `1px solid ${C.bd}` }}>
            <span style={{ fontSize: 10, color: C.t3, fontStyle: 'italic' }}>Health score disponível após 20 trades · bot calculando…</span>
          </div>
        ) : null}

        {/* Status pill + symbol + config button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '3px 8px', borderRadius: 4,
            background: active ? '#0d2016' : C.s3,
            color: active ? C.gr : C.t2,
            border: `1px solid ${active ? '#1a4028' : C.bd}`,
          }}>
            {active ? `● ${broker.status_text || 'AGUARDANDO SINAL'}` : '○ DESLIGADA'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10, color: C.t2 }}>
              {broker.simbolo} · {lotePorSaldo(displayBalance, faixas)}L
            </div>
            <button onClick={() => onCred(broker)} title="Configurar conexão MT5"
              style={{ background: 'transparent', border: `1px solid ${C.bd}`, borderRadius: 5, padding: '3px 6px', cursor: 'pointer', color: broker.mt5_login ? C.cy : C.t3, display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
              <Settings size={10} /> {broker.mt5_login ? 'MT5 ✓' : 'Configurar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? C.tx, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

// ── Painel de ranking dinâmico das corretoras ────────────────────────────────
function BrokerRanking({ ranking, loading }: { ranking: RankedBroker[]; loading: boolean }) {
  const RANK_COLORS = ['#f59e0b', '#94a3b8', '#b45309']

  const estadoCor = (estado: string) => {
    if (estado === 'ACTIVE')         return C.gr
    if (estado === 'ACTIVE_REDUCED') return C.am
    if (estado === 'STANDBY')        return C.bl
    return C.re
  }

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
          Ranking Dinâmico · Cascata de Seleção Automática
        </div>
        {loading
          ? <span style={{ fontSize: 9, color: C.t3 }}>carregando...</span>
          : <span style={{ fontSize: 9, color: C.t2 }}>atualiza a cada 30s · critérios: estado → health score → prioridade</span>
        }
      </div>

      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {loading && ranking.length === 0 && (
          <div style={{ gridColumn: '1/-1', color: C.t3, fontSize: 12, textAlign: 'center', padding: 24 }}>
            Buscando ranking...
          </div>
        )}
        {ranking.map((b) => {
          const rankColor = RANK_COLORS[b.rank - 1] ?? C.t2
          const isTop = b.rank === 1

          return (
            <div key={b.id} style={{
              background:    C.s2,
              border:        `1px solid ${isTop ? rankColor : C.bd}`,
              borderTop:     `3px solid ${isTop ? rankColor : C.bd}`,
              borderRadius:  8,
              padding:       14,
              opacity:       b.eligible ? 1 : 0.55,
            }}>
              {/* Cabeçalho: rank + nome + badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div style={{
                  background: `${rankColor}22`, border: `1px solid ${rankColor}`,
                  color: rankColor, borderRadius: 4, padding: '2px 8px',
                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>
                  #{b.rank}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, flex: 1 }}>{b.nome}</div>
                {isTop && (
                  <div style={{ background: '#0d2010', border: `1px solid ${C.gr}`, color: C.gr, borderRadius: 4, padding: '2px 6px', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>
                    ★ ATIVO
                  </div>
                )}
              </div>

              {/* Estado + barra de health */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ fontSize: 11, color: estadoCor(b.estado), fontWeight: 600 }}>
                    ● {b.estadoLabel}
                  </span>
                  <span style={{ fontSize: 12, color: C.tx, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                    {b.healthScore.toFixed(0)}
                  </span>
                </div>
                <div style={{ height: 5, background: C.bd, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width:  `${Math.min(b.healthScore, 100)}%`,
                    background: b.healthScore >= 60 ? C.gr : b.healthScore >= 30 ? C.am : C.re,
                    borderRadius: 3,
                  }} />
                </div>
              </div>

              {/* Métricas */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 10, fontSize: 10, color: C.t2 }}>
                <div>CB: <span style={{ color: b.circuitBreaker === 'CLOSED' ? C.gr : C.re }}>
                  {b.circuitBreaker === 'CLOSED' ? '✓ Fechado' : '✗ Aberto'}
                </span></div>
                <div>Priority: <span style={{ color: C.tx }}>{b.priority}</span></div>
                <div style={{ gridColumn: '1/-1' }}>
                  Símbolo: <span style={{ color: C.cy, fontFamily: 'monospace', fontSize: 11 }}>{b.symbol}</span>
                </div>
              </div>

              {/* Motivo */}
              <div style={{ background: C.bg, borderRadius: 4, padding: '6px 8px' }}>
                <div style={{ fontSize: 9, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
                  Por que #{b.rank}?
                </div>
                <div style={{ fontSize: 10, color: C.t2, lineHeight: 1.5 }}>{b.reason}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

