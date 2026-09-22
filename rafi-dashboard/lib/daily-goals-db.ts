'use client'

import { createClient } from './supabase'

export interface DailyGoalRecord {
  date:       string  // 'YYYY-MM-DD' BRT
  dailyPct:   number
  dailyPnl:   number
  dailyMet:   boolean
  weeklyPct:  number
  weeklyPnl:  number
  weeklyMet:  boolean
  weekMonday: string  // 'YYYY-MM-DD' BRT — segunda-feira da semana
}

export async function upsertDailyGoal(r: DailyGoalRecord): Promise<void> {
  const db = createClient()
  const { error } = await db
    .from('rafi_daily_goals')
    .upsert({
      date:        r.date,
      daily_pct:   r.dailyPct,
      daily_pnl:   r.dailyPnl,
      daily_met:   r.dailyMet,
      weekly_pct:  r.weeklyPct,
      weekly_pnl:  r.weeklyPnl,
      weekly_met:  r.weeklyMet,
      week_monday: r.weekMonday,
      updated_at:  new Date().toISOString(),
    }, { onConflict: 'date' })
  if (error) console.error('[daily-goals] upsert:', error.message)
}

export async function fetchDailyGoal(date: string): Promise<DailyGoalRecord | null> {
  const db = createClient()
  const { data, error } = await db
    .from('rafi_daily_goals')
    .select('*')
    .eq('date', date)
    .maybeSingle()
  if (error || !data) return null
  return {
    date:       String(data.date),
    dailyPct:   Number(data.daily_pct),
    dailyPnl:   Number(data.daily_pnl),
    dailyMet:   Boolean(data.daily_met),
    weeklyPct:  Number(data.weekly_pct),
    weeklyPnl:  Number(data.weekly_pnl),
    weeklyMet:  Boolean(data.weekly_met),
    weekMonday: String(data.week_monday),
  }
}

// Busca o registro semanal mais recente que ainda está ativo nesta semana BRT
export async function fetchWeeklyGoal(weekMonday: string): Promise<DailyGoalRecord | null> {
  const db = createClient()
  const { data, error } = await db
    .from('rafi_daily_goals')
    .select('*')
    .eq('week_monday', weekMonday)
    .eq('weekly_met', true)
    .gt('weekly_pct', 0)   // ignora registros corrompidos com valores zerados
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return {
    date:       String(data.date),
    dailyPct:   Number(data.daily_pct),
    dailyPnl:   Number(data.daily_pnl),
    dailyMet:   Boolean(data.daily_met),
    weeklyPct:  Number(data.weekly_pct),
    weeklyPnl:  Number(data.weekly_pnl),
    weeklyMet:  Boolean(data.weekly_met),
    weekMonday: String(data.week_monday),
  }
}
