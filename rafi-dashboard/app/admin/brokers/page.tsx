'use client'

import { useEffect, useState, useCallback } from 'react'
import { Globe, RefreshCw, Settings, Eye, EyeOff, Lock } from 'lucide-react'

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

// ── Tabela de lotes (compartilhada com config) ────────────────────────────
const FAIXAS_LOTE = [
  { min: 0,      max: 40,       lote:   0.10, pip: '$1/pip'   },
  { min: 40,     max: 80,       lote:   0.20, pip: '$2/pip'   },
  { min: 80,     max: 150,      lote:   0.40, pip: '$4/pip'   },
  { min: 150,    max: 200,      lote:   0.70, pip: '$7/pip'   },
  { min: 200,    max: 400,      lote:   1.00, pip: '$10/pip'  },
  { min: 400,    max: 800,      lote:   2.00, pip: '$20/pip'  },
  { min: 800,    max: 1500,     lote:   4.00, pip: '$40/pip'  },
  { min: 1500,   max: 3000,     lote:   8.00, pip: '$80/pip'  },
  { min: 3000,   max: 6000,     lote:  15.00, pip: '$150/pip' },
  { min: 6000,   max: 10000,    lote:  30.00, pip: '$300/pip' },
  { min: 10000,  max: 20000,    lote:  50.00, pip: '$500/pip' },
  { min: 20000,  max: Infinity, lote: 100.00, pip: '$1k/pip'  },
]

interface Broker {
  id:           string
  nome:         string
  servidor:     string
  login:        number
  simbolo:      string
  enabled:      boolean
  saldo:        number
  posicoes:     number
  pnl_hoje:     number
  status_text:  string
  updated_at:   string
  mt5_login?:   number | null
  mt5_servidor?: string | null
  mt5_simbolo?: string | null
  mt5_path?:    string | null
  mt5_senha?:   string | null
}

interface CredForm {
  mt5_login:    string
  mt5_senha:    string
  mt5_servidor: string
  mt5_simbolo:  string
  mt5_path:     string
}

// ── Logo por corretora ───────────────────────────────────────────────────
const LOGOS: Record<string, { label: string; cor: string; bg: string; bd: string }> = {
  xm:          { label: 'XM',  cor: C.gr, bg: '#0d2016', bd: '#1a4028' },
  pepperstone: { label: 'PP',  cor: C.bl, bg: '#0d1a28', bd: '#1a2a44' },
  exness:      { label: 'EX',  cor: C.cy, bg: '#0a1a20', bd: '#1a3040' },
  tickmill:    { label: 'TI',  cor: C.am, bg: '#1a1500', bd: '#302800' },
}
function getLogo(id: string) {
  return LOGOS[id] ?? { label: id.slice(0,2).toUpperCase(), cor: C.t2, bg: C.s3, bd: C.bd }
}

const MT5_PATHS: Record<string, string> = {
  pepperstone: "C:\\Program Files\\MetaTrader 5\\terminal64.exe",
  exness:      "C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe",
  tickmill:    "C:\\Program Files\\Tickmill UK MT5 Terminal\\terminal64.exe",
}

