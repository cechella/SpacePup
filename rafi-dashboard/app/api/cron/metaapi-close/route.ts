import { NextRequest, NextResponse } from 'next/server'

// Cron: 17:30 UTC — fecha sessão MetaAPI (fim da sobreposição Londres + NY)
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://space-pup.vercel.app'
  const res  = await fetch(`${base}/api/metaapi/undeploy`, {
    method:  'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })
  const data = await res.json()
  console.log('[cron/metaapi-close]', JSON.stringify(data))
  return NextResponse.json({ cron: 'metaapi-close', ...data })
}
