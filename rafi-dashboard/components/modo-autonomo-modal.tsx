'use client'

import { useEffect, useState } from 'react'
import { Brain, Moon, Zap, Frown, AlertTriangle, Bot, User } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CheckinResult {
  sono:    'otimo' | 'ok' | 'mal'
  energia: 'alta'  | 'ok' | 'baixa'
  mental:  'focado'| 'ok' | 'ruim'
  humor:   'feliz' | 'neutro' | 'triste'
}

interface Props {
  checkin:    CheckinResult
  onAutonomo: () => void   // "Deixar a IA operar"
  onManual:   () => void   // "Operar eu mesmo"
}

const AUTO_ACTIVATE_SEC = 60

const LABEL: Record<string, string> = {
  sono_mal:      '😴 Sono ruim',
  energia_baixa: '⚡ Energia baixa',
  mental_ruim:   '🎯 Mental comprometido',
  humor_triste:  '😞 Humor triste',
}

export function ModoAutonomoModal({ checkin, onAutonomo, onManual }: Props) {
  const [remaining, setRemaining] = useState(AUTO_ACTIVATE_SEC)

  useEffect(() => {
    const iv = setInterval(() => setRemaining(r => {
      if (r <= 1) { clearInterval(iv); onAutonomo(); return 0 }
      return r - 1
    }), 1000)
    return () => clearInterval(iv)
  }, [onAutonomo])

  // Coleta quais dimensões estão ruins
  const problemas: string[] = []
  if (checkin.sono    === 'mal')    problemas.push('sono_mal')
  if (checkin.energia === 'baixa')  problemas.push('energia_baixa')
  if (checkin.mental  === 'ruim')   problemas.push('mental_ruim')
  if (checkin.humor   === 'triste') problemas.push('humor_triste')

  const pct = Math.round((remaining / AUTO_ACTIVATE_SEC) * 100)

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[360px] rounded-2xl border border-[#f59e0b]/30 bg-[#161b22] shadow-2xl overflow-hidden">

        {/* Timer bar */}
        <div className="h-1 bg-[#21262d]">
          <div className="h-full bg-[#f59e0b] transition-all duration-1000" style={{ width: `${pct}%` }} />
        </div>

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-[#30363d]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-[#f59e0b]/15 flex items-center justify-center">
              <Brain size={20} className="text-[#f59e0b]" />
            </div>
            <div>
              <div className="text-sm font-black text-[#f0f6fc]">Estado mental comprometido</div>
              <div className="text-[10px] text-[#484f58]">IA detectou check-in negativo hoje</div>
            </div>
          </div>

          {/* Dimensões ruins */}
          <div className="flex flex-wrap gap-1.5">
            {problemas.map(p => (
              <span key={p}
                className="text-[9px] font-mono px-2 py-1 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/25 text-[#ef4444]">
                {LABEL[p]}
              </span>
            ))}
          </div>
        </div>

        {/* Opções */}
        <div className="px-6 py-4 space-y-3">

          {/* Opção A — Modo Autônomo */}
          <button
            onClick={onAutonomo}
            className="w-full rounded-xl border border-[#10b981]/30 bg-[#10b981]/8 p-4 text-left transition-all hover:border-[#10b981]/60 hover:bg-[#10b981]/12 group"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#10b981]/20 flex items-center justify-center shrink-0">
                <Bot size={16} className="text-[#10b981]" />
              </div>
              <div>
                <div className="text-sm font-bold text-[#10b981]">Deixar a IA operar</div>
                <div className="text-[9px] text-[#484f58] mt-0.5 leading-relaxed">
                  IA monitora Londres + NY, executa automaticamente com seus critérios e para ao atingir +7% do dia.
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[8px] text-[#10b981]/70">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse" />
              Ativa em {remaining}s automaticamente se você não escolher
            </div>
          </button>

          {/* Opção B — Manual */}
          <button
            onClick={onManual}
            className="w-full rounded-xl border border-[#30363d] bg-[#21262d]/50 p-4 text-left transition-all hover:border-[#484f58] group"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#30363d] flex items-center justify-center shrink-0">
                <User size={16} className="text-[#8b949e]" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[#8b949e]">Operar eu mesmo</div>
                <div className="text-[9px] text-[#484f58] mt-0.5 leading-relaxed">
                  Pop-ups de alerta continuam ativos. Você mantém o controle e autoriza cada entrada.
                </div>
              </div>
            </div>
          </button>
        </div>

        {/* Aviso */}
        <div className="px-6 pb-5">
          <div className="flex items-start gap-2 text-[8px] text-[#484f58]">
            <AlertTriangle size={10} className="text-[#f59e0b] mt-0.5 shrink-0" />
            <span>
              Modo autônomo respeita todos os limites de risco: máx 2 trades/dia, stop sempre presente,
              para imediatamente ao atingir +7%. Kill switch disponível a qualquer momento.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
