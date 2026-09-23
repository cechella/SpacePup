// Cron wrapper para sessão Londres/NY (14:00 UTC / 11:00 BRT)
// Re-exporta o GET principal do auto-scan para que o Vercel possa agendar
// em um path diferente (/api/ml/auto-scan-c).
export const runtime     = 'nodejs'
export const maxDuration = 10
export { GET } from '../auto-scan/route'
