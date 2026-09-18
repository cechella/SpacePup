import { NextRequest, NextResponse } from 'next/server'

// Cron: 13:00 UTC — abre sessão MetaAPI (sobreposição Londres + NY)
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  // Vercel envia o header authorization com o CRON_SECRET configurado em Environment Variables
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://space-pup.vercel.app'
  const res  = await fetch(`${base}/api/metaapi/deploy`, {
    method:  'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })
  const data = await res.json()
  console.log('[cron/metaapi-open]', JSON.stringify(data))
  return NextResponse.json({ cron: 'metaapi-open', ...data })
}
