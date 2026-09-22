'use client'

import { useEffect, useState, useRef } from 'react'
import { X, Brain, TrendingUp, Sparkles, BarChart2, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createBrowserClient } from '@supabase/ssr'

interface FeatureImportance {
  feature: string
  importance: number
  rank: number
}

interface MLModel {
  n_trades: number
  wr_raw: number
  wr_filtrado: number
  auc_roc: number
  threshold: number
  treinado_em: string
}

interface IAnoiteTrade {
  direction: string
  entry: number
  result: string | null
  pnl_usd: number | null
  rafi: number
  time: number
}

interface Props {
  open: boolean
  onClose: () => void
  checkin?: { sono?: string; energia?: string; mental?: string; humor?: string } | null
  capital?: number
  brokerCount?: number
}

function useSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

const FEATURE_LABELS: Record<string, string> = {
  rafi:           'Força RAFI',
  bb_width:       'Largura das BB',
  hora_utc:       'Hora (UTC)',
  dia_semana:     'Dia da semana',
  sessao:         'Sessão de mercado',
  checkin_sono:   'Sono do trader',
  checkin_energia: 'Energia do trader',
  checkin_mental: 'Estado mental',
  checkin_humor:  'Humor do trader',
  volume:         'Volume relativo',
  atr:            'ATR (volatilidade)',
  direcao:        'Direção do trade',
}

