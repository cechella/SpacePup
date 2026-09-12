export type SessionConfig = {
  capitalTarget:        number    // meta final ($1M)
  capitalInicial:       number    // capital de partida ($100)
  dailyGoal:            number    // meta de lucro por dia ($5)
  weeklyGoal:           number    // meta de lucro por semana ($25)
  monthlyGoal:          number    // meta de lucro por mês ($100)
  maxConsecutiveLosses: number    // gate: nº de perdas seguidas antes de bloquear
  maxWeeklyDrawdownPct: number    // gate: drawdown semanal máximo (%)
  tradingDays:          number[]  // dias operacionais (1=Seg … 5=Sex; 0=Dom; 6=Sáb)
  sessionStartUTC:      string    // início da janela operacional ("13:00")
  sessionEndUTC:        string    // fim da janela operacional ("17:00")
}

const SESSION_CONFIG_KEY = 'rafi-session-config'

export const SESSION_DEFAULTS: SessionConfig = {
  capitalTarget:        1_000_000,
  capitalInicial:       100,
  dailyGoal:            5,
  weeklyGoal:           25,
  monthlyGoal:          100,
  maxConsecutiveLosses: 2,
  maxWeeklyDrawdownPct: 30,
  tradingDays:          [1, 2, 3, 4],   // Seg–Qui
  sessionStartUTC:      '13:00',
  sessionEndUTC:        '17:00',
}

export function getSessionConfig(): SessionConfig {
  if (typeof window === 'undefined') return SESSION_DEFAULTS
  try {
    const raw = localStorage.getItem(SESSION_CONFIG_KEY)
    if (!raw) return SESSION_DEFAULTS
    return { ...SESSION_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return SESSION_DEFAULTS
  }
}

export function saveSessionConfig(cfg: Partial<SessionConfig>): void {
  if (typeof window === 'undefined') return
  try {
    const current = getSessionConfig()
    localStorage.setItem(SESSION_CONFIG_KEY, JSON.stringify({ ...current, ...cfg }))
  } catch {}
}
