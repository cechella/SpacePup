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
  bot_heartbeat_at?:   string | null
  mt5_login?:          number | null
  mt5_servidor?:       string | null
  mt5_simbolo?:        string | null
  mt5_path?:           string | null
  mt5_senha?:          string | null
  metaapi_account_id?: string | null
  bot_enabled?:        boolean | null
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

interface LivePosition {
  id:           string
  symbol:       string
  type:         string
  volume:       number
  openPrice:    number
  currentPrice: number
  profit:       number
  stopLoss:     number
  takeProfit:   number
  openTime:     string
}

interface BrokerLiveData {
  rank:       number
  brokerId:   string
  nome:       string
  symbol:     string
  positions:  LivePosition[]
  totalPnl:   number
  error?:     number | string
}

interface ExecQuality {
  brokerId:        string
  nome:            string
  noData:          boolean
  error?:          boolean
  totalTrades?:    number
  winRate?:        number
  profitFactor?:   number
  totalPnl?:       number
  avgPnl?:         number
  avgSlippagePips?: number | null
  avgExecMs?:      number | null
  winners?:        number
  losers?:         number
}

interface ByTypeStats { avg: number; count: number }
interface BrokerAnalytics {
  brokerId:    string
  nome:        string
  lastLatency: number | null
  lastAt:      string | null
  sparkline:   number[]
  p90:         number
  avgLatency:  number
  uptimePct:   number
  totalEvents: number
  failedEvents:number
  byType:      { positions?: ByTypeStats; order?: ByTypeStats; close?: ByTypeStats; modify?: ByTypeStats }
}

