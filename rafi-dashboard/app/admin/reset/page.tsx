'use client'

import { useState } from 'react'
import { AlertTriangle, Trash2, CheckCircle2, RefreshCw } from 'lucide-react'

// O que sempre será apagado
const WILL_DELETE = [
  { label: 'Trades registrados',  desc: 'Entradas, SLs, TPs, resultados, snapshots', table: 'rafi_trades'        },
  { label: 'Histórico de trades', desc: 'Log de deals fechados',                     table: 'rafi_historico'     },
  { label: 'Runs de backtest',    desc: 'Resultados de backtests anteriores',         table: 'rafi_backtest_runs' },
  { label: 'Comandos do bot',     desc: 'Fila de comandos pendentes',                 table: 'rafi_bot_commands'  },
  { label: 'Logs do bot',        desc: 'Log de execução do executor.py',             table: 'rafi_bot_logs'      },
  { label: 'Status do bot',      desc: 'Estado atual do bot',                        table: 'rafi_bot_status'    },
  { label: 'Uploads de CSV',     desc: 'Arquivos de dados importados',               table: 'rafi_uploads'       },
]

// O que NÃO será apagado por padrão
const WILL_KEEP = [
  'Configurações de risco (capital, % risco, max trades)',
  'Faixas de lote',
  'Corretoras cadastradas',
  'Config do bot (par, timeframe, limiares)',
  'Saldo e equity (vem direto da Pepperstone via MetaAPI)',
]

export default function ResetPage() {
  const [step,         setStep]         = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle')
  const [typed,        setTyped]        = useState('')
  const [clearCandles, setClearCandles] = useState(false)
  const [results,      setResults]      = useState<Record<string, string> | null>(null)
  const [errMsg,       setErrMsg]       = useState('')

  const PHRASE = 'RESETAR'

  async function handleReset() {
    setStep('running')
    setResults(null)
    setErrMsg('')
    try {
      const res = await fetch('/api/admin/reset-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESETAR', clearCandles }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erro desconhecido')
      // Limpa também o localStorage do browser (trades locais, CSV history, IA state)
      try {
        const LOCAL_KEYS = ['rafi-trade-log', 'rafi-csv-history', 'rafi-meta-auto', 'rafi-ai-state']
        LOCAL_KEYS.forEach(k => localStorage.removeItem(k))
      } catch {}
      setResults(data.tables)
      setStep('done')
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStep('error')
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
          <Trash2 size={18} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[#f0f6fc]">Reset do Banco de Dados</h1>
          <p className="text-sm text-[#8b949e]">Apaga todos os dados de trades e IA para começar do zero</p>
        </div>
      </div>

      {step === 'idle' && (
        <div className="space-y-5">
          {/* O que vai apagar */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={15} className="text-orange-400" />
              <span className="text-sm font-semibold text-orange-400">Será apagado permanentemente</span>
            </div>
            <div className="space-y-2">
              {WILL_DELETE.map(item => (
                <div key={item.table} className="flex items-start gap-3 py-2 border-b border-[#21262d] last:border-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-400 mt-2 shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-[#f0f6fc]">{item.label}</div>
                    <div className="text-xs text-[#484f58]">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* O que vai manter */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 size={15} className="text-[#10b981]" />
              <span className="text-sm font-semibold text-[#10b981]">Será mantido</span>
            </div>
            <div className="space-y-1.5">
              {WILL_KEEP.map(item => (
                <div key={item} className="flex items-center gap-2.5 text-sm text-[#8b949e]">
                  <div className="w-1 h-1 rounded-full bg-[#10b981]" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          {/* Opção: apagar candles históricos */}
          <label className="flex items-start gap-3 bg-[#161b22] border border-[#30363d] rounded-xl p-4 cursor-pointer hover:border-orange-500/40 transition-all">
            <input
              type="checkbox"
              checked={clearCandles}
              onChange={e => setClearCandles(e.target.checked)}
              className="mt-0.5 accent-orange-400"
            />
            <div>
              <div className="text-sm font-medium text-[#f0f6fc]">
                Também apagar candles históricos
              </div>
              <div className="text-xs text-[#484f58] mt-0.5">
                Recomendado apenas se quiser começar com dados de mercado completamente novos.
                Deixe desmarcado para preservar o histórico de preços e ter o gráfico
                carregando instantâneo desde o primeiro uso.
              </div>
            </div>
          </label>

          <button
            onClick={() => setStep('confirm')}
            className="w-full py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 font-semibold text-sm hover:bg-red-500/25 transition-all"
          >
            Continuar para confirmação →
          </button>
        </div>
      )}

      {step === 'confirm' && (
        <div className="bg-[#161b22] border border-red-500/30 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-400" />
            <span className="font-bold text-red-400">Confirmação obrigatória</span>
          </div>
          <p className="text-sm text-[#8b949e]">
            Esta ação é <span className="text-red-400 font-semibold">irreversível</span>.
            Todos os trades, snapshots e dados de treinamento da IA serão apagados.
          </p>
          <div>
            <label className="block text-xs text-[#8b949e] mb-2">
              Digite <span className="text-[#f0f6fc] font-mono font-bold">{PHRASE}</span> para confirmar
            </label>
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value.toUpperCase())}
              placeholder="Digite aqui..."
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2.5 text-sm text-[#f0f6fc] font-mono outline-none focus:border-red-500/60 transition-colors"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => { setStep('idle'); setTyped('') }}
              className="flex-1 py-2.5 rounded-xl border border-[#30363d] text-[#8b949e] text-sm hover:border-[#484f58] transition-all"
            >
              Cancelar
            </button>
            <button
              disabled={typed !== PHRASE}
              onClick={handleReset}
              className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Apagar tudo e resetar
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-8 flex flex-col items-center gap-4">
          <RefreshCw size={28} className="text-[#3b82f6] animate-spin" />
          <p className="text-sm text-[#8b949e]">Apagando dados...</p>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-5">
          <div className="bg-[#161b22] border border-[#10b981]/30 rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 size={18} className="text-[#10b981]" />
              <span className="font-bold text-[#10b981]">Reset concluído com sucesso</span>
            </div>
            <div className="space-y-1.5">
              {results && Object.entries(results).map(([table, status]) => (
                <div key={table} className="flex items-center justify-between text-sm">
                  <span className="text-[#8b949e] font-mono">{table}</span>
                  <span className={status === 'OK' ? 'text-[#10b981]' : 'text-red-400'}>{status}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-sm text-[#484f58] text-center">
            Banco limpo. Faça o novo depósito e comece a operar. A IA aprenderá do zero.
          </p>
          <button
            onClick={() => { setStep('idle'); setTyped(''); setResults(null) }}
            className="w-full py-2.5 rounded-xl border border-[#30363d] text-[#8b949e] text-sm hover:border-[#484f58] transition-all"
          >
            Voltar
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className="bg-[#161b22] border border-red-500/30 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-400" />
            <span className="font-bold text-red-400">Erro ao resetar</span>
          </div>
          <p className="text-sm text-red-400 font-mono">{errMsg}</p>
          <button
            onClick={() => setStep('idle')}
            className="py-2.5 px-5 rounded-xl border border-[#30363d] text-[#8b949e] text-sm hover:border-[#484f58] transition-all"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  )
}