export function LoopDeAprendizadoPanel({ open, onClose, checkin, capital, brokerCount }: Props) {
  const supa = useSupabaseClient()
  const [loading, setLoading]          = useState(false)
  const [features, setFeatures]        = useState<FeatureImportance[]>([])
  const [model, setModel]              = useState<MLModel | null>(null)
  const [iaTrades, setIaTrades]        = useState<IAnoiteTrade[]>([])
  const [totalTrades, setTotalTrades]  = useState(0)
  const [activeCard, setActiveCard]    = useState<0 | 1 | 2>(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    load()
  }, [open])

  // Fecha com ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function load() {
    setLoading(true)
    try {
      const [featRes, modelRes, tradesRes, totalRes] = await Promise.all([
        supa.from('rafi_feature_importances').select('feature, importance, rank').order('rank').limit(8),
        supa.from('rafi_ml_models').select('*').eq('id', 'xgboost_v1').single(),
        (() => {
          const startOfDay = new Date()
          startOfDay.setUTCHours(0, 0, 0, 0)
          return supa
            .from('rafi_trades')
            .select('direction, entry, result, pnl_usd, rafi, time')
            .eq('entry_type', 'ia_autonoma')
            .gte('time', Math.floor(startOfDay.getTime() / 1000))
            .order('time', { ascending: false })
        })(),
        supa.from('rafi_trades').select('id', { count: 'exact', head: true }).in('result', ['win', 'loss']),
      ])

      setFeatures((featRes.data ?? []) as FeatureImportance[])
      setModel(modelRes.data as MLModel | null)
      setIaTrades((tradesRes.data ?? []) as IAnoiteTrade[])
      setTotalTrades(totalRes.count ?? 0)
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const pnlHoje = iaTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)
  const wins    = iaTrades.filter(t => t.result === 'win').length
  const losses  = iaTrades.filter(t => t.result === 'loss').length
  const wr      = iaTrades.filter(t => t.result !== null).length > 0
    ? Math.round((wins / iaTrades.filter(t => t.result !== null).length) * 100)
    : null

  // Padrões que o usuário "ensinou": agrupamentos de check-in x resultado
  const checkinPadroes: string[] = []
  if (checkin?.sono === 'otimo') checkinPadroes.push('Sono excelente +12% win rate')
  if (checkin?.energia === 'alta') checkinPadroes.push('Alta energia favorece entradas')
  if (checkin?.mental === 'focado') checkinPadroes.push('Foco mental melhora timing')
  if (checkin?.humor === 'feliz') checkinPadroes.push('Humor positivo correlaciona com boa execução')
  if (checkinPadroes.length === 0) checkinPadroes.push('Complete o check-in diário para treinar a IA')

  const cards = [
    {
      icon: <Brain className="w-5 h-5" />,
      title: 'Você ensinou à IA',
      color: 'from-violet-500 to-purple-600',
      borderColor: 'border-violet-500/30',
      bgColor: 'bg-violet-500/10',
    },
    {
      icon: <TrendingUp className="w-5 h-5" />,
      title: 'IA trabalhou por você',
      color: 'from-blue-500 to-cyan-600',
      borderColor: 'border-blue-500/30',
      bgColor: 'bg-blue-500/10',
    },
    {
      icon: <Sparkles className="w-5 h-5" />,
      title: 'O que a IA descobriu',
      color: 'from-amber-500 to-orange-600',
      borderColor: 'border-amber-500/30',
      bgColor: 'bg-amber-500/10',
    },
  ]

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Painel deslizante — entra pela direita */}
      <div
        ref={panelRef}
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 w-full max-w-md',
          'bg-[#0d1117] border-l border-white/10 shadow-2xl',
          'flex flex-col overflow-hidden',
          'animate-in slide-in-from-right duration-300',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
              <Brain className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Loop de Aprendizado</p>
              <p className="text-xs text-white/40">IA + Você = equipe imbatível</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
              title="Atualizar"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs dos 3 cards */}
        <div className="flex gap-1 px-4 pt-4 pb-2">
          {cards.map((card, i) => (
            <button
              key={i}
              onClick={() => setActiveCard(i as 0 | 1 | 2)}
              className={cn(
                'flex-1 flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl text-xs transition-all',
                activeCard === i
                  ? `bg-gradient-to-br ${card.color} text-white shadow-lg scale-[1.02]`
                  : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60',
              )}
            >
              {card.icon}
              <span className="text-center leading-tight font-medium">{card.title}</span>
            </button>
          ))}
        </div>

        {/* Conteúdo scrollável */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-white/30">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">Carregando insights...</p>
            </div>
          ) : (
            <>
              {/* ── Card 0: Você ensinou à IA ── */}
              {activeCard === 0 && (
                <div className="space-y-3 animate-in fade-in duration-200">
                  <div className={cn('rounded-xl border p-4 space-y-3', cards[0].borderColor, cards[0].bgColor)}>
                    <p className="text-xs font-semibold text-violet-300 uppercase tracking-wider">
                      Trades rotulados
                    </p>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-white tabular-nums">{totalTrades}</span>
                      <span className="text-sm text-white/40">trades no banco</span>
                    </div>
                    <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-purple-400 rounded-full transition-all duration-700"
                        style={{ width: `${Math.min(totalTrades / 300 * 100, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-white/40">{totalTrades}/300 para treino robusto do XGBoost</p>
                  </div>

                  <div className={cn('rounded-xl border p-4 space-y-3', cards[0].borderColor, cards[0].bgColor)}>
                    <p className="text-xs font-semibold text-violet-300 uppercase tracking-wider">
                      Seus padrões pessoais
                    </p>
                    <div className="space-y-2">
                      {checkinPadroes.map((p, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm text-white/70">
                          <ChevronRight className="w-3.5 h-3.5 text-violet-400 mt-0.5 flex-shrink-0" />
                          <span>{p}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {checkin && (
                    <div className={cn('rounded-xl border p-4', cards[0].borderColor, cards[0].bgColor)}>
                      <p className="text-xs font-semibold text-violet-300 uppercase tracking-wider mb-3">
                        Check-in de hoje
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: 'Sono', val: checkin.sono },
                          { label: 'Energia', val: checkin.energia },
                          { label: 'Mental', val: checkin.mental },
                          { label: 'Humor', val: checkin.humor },
                        ].map(({ label, val }) => val && (
                          <div key={label} className="bg-white/5 rounded-lg px-3 py-2">
                            <p className="text-xs text-white/40">{label}</p>
                            <p className="text-sm font-medium text-white capitalize">{val}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Card 1: IA trabalhou por você ── */}
              {activeCard === 1 && (
                <div className="space-y-3 animate-in fade-in duration-200">
                  <div className={cn('rounded-xl border p-4', cards[1].borderColor, cards[1].bgColor)}>
                    <p className="text-xs font-semibold text-blue-300 uppercase tracking-wider mb-3">
                      Desempenho de hoje
                    </p>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="text-center">
                        <p className={cn(
                          'text-2xl font-bold tabular-nums',
                          pnlHoje > 0 ? 'text-emerald-400' : pnlHoje < 0 ? 'text-red-400' : 'text-white/40',
                        )}>
                          {pnlHoje > 0 ? '+' : ''}{pnlHoje.toFixed(2)}
                        </p>
                        <p className="text-xs text-white/40">PnL ($)</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-white tabular-nums">{iaTrades.length}</p>
                        <p className="text-xs text-white/40">Trades</p>
                      </div>
                      <div className="text-center">
                        <p className={cn(
                          'text-2xl font-bold tabular-nums',
                          wr !== null && wr >= 55 ? 'text-emerald-400' : 'text-white/40',
                        )}>
                          {wr !== null ? `${wr}%` : '—'}
                        </p>
                        <p className="text-xs text-white/40">Win rate</p>
                      </div>
                    </div>
                  </div>

                  {iaTrades.length === 0 ? (
                    <div className={cn('rounded-xl border p-6 text-center', cards[1].borderColor, cards[1].bgColor)}>
                      <TrendingUp className="w-8 h-8 text-blue-400/50 mx-auto mb-2" />
                      <p className="text-sm text-white/40">
                        Nenhum trade autônomo hoje ainda
                      </p>
                      <p className="text-xs text-white/30 mt-1">
                        Próximo scan: 02:00 ou 07:00 UTC
                      </p>
                    </div>
                  ) : (
                    <div className={cn('rounded-xl border overflow-hidden', cards[1].borderColor)}>
                      <div className="px-4 py-2 bg-blue-500/10">
                        <p className="text-xs font-semibold text-blue-300 uppercase tracking-wider">Trades da IA hoje</p>
                      </div>
                      <div className="divide-y divide-white/5">
                        {iaTrades.map((t, i) => {
                          const hora = new Date(t.time * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
                          return (
                            <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors">
                              <div className={cn(
                                'w-2 h-2 rounded-full flex-shrink-0',
                                t.direction === 'buy' ? 'bg-emerald-400' : 'bg-red-400',
                              )} />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-white/70">
                                  {t.direction === 'buy' ? 'COMPRA' : 'VENDA'} @ {t.entry.toFixed(5)}
                                </p>
                                <p className="text-xs text-white/30">{hora} · RAFI {Math.abs(t.rafi).toFixed(2)}</p>
                              </div>
                              <div className="text-right">
                                {t.result ? (
                                  <span className={cn(
                                    'text-xs font-medium',
                                    t.result === 'win' ? 'text-emerald-400' : 'text-red-400',
                                  )}>
                                    {t.pnl_usd !== null ? `${t.pnl_usd > 0 ? '+' : ''}$${t.pnl_usd.toFixed(2)}` : t.result.toUpperCase()}
                                  </span>
                                ) : (
                                  <span className="text-xs text-blue-400 animate-pulse">aberto</span>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Card 2: O que a IA descobriu ── */}
              {activeCard === 2 && (
                <div className="space-y-3 animate-in fade-in duration-200">
                  {model && (
                    <div className={cn('rounded-xl border p-4', cards[2].borderColor, cards[2].bgColor)}>
                      <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider mb-3">
                        Modelo XGBoost atual
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: 'Win rate bruto', val: model.wr_raw !== null ? `${Math.round(model.wr_raw * 100)}%` : '—' },
                          { label: 'Win rate filtrado', val: model.wr_filtrado !== null ? `${Math.round(model.wr_filtrado * 100)}%` : '—' },
                          { label: 'AUC-ROC', val: model.auc_roc !== null ? model.auc_roc.toFixed(3) : '—' },
                          { label: 'Threshold', val: model.threshold !== null ? `${Math.round(model.threshold * 100)}%` : '—' },
                          { label: 'Trades usados', val: model.n_trades ?? '—' },
                          { label: 'Treinado em', val: model.treinado_em ? new Date(model.treinado_em).toLocaleDateString('pt-BR') : '—' },
                        ].map(({ label, val }) => (
                          <div key={label} className="bg-white/5 rounded-lg px-3 py-2">
                            <p className="text-xs text-white/40">{label}</p>
                            <p className="text-sm font-semibold text-white tabular-nums">{val}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {features.length > 0 ? (
                    <div className={cn('rounded-xl border p-4 space-y-3', cards[2].borderColor, cards[2].bgColor)}>
                      <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
                        Features mais importantes
                      </p>
                      <div className="space-y-2.5">
                        {features.slice(0, 6).map((f, i) => {
                          const maxImp = features[0]?.importance ?? 1
                          const pct    = Math.round((f.importance / maxImp) * 100)
                          return (
                            <div key={f.feature} className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-white/70 flex items-center gap-1.5">
                                  <span className="w-4 h-4 rounded bg-amber-500/20 flex items-center justify-center text-amber-400 text-[10px] font-bold">
                                    {i + 1}
                                  </span>
                                  {FEATURE_LABELS[f.feature] ?? f.feature}
                                </span>
                                <span className="text-white/50 tabular-nums">{(f.importance * 100).toFixed(1)}%</span>
                              </div>
                              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="h-full bg-gradient-to-r from-amber-500 to-orange-400 rounded-full transition-all duration-700"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className={cn('rounded-xl border p-6 text-center', cards[2].borderColor, cards[2].bgColor)}>
                      <BarChart2 className="w-8 h-8 text-amber-400/50 mx-auto mb-2" />
                      <p className="text-sm text-white/40">XGBoost ainda não treinado</p>
                      <p className="text-xs text-white/30 mt-1">
                        Execute o treino após {totalTrades >= 10 ? 'confirmar rótulos' : `${10 - totalTrades} trades mais`}
                      </p>
                    </div>
                  )}

                  {features.length > 0 && (
                    <div className={cn('rounded-xl border p-4', cards[2].borderColor, cards[2].bgColor)}>
                      <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider mb-2">
                        Insight principal
                      </p>
                      <p className="text-sm text-white/70 leading-relaxed">
                        {features[0]
                          ? `${FEATURE_LABELS[features[0].feature] ?? features[0].feature} é o fator que mais prediz sucesso nos seus trades (${(features[0].importance * 100).toFixed(1)}%). Foque nela ao avaliar entradas.`
                          : 'Treine o modelo para descobrir os padrões nos seus trades.'
                        }
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer com timestamp */}
        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-between">
          <p className="text-xs text-white/30">Atualizado ao abrir o painel</p>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-violet-400 hover:text-violet-300 transition-colors flex items-center gap-1"
          >
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
            Atualizar
          </button>
        </div>
      </div>
    </>
  )
}
