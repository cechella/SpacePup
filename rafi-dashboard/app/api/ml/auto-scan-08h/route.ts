// Cron wrapper — 08:00 UTC — re-exporta o handler principal do auto-scan
export const runtime = 'nodejs'
export const maxDuration = 10
export { GET } from '../auto-scan/route'
