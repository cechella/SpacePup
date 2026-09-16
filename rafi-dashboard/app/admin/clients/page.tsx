'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function ClientsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/client') }, [router])
  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
      <p className="text-[#8b949e] text-sm">Redirecionando para /client…</p>
    </div>
  )
}