// ── Componente principal ─────────────────────────────────────────────────
export default function BrokersPage() {
  const [brokers, setBrokers]   = useState<Broker[]>([])
  const [loading, setLoading]   = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState('')

  // Modal de credenciais
  const [credBroker, setCredBroker] = useState<Broker | null>(null)
  const [credForm,   setCredForm]   = useState<CredForm>({ mt5_login: '', mt5_senha: '', mt5_servidor: '', mt5_simbolo: '', mt5_path: '' })
  const [credSaving, setCredSaving] = useState(false)
  const [credOk,     setCredOk]     = useState(false)
  const [showSenha,  setShowSenha]  = useState(false)

  const fetchBrokers = useCallback(async () => {
    try {
      const res  = await fetch('/api/brokers')
      const json = await res.json()
      if (json.brokers) {
        setBrokers(json.brokers)
        setLastUpdate(new Date().toLocaleTimeString('pt-BR'))
      }
    } catch {
      // silencioso — não bloqueia a UI
    } finally {
      setLoading(false)
    }
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
      mt5_login:    String(broker.mt5_login ?? broker.login ?? ''),
      mt5_senha:    '',
      mt5_servidor: broker.mt5_servidor ?? broker.servidor ?? '',
      mt5_simbolo:  broker.mt5_simbolo  ?? broker.simbolo  ?? '',
      mt5_path:     broker.mt5_path     ?? MT5_PATHS[broker.id] ?? '',
    })
  }

  const salvarCred = async () => {
    if (!credBroker) return
    setCredSaving(true)
    try {
      const body: Record<string, unknown> = {
        id:           credBroker.id,
        mt5_login:    credForm.mt5_login    ? Number(credForm.mt5_login) : null,
        mt5_servidor: credForm.mt5_servidor || null,
        mt5_simbolo:  credForm.mt5_simbolo  || null,
        mt5_path:     credForm.mt5_path     || null,
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
          {lastUpdate && (
            <span style={{ color: C.t3, fontSize: 10 }}>atualizado {lastUpdate}</span>
          )}
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
          {brokers.map((b) => <BrokerCard key={b.id} broker={b} onToggle={toggle} toggling={toggling === b.id} onCred={abrirCred} />)}
        </div>
      )}

      {/* Config compartilhado */}
      <SharedConfig />

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
              { label: 'Login MT5', key: 'mt5_login', type: 'number', placeholder: credBroker.login?.toString() ?? '12345678' },
              { label: 'Servidor',  key: 'mt5_servidor', type: 'text', placeholder: credBroker.servidor ?? 'Broker-Live01' },
              { label: 'Símbolo',   key: 'mt5_simbolo', type: 'text', placeholder: credBroker.simbolo ?? 'EURUSD' },
              { label: 'MT5 Path',  key: 'mt5_path', type: 'text', placeholder: MT5_PATHS[credBroker.id] ?? '' },
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
function BrokerCard({ broker, onToggle, toggling, onCred }: { broker: Broker; onToggle: (b: Broker) => void; toggling: boolean; onCred: (b: Broker) => void }) {
  const logo   = getLogo(broker.id)
  const active = broker.enabled

  const pnlColor = broker.pnl_hoje > 0 ? C.gr : broker.pnl_hoje < 0 ? C.re : C.tx

  return (
    <div style={{
      background: C.s1,
      border: `1px solid ${active ? C.gr : C.bd}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'border-color .2s',
    }}>
      {/* Status bar */}
      <div style={{ height: 3, background: active ? C.gr : C.bd }} />

      <div style={{ padding: 16 }}>
        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          {/* Identity */}
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
          <Metric label="Saldo"     value={`$${(broker.saldo ?? 0).toFixed(2)}`}      color={active ? C.gr : C.tx} />
          <Metric label="Posições"  value={active ? String(broker.posicoes ?? 0) : '—'} />
          <Metric label="P&L Hoje"  value={active ? `${broker.pnl_hoje >= 0 ? '+' : ''}$${(broker.pnl_hoje ?? 0).toFixed(2)}` : '—'} color={active ? pnlColor : C.t2} />
        </div>

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
              {broker.simbolo} · {lotePorSaldo(broker.saldo ?? 0)}L
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

function lotePorSaldo(saldo: number): string {
  const f = FAIXAS_LOTE.find((x) => saldo >= x.min && saldo < x.max)
  return f ? f.lote.toFixed(2) : '0.10'
}

// ── Painel de configurações compartilhadas ────────────────────────────────
function SharedConfig() {
  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 10, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ background: C.s2, borderBottom: `1px solid ${C.bd}`, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.tx }}>
          Parâmetros do Bot — válidos para todas as corretoras ativas
        </div>
        <div style={{ fontSize: 9, color: C.t2 }}>edite em /admin/config</div>
      </div>

      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Estratégia */}
        <div>
          <SectionTitle>Estratégia RAFI</SectionTitle>
          {[
            ['RAFI Limiar', '2.50'], ['MA Rápida', '20'], ['MA Lenta', '50'],
            ['S/R Lookback', '50'], ['Swing Stop', '150'],
            ['Bollinger Filtro', 'ATIVO'], ['R:R', '1.5×'], ['Máx. Posições', '1'],
          ].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
              <span style={{ fontSize: 12, color: C.t2 }}>{k}</span>
              <span style={{ fontSize: 12, color: v === 'ATIVO' || v === '2.50' || v.includes('×') ? C.gr : C.tx, fontWeight: 500 }}>{v}</span>
            </div>
          ))}

          <SectionTitle style={{ marginTop: 14 }}>Backtest vencedor</SectionTitle>
          {[['Trades', '56'], ['Win Rate', '~69%'], ['Retorno', '+$3.769']].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
              <span style={{ fontSize: 12, color: C.t2 }}>{k}</span>
              <span style={{ fontSize: 12, color: k === 'Trades' ? C.tx : C.gr, fontWeight: 500 }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Tabela de lotes */}
        <div>
          <SectionTitle>Crescimento de Lote — automático por saldo</SectionTitle>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                {['Capital', 'Lote', 'Pip value'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.t2, padding: '4px 6px 8px', borderBottom: `1px solid ${C.bd}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FAIXAS_LOTE.map((f, i) => (
                <tr key={i}>
                  <td style={{ padding: '5px 6px', color: C.tx, borderBottom: `1px solid #111b27` }}>
                    ${f.min.toLocaleString('pt-BR')} – {f.max === Infinity ? '+' : `$${f.max.toLocaleString('pt-BR')}`}
                  </td>
                  <td style={{ padding: '5px 6px', color: C.gr, fontWeight: 700, borderBottom: `1px solid #111b27` }}>{f.lote.toFixed(2)}L</td>
                  <td style={{ padding: '5px 6px', color: C.bl, borderBottom: `1px solid #111b27` }}>{f.pip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2,
      marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${C.bd}`, ...style,
    }}>
      {children}
    </div>
  )
}
