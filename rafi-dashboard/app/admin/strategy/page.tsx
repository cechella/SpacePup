'use client'

import { useEffect, useState } from 'react'
import { Settings2, RefreshCw, CheckCircle, AlertCircle, Sliders } from 'lucide-react'
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null

interface BotConfig {
  autoscan_min_breakout?: number
  autoscan_min_gap_candles?: number
  autoscan_stop_offset?: number
  bb_squeeze_expansao_min?: number
  sr_lookback?: number
  ratio_risco_retorno?: number
  risco_por_trade?: number
  max_trades_simultaneos?: number
  max_stop_pips?: number
  max_duracao_candles?: number
  spread_pips?: number
  slippage_pips?: number
  comissao_por_lote?: number
  updated_at?: string
}

const C = {
  bg: '#0d1117', s1: '#161b22', s2: '#21262d', s3: '#30363d',
  bd: '#30363d', cy: '#3b82f6', gr: '#10b981', am: '#f59e0b',
  re: '#ef4444', tx: '#f0f6fc', t2: '#8b949e', t3: '#484f58',
}

function Row({ label, value, unit = '', note = '' }: { label: string; value: string | number; unit?: string; note?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderBottom: `1px solid ${C.bd}`, fontSize: 12 }}>
      <div>
        <span style={{ color: C.tx }}>{label}</span>
        {note && <span style={{ color: C.t3, fontSize: 10, marginLeft: 8 }}>{note}</span>}
      </div>
      <div style={{ fontFamily: 'monospace', fontWeight: 700, color: C.cy }}>
        {value}{unit && <span style={{ color: C.t3, fontWeight: 400, marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  )
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div style={{ background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Icon size={14} color={C.cy} />
        <span style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>{title}</span>
      </div>
      {children}
    </div>
  )
}

export default function StrategyPage() {
  const [cfg, setCfg] = useState<BotConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      if (!supa) throw new Error('Supabase não configurado')
      const { data, error } = await supa
        .from('rafi_bot_config')
        .select('*')
        .eq('profile', 'live')
        .single()
      if (error) throw error
      setCfg(data)
    } catch (e: any) {
      setErr(e.message ?? 'Erro ao carregar configuração')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: 20, fontFamily: 'Inter,system-ui,sans-serif' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap');body{font-family:'Inter',system-ui,sans-serif!important}`}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: C.tx, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Settings2 size={20} color={C.cy} />
            Estratégia Autoscan
          </h1>
          <p style={{ fontSize: 11, color: C.t3, margin: '4px 0 0' }}>
            Parâmetros ativos · EURUSD M5 · OOS WR=68.1% PF=2.33 · 26 anos validados
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{
          display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 14px',
          background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 8, color: C.t2, cursor: 'pointer',
        }}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Atualizar
        </button>
      </div>

      {err && (
        <div style={{ background: '#ef444415', border: `1px solid ${C.re}30`, borderRadius: 8,
          padding: '10px 16px', color: C.re, fontSize: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={14} /> {err}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', color: C.t3, fontSize: 12, paddingTop: 60 }}>
          Carregando configuração…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* Autoscan */}
          <Section title="Autoscan — Parâmetros Chave" icon={Sliders}>
            <div style={{ background: '#10b98110', border: `1px solid #10b98130`, borderRadius: 8,
              padding: '8px 12px', marginBottom: 12, fontSize: 11, color: C.gr, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle size={12} /> Grid-search otimizado · 2.916 combinações × 1,9M candles M5 (26 anos)
            </div>
            <Row label="Min. rompimento" value={cfg?.autoscan_min_breakout !== undefined ? (cfg.autoscan_min_breakout * 10000).toFixed(1) : '5.0'} unit="pips" note="CHAVE do WR 69%" />
            <Row label="Gap mínimo entre trades" value={cfg?.autoscan_min_gap_candles ?? 5} unit="candles (25 min)" note="otimizado 26 anos" />
            <Row label="Buffer no stop" value={cfg?.autoscan_stop_offset !== undefined ? (cfg.autoscan_stop_offset * 10000).toFixed(1) : '1.0'} unit="pips" />
            <Row label="Expansão BB mínima" value={cfg?.bb_squeeze_expansao_min ?? 1.05} unit="×" />
            <Row label="S/R lookback" value={cfg?.sr_lookback ?? 10} unit="candles" note="otimizado 26 anos" />
            <Row label="R:R ratio" value={cfg?.ratio_risco_retorno ?? 1.3} unit="×" note="OOS WR=68.1%" />
          </Section>

          {/* Gestão de Risco */}
          <Section title="Gestão de Risco" icon={AlertCircle}>
            <Row label="Risco por trade" value={cfg?.risco_por_trade !== undefined ? (cfg.risco_por_trade * 100).toFixed(0) : '2'} unit="%" />
            <Row label="Máx. posições simultâneas" value={cfg?.max_trades_simultaneos ?? 1} />
            <Row label="Stop máximo" value={cfg?.max_stop_pips ? `${cfg.max_stop_pips} pips` : 'desativado'} />
            <Row label="Duração máxima" value={cfg?.max_duracao_candles ? `${cfg.max_duracao_candles} candles` : 'sem limite'} />
            <Row label="Spread estimado" value={cfg?.spread_pips ?? 0.1} unit="pips" />
            <Row label="Slippage" value={cfg?.slippage_pips ?? 0.3} unit="pips" />
            <Row label="Comissão" value={cfg?.comissao_por_lote ?? 6.0} unit="$/lote RT" note="Razor $3×2" />
          </Section>

          {/* Resultado OOS */}
          <div style={{ gridColumn: '1 / -1', background: C.s1, border: `1px solid ${C.bd}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 11, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
              Resultado Out-of-Sample (569.748 candles — Nov 2018 → Ago 2026 · nunca vistos no treino)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Win Rate', value: '68.1%', color: C.gr },
                { label: 'Profit Factor', value: '2.33', color: C.cy },
                { label: 'Trades OOS', value: '36.897', color: C.am },
                { label: 'R:R otimizado', value: '1.3×', color: C.cy },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: C.s2, border: `1px solid ${C.bd}`, borderRadius: 8, padding: '14px 16px' }}>
                  <div style={{ fontSize: 9, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 800, color }}>{value}</div>
                </div>
              ))}
            </div>
            {cfg?.updated_at && (
              <div style={{ marginTop: 12, fontSize: 10, color: C.t3, textAlign: 'right' }}>
                Config atualizada: {new Date(cfg.updated_at).toLocaleString('pt-BR')}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
