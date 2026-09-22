'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase'

export interface CheckinResult {
  id?:          string
  sono:         'otimo' | 'ok' | 'mal'
  energia:      'alta'  | 'ok' | 'baixa'
  mental:       'focado'| 'ok' | 'ruim'
  humor:        'feliz' | 'neutro' | 'triste'
  scorePenalty: number
  blocked:      boolean
  time:         number  // timestamp unix
}

interface Props {
  onComplete: (result: CheckinResult) => void
}

function calcPenalty(sono: string, energia: string, mental: string, humor: string): { penalty: number; blocked: boolean } {
  if (humor === 'triste') return { penalty: 100, blocked: true }

  let penalty = 0
  if (sono    === 'mal')   penalty += 15
  else if (sono    === 'ok')  penalty += 5

  if (energia === 'baixa') penalty += 10
  else if (energia === 'ok') penalty += 3

  if (mental  === 'ruim')  penalty += 15
  else if (mental  === 'ok') penalty += 5

  if (humor   === 'neutro') penalty += 5

  return { penalty, blocked: false }
}

const QUESTIONS = [
  {
    key: 'sono',
    label: 'Sono',
    opts: [{ v: 'otimo', label: 'Ótimo' }, { v: 'ok', label: 'Ok' }, { v: 'mal', label: 'Mal' }],
  },
  {
    key: 'energia',
    label: 'Energia',
    opts: [{ v: 'alta', label: 'Alta' }, { v: 'ok', label: 'Ok' }, { v: 'baixa', label: 'Baixa' }],
  },
  {
    key: 'mental',
    label: 'Mental',
    opts: [{ v: 'focado', label: 'Focado' }, { v: 'ok', label: 'Ok' }, { v: 'ruim', label: 'Ruim' }],
  },
  {
    key: 'humor',
    label: '😊 Humor',
    opts: [{ v: 'feliz', label: 'Feliz' }, { v: 'neutro', label: 'Neutro' }, { v: 'triste', label: 'Triste' }],
  },
] as const

export function CheckinModal({ onComplete }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving,  setSaving]  = useState(false)

  const ready   = QUESTIONS.every(q => answers[q.key])
  const preview = ready
    ? calcPenalty(answers.sono, answers.energia, answers.mental, answers.humor)
    : null

  function pick(key: string, val: string) {
    setAnswers(prev => ({ ...prev, [key]: val }))
  }

  async function handleSubmit() {
    if (!ready || saving) return
    setSaving(true)

    const { penalty, blocked } = calcPenalty(
      answers.sono, answers.energia, answers.mental, answers.humor,
    )

    const result: CheckinResult = {
      sono:         answers.sono    as CheckinResult['sono'],
      energia:      answers.energia as CheckinResult['energia'],
      mental:       answers.mental  as CheckinResult['mental'],
      humor:        answers.humor   as CheckinResult['humor'],
      scorePenalty: penalty,
      blocked,
      time:         Math.floor(Date.now() / 1000),
    }

    try {
      const db = createClient()
      const { data, error } = await db
        .from('rafi_checkins')
        .upsert({
          sono:          result.sono,
          energia:       result.energia,
          mental:        result.mental,
          humor:         result.humor,
          score_penalty: penalty,
          blocked,
          date:          new Date().toISOString().slice(0, 10),
        }, { onConflict: 'date' })
        .select('id')
        .single()
      if (error) console.error('[Checkin] Supabase insert error:', error.message)
      if (data?.id) result.id = data.id
    } catch (e) {
      console.error('[Checkin] Falha ao salvar no Supabase:', e)
    }

    setSaving(false)
    onComplete(result)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[340px] rounded-2xl border border-[#1c3050] bg-[#0d1117] p-6 shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-2.5 mb-5">
          <span className="text-2xl">🧠</span>
          <div>
            <div className="text-[14px] font-bold text-[#ddeeff]">Como você está hoje?</div>
            <div className="text-[10px] text-[#7a96b8]">Check-in obrigatório antes de operar</div>
          </div>
        </div>

        {/* Perguntas */}
        <div className="flex flex-col gap-4 mb-5">
          {QUESTIONS.map(q => (
            <div key={q.key}>
              <div className="text-[10px] text-[#7a96b8] uppercase tracking-widest mb-1.5">{q.label}</div>
              <div className="flex gap-2">
                {q.opts.map(o => (
                  <button
                    key={o.v}
                    onClick={() => pick(q.key, o.v)}
                    className={cn(
                      'flex-1 py-1.5 rounded-lg text-[11px] font-semibold border transition-all',
                      answers[q.key] === o.v
                        ? 'bg-[#4499ff]/20 border-[#4499ff] text-[#4499ff]'
                        : 'bg-[#131f2e] border-[#1c3050] text-[#334455] hover:border-[#334455] hover:text-[#7a96b8]',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Preview do diagnóstico */}
        {preview && (
          <div className={cn(
            'rounded-lg px-3 py-2 mb-4 border text-[10px] leading-relaxed',
            preview.blocked
              ? 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]'
              : preview.penalty >= 20
              ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
              : 'bg-[#00e676]/10 border-[#00e676]/30 text-[#00e676]',
          )}>
            {preview.blocked
              ? '🚫 A IA recomenda NÃO operar hoje. Proteja seu capital — o mercado estará aqui amanhã.'
              : preview.penalty >= 20
              ? `⚠️ Estado comprometido — score da IA reduzido em ${preview.penalty}pts. Opere com cautela extra.`
              : '✓ Bom estado — você está pronto para operar com foco.'
            }
          </div>
        )}

        {/* Botão */}
        <button
          disabled={!ready || saving}
          onClick={handleSubmit}
          className={cn(
            'w-full py-2.5 rounded-xl text-[12px] font-bold transition-all',
            !ready
              ? 'bg-[#131f2e] border border-[#1c3050] text-[#334455] cursor-not-allowed'
              : preview?.blocked
              ? 'bg-[#ef4444]/15 border border-[#ef4444]/40 text-[#ef4444] hover:bg-[#ef4444]/25'
              : 'bg-[#00e676]/15 border border-[#00e676]/40 text-[#00e676] hover:bg-[#00e676]/25',
          )}
        >
          {saving
            ? 'Salvando…'
            : !ready
            ? 'Responda todas as perguntas'
            : preview?.blocked
            ? 'Entendido — não vou operar hoje'
            : 'Estou pronto para operar →'
          }
        </button>
      </div>
    </div>
  )
}