// ── Logo por corretora ───────────────────────────────────────────────────
const LOGOS: Record<string, { label: string; cor: string; bg: string; bd: string }> = {
  xm:             { label: 'XM',  cor: C.am,      bg: '#1f1508', bd: '#3d2a10' },
  pepperstone:    { label: 'PP',  cor: C.bl,      bg: '#0d1a28', bd: '#1a2a44' },
  exness:         { label: 'EX',  cor: C.cy,      bg: '#0a1a20', bd: '#1a3040' },
  tickmill:       { label: 'TK',  cor: '#f97316', bg: '#1a0f00', bd: '#3a1f00' },
  icmarkets:      { label: 'IC',  cor: '#e11d48', bg: '#1a0008', bd: '#3a001a' },
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

  // Performance em tempo real — posições abertas de todas as corretoras
  const [livePerf,        setLivePerf]        = useState<BrokerLiveData[]>([])
  const [livePerfLoading, setLivePerfLoading] = useState(false)
  const [livePerfAt,      setLivePerfAt]      = useState('')

  // Analytics de ping / latência por corretora (histórico do bot)
  const [analytics,      setAnalytics]      = useState<BrokerAnalytics[]>([])
  const [analyticsAt,    setAnalyticsAt]    = useState('')

  // Pings ao vivo — medidos diretamente no servidor Next.js, sem bot
  const [livePingMap,    setLivePingMap]    = useState<Record<string, { latencyMs: number | null; success: boolean }>>({})
  const [livePingSpark,  setLivePingSpark]  = useState<Record<string, number[]>>({})  // sparkline acumulada
  const [livePingAt,     setLivePingAt]     = useState('')

  // Qualidade de execução — slippage, win rate, tempo de execução
  const [execQuality,    setExecQuality]    = useState<ExecQuality[]>([])
  const [execQualityAt,  setExecQualityAt]  = useState('')
  const [execQualityDays, setExecQualityDays] = useState<30 | 90>(30)

  // Seleção em lote para ações de bot
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set())
  const [batchWorking, setBatchWorking] = useState(false)

  const toggleSelectBroker = (id: string) =>
    setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const selectAllBrokers = () =>
    setSelectedIds(new Set(brokers.filter(b => b.enabled).map(b => b.id)))

  const clearSelection = () => setSelectedIds(new Set())

  const batchSetBot = async (ids: string[], value: boolean) => {
    setBatchWorking(true)
    try {
      await Promise.all(ids.map(id =>
        fetch('/api/brokers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, bot_enabled: value }),
        })
      ))
      await fetchBrokers()
      setSelectedIds(new Set())
    } finally {
      setBatchWorking(false)
    }
  }

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

  // Analytics de latência a cada 10s
  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const res  = await fetch('/api/admin/broker-analytics')
        const json = await res.json()
        if (json.brokers) {
          setAnalytics(json.brokers)
          setAnalyticsAt(new Date().toLocaleTimeString('pt-BR'))
        }
      } catch { /* silencioso */ }
    }
    fetchAnalytics()
    const iv = setInterval(fetchAnalytics, 10_000)
    return () => clearInterval(iv)
  }, [])

  // Qualidade de execução — busca uma vez por dia (dados históricos)
  const fetchExecQuality = useCallback(async (days: 30 | 90) => {
    try {
      const res  = await fetch(`/api/admin/broker-execution-quality?days=${days}`)
      const json = await res.json()
      if (json.brokers) {
        setExecQuality(json.brokers)
        setExecQualityAt(new Date().toLocaleTimeString('pt-BR'))
      }
    } catch { /* silencioso */ }
  }, [])

  useEffect(() => { fetchExecQuality(execQualityDays) }, [execQualityDays, fetchExecQuality])

  // Pings ao vivo a cada 5s — sem depender do bot Python
  useEffect(() => {
    const fetchPing = async () => {
      try {
        const res  = await fetch('/api/admin/broker-ping')
        const json = await res.json()
        if (!json.pings) return
        const map: Record<string, { latencyMs: number | null; success: boolean }> = {}
        for (const p of json.pings) map[p.brokerId] = { latencyMs: p.latencyMs, success: p.success }
        setLivePingMap(map)
        setLivePingSpark(prev => {
          const next = { ...prev }
          for (const p of json.pings) {
            if (p.latencyMs !== null) {
              next[p.brokerId] = [...(prev[p.brokerId] ?? []).slice(-29), p.latencyMs]
            }
          }
          return next
        })
        setLivePingAt(new Date().toLocaleTimeString('pt-BR'))
      } catch { /* silencioso */ }
    }
    fetchPing()
    const iv = setInterval(fetchPing, 5_000)
    return () => clearInterval(iv)
  }, [])

  // Recalcula health scores com dados reais a cada 60s
  useEffect(() => {
    const run = () => fetch('/api/admin/health-engine', { method: 'POST' }).catch(() => {})
    run()
    const iv = setInterval(run, 60_000)
    return () => clearInterval(iv)
  }, [])

  // Busca posições abertas de TODAS as corretoras a cada 5s
  useEffect(() => {
    const fetchPerf = async () => {
      setLivePerfLoading(true)
      try {
        const res = await fetch('/api/metaapi/all-positions')
        const json = await res.json()
        if (json.brokers) {
          setLivePerf(json.brokers)
          setLivePerfAt(new Date().toLocaleTimeString('pt-BR'))
        }
      } catch { /* silencioso */ } finally { setLivePerfLoading(false) }
    }
    fetchPerf()
    const iv = setInterval(fetchPerf, 5_000)
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

  const toggleBot = async (broker: Broker) => {
    setToggling(broker.id + '_bot')
    try {
      await fetch('/api/brokers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: broker.id, bot_enabled: !(broker.bot_enabled ?? false) }),
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

      {/* 1. Ranking dinâmico — primeira informação visível */}
      <BrokerRanking ranking={ranking} loading={rankLoading} execQuality={execQuality} />

      {/* 2. Analytics de ping e latência */}
      <BrokerPingPanel
        data={analytics}
        updatedAt={analyticsAt}
        livePingMap={livePingMap}
        livePingSpark={livePingSpark}
        livePingAt={livePingAt}
      />

      {/* 3. Corretoras cadastradas */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2, marginBottom: 12 }}>
          Corretoras Cadastradas
        </div>

        {/* Notice */}
        <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderLeft: `3px solid ${C.bl}`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.t2, marginBottom: 16, lineHeight: 1.8 }}>
          <strong style={{ color: C.bl }}>Como funciona:</strong> o toggle habilita para a <strong style={{ color: C.tx }}>Mesa de Operação</strong> (trade manual) e para o <strong style={{ color: C.tx }}>bot automático</strong>. São dois sistemas independentes:{'  '}
          <span style={{ color: C.gr }}>● Mesa de Operação</span> — toggle ON + MetaAPI conectado, sem VPS.{'  '}
          <span style={{ color: C.am }}>● Bot automático</span> — processo Python no VPS: <code style={{ color: C.tx }}>py -m src.executor --broker &lt;id&gt;</code>
        </div>

        {/* Barra de comando em lote */}
        {!loading && brokers.filter(b => b.enabled).length > 0 && (
          <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, opacity: batchWorking ? 0.6 : 1 }}>
            <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', color: C.t2, flexShrink: 0 }}>Controle de Bots</span>
            {/* Ligar / Desligar todos */}
            <button
              onClick={() => batchSetBot(brokers.filter(b => b.enabled).map(b => b.id), true)}
              disabled={batchWorking}
              style={{ background: 'rgba(0,230,118,.08)', border: `1px solid rgba(0,230,118,.25)`, color: C.gr, padding: '5px 12px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              ▶ Ligar Todos
            </button>
            <button
              onClick={() => batchSetBot(brokers.filter(b => b.enabled).map(b => b.id), false)}
              disabled={batchWorking}
              style={{ background: 'rgba(255,71,87,.07)', border: `1px solid rgba(255,71,87,.25)`, color: C.re, padding: '5px 12px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              ■ Desligar Todos
            </button>
            {/* Seleção */}
            <div style={{ width: 1, height: 14, background: C.bd, margin: '0 2px' }} />
            <button
              onClick={selectedIds.size === 0 ? selectAllBrokers : clearSelection}
              style={{ background: 'transparent', border: `1px solid ${C.bd}`, color: C.t2, padding: '5px 10px', borderRadius: 5, fontSize: 9, cursor: 'pointer', letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              {selectedIds.size === 0 ? 'Selecionar Todas' : `${selectedIds.size} selecionada${selectedIds.size > 1 ? 's' : ''} · Limpar`}
            </button>
            {selectedIds.size > 0 && (
              <>
                <button
                  onClick={() => batchSetBot(Array.from(selectedIds), true)}
                  disabled={batchWorking}
                  style={{ background: 'rgba(0,217,255,.08)', border: `1px solid rgba(0,217,255,.25)`, color: C.cy, padding: '5px 12px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                >
                  ▶ Ligar Selecionadas
                </button>
                <button
                  onClick={() => batchSetBot(Array.from(selectedIds), false)}
                  disabled={batchWorking}
                  style={{ background: 'rgba(255,179,0,.07)', border: `1px solid rgba(255,179,0,.25)`, color: C.am, padding: '5px 12px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                >
                  ■ Desligar Selecionadas
                </button>
              </>
            )}
            {batchWorking && <span style={{ fontSize: 9, color: C.cy }}>● aplicando...</span>}
          </div>
        )}

        {loading ? (
          <div style={{ color: C.t2, fontSize: 12, textAlign: 'center', padding: 40 }}>Carregando corretoras...</div>
        ) : brokers.length === 0 ? (
          <div style={{ color: C.t2, fontSize: 12, textAlign: 'center', padding: 40 }}>
            Tabela rafi_brokers não encontrada. Execute o SQL de criação no Supabase.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {brokers.map((b) => (
              <BrokerCard key={b.id} broker={b} faixas={faixas} live={liveData[b.id]} onToggle={toggle} onToggleBot={toggleBot} toggling={toggling === b.id} togglingBot={toggling === b.id + '_bot'} onCred={abrirCred} selected={selectedIds.has(b.id)} onSelect={toggleSelectBroker} />
            ))}
          </div>
        )}
      </div>

      {/* 4. Performance em tempo real */}
      <LivePerformance data={livePerf} loading={livePerfLoading} updatedAt={livePerfAt} />

      {/* 5. Qualidade de execução — slippage, win rate, tempo de execução real */}
      <ExecutionQualityPanel
        data={execQuality}
        updatedAt={execQualityAt}
        days={execQualityDays}
        onChangeDays={setExecQualityDays}
        onRefresh={() => fetchExecQuality(execQualityDays)}
      />

      {/* 6. Legenda dos parâmetros */}
      <ParamLegend />

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

// ── Sparkline SVG inline ─────────────────────────────────────────────────────
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return (
    <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 9, color: C.t3 }}>aguardando dados...</span>
    </div>
  )
  const W = 200
  const H = 32
  const max = Math.max(...values, 50)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = H - 2 - ((v / max) * (H - 6))
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  // Área preenchida abaixo da linha
  const first = values[0], last = values[values.length - 1]
  const y0 = (H - 2 - ((first / max) * (H - 6))).toFixed(1)
  const yN = (H - 2 - ((last  / max) * (H - 6))).toFixed(1)
  const area = `0,${H} ${pts} ${W},${H}`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 36, display: 'block' }} preserveAspectRatio="none">
      <polygon points={area} fill={color} fillOpacity={0.08} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* Ponto mais recente (direita) */}
      <circle cx={W} cy={yN} r="3" fill={color} />
    </svg>
  )
}

// ── Painel de analytics de ping e latência ───────────────────────────────────
function BrokerPingPanel({
  data,
  updatedAt,
  livePingMap   = {},
  livePingSpark = {},
  livePingAt    = '',
}: {
  data:          BrokerAnalytics[]
  updatedAt:     string
  livePingMap?:  Record<string, { latencyMs: number | null; success: boolean }>
  livePingSpark?: Record<string, number[]>
  livePingAt?:   string
}) {
  // Constrói lista de brokers: usa analytics histórico se disponível;
  // caso contrário, usa as entradas do livePingMap
  const liveIds   = Object.keys(livePingMap)
  const histIds   = data.map(d => d.brokerId)
  const allIds    = Array.from(new Set([...histIds, ...liveIds]))

  // Para brokers sem histórico (bot offline), cria um item sintético
  const fullData: BrokerAnalytics[] = allIds.map(id => {
    const hist = data.find(d => d.brokerId === id)
    if (hist) return hist
    const liveName = liveIds.includes(id) ? id : id
    return {
      brokerId:    id,
      nome:        liveName,
      lastLatency: null,
      lastAt:      null,
      sparkline:   [],
      p90:         0,
      avgLatency:  0,
      uptimePct:   100,
      totalEvents: 0,
      failedEvents:0,
      byType:      {},
    }
  })

  if (!fullData.length) return null

  // Ranking por ping ao vivo (menor = melhor); sem dados → último
  const ranked = [...fullData].sort((a, b) => {
    const la = livePingMap[a.brokerId]?.latencyMs ?? null
    const lb = livePingMap[b.brokerId]?.latencyMs ?? null
    if (la === null && lb === null) {
      // Fallback: histórico p90
      if (!a.totalEvents && !b.totalEvents) return 0
      if (!a.totalEvents) return 1
      if (!b.totalEvents) return -1
      return a.p90 - b.p90
    }
    if (la === null) return 1
    if (lb === null) return -1
    return la - lb
  })

  const medals = ['🥇', '🥈', '🥉']

  function latColor(ms: number | null): string {
    if (ms === null) return C.t2
    if (ms < 300)   return C.gr
    if (ms < 800)   return C.am
    return C.re
  }

  const TYPE_LABELS: Record<string, string> = {
    positions: 'PING',
    order:     'ORDEM',
    close:     'FECHAR',
    modify:    'MODIFY',
  }

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 12 }}>
      {/* Animação do ponto pulsante */}
      <style>{`
        @keyframes rafi-pulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.7); }
        }
        .rafi-ping-dot { animation: rafi-pulse 1.4s ease-in-out infinite; }
      `}</style>

      {/* Header */}
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="rafi-ping-dot" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: C.gr }} />
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
            Broker Ping · Latência em Tempo Real
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Ranking rápido no header — usa ping ao vivo */}
          {ranked.map((b, i) => {
            const lp = livePingMap[b.brokerId]
            const ms = lp?.latencyMs ?? (b.totalEvents > 0 ? b.p90 : null)
            if (ms === null) return null
            return (
              <span key={b.brokerId} style={{ fontSize: 10, color: latColor(ms) }}>
                {medals[i]} {b.nome.split(' ')[0]} <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{ms}ms</span>
              </span>
            )
          })}
          {livePingAt && <span style={{ fontSize: 9, color: C.gr }}>● ao vivo {livePingAt}</span>}
          {!livePingAt && updatedAt && <span style={{ fontSize: 9, color: C.t3 }}>hist. {updatedAt}</span>}
        </div>
      </div>

      {/* Cards */}
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {ranked.map((b, i) => {
          const lp       = livePingMap[b.brokerId]
          const livems   = lp?.latencyMs ?? null
          const liveOk   = lp?.success ?? false
          const spark    = livePingSpark[b.brokerId]?.length
            ? livePingSpark[b.brokerId]
            : b.sparkline
          const dispMs   = livems ?? b.lastLatency
          const col      = latColor(dispMs)
          const hasLive  = livems !== null
          const hasHist  = b.totalEvents > 0
          const noData   = !hasLive && !hasHist

          return (
            <div key={b.brokerId} style={{
              background:   C.s2,
              border:       `1px solid ${noData ? C.bd : col + '66'}`,
              borderTop:    `3px solid ${noData ? C.bd : col}`,
              borderRadius: 8,
              padding:      14,
            }}>
              {/* Cabeçalho: nome + medalha + badge AO VIVO */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.tx }}>{b.nome}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {hasLive && liveOk && (
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: C.gr, background: '#0d2010', border: `1px solid ${C.gr}44`, borderRadius: 3, padding: '1px 5px' }}>
                      AO VIVO
                    </span>
                  )}
                  {hasLive && !liveOk && (
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: C.re, background: '#1a0008', border: `1px solid ${C.re}44`, borderRadius: 3, padding: '1px 5px' }}>
                      TIMEOUT
                    </span>
                  )}
                  <div style={{ fontSize: 16 }}>{medals[i] ?? ''}</div>
                </div>
              </div>

              {/* Ping atual — número grande pulsante */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
                <div style={{ fontSize: 34, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: noData ? C.t3 : col, lineHeight: 1 }}>
                  {noData ? '—' : (dispMs ?? '—')}
                </div>
                {!noData && <span style={{ fontSize: 11, color: C.t2 }}>ms</span>}
                {hasLive && liveOk && (
                  <span className="rafi-ping-dot" style={{
                    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                    background: col, marginLeft: 4,
                  }} />
                )}
              </div>

              {/* Sparkline — acumulada dos pings ao vivo ou histórico */}
              <div style={{ marginBottom: 12, background: C.bg, borderRadius: 4, padding: '4px 0' }}>
                <Sparkline values={spark} color={noData ? C.t3 : col} />
              </div>

              {/* Stats: p90 | média | uptime */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 12 }}>
                {[
                  { label: 'p90',    value: hasHist ? `${b.p90}ms` : (hasLive && livems ? `${livems}ms` : '—') },
                  { label: 'Média',  value: hasHist ? `${b.avgLatency}ms` : (livePingSpark[b.brokerId]?.length ? `${Math.round(livePingSpark[b.brokerId].reduce((s,v) => s+v, 0) / livePingSpark[b.brokerId].length)}ms` : '—') },
                  { label: 'Uptime', value: hasHist ? `${b.uptimePct}%` : (hasLive ? (liveOk ? '100%' : '—') : '—'), color: hasHist ? (b.uptimePct >= 99 ? C.gr : b.uptimePct >= 95 ? C.am : C.re) : (liveOk ? C.gr : C.t3) },
                ].map(s => (
                  <div key={s.label} style={{ background: C.s3, borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: 9, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{s.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: s.color ?? C.tx }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Breakdown por tipo */}
              <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 10 }}>
                <div style={{ fontSize: 9, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                  Latência por operação
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                  {(Object.entries(TYPE_LABELS) as [string, string][]).map(([key, label]) => {
                    const stat = (b.byType as any)[key] as ByTypeStats | undefined
                    return (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.bg, borderRadius: 4, padding: '5px 8px' }}>
                        <span style={{ fontSize: 9, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: stat ? latColor(stat.avg) : C.t3 }}>
                          {stat ? `${stat.avg}ms` : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Rodapé: eventos e falhas */}
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.t3 }}>
                <span>Eventos 24h: <span style={{ color: C.t2 }}>{b.totalEvents.toLocaleString('pt-BR')}</span></span>
                <span>Falhas: <span style={{ color: b.failedEvents > 0 ? C.re : C.t2 }}>{b.failedEvents}</span></span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Legenda dos parâmetros ───────────────────────────────────────────────────
// ── Qualidade de Execução por Corretora ──────────────────────────────────────
function ExecutionQualityPanel({ data, updatedAt, days, onChangeDays, onRefresh }: {
  data: ExecQuality[]
  updatedAt: string
  days: 30 | 90
  onChangeDays: (d: 30 | 90) => void
  onRefresh: () => void
}) {
  const withData = data.filter(b => !b.noData && (b.totalTrades ?? 0) > 0)
  const noData   = data.filter(b => b.noData || (b.totalTrades ?? 0) === 0)

  // Melhor em cada métrica
  const bestWinRate    = withData.length ? Math.max(...withData.map(b => b.winRate ?? 0)) : 0
  const bestPF         = withData.length ? Math.max(...withData.map(b => b.profitFactor ?? 0)) : 0
  const bestSlippage   = withData.filter(b => b.avgSlippagePips != null).length
    ? Math.min(...withData.filter(b => b.avgSlippagePips != null).map(b => b.avgSlippagePips as number)) : null
  const bestExec       = withData.filter(b => b.avgExecMs != null).length
    ? Math.min(...withData.filter(b => b.avgExecMs != null).map(b => b.avgExecMs as number)) : null

  const MetricCell = ({ value, best, unit, lowerIsBetter = false }: {
    value: number | null | undefined; best: number | null; unit: string; lowerIsBetter?: boolean
  }) => {
    if (value == null) return <td style={{ padding: '8px 10px', color: C.t3, fontSize: 11, textAlign: 'right' }}>—</td>
    const isBest = best != null && (lowerIsBetter ? value <= best : value >= best)
    return (
      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{
          fontSize: 12, fontWeight: isBest ? 700 : 400,
          color: isBest ? C.gr : value > 0 ? C.tx : C.re,
          background: isBest ? 'rgba(0,230,118,.1)' : 'transparent',
          padding: isBest ? '2px 5px' : '0',
          borderRadius: isBest ? 4 : 0,
        }}>
          {unit === 'ms' ? value : unit === '%' ? value : value.toFixed(unit === 'pips' ? 1 : 2)}{unit !== '' ? ` ${unit}` : ''}
          {isBest && <span style={{ fontSize: 8, marginLeft: 3, color: C.gr }}>✓</span>}
        </span>
      </td>
    )
  }

  return (
    <div style={{ marginTop: 28 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2 }}>
            Qualidade de Execução · Comparativo Real por Corretora
          </div>
          {updatedAt && <div style={{ fontSize: 9, color: C.t3, marginTop: 2 }}>atualizado {updatedAt} · dados via MetaAPI</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Seletor de período */}
          <div style={{ display: 'flex', background: C.s2, borderRadius: 6, border: `1px solid ${C.bd}`, overflow: 'hidden' }}>
            {([30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => onChangeDays(d)}
                style={{
                  padding: '4px 10px', fontSize: 10, border: 'none', cursor: 'pointer',
                  background: days === d ? C.cy : 'transparent',
                  color:      days === d ? C.bg : C.t2,
                  fontWeight: days === d ? 700 : 400,
                }}
              >{d}d</button>
            ))}
          </div>
          <button
            onClick={onRefresh}
            style={{ background: 'transparent', border: `1px solid ${C.bd}`, color: C.t2, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 10 }}
          >
            ↻ Atualizar
          </button>
        </div>
      </div>

      <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden' }}>
        {withData.length === 0 && noData.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: C.t2, fontSize: 12 }}>
            Carregando dados de execução...
          </div>
        ) : withData.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: C.t2, fontSize: 12 }}>
            Nenhum trade encontrado nos últimos {days} dias nas corretoras conectadas.
            <br /><span style={{ fontSize: 10, color: C.t3 }}>Os dados aparecem conforme as operações forem realizadas.</span>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: C.s2, borderBottom: `1px solid ${C.bd}` }}>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Corretora</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Trades</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Win Rate</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Profit Factor</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>P&L Total</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>P&L / Trade</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Slippage</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, fontWeight: 600 }}>Exec. Time</th>
                </tr>
              </thead>
              <tbody>
                {withData.map((b, i) => {
                  const logo = getLogo(b.brokerId)
                  return (
                    <tr key={b.brokerId} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.01)' }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: 5, background: logo.bg, border: `1px solid ${logo.bd}`, color: logo.cor, fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {logo.label}
                          </div>
                          <span style={{ color: C.tx, fontWeight: 500 }}>{b.nome}</span>
                        </div>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: C.tx, fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ fontSize: 12 }}>{b.totalTrades}</span>
                        <span style={{ fontSize: 9, color: C.t3, marginLeft: 4 }}>{b.winners}W/{b.losers}L</span>
                      </td>
                      <MetricCell value={b.winRate}          best={bestWinRate}  unit="%" />
                      <MetricCell value={b.profitFactor}     best={bestPF}       unit="" />
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: (b.totalPnl ?? 0) >= 0 ? C.gr : C.re }}>
                          {(b.totalPnl ?? 0) >= 0 ? '+' : ''}{(b.totalPnl ?? 0).toFixed(2)} USD
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ fontSize: 11, color: (b.avgPnl ?? 0) >= 0 ? C.gr : C.re }}>
                          {(b.avgPnl ?? 0) >= 0 ? '+' : ''}{(b.avgPnl ?? 0).toFixed(2)}
                        </span>
                      </td>
                      <MetricCell value={b.avgSlippagePips}  best={bestSlippage} unit="pips" lowerIsBetter />
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {b.avgExecMs != null ? (
                          <span style={{
                            fontSize: 12, fontWeight: b.avgExecMs === bestExec ? 700 : 400,
                            color: b.avgExecMs === bestExec ? C.gr : b.avgExecMs < 500 ? C.tx : b.avgExecMs < 1000 ? C.am : C.re,
                            background: b.avgExecMs === bestExec ? 'rgba(0,230,118,.1)' : 'transparent',
                            padding: b.avgExecMs === bestExec ? '2px 5px' : '0', borderRadius: 4,
                          }}>
                            {b.avgExecMs}ms{b.avgExecMs === bestExec && <span style={{ fontSize: 8, marginLeft: 3 }}>✓</span>}
                          </span>
                        ) : <span style={{ color: C.t3 }}>—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Corretoras sem dados */}
        {noData.length > 0 && (
          <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.bd}`, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 9, color: C.t3, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Sem trades ({days}d):</span>
            {noData.map(b => (
              <span key={b.brokerId} style={{ fontSize: 9, color: C.t3 }}>{b.nome}</span>
            ))}
          </div>
        )}

        {/* Legenda */}
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.bd}`, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <span style={{ fontSize: 9, color: C.t3 }}>✓ melhor da categoria</span>
          <span style={{ fontSize: 9, color: C.t3 }}>Slippage = diferença preço pedido vs preenchido (pips)</span>
          <span style={{ fontSize: 9, color: C.t3 }}>Exec. Time = ordem enviada → confirmada pela corretora</span>
          <span style={{ fontSize: 9, color: C.t3 }}>Baseado em trades reais dos últimos {days} dias</span>
        </div>
      </div>
    </div>
  )
}

