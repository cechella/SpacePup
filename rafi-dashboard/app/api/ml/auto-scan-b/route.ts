// Segundo cron de auto-scan — disparo das 07:00 UTC (sessão Tóquio/Londres)
// Vercel exige paths únicos; este re-exporta o mesmo handler do auto-scan principal.
export { GET } from '../auto-scan/route'
export { runtime, maxDuration } from '../auto-scan/route'
