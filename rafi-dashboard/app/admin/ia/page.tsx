'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import {
  Brain, Power, Shield, Clock, Target, TrendingUp, AlertTriangle,
  CheckCircle, XCircle, RefreshCw, Zap, Calendar, Globe,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createBrowserClient } from '@supabase/ssr'

interface IAConfig {
  ia_autonoma_ativa: boolean
  sessao_sydney_tokyo: boolean
  sessao_tokyo_london: boolean
  meta_diaria_pct: number
  meta_semanal_pct: number
  threshold_confianca: number
  xgboost_mode: 'off' | 'shadow' | 'and' | 'xgboost'
  updated_at: string
}

const XGB_MODES: { key: 'off' | 'shadow' | 'and' | 'xgboost'; label: string; desc: string; color: string }[] = [
  { key: 'off',      label: 'Desativado', desc: 'Usa só similaridade',       color: 'border-white/20 text-white/50' },
  { key: 'shadow',   label: 'Sombra',     desc: 'Similaridade + observa XGB', color: 'border-blue-500/40 text-blue-400' },
  { key: 'and',      label: 'AND',        desc: 'Ambos devem concordar',      color: 'border-amber-500/40 text-amber-400' },
  { key: 'xgboost',  label: 'XGBoost',    desc: 'Só XGBoost decide',          color: 'border-violet-500/40 text-violet-400' },
]

interface IAStats {
  sinaisHoje: number    // registros Supabase (1 por sinal detectado)
  ordensHoje: number    // ordens MT5 reais (sinais × brokers ativos)
  pnlHoje: number
  winsHoje: number
  lossesHoje: number
  totalSemana: number
  pnlSemana: number
}

function useSupabase() {
  const [client] = useState<ReturnType<typeof createBrowserClient> | null>(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return null
    return createBrowserClient(url, key)
  })
  return client
}

function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const dims = {
    sm: { track: 'w-9 h-5', thumb: 'w-4 h-4', on: 'translate-x-4' },
    md: { track: 'w-12 h-6', thumb: 'w-5 h-5', on: 'translate-x-6' },
    lg: { track: 'w-16 h-8', thumb: 'w-6 h-6', on: 'translate-x-8' },
  }[size]

  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out',
        'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0d1117]',
        dims.track,
        checked ? 'bg-emerald-500 focus:ring-emerald-500' : 'bg-white/20 focus:ring-white/30',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow transform transition-transform duration-200 ease-in-out m-0.5',
          dims.thumb,
          checked ? dims.on : 'translate-x-0',
        )}
      />
    </button>
  )
}

const SECURITY_RULES = [
  { icon: <AlertTriangle className="w-4 h-4" />, color: 'text-red-400', label: 'Perda diária > 5%', desc: 'IA para imediatamente até meia-noite' },
  { icon: <CheckCircle className="w-4 h-4" />,   color: 'text-emerald-400', label: 'Meta diária atingida (7%)', desc: 'IA para até o próximo dia' },
  { icon: <Calendar className="w-4 h-4" />,      color: 'text-blue-400', label: 'Meta semanal atingida (25%)', desc: 'IA para até segunda-feira 00:00 (Brasília)' },
  { icon: <Shield className="w-4 h-4" />,        color: 'text-violet-400', label: 'Máx. 2 posições simultâneas', desc: 'Nunca abre 3ª posição enquanto houver 2 abertas' },
  { icon: <Zap className="w-4 h-4" />,           color: 'text-amber-400', label: 'P(sucesso) ≥ 65%', desc: 'IA só entra com alta confiança estatística' },
  { icon: <XCircle className="w-4 h-4" />,       color: 'text-red-400', label: 'Nunca opera sem stop-loss', desc: 'SL validado antes de enviar qualquer ordem' },
]