function ParamLegend() {
  const items: { label: string; desc: string; detail?: string; color?: string }[] = [
    {
      label: 'Saldo ●',
      desc:  'Saldo atual da conta em dólares.',
      detail: 'Quando o ponto ● aparece ao lado, o valor veio ao vivo da MetaAPI (conta conectada). Sem ●, é o último valor salvo no Supabase.',
      color: C.cy,
    },
    {
      label: 'P&L Hoje',
      desc:  'Lucro ou perda acumulado nas operações FECHADAS no dia.',
      detail: 'Não inclui posições abertas. Verde = lucro, vermelho = perda. Zera à meia-noite (servidor MetaAPI).',
      color: C.gr,
    },
    {
      label: 'Posições',
      desc:  'Número de trades abertos neste momento nesta corretora.',
    },
    {
      label: 'Health Score',
      desc:  'Pontuação de saúde da corretora de 0 a 100.',
      detail: 'Calculado automaticamente com dados reais de cada chamada MetaAPI: 40% latência p90 (quanto mais rápido, melhor), 50% taxa de sucesso dos últimos 50 eventos, 10% recência (inativo > 2h perde pontos). ≥ 78 = ACTIVE, ≥ 52 = ACTIVE_REDUCED, ≥ 25 = STANDBY, < 25 = QUARANTINED. Atualiza a cada 60s enquanto este painel estiver aberto.',
      color: C.am,
    },
    {
      label: 'CB (Circuit Breaker)',
      desc:  'Interruptor automático de segurança.',
      detail: 'FECHADO ✓ = corretora operacional, pode receber ordens. ABERTO ✗ = corretora bloqueada automaticamente após falhas consecutivas (ex.: 3 rejeições seguidas). O bot ignora corretoras com CB ABERTO na replicação.',
    },
    {
      label: 'Estado',
      desc:  'Status operacional da corretora no sistema de roteamento.',
      detail: 'ACTIVE = plena operação (prioridade máxima). ACTIVE_REDUCED = operando com restrições (spread alto ou latência elevada). STANDBY = em espera, só recebe ordens se as ACTIVE falharem. QUARANTINED = excluída de todos os roteamentos por falhas graves.',
    },
    {
      label: 'Símbolo',
      desc:  'Par de moedas configurado nesta corretora.',
      detail: 'Exness usa EURUSDz (sufixo "z" do servidor). Pepperstone e Tickmill usam EURUSD padrão. O sistema normaliza automaticamente na correspondência cruzada de posições.',
      color: C.cy,
    },
    {
      label: 'Lote',
      desc:  'Tamanho de posição (lotes) calculado automaticamente pelo saldo atual.',
      detail: 'Baseado na tabela de faixas cadastrada em Configurações. Ex.: $5.000 → 0.10 lote, $10.000 → 0.20 lote. Aparece no formato "0.10L" no card.',
    },
    {
      label: 'Priority',
      desc:  'Número de prioridade para desempate no ranking (menor = mais prioritário).',
      detail: 'Usado quando duas corretoras têm o mesmo estado e health score. Ex.: Priority 1 bate Priority 2 se tudo mais for igual.',
    },
    {
      label: '★ MELHOR P&L',
      desc:  'Badge no painel de Performance: corretora com maior lucro total nas posições abertas.',
      color: C.gr,
    },
    {
      label: '⚡ MELHOR FILL',
      desc:  'Badge no painel de Performance: corretora com melhor preço de entrada para o mesmo símbolo.',
      detail: 'Em BUY: menor openPrice = entrou mais barato = melhor fill. Em SELL: maior openPrice = entrou mais caro = melhor fill. Spread diferente entre corretoras é normal — não significa manipulação.',
      color: C.cy,
    },
  ]

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 12, marginBottom: 8 }}>
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
          Guia dos Parâmetros · O que cada número significa
        </div>
      </div>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
          {items.map((item) => (
            <div key={item.label} style={{
              background: C.s2,
              border:     `1px solid ${C.bd}`,
              borderLeft: `3px solid ${item.color ?? C.t3}`,
              borderRadius: 6,
              padding:    '10px 12px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: item.color ?? C.tx, marginBottom: 4, letterSpacing: '0.04em' }}>
                {item.label}
              </div>
              <div style={{ fontSize: 11, color: C.tx, lineHeight: 1.5, marginBottom: item.detail ? 6 : 0 }}>
                {item.desc}
              </div>
              {item.detail && (
                <div style={{ fontSize: 10, color: C.t2, lineHeight: 1.6, borderTop: `1px solid ${C.bd}`, paddingTop: 6 }}>
                  {item.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Card individual de corretora ──────────────────────────────────────────
function BrokerCard({ broker, faixas, live, onToggle, onToggleBot, toggling, togglingBot, onCred, selected, onSelect }: {
  broker: Broker
  faixas: FaixaLote[]
  live?: LiveData
  onToggle: (b: Broker) => void
  onToggleBot: (b: Broker) => void
  toggling: boolean
  togglingBot: boolean
  onCred: (b: Broker) => void
  selected?: boolean
  onSelect?: (id: string) => void
}) {
  const logo    = getLogo(broker.id)
  const active  = broker.enabled
  const displayBalance = live?.connected ? live.balance : (broker.saldo ?? 0)
  const displayPnl     = live?.connected ? live.todayPnl : (broker.pnl_hoje ?? 0)
  const pnlColor = displayPnl > 0 ? C.gr : displayPnl < 0 ? C.re : C.tx

  return (
    <div
      style={{
        background: C.s1,
        border: `1.5px solid ${selected ? C.cy : active ? C.gr : C.bd}`,
        borderRadius: 10,
        overflow: 'hidden',
        transition: 'border-color .2s',
        cursor: onSelect ? 'default' : undefined,
      }}
    >
      <div style={{ height: 3, background: selected ? C.cy : active ? C.gr : C.bd, transition: 'background .2s' }} />

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

          {/* Checkbox + Toggles */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {onSelect && (
              <button
                onClick={() => onSelect(broker.id)}
                title={selected ? 'Desmarcar' : 'Selecionar para ação em lote'}
                style={{
                  width: 18, height: 18, borderRadius: 4, marginTop: 2, flexShrink: 0,
                  border: `1.5px solid ${selected ? C.cy : C.t3}`,
                  background: selected ? 'rgba(0,217,255,.15)' : C.s2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                {selected && <span style={{ width: 8, height: 8, background: C.cy, borderRadius: 2, display: 'block' }} />}
              </button>
            )}

          {/* Toggles — Mesa e Bot separados */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            {/* Mesa toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8, color: active ? C.gr : C.t3, letterSpacing: '0.08em' }}>MESA</span>
              <button
                onClick={() => !toggling && onToggle(broker)}
                disabled={toggling}
                title={active ? `Desativar Mesa ${broker.nome}` : `Ativar Mesa ${broker.nome}`}
                style={{
                  width: 34, height: 18, borderRadius: 9, border: 'none',
                  cursor: toggling ? 'wait' : 'pointer',
                  background: active ? C.gr : C.s3,
                  position: 'relative', transition: 'background .2s',
                  opacity: toggling ? 0.6 : 1, flexShrink: 0,
                }}
              >
                <span style={{
                  position: 'absolute', top: 2, width: 14, height: 14, borderRadius: '50%',
                  background: '#fff', transition: 'left .2s',
                  left: active ? 18 : 2,
                }} />
              </button>
            </div>
            {/* Bot toggle — só disponível se Mesa estiver ativa */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8, color: (broker.bot_enabled && active) ? C.am : C.t3, letterSpacing: '0.08em' }}>BOT</span>
              <button
                onClick={() => !togglingBot && active && onToggleBot(broker)}
                disabled={togglingBot || !active}
                title={!active ? 'Ative a Mesa primeiro' : (broker.bot_enabled ? `Desativar Bot ${broker.nome}` : `Ativar Bot ${broker.nome}`)}
                style={{
                  width: 34, height: 18, borderRadius: 9, border: 'none',
                  cursor: (togglingBot || !active) ? 'not-allowed' : 'pointer',
                  background: (broker.bot_enabled && active) ? C.am : C.s3,
                  position: 'relative', transition: 'background .2s',
                  opacity: (!active || togglingBot) ? 0.4 : 1, flexShrink: 0,
                }}
              >
                <span style={{
                  position: 'absolute', top: 2, width: 14, height: 14, borderRadius: '50%',
                  background: '#fff', transition: 'left .2s',
                  left: (broker.bot_enabled && active) ? 18 : 2,
                }} />
              </button>
            </div>
          </div>
          </div>{/* end checkbox+toggles wrapper */}
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
                  {broker.motivo_estado
                    ? broker.motivo_estado
                    : (broker.health_score ?? 0) === 0
                      ? `Bot offline — inicie no VPS: py -m src.executor --broker ${broker.id}`
                      : ''}
                </div>
              </div>
            </div>
          </div>
        ) : broker.enabled ? (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: C.s2, borderRadius: 6, border: `1px solid ${C.bd}` }}>
            <div style={{ fontSize: 10, color: C.t3 }}>
              <span style={{ color: C.gr }}>Mesa de Operação: pronta</span>
              <span style={{ color: C.bd, margin: '0 6px' }}>|</span>
              <span>Bot automático: offline — inicie no VPS com <code style={{ color: C.am }}>py -m src.executor --broker {broker.id}</code></span>
            </div>
          </div>
        ) : null}

        {/* Status pill + symbol + config button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {/* Mesa de Operação status */}
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '3px 7px', borderRadius: 4,
              background: active ? '#0d2016' : C.s3,
              color: active ? C.gr : C.t2,
              border: `1px solid ${active ? '#1a4028' : C.bd}`,
            }}>
              {active ? '● MESA ON' : '○ DESABILITADA'}
            </div>
            {/* Bot status — só aparece quando habilitada */}
            {active && (() => {
              const st = broker.status_text ?? ''
              // Usa bot_heartbeat_at (atualizado SOMENTE pelo bot) para detectar staleness
              // Fallback para updated_at se a coluna ainda não existir no Supabase
              const hbAt = broker.bot_heartbeat_at ?? broker.updated_at
              const secsOld = hbAt ? (Date.now() - new Date(hbAt).getTime()) / 1000 : Infinity
              const botOnline = st !== '' && st !== 'DESLIGADA' && secsOld < 180
              return (
                <div
                  title={botOnline ? undefined : `Iniciar no VPS: py -m src.executor --broker ${broker.id}`}
                  style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    padding: '3px 7px', borderRadius: 4,
                    background: botOnline ? 'rgba(255,179,0,.08)' : C.s3,
                    color: botOnline ? C.am : C.t3,
                    border: `1px solid ${botOnline ? 'rgba(255,179,0,.25)' : C.bd}`,
                  }}>
                  {botOnline ? `BOT: ${st}` : 'BOT: OFFLINE'}
                </div>
              )
            })()}
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
function calcExecScore(eq: ExecQuality | undefined): number | null {
  if (!eq || eq.noData) return null
  const win  = eq.winRate        ?? null
  const pf   = eq.profitFactor   ?? null
  const slip = eq.avgSlippagePips ?? null
  const exec = eq.avgExecMs       ?? null

  // Cada componente normalizado para 0–100
  const winScore  = win  !== null ? win  : null
  const pfScore   = pf   !== null ? Math.min(pf / 3.0, 1) * 100 : null
  const slipScore = slip !== null ? Math.max(0, 100 - (slip / 3.0) * 100) : null
  const execScore = exec !== null ? Math.max(0, 100 - (exec / 5000) * 100) : null

  // Pesos: win 30%, pf 30%, slip 25%, exec 15%
  let total = 0; let weight = 0
  if (winScore  !== null) { total += winScore  * 0.30; weight += 0.30 }
  if (pfScore   !== null) { total += pfScore   * 0.30; weight += 0.30 }
  if (slipScore !== null) { total += slipScore * 0.25; weight += 0.25 }
  if (execScore !== null) { total += execScore * 0.15; weight += 0.15 }

  return weight > 0 ? Math.round(total / weight) : null
}

function BrokerRanking({ ranking, loading, execQuality }: {
  ranking:     RankedBroker[]
  loading:     boolean
  execQuality: ExecQuality[]
}) {
  const RANK_COLORS = ['#f59e0b', '#94a3b8', '#b45309']

  const estadoCor = (estado: string) => {
    if (estado === 'ACTIVE')         return C.gr
    if (estado === 'ACTIVE_REDUCED') return C.am
    if (estado === 'STANDBY')        return C.bl
    return C.re
  }

  // Mapeia execQuality por brokerId para acesso rápido
  const eqMap: Record<string, ExecQuality> = {}
  for (const eq of execQuality) eqMap[eq.brokerId] = eq

  // Calcula scores de execução para realçar o melhor
  const scores = ranking.map(b => ({ id: b.id, score: calcExecScore(eqMap[b.id]) }))
  const bestExecScore = scores.reduce((best, s) => (s.score !== null && (best === null || s.score > best) ? s.score : best), null as number | null)

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
          Ranking Dinâmico · Cascata de Seleção Automática
        </div>
        {loading
          ? <span style={{ fontSize: 9, color: C.t3 }}>carregando...</span>
          : <span style={{ fontSize: 9, color: C.t2 }}>atualiza a cada 30s · critérios: estado → health score → prioridade · exec score: win rate + PF + slippage + velocidade</span>
        }
      </div>

      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {loading && ranking.length === 0 && (
          <div style={{ gridColumn: '1/-1', color: C.t3, fontSize: 12, textAlign: 'center', padding: 24 }}>
            Buscando ranking...
          </div>
        )}
        {ranking.map((b) => {
          const rankColor  = RANK_COLORS[b.rank - 1] ?? C.t2
          const isTop      = b.rank === 1
          const eq         = eqMap[b.id]
          const execScore  = calcExecScore(eq)
          const isBestExec = execScore !== null && execScore === bestExecScore

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

              {/* Exec Score — qualidade de execução real */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: C.t2 }}>Exec Score</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isBestExec && (
                      <span style={{ background: '#002a15', border: `1px solid ${C.gr}`, color: C.gr, borderRadius: 3, padding: '1px 5px', fontSize: 8, fontWeight: 700 }}>
                        ★ MELHOR
                      </span>
                    )}
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: execScore !== null ? (execScore >= 65 ? C.gr : execScore >= 40 ? C.am : C.re) : C.t3 }}>
                      {execScore !== null ? execScore : '—'}
                    </span>
                  </span>
                </div>
                <div style={{ height: 4, background: C.bd, borderRadius: 3, overflow: 'hidden' }}>
                  {execScore !== null && (
                    <div style={{
                      height: '100%',
                      width:  `${execScore}%`,
                      background: execScore >= 65 ? C.gr : execScore >= 40 ? C.am : C.re,
                      borderRadius: 3,
                    }} />
                  )}
                </div>
                {/* Detalhes de execução */}
                {eq && !eq.noData && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, marginTop: 6, fontSize: 9, color: C.t3, textAlign: 'center' }}>
                    <div>
                      <div style={{ color: C.t2, marginBottom: 1 }}>Win%</div>
                      <div style={{ color: C.tx, fontVariantNumeric: 'tabular-nums' }}>{eq.winRate ?? '—'}</div>
                    </div>
                    <div>
                      <div style={{ color: C.t2, marginBottom: 1 }}>PF</div>
                      <div style={{ color: C.tx, fontVariantNumeric: 'tabular-nums' }}>{eq.profitFactor ?? '—'}</div>
                    </div>
                    <div>
                      <div style={{ color: C.t2, marginBottom: 1 }}>Slip</div>
                      <div style={{ color: C.tx, fontVariantNumeric: 'tabular-nums' }}>{eq.avgSlippagePips != null ? `${eq.avgSlippagePips}p` : '—'}</div>
                    </div>
                    <div>
                      <div style={{ color: C.t2, marginBottom: 1 }}>Exec</div>
                      <div style={{ color: C.tx, fontVariantNumeric: 'tabular-nums' }}>{eq.avgExecMs != null ? `${eq.avgExecMs}ms` : '—'}</div>
                    </div>
                  </div>
                )}
                {(!eq || eq.noData) && (
                  <div style={{ fontSize: 9, color: C.t3, marginTop: 4, textAlign: 'center' }}>sem histórico de trades</div>
                )}
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
                <div style={{ fontSize: 10, color: C.t2, lineHeight: 1.6 }}>
                  {b.reason.split('\n').map((line, li) => (
                    <div key={li} style={{ color: line.includes('← ') ? C.tx : C.t2 }}>
                      {line.includes('← ') ? (
                        <>
                          {line.replace(' ← perdeu aqui', '').replace(' ← critério decisivo', '').replace(' ← decisivo', '')}
                          <span style={{ color: C.am, fontWeight: 700, marginLeft: 4 }}>
                            {line.includes('← critério decisivo') ? '← decisivo' :
                             line.includes('← decisivo') ? '← decisivo' : '← perde aqui'}
                          </span>
                        </>
                      ) : line}
                    </div>
                  ))}
                  {execScore !== null && (
                    <div style={{ color: execScore >= 65 ? C.gr : execScore >= 40 ? C.am : C.re, marginTop: 2 }}>
                      Exec Score: {execScore}/100{isBestExec ? ' — melhor entre as corretoras' : ''}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Painel de performance em tempo real ─────────────────────────────────────
function LivePerformance({ data, loading, updatedAt }: { data: BrokerLiveData[]; loading: boolean; updatedAt: string }) {
  const totalPositions = data.reduce((s, b) => s + b.positions.length, 0)
  const hasPositions   = totalPositions > 0

  // Para cada símbolo aberto, calcula quem tem o melhor fill (menor openPrice em BUY, maior em SELL)
  const bestFill: Record<string, string> = {}
  if (hasPositions) {
    const bySymbol: Record<string, { brokerId: string; openPrice: number; type: string }[]> = {}
    for (const b of data) {
      for (const p of b.positions) {
        if (!bySymbol[p.symbol]) bySymbol[p.symbol] = []
        bySymbol[p.symbol].push({ brokerId: b.brokerId, openPrice: p.openPrice, type: p.type })
      }
    }
    for (const [sym, entries] of Object.entries(bySymbol)) {
      if (entries.length < 2) continue
      const isBuy = entries[0].type === 'buy'
      const winner = entries.reduce((best, cur) =>
        isBuy ? (cur.openPrice < best.openPrice ? cur : best)
               : (cur.openPrice > best.openPrice ? cur : best)
      )
      bestFill[sym] = winner.brokerId
    }
  }

  // Ranking por P&L total (maior = melhor)
  const sorted = [...data].sort((a, b) => b.totalPnl - a.totalPnl)
  const topPnlId = sorted[0]?.brokerId

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 12 }}>
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
          Performance em Tempo Real · Posições Abertas
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loading && <span style={{ fontSize: 9, color: C.cy }}>● atualizando...</span>}
          {updatedAt && <span style={{ fontSize: 9, color: C.t3 }}>atualizado {updatedAt}</span>}
          {!hasPositions && !loading && (
            <span style={{ fontSize: 9, color: C.t3 }}>Nenhuma posição aberta</span>
          )}
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {!hasPositions && !loading ? (
          <div style={{ textAlign: 'center', color: C.t3, fontSize: 12, padding: '24px 0' }}>
            Sem posições abertas em nenhuma corretora
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {data.map((b) => {
              const isTopPnl    = b.brokerId === topPnlId && hasPositions && b.positions.length > 0
              const pnlPositive = b.totalPnl >= 0
              const hasBestFill = b.positions.some(p => bestFill[p.symbol] === b.brokerId)

              return (
                <div key={b.brokerId} style={{
                  background:   C.s2,
                  border:       `1px solid ${isTopPnl ? C.gr : C.bd}`,
                  borderTop:    `3px solid ${isTopPnl ? C.gr : C.bd}`,
                  borderRadius: 8,
                  padding:      14,
                }}>
                  {/* Cabeçalho */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, flex: 1 }}>{b.nome}</div>
                    {isTopPnl && b.positions.length > 0 && (
                      <span style={{ background: '#0d2010', border: `1px solid ${C.gr}`, color: C.gr, borderRadius: 4, padding: '2px 6px', fontSize: 9, fontWeight: 700 }}>
                        ★ MELHOR P&L
                      </span>
                    )}
                    {hasBestFill && (
                      <span style={{ background: '#0a1a20', border: `1px solid ${C.cy}`, color: C.cy, borderRadius: 4, padding: '2px 6px', fontSize: 9, fontWeight: 700 }}>
                        ⚡ MELHOR FILL
                      </span>
                    )}
                  </div>

                  {/* P&L total */}
                  {b.positions.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, background: C.bg, borderRadius: 6, padding: '8px 10px' }}>
                      <span style={{ fontSize: 10, color: C.t2 }}>P&L Total</span>
                      <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: pnlPositive ? C.gr : C.re }}>
                        {pnlPositive ? '+' : ''}{b.totalPnl.toFixed(2)} USD
                      </span>
                    </div>
                  )}

                  {/* Sem posições */}
                  {b.positions.length === 0 && (
                    <div style={{ textAlign: 'center', color: C.t3, fontSize: 11, padding: '12px 0' }}>
                      {b.error ? `Erro ${b.error}` : 'Sem posições'}
                    </div>
                  )}

                  {/* Posições individuais */}
                  {b.positions.map((p) => {
                    const posPnlPos = p.profit >= 0
                    const isBestFillPos = bestFill[p.symbol] === b.brokerId
                    const pips = Math.abs(p.currentPrice - p.openPrice) * 10000

                    return (
                      <div key={p.id} style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 10, marginTop: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 10, color: C.cy, fontFamily: 'monospace', fontWeight: 700 }}>{p.symbol}</span>
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                              background: p.type === 'buy' ? '#0d2010' : '#200d0d',
                              color:      p.type === 'buy' ? C.gr : C.re,
                              border:     `1px solid ${p.type === 'buy' ? C.gr : C.re}`,
                            }}>
                              {p.type === 'buy' ? '▲ BUY' : '▼ SELL'}
                            </span>
                            <span style={{ fontSize: 9, color: C.t2 }}>{p.volume}L</span>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: posPnlPos ? C.gr : C.re }}>
                            {posPnlPos ? '+' : ''}{p.profit.toFixed(2)}
                          </span>
                        </div>

                        {/* Preços */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: 10 }}>
                          <div>
                            <div style={{ color: C.t3, fontSize: 9, marginBottom: 2 }}>ENTRADA</div>
                            <div style={{ color: C.tx, fontFamily: 'monospace', fontWeight: 700 }}>
                              {p.openPrice.toFixed(5)}
                              {isBestFillPos && <span style={{ color: C.cy, fontSize: 8, marginLeft: 3 }}>★</span>}
                            </div>
                          </div>
                          <div>
                            <div style={{ color: C.t3, fontSize: 9, marginBottom: 2 }}>ATUAL</div>
                            <div style={{ color: C.tx, fontFamily: 'monospace' }}>{p.currentPrice.toFixed(5)}</div>
                          </div>
                          <div>
                            <div style={{ color: C.t3, fontSize: 9, marginBottom: 2 }}>PIPS</div>
                            <div style={{ color: posPnlPos ? C.gr : C.re, fontFamily: 'monospace', fontWeight: 600 }}>
                              {posPnlPos ? '+' : '-'}{pips.toFixed(1)}
                            </div>
                          </div>
                        </div>

                        {/* SL / TP */}
                        <div style={{ display: 'flex', gap: 10, fontSize: 9, color: C.t3, marginTop: 6 }}>
                          <span>SL: <span style={{ color: C.re, fontFamily: 'monospace' }}>{p.stopLoss?.toFixed(5) ?? '—'}</span></span>
                          <span>TP: <span style={{ color: C.gr, fontFamily: 'monospace' }}>{p.takeProfit?.toFixed(5) ?? '—'}</span></span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

