// Segundo cron de auto-scan — disparo das 07:00 UTC (sessão Tóquio/Londres)
// Vercel exige paths únicos; este re-exporta o mesmo handler do auto-scan principal.
// Configs de rota devem ser declaradas localmente (não re-exportadas) no Next.js.
export const runtime = 'nodejs'
export const maxDuration = 10  // Vercel Hobby: máximo 10s
export { GET } from '../auto-scan/route'
