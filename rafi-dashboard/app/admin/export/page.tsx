'use client'

import { useEffect, useState, useMemo } from 'react'
import { Download, Trash2, TrendingUp, TrendingDown, BarChart2, FileText, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ManualTrade {
  id:         string
  direction:  'buy' | 'sell'
  entry:      number
  stopLoss:   number
  takeProfit: number
  label:      string
  time:       number
  lot:        number
  leverage:   number
  result?:    'win' | 'loss' | 'pending'
  rafi?:      number
  rafiDir?:   'bull' | 'bear'
  bbWidth?:   number
}

const STORAGE_KEY = 'rafi-trade-log'

function riskPips(e: number, s: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((e - s) * 10000) : Math.round((s - e) * 10000)
}
function rewardPips(e: number, t: number, dir: 'buy' | 'sell') {
  return dir === 'buy' ? Math.round((t - e) * 10000) : Math.round((e - t) * 10000)
}
function pipValueUSD(lot: number) { return lot * 10 }

function exportCSV(trades: ManualTrade[]) {
  const header = 'id,time,direction,entry,sl,tp,lot,leverage,rafi,rafiDir,bbWidth,riskPips,rewardPips,rr,riskUSD,tpUSD,result'
  const rows = trades.map(t => {
    const r  = riskPips(t.entry, t.stopLoss, t.direction)
    const w  = rewardPips(t.entry, t.takeProfit, t.direction)
    const pv = pipValueUSD(t.lot)
    const rr = r > 0 ? (w / r).toFixed(2) : '0'
    const ts = new Date(t.time * 1000).toISOString()
    return [
      t.id, ts, t.direction, t.entry, t.stopLoss, t.takeProfit,
      t.lot, t.leverage,
      t.rafi ?? '', t.rafiDir ?? '', t.bbWidth?.toFixed(5) ?? '',
      r, w, rr, (r * pv).toFixed(2), (w * pv).toFixed(2),
      t.result ?? 'pending',
    ].join(',')
  })
  const csv  = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `rafi-dataset-ml-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Mini curva de capital (SVG) ───────────────────────────────────────────────
function EquitySparkline({ trades }: { trades: ManualTrade[] }) {
  const decided = trades.filter(t => t.result === 'win' || t.result === 'loss')
  if (decided.length < 2) return (
    <div className="flex items-center justify-center h-full text-[10px] text-[#484f58]">
      Rotule trades para ver a curva
    </div>
  )
  const points: number[] = [0]
  for (const t of decided) {
    const r  = riskPips(t.entry, t.stopLoss, t.direction)
    const w  = rewardPips(t.entry, t.takeProfit, t.direction)
    const pv = pipValueUSD(t.lot)
    const last = points[points.length - 1]
    points.push(t.result === 'win' ? last + w * pv : last - r * pv)
  }
  const W = 320, H = 80
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const toY = (v: number) => H - ((v - min) / range) * (H - 8) - 4
  const toX = (i: number) => (i / (points.length - 1)) * W
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
  const fill = `${path} L${W},${H} L0,${H} Z`
  const finalPnl = points[points.length - 1]
  const color = finalPnl >= 0 ? '#10b981' : '#ef4444'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1={toY(0).toFixed(1)} x2={W} y2={toY(0).toFixed(1)}
        stroke="#30363d" strokeWidth="1" strokeDasharray="4 4" />
      <path d={fill} fill="url(#eq-fill)" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={toX(points.length - 1)} cy={toY(finalPnl)} r="3" fill={color} />
    </svg>
  )
}

// ── Donut de resultado ────────────────────────────────────────────────────────
function ResultDonut({ wins, losses, pending }: { wins: number; losses: number; pending: number }) {
  const total   = wins + losses + pending || 1
  const winPct  = (wins    / total) * 100
  const lossPct = (losses  / total) * 100
  const pendPct = (pending / total) * 100
  const R = 28, cx = 36, cy = 36, stroke = 18
  const circ = 2 * Math.PI * R
  const segs = [
    { pct: winPct,  color: '#10b981', offset: 0 },
    { pct: lossPct, color: '#ef4444', offset: winPct },
    { pct: pendPct, color: '#30363d', offset: winPct + lossPct },
  ]
  const decided = wins + losses
  const wr = decided > 0 ? Math.round(wins / decided * 100) : null
  return (
    <div className="flex items-center gap-4">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="#21262d" strokeWidth={stroke} />
        {segs.map(({ pct, color, offset }) => pct > 0 && (
          <circle key={color} cx={cx} cy={cy} r={R} fill="none"
            stroke={color} strokeWidth={stroke}
            strokeDasharray={`${(pct / 100) * circ} ${circ}`}
            strokeDashoffset={(-(offset / 100) * circ) + circ / 4}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fill="#f0f6fc" fontSize="12" fontWeight="800" fontFamily="monospace">
          {wr !== null ? `${wr}%` : '—'}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#484f58" fontSize="8">win rate</text>
      </svg>
      <div className="flex flex-col gap-1.5 text-[11px]">
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#10b981]" /><span className="text-[#8b949e]">Win</span><span className="ml-2 font-mono font-bold text-[#10b981]">{wins}</span></div>
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#ef4444]" /><span className="text-[#8b949e]">Loss</span><span className="ml-2 font-mono font-bold text-[#ef4444]">{losses}</span></div>
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#30363d]" /><span className="text-[#8b949e]">Pendente</span><span className="ml-2 font-mono font-bold text-[#484f58]">{pending}</span></div>
      </div>
    </div>
  )
}

// ── Distribuição RAFI por resultado ──────────────────────────────────────────
function RAFIDistribution({ trades }: { trades: ManualTrade[] }) {
  const buckets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]
  const data = buckets.map(b => ({
    label:  b.toFixed(1),
    wins:   trades.filter(t => t.result === 'win'  && (t.rafi ?? 0) >= b && (t.rafi ?? 0) < b + 0.5).length,
    losses: trades.filter(t => t.result === 'loss' && (t.rafi ?? 0) >= b && (t.rafi ?? 0) < b + 0.5).length,
  }))
  const maxVal = Math.max(...data.map(d => d.wins + d.losses), 1)
  return (
    <div className="flex flex-col gap-1 h-full justify-end">
      <div className="flex items-end gap-0.5 flex-1">
        {data.map(d => (
          <div key={d.label} className="flex flex-col items-center gap-px flex-1" style={{ height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ height: `${(d.wins / maxVal) * 100}%`, minHeight: d.wins > 0 ? 2 : 0 }} className="w-full bg-[#10b981] rounded-t-sm" />
            <div style={{ height: `${(d.losses / maxVal) * 100}%`, minHeight: d.losses > 0 ? 2 : 0 }} className="w-full bg-[#ef4444] rounded-t-sm" />
          </div>
        ))}
      </div>
      <div className="flex gap-0.5">
        {data.map(d => (
          <div key={d.label} className="flex-1 text-center text-[7px] text-[#484f58] font-mono">{d.label}</div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[9px] text-[#484f58] mt-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-[#10b981] rounded-sm" />Win</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-[#ef4444] rounded-sm" />Loss</span>
        <span className="ml-auto">RAFI na entrada</span>
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3">
      <div className="text-[9px] uppercase tracking-widest text-[#484f58] mb-1">{label}</div>
      <div className="text-xl font-bold font-mono" style={{ color: color ?? '#f0f6fc' }}>{value}</div>
      {sub && <div className="text-[10px] text-[#484f58] mt-0.5">{sub}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

type DirFilter    = 'all' | 'buy' | 'sell'
type ResultFilter = 'all' | 'win' | 'loss' | 'pending'

export default function ExportPage() {
  const [trades,  setTrades]  = useState<ManualTrade[]>([])
  const [mounted, setMounted] = useState(false)
  const [dirF,    setDirF]    = useState<DirFilter>('all')
  const [resultF, setResultF] = useState<ResultFilter>('all')

  useEffect(() => {
    setMounted(true)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setTrades(parsed)
      }
    } catch {}
  }, [])

  function clearAll() {
    if (!confirm('Apagar todos os trades mapeados? Ação irreversível.')) return
    localStorage.removeItem(STORAGE_KEY)
    setTrades([])
  }

  function markResult(id: string, result: 'win' | 'loss') {
    setTrades(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, result } : t)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
      return updated
    })
  }

  const wins    = trades.filter(t => t.result === 'win').length
  const losses  = trades.filter(t => t.result === 'loss').length
  const pending = trades.filter(t => !t.result || t.result === 'pending').length
  const decided = wins + losses
  const winRate = decided > 0 ? Math.round(wins / decided * 100) : null

  const pnl = useMemo(() => trades.reduce((acc, t) => {
    if (t.result === 'win')  return acc + rewardPips(t.entry, t.takeProfit, t.direction) * pipValueUSD(t.lot)
    if (t.result === 'loss') return acc - riskPips(t.entry, t.stopLoss, t.direction)    * pipValueUSD(t.lot)
    return acc
  }, 0), [trades])

  const avgRR = useMemo(() => {
    const valid = trades.filter(t => riskPips(t.entry, t.stopLoss, t.direction) > 0)
    if (!valid.length) return null
    const sum = valid.reduce((acc, t) => {
      const r = riskPips(t.entry, t.stopLoss, t.direction)
      const w = rewardPips(t.entry, t.takeProfit, t.direction)
      return acc + w / r
    }, 0)
    return (sum / valid.length).toFixed(1)
  }, [trades])

  const filtered = useMemo(() => trades.filter(t => {
    if (dirF !== 'all' && t.direction !== dirF) return false
    const res = t.result ?? 'pending'
    if (resultF !== 'all' && res !== resultF) return false
    return true
  }), [trades, dirF, resultF])

  if (!mounted) return null

  return (
    <div className="min-h-screen bg-[#0d1117] p-5 space-y-5">

      {/* Cabeçalho */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#f0f6fc] flex items-center gap-2">
            <FileText size={18} className="text-[#3b82f6]" />
            Dataset ML — Trades Mapeados
          </h1>
          <p className="text-xs text-[#484f58] mt-0.5">
            Trades registrados no Gráfico RAFI · armazenados localmente no navegador
          </p>
        </div>
        {trades.length > 0 && (
          <div className="flex gap-2">
            <button onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/25 hover:bg-red-500/10 transition-all">
              <Trash2 size={11} /> Limpar
            </button>
            <button onClick={() => exportCSV(trades)}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#3b82f6] hover:bg-[#2563eb] text-white transition-all">
              <Download size={12} /> Exportar CSV ({trades.length})
            </button>
          </div>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <BarChart2 size={48} className="text-[#30363d] mb-4" />
          <p className="text-[#484f58] text-sm">Nenhum trade mapeado ainda.</p>
          <p className="text-[#30363d] text-xs mt-1">
            Vá para <span className="text-[#3b82f6]">Gráfico RAFI</span>, posicione o OCO e clique COMPRA ou VENDA.
          </p>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="Total" value={trades.length} sub={`${pending} pendentes`} />
            <StatCard label="Win Rate" value={winRate !== null ? `${winRate}%` : '—'}
              sub={`${wins}W · ${losses}L`}
              color={winRate !== null ? (winRate >= 55 ? '#10b981' : winRate >= 45 ? '#f59e0b' : '#ef4444') : '#f0f6fc'} />
            <StatCard label="P&L Simulado" value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
              sub="trades rotulados" color={pnl >= 0 ? '#10b981' : '#ef4444'} />
            <StatCard label="R:R Médio" value={avgRR ? `${avgRR}×` : '—'} sub="todos os trades" />
            <StatCard label="Compras" value={trades.filter(t => t.direction === 'buy').length}
              sub={`${trades.filter(t => t.direction === 'buy' && t.result === 'win').length}W · ${trades.filter(t => t.direction === 'buy' && t.result === 'loss').length}L`}
              color="#3b82f6" />
            <StatCard label="Vendas" value={trades.filter(t => t.direction === 'sell').length}
              sub={`${trades.filter(t => t.direction === 'sell' && t.result === 'win').length}W · ${trades.filter(t => t.direction === 'sell' && t.result === 'loss').length}L`}
              color="#f59e0b" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <div className="text-[9px] uppercase tracking-widest text-[#484f58] mb-2">Curva de Capital</div>
              <div className="h-20"><EquitySparkline trades={trades} /></div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-[#484f58]">P&L acumulado</span>
                <span className={cn('text-sm font-mono font-bold', pnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </span>
              </div>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <div className="text-[9px] uppercase tracking-widest text-[#484f58] mb-3">Resultado</div>
              <ResultDonut wins={wins} losses={losses} pending={pending} />
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <div className="text-[9px] uppercase tracking-widest text-[#484f58] mb-2">RAFI vs Resultado</div>
              <div className="h-24"><RAFIDistribution trades={trades} /></div>
            </div>
          </div>

          {/* Filtros + Tabela */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#30363d] flex items-center gap-3 bg-[#0d1117]">
              <Filter size={10} className="text-[#484f58]" />
              <div className="flex items-center gap-1">
                {(['all', 'buy', 'sell'] as DirFilter[]).map(f => (
                  <button key={f} onClick={() => setDirF(f)}
                    className={cn('px-2.5 py-1 rounded text-[10px] font-semibold transition-all',
                      dirF === f ? 'bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/30' : 'text-[#484f58] hover:text-[#8b949e]')}>
                    {f === 'all' ? 'Todos' : f === 'buy' ? '▲ Compra' : '▼ Venda'}
                  </button>
                ))}
              </div>
              <div className="w-px h-4 bg-[#30363d]" />
              <div className="flex items-center gap-1">
                {(['all', 'win', 'loss', 'pending'] as ResultFilter[]).map(f => (
                  <button key={f} onClick={() => setResultF(f)}
                    className={cn('px-2.5 py-1 rounded text-[10px] font-semibold transition-all',
                      resultF === f
                        ? f === 'win'  ? 'bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/30'
                        : f === 'loss' ? 'bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/30'
                        : 'bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/30'
                        : 'text-[#484f58] hover:text-[#8b949e]')}>
                    {f === 'all' ? 'Todos' : f === 'win' ? 'WIN' : f === 'loss' ? 'LOSS' : 'Pendente'}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-[10px] text-[#484f58]">{filtered.length} trade{filtered.length !== 1 ? 's' : ''}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-[#30363d] text-[#484f58] text-[9px] uppercase tracking-wider">
                    <th className="px-4 py-2.5 text-left">Data/Hora</th>
                    <th className="px-3 py-2.5 text-left">Dir</th>
                    <th className="px-3 py-2.5 text-right">Entrada</th>
                    <th className="px-3 py-2.5 text-right">SL</th>
                    <th className="px-3 py-2.5 text-right">TP</th>
                    <th className="px-3 py-2.5 text-right">Risco</th>
                    <th className="px-3 py-2.5 text-right">Alvo</th>
                    <th className="px-3 py-2.5 text-right">R:R</th>
                    <th className="px-3 py-2.5 text-right">RAFI</th>
                    <th className="px-3 py-2.5 text-right">Lote</th>
                    <th className="px-3 py-2.5 text-center">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t, i) => {
                    const r   = riskPips(t.entry, t.stopLoss, t.direction)
                    const w   = rewardPips(t.entry, t.takeProfit, t.direction)
                    const rr  = r > 0 ? w / r : 0
                    const pv  = pipValueUSD(t.lot)
                    const dt  = new Date(t.time * 1000)
                    const ds  = `${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                    const rowBg = t.result === 'win'  ? 'bg-[#10b981]/5'
                                : t.result === 'loss' ? 'bg-[#ef4444]/5'
                                : i % 2 === 1        ? 'bg-[#0d1117]/30' : ''
                    return (
                      <tr key={t.id} className={cn('border-b border-[#21262d] hover:bg-[#21262d]/50 transition-colors', rowBg)}>
                        <td className="px-4 py-2 text-[#8b949e]">{ds}</td>
                        <td className="px-3 py-2">
                          {t.direction === 'buy'
                            ? <span className="flex items-center gap-1 text-[#3b82f6]"><TrendingUp size={10} />BUY</span>
                            : <span className="flex items-center gap-1 text-[#f59e0b]"><TrendingDown size={10} />SELL</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-[#f0f6fc]">{t.entry.toFixed(5)}</td>
                        <td className="px-3 py-2 text-right text-[#ef4444]">{t.stopLoss.toFixed(5)}</td>
                        <td className="px-3 py-2 text-right text-[#10b981]">{t.takeProfit.toFixed(5)}</td>
                        <td className="px-3 py-2 text-right text-[#ef4444]">{r}p · ${(r * pv).toFixed(0)}</td>
                        <td className="px-3 py-2 text-right text-[#10b981]">{w}p · ${(w * pv).toFixed(0)}</td>
                        <td className={cn('px-3 py-2 text-right font-bold',
                          rr >= 1.5 ? 'text-[#10b981]' : rr >= 1 ? 'text-[#f59e0b]' : 'text-[#ef4444]')}>
                          {rr.toFixed(1)}×
                        </td>
                        <td className={cn('px-3 py-2 text-right',
                          (t.rafi ?? 0) >= 2.5 ? 'text-[#10b981]' : 'text-[#f59e0b]')}>
                          {t.rafi?.toFixed(2) ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-[#8b949e]">{t.lot}</td>
                        <td className="px-3 py-2 text-center">
                          {t.result === 'win'  && <span className="px-2 py-0.5 rounded text-[9px] bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/25">WIN</span>}
                          {t.result === 'loss' && <span className="px-2 py-0.5 rounded text-[9px] bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/25">LOSS</span>}
                          {(!t.result || t.result === 'pending') && (
                            <div className="flex gap-1 justify-center">
                              <button onClick={() => markResult(t.id, 'win')}
                                className="px-1.5 py-0.5 rounded text-[9px] bg-[#10b981]/10 text-[#10b981] border border-[#10b981]/20 hover:bg-[#10b981]/25 transition-all">W</button>
                              <button onClick={() => markResult(t.id, 'loss')}
                                className="px-1.5 py-0.5 rounded text-[9px] bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20 hover:bg-[#ef4444]/25 transition-all">L</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[9px] text-[#30363d] text-center pb-2">
            CSV exportado: id · timestamp · direção · entrada · SL · TP · lote · alavancagem · RAFI · bbWidth · pips · R:R · USD · resultado — pronto para XGBoost
          </p>
        </>
      )}
    </div>
  )
}