const SESSION_TIMES = [
  {
    key: 'sessao_sydney_tokyo' as const,
    icon: <Globe className="w-4 h-4" />,
    name: 'Sydney / Tóquio',
    horaBrasil: '20:00 – 04:00',
    horaUtc: '23:00 – 07:00',
    color: 'from-indigo-500 to-blue-600',
    bgColor: 'bg-indigo-500/10',
    borderColor: 'border-indigo-500/30',
    textColor: 'text-indigo-300',
    cronUtc: '02:00 UTC',
  },
  {
    key: 'sessao_tokyo_london' as const,
    icon: <Clock className="w-4 h-4" />,
    name: 'Tóquio / Londres',
    horaBrasil: '04:00 – 05:00',
    horaUtc: '07:00 – 08:00',
    color: 'from-cyan-500 to-teal-600',
    bgColor: 'bg-cyan-500/10',
    borderColor: 'border-cyan-500/30',
    textColor: 'text-cyan-300',
    cronUtc: '07:00 UTC',
  },
]

export default function AdminIAPage() {
  const supa = useSupabase()
  const [config, setConfig] = useState<IAConfig | null>(null)
  const [stats, setStats]   = useState<IAStats | null>(null)
  const [loading, setLoading]   = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [capitalReal, setCapitalReal]       = useState(0)
  const [nBrokersAtivos, setNBrokersAtivos] = useState(4)

  const loadConfig = useCallback(async () => {
    if (!supa) return
    setLoading(true)
    try {
      const [cfgRes, statsHoje, statsSemana] = await Promise.all([
        fetch('/api/ia/status').then(r => r.json()),
        (() => {
          const startOfDay = new Date()
          startOfDay.setUTCHours(0, 0, 0, 0)
          return supa
            .from('rafi_trades')
            .select('result, pnl_usd, label')
            .eq('entry_type', 'ia_autonoma')
            .gte('time', Math.floor(startOfDay.getTime() / 1000))
        })(),
        (() => {
          // Semana começa segunda-feira BRT (UTC-3), igual ao admin dashboard
          const nowBRT2  = new Date(Date.now() - 3 * 60 * 60 * 1000)
          const jsDay2   = nowBRT2.getUTCDay()
          const daysMon2 = jsDay2 === 0 ? 6 : jsDay2 - 1
          const startOfWeek = new Date(nowBRT2)
          startOfWeek.setUTCDate(nowBRT2.getUTCDate() - daysMon2)
          startOfWeek.setUTCHours(0, 0, 0, 0)
          return supa
            .from('rafi_trades')
            .select('pnl_usd')
            .eq('entry_type', 'ia_autonoma')
            .gte('time', Math.floor(startOfWeek.getTime() / 1000))
        })(),
      ])

      setConfig(cfgRes)

      const hoje = statsHoje.data ?? []
      const semana = statsSemana.data ?? []
      // Conta ordens MT5 reais contando positionIds no label de cada sinal
      const ordensHoje = hoje.reduce((sum: number, r: any) => {
        const m = String(r.label ?? '').match(/\|pos:(\S+)/)
        return sum + (m ? m[1].split(',').filter(Boolean).length : 1)
      }, 0)
      setStats({
        sinaisHoje:  hoje.length,
        ordensHoje,
        pnlHoje:     hoje.reduce((s: number, r: any) => s + (Number(r.pnl_usd) || 0), 0),
        winsHoje:    hoje.filter((r: any) => r.result === 'win').length,
        lossesHoje:  hoje.filter((r: any) => r.result === 'loss').length,
        totalSemana: semana.length,
        pnlSemana:   semana.reduce((s: number, r: any) => s + (Number(r.pnl_usd) || 0), 0),
      })
    } finally {
      setLoading(false)
    }
  }, [supa])

  useEffect(() => { loadConfig() }, [loadConfig])

  // Busca capital consolidado real das corretoras ativas
  useEffect(() => {
    async function fetchCapital() {
      try {
        const bRes  = await fetch('/api/brokers')
        const bData = await bRes.json()
        const ativos = (bData.brokers ?? []).filter((b: any) => b.enabled && b.metaapi_account_id)
        setNBrokersAtivos(Math.max(ativos.length, 1))
        const balances = await Promise.all(
          ativos.map((b: any) =>
            fetch(`/api/metaapi/account?accountId=${b.metaapi_account_id}`)
              .then(r => r.json())
              .then(d => Number(d.balance ?? 0))
              .catch(() => 0)
          )
        )
        const total = (balances as number[]).reduce((s, b) => s + b, 0)
        if (total > 0) setCapitalReal(total)
      } catch {}
    }
    fetchCapital()
  }, [])

  async function update(patch: Partial<IAConfig>) {
    const key = Object.keys(patch)[0]
    setUpdating(key)
    try {
      const res = await fetch('/api/ia/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const updated = await res.json()
      setConfig(updated)
    } finally {
      setUpdating(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3 text-white/30">
          <RefreshCw className="w-8 h-8 animate-spin" />
          <p className="text-sm">Carregando...</p>
        </div>
      </div>
    )
  }

  const iaAtiva    = config?.ia_autonoma_ativa ?? false
  const capitalBase = capitalReal > 0 ? capitalReal : 1000  // fallback até carregar
  const metaDiariaUsd  = capitalBase * ((config?.meta_diaria_pct  ?? 7)  / 100)
  const metaSemanaUsd  = capitalBase * ((config?.meta_semanal_pct ?? 25) / 100)
  const pnlHoje   = stats?.pnlHoje   ?? 0
  const pnlSemana = stats?.pnlSemana ?? 0
  const progDia   = Math.min(Math.max(pnlHoje   / metaDiariaUsd  * 100, 0), 100)
  const progSem   = Math.min(Math.max(pnlSemana / metaSemanaUsd  * 100, 0), 100)

  return (
    <div className="min-h-screen bg-[#080c10] text-white p-4 md:p-6 space-y-5 max-w-2xl mx-auto">

      {/* ── Cabeçalho ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Brain className="w-6 h-6 text-violet-400" />
            Admin IA Autônoma
          </h1>
          <p className="text-sm text-white/40 mt-0.5">Controle e monitoramento da IA</p>
        </div>
        <button
          onClick={loadConfig}
          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* ── Kill Switch Master ── */}
      <div className={cn(
        'rounded-2xl border p-5 transition-all duration-300',
        iaAtiva
          ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5'
          : 'border-red-500/40 bg-gradient-to-br from-red-500/10 to-red-500/5',
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={cn(
              'w-14 h-14 rounded-2xl flex items-center justify-center transition-colors',
              iaAtiva ? 'bg-emerald-500/20' : 'bg-red-500/20',
            )}>
              <Power className={cn('w-7 h-7', iaAtiva ? 'text-emerald-400' : 'text-red-400')} />
            </div>
            <div>
              <p className="text-base font-semibold text-white">IA Autônoma</p>
              <p className={cn('text-sm font-medium', iaAtiva ? 'text-emerald-400' : 'text-red-400')}>
                {iaAtiva ? '● ATIVA — operando nos horários programados' : '○ DESATIVADA — nenhum trade será enviado'}
              </p>
              <p className="text-xs text-white/30 mt-0.5">
                Kill switch de segurança — desative se notar comportamento anômalo
              </p>
            </div>
          </div>
          <ToggleSwitch
            checked={iaAtiva}
            onChange={(v) => update({ ia_autonoma_ativa: v })}
            disabled={updating === 'ia_autonoma_ativa'}
            size="lg"
          />
        </div>
      </div>

      {/* ── Sessões ── */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider px-1">
          Sessões de operação
        </p>
        {SESSION_TIMES.map(session => {
          const isOn = (config?.[session.key]) ?? true
          return (
            <div
              key={session.key}
              className={cn(
                'rounded-xl border p-4 transition-all',
                session.borderColor,
                isOn ? session.bgColor : 'bg-white/3',
                !iaAtiva && 'opacity-50',
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center',
                    isOn ? session.bgColor : 'bg-white/5',
                  )}>
                    <span className={isOn ? session.textColor : 'text-white/30'}>{session.icon}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{session.name}</p>
                    <p className="text-xs text-white/40">
                      {session.horaBrasil} Brasília · Cron {session.cronUtc}
                    </p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={isOn}
                  onChange={(v) => update({ [session.key]: v } as Partial<IAConfig>)}
                  disabled={!iaAtiva || updating === session.key}
                  size="md"
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Próxima Operação ── */}
      {(() => {
        const now        = new Date()
        const horaU      = now.getUTCHours()
        const minU       = now.getUTCMinutes()
        const scan02Done = horaU > 2 || (horaU === 2 && minU > 0)
        const scan07Done = horaU > 7 || (horaU === 7 && minU > 0)

        let nextScanUtc: string, nextScanBRT: string, sessaoNome: string, sessaoOn: boolean
        if (!scan02Done) {
          nextScanUtc = 'hoje 02:00 UTC'; nextScanBRT = '23:00 BRT'; sessaoNome = 'Sydney / Tóquio'; sessaoOn = config?.sessao_sydney_tokyo ?? true
        } else if (!scan07Done) {
          nextScanUtc = 'hoje 07:00 UTC'; nextScanBRT = '04:00 BRT'; sessaoNome = 'Tóquio / Londres'; sessaoOn = config?.sessao_tokyo_london ?? true
        } else {
          nextScanUtc = 'amanhã 02:00 UTC'; nextScanBRT = '23:00 BRT'; sessaoNome = 'Sydney / Tóquio'; sessaoOn = config?.sessao_sydney_tokyo ?? true
        }

        const LOT_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]
        const COMM_PER  = 0.35
        const dailyGoal = capitalBase * ((config?.meta_diaria_pct ?? 7) / 100)
        const perBroker = dailyGoal / nBrokersAtivos
        let lot = 0.10
        for (const l of LOT_STEPS) {
          const p = (perBroker + COMM_PER) / (l * 10)
          if (p >= 4 && p <= 80) { lot = l; break }
        }
        const pipsNec   = (perBroker + COMM_PER) / (lot * 10)
        const faltaHoje = Math.max(0, dailyGoal - pnlHoje)
        const faltaSem  = Math.max(0, capitalBase * ((config?.meta_semanal_pct ?? 25) / 100) - pnlSemana)
        const vaOperar  = iaAtiva && sessaoOn && faltaHoje > 0 && faltaSem > 0

        return (
          <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
            <p className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              Próxima Operação
            </p>

            {/* Status */}
            <div className={cn(
              'rounded-lg px-3 py-2 text-xs font-semibold flex items-center gap-2',
              vaOperar
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                : 'bg-red-500/10 border border-red-500/30 text-red-400',
            )}>
              {vaOperar
                ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
              {vaOperar
                ? `IA vai operar ${nextScanBRT} · ${sessaoNome}`
                : !iaAtiva ? 'IA está desativada — nenhum trade será enviado'
                : !sessaoOn ? `Sessão ${sessaoNome} está desativada`
                : faltaSem <= 0 ? 'Meta semanal atingida — IA retoma segunda-feira'
                : 'Meta diária atingida — IA retoma amanhã'}
            </div>

            {/* Grid de parâmetros */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-white/5 p-3 space-y-1">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Capital base</p>
                <p className="text-base font-bold tabular-nums text-white">${capitalBase.toFixed(2)}</p>
                <p className="text-[9px] text-white/25">{nBrokersAtivos} corretoras ativas</p>
              </div>
              <div className="rounded-lg bg-white/5 p-3 space-y-1">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Lote estimado</p>
                <p className="text-base font-bold tabular-nums text-cyan-400">{lot.toFixed(2)} lot</p>
                <p className="text-[9px] text-white/25">por corretora × {nBrokersAtivos}</p>
              </div>
              <div className="rounded-lg bg-white/5 p-3 space-y-1">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Pips p/ meta</p>
                <p className="text-base font-bold tabular-nums text-amber-400">{pipsNec.toFixed(1)} pips</p>
                <p className="text-[9px] text-white/25">TP alvo por trade</p>
              </div>
              <div className="rounded-lg bg-white/5 p-3 space-y-1">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Próximo scan</p>
                <p className="text-[11px] font-bold text-violet-400">{nextScanUtc}</p>
                <p className="text-[9px] text-white/25">{nextScanBRT} (Brasília)</p>
              </div>
            </div>

            {/* Falta para as metas */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="flex justify-between items-center bg-white/5 rounded-lg px-3 py-2">
                <span className="text-white/40">Falta hoje</span>
                <span className={cn('font-bold tabular-nums', faltaHoje <= 0 ? 'text-emerald-400' : 'text-white')}>
                  {faltaHoje <= 0 ? 'META ✓' : `$${faltaHoje.toFixed(2)}`}
                </span>
              </div>
              <div className="flex justify-between items-center bg-white/5 rounded-lg px-3 py-2">
                <span className="text-white/40">Falta semana</span>
                <span className={cn('font-bold tabular-nums', faltaSem <= 0 ? 'text-emerald-400' : 'text-white')}>
                  {faltaSem <= 0 ? 'META ✓' : `$${faltaSem.toFixed(2)}`}
                </span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Metas combinadas ── */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-4">
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider">
          Metas combinadas (Você + IA)
        </p>

        <div className="grid grid-cols-2 gap-3">
          {/* Diária */}
          <div className="rounded-lg bg-white/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-blue-400" />
              <p className="text-xs text-white/60">Meta diária</p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-white">14%</span>
              <span className="text-xs text-white/40">/ dia</span>
            </div>
            <p className="text-xs text-white/30">7% você + 7% IA</p>
          </div>

          {/* Semanal */}
          <div className="rounded-lg bg-white/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-violet-400" />
              <p className="text-xs text-white/60">Meta semanal</p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-white">50%</span>
              <span className="text-xs text-white/40">/ semana</span>
            </div>
            <p className="text-xs text-white/30">25% você + 25% IA</p>
          </div>
        </div>

        {/* Progresso da IA hoje */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/50 flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5 text-violet-400" />
              IA hoje
            </span>
            <span className={cn('font-medium tabular-nums', pnlHoje >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {pnlHoje > 0 ? '+' : ''}{pnlHoje.toFixed(2)} / ${metaDiariaUsd.toFixed(2)}
            </span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-700',
                pnlHoje >= 0 ? 'bg-gradient-to-r from-violet-500 to-purple-400' : 'bg-red-500/60',
              )}
              style={{ width: `${progDia}%` }}
            />
          </div>
        </div>

        {/* Progresso da IA na semana */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/50 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
              IA esta semana
            </span>
            <span className={cn('font-medium tabular-nums', pnlSemana >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {pnlSemana > 0 ? '+' : ''}{pnlSemana.toFixed(2)} / ${metaSemanaUsd.toFixed(2)}
            </span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-700',
                pnlSemana >= 0 ? 'bg-gradient-to-r from-blue-500 to-cyan-400' : 'bg-red-500/60',
              )}
              style={{ width: `${progSem}%` }}
            />
          </div>
        </div>

        {/* Stats rápidos */}
        {stats && (
          <>
            {/* Linha 1: sinais e ordens MT5 */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="text-center bg-white/5 rounded-lg py-3 border border-white/5">
                <p className="text-2xl font-bold tabular-nums text-violet-400">{stats.sinaisHoje}</p>
                <p className="text-[10px] text-white/40 mt-0.5">Sinal(is) detectado(s)</p>
                <p className="text-[9px] text-white/20 mt-0.5">1 análise técnica por sessão</p>
              </div>
              <div className="text-center bg-white/5 rounded-lg py-3 border border-white/5">
                <p className="text-2xl font-bold tabular-nums text-cyan-400">{stats.ordensHoje}</p>
                <p className="text-[10px] text-white/40 mt-0.5">Ordens MT5 enviadas</p>
                <p className="text-[9px] text-white/20 mt-0.5">1 por corretora × sinal</p>
              </div>
            </div>
            {/* Linha 2: win/loss/semana */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Vitórias', val: stats.winsHoje, green: true },
                { label: 'Derrotas', val: stats.lossesHoje, red: true },
                { label: 'Semana', val: stats.totalSemana },
              ].map(({ label, val, green, red }) => (
                <div key={label} className="text-center bg-white/5 rounded-lg py-2">
                  <p className={cn(
                    'text-lg font-bold tabular-nums',
                    green ? 'text-emerald-400' : red ? 'text-red-400' : 'text-white',
                  )}>{val}</p>
                  <p className="text-[10px] text-white/30">{label}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Regras de segurança (somente leitura) ── */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          Regras de segurança — sempre ativas
        </p>
        <div className="space-y-2">
          {SECURITY_RULES.map((rule, i) => (
            <div key={i} className="flex items-start gap-3 py-2 border-b border-white/5 last:border-0">
              <span className={cn('flex-shrink-0 mt-0.5', rule.color)}>{rule.icon}</span>
              <div>
                <p className="text-sm font-medium text-white">{rule.label}</p>
                <p className="text-xs text-white/40 mt-0.5">{rule.desc}</p>
              </div>
              <CheckCircle className="w-4 h-4 text-emerald-500/60 flex-shrink-0 ml-auto mt-0.5" />
            </div>
          ))}
        </div>
        <p className="text-xs text-white/20 italic">
          Estas regras são invioláveis e não podem ser desativadas por aqui.
        </p>
      </div>

      {/* ── Modo XGBoost ── */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5 text-violet-400" />
            Modo de decisão IA
          </p>
          {(config?.xgboost_mode ?? 'off') !== 'off' && (
            <span className="text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/30 rounded px-2 py-0.5">
              XGBoost ativo
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {XGB_MODES.map(m => {
            const isActive = (config?.xgboost_mode ?? 'off') === m.key
            return (
              <button
                key={m.key}
                disabled={updating === 'xgboost_mode'}
                onClick={() => update({ xgboost_mode: m.key })}
                className={cn(
                  'rounded-lg border p-3 text-left transition-all',
                  isActive
                    ? `${m.color} bg-white/5`
                    : 'border-white/10 text-white/30 hover:border-white/20 hover:text-white/50',
                  updating === 'xgboost_mode' && 'opacity-50 cursor-not-allowed',
                )}
              >
                <p className="text-xs font-bold">{m.label}</p>
                <p className="text-[10px] mt-0.5 opacity-70">{m.desc}</p>
              </button>
            )
          })}
        </div>
        <p className="text-[10px] text-white/20">
          Ative <span className="text-blue-400">Sombra</span> a partir de 50 trades para comparar XGBoost vs similaridade antes de mudar para AND ou XGBoost.
        </p>
      </div>

      {/* ── Configurações avançadas ── */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider">
          Configurações
        </p>
        <div className="grid grid-cols-1 gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Threshold de confiança</p>
              <p className="text-xs text-white/40">P(sucesso) mínimo para operar</p>
            </div>
            <span className="text-sm font-bold text-amber-400 tabular-nums">
              {Math.round((config?.threshold_confianca ?? 0.65) * 100)}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Meta diária (IA)</p>
              <p className="text-xs text-white/40">Para ao atingir este % de ganho</p>
            </div>
            <span className="text-sm font-bold text-blue-400 tabular-nums">
              {config?.meta_diaria_pct ?? 7}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Meta semanal (IA)</p>
              <p className="text-xs text-white/40">Para até segunda-feira ao atingir</p>
            </div>
            <span className="text-sm font-bold text-violet-400 tabular-nums">
              {config?.meta_semanal_pct ?? 25}%
            </span>
          </div>
        </div>
      </div>

      {/* Última atualização */}
      {config?.updated_at && (
        <p className="text-xs text-white/20 text-center pb-2">
          Última alteração: {new Date(config.updated_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
        </p>
      )}
    </div>
  )
}
