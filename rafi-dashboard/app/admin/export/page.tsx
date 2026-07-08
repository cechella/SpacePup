'use client'

import { useEffect, useState } from 'react'
import { Download, Trash2, TrendingUp, TrendingDown, BarChart2, FileText } from 'lucide-react'
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

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-5 py-4">
      <div className="text-[10px] uppercase tracking-widest text-[#484f58] mb-1">{label}</div>
      <div className="text-2xl font-bold text-[#f0f6fc] font-mono">{value}</div>
      {sub && <div className="text-[11px] text-[#484f58] mt-0.5">{sub}</div>}
    </div>
  )
}

export default function ExportPage() {
  const [trades, setTrades] = useState<ManualTrade[]>([])
  const [mounted, setMounted] = useState(false)

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

  const wins     = trades.filter(t => t.result === 'win').length
  const losses   = trades.filter(t => t.result === 'loss').length
  const pending  = trades.filter(t => !t.result || t.result === 'pending').length
  const winRate  = trades.length > 0 && (wins + losses) > 0
    ? Math.round(wins / (wins + losses) * 100)
    : null

  if (!mounted) return null

  return (
    <div className="min-h-screen bg-[#0d1117] p-6 space-y-6">

      {/* Cabeçalho */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#f0f6fc] flex items-center gap-2">
            <FileText size={20} className="text-[#3b82f6]" />
            Dataset ML — Trades Mapeados
          </h1>
          <p className="text-sm text-[#484f58] mt-1">
            Trades registrados no Gráfico RAFI · armazenados localmente no navegador
          </p>
        </div>
        <div className="flex gap-2">
          {trades.length > 0 && (
            <>
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-red-400 border border-red-500/25 hover:bg-red-500/10 transition-all"
              >
                <Trash2 size={12} /> Limpar tudo
              </button>
              <button
                onClick={() => exportCSV(trades)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[#3b82f6] hover:bg-[#2563eb] text-white transition-all"
              >
                <Download size={14} /> Exportar CSV ({trades.length} trades)
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      {trades.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total de trades" value={trades.length} />
          <StatCard label="Win Rate" value={winRate !== null ? `${winRate}%` : '—'} sub={`${wins}W · ${losses}L · ${pending} pendentes`} />
          <StatCard label="Compras" value={trades.filter(t => t.direction === 'buy').length} />
          <StatCard label="Vendas" value={trades.filter(t => t.direction === 'sell').length} />
        </div>
      )}

      {/* Tabela */}
      {trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <BarChart2 size={48} className="text-[#30363d] mb-4" />
          <p className="text-[#484f58] text-sm">Nenhum trade mapeado ainda.</p>
          <p className="text-[#30363d] text-xs mt-1">
            Vá para <span className="text-[#3b82f6]">Gráfico RAFI</span>, posicione o OCO e clique COMPRA ou VENDA para registrar trades.
          </p>
        </div>
      ) : (
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-[#30363d] text-[#484f58] text-[10px] uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Data/Hora</th>
                  <th className="px-3 py-3 text-left">Dir</th>
                  <th className="px-3 py-3 text-right">Entrada</th>
                  <th className="px-3 py-3 text-right">SL</th>
                  <th className="px-3 py-3 text-right">TP</th>
                  <th className="px-3 py-3 text-right">Risco (pip)</th>
                  <th className="px-3 py-3 text-right">Alvo (pip)</th>
                  <th className="px-3 py-3 text-right">R:R</th>
                  <th className="px-3 py-3 text-right">Lote</th>
                  <th className="px-3 py-3 text-center">Resultado</th>
                  <th className="px-3 py-3 text-left">Rótulo</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => {
                  const r  = riskPips(t.entry, t.stopLoss, t.direction)
                  const w  = rewardPips(t.entry, t.takeProfit, t.direction)
                  const rr = r > 0 ? (w / r).toFixed(1) : '—'
                  const dt = new Date(t.time * 1000)
                  const dateStr = `${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  return (
                    <tr
                      key={t.id}
                      className={cn(
                        'border-b border-[#21262d] hover:bg-[#21262d]/50 transition-colors',
                        i % 2 === 0 ? '' : 'bg-[#0d1117]/30',
                      )}
                    >
                      <td className="px-4 py-2.5 text-[#8b949e]">{dateStr}</td>
                      <td className="px-3 py-2.5">
                        {t.direction === 'buy'
                          ? <span className="flex items-center gap-1 text-[#3fb950]"><TrendingUp size={11} /> BUY</span>
                          : <span className="flex items-center gap-1 text-[#f85149]"><TrendingDown size={11} /> SELL</span>
                        }
                      </td>
                      <td className="px-3 py-2.5 text-right text-[#f0f6fc]">{t.entry.toFixed(5)}</td>
                      <td className="px-3 py-2.5 text-right text-[#f85149]">{t.stopLoss.toFixed(5)}</td>
                      <td className="px-3 py-2.5 text-right text-[#3fb950]">{t.takeProfit.toFixed(5)}</td>
                      <td className="px-3 py-2.5 text-right text-[#f85149]">{r}p</td>
                      <td className="px-3 py-2.5 text-right text-[#3fb950]">{w}p</td>
                      <td className={cn('px-3 py-2.5 text-right font-bold', parseFloat(rr) >= 1.5 ? 'text-[#3fb950]' : 'text-[#e3b341]')}>{rr}x</td>
                      <td className="px-3 py-2.5 text-right text-[#8b949e]">{t.lot}</td>
                      <td className="px-3 py-2.5 text-center">
                        {t.result === 'win' && <span className="px-2 py-0.5 rounded text-[10px] bg-[#3fb950]/15 text-[#3fb950] border border-[#3fb950]/25">WIN</span>}
                        {t.result === 'loss' && <span className="px-2 py-0.5 rounded text-[10px] bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/25">LOSS</span>}
                        {(!t.result || t.result === 'pending') && (
                          <div className="flex gap-1 justify-center">
                            <button onClick={() => markResult(t.id, 'win')}  className="px-1.5 py-0.5 rounded text-[10px] bg-[#3fb950]/10 text-[#3fb950] border border-[#3fb950]/20 hover:bg-[#3fb950]/25 transition-all">W</button>
                            <button onClick={() => markResult(t.id, 'loss')} className="px-1.5 py-0.5 rounded text-[10px] bg-[#f85149]/10 text-[#f85149] border border-[#f85149]/20 hover:bg-[#f85149]/25 transition-all">L</button>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[#8b949e] max-w-[140px] truncate">{t.label || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Instrução de exportação */}
      {trades.length > 0 && (
        <p className="text-[10px] text-[#30363d] text-center">
          O arquivo CSV exportado contém: id, timestamp, direção, entrada, SL, TP, lote, alavancagem, RAFI, bbWidth, pips de risco/alvo, R:R, risco em USD, resultado — pronto para treinar o classificador XGBoost (Fase 2).
        </p>
      )}
    </div>
  )
}
