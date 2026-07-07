'use client'

import { useState } from 'react'
import { TrendingUp, Lock, Mail, Eye, EyeOff } from 'lucide-react'

export default function LoginPage() {
  const [showPass, setShowPass] = useState(false)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // TODO: integrar Supabase Auth
    // const supabase = createClient()
    // await supabase.auth.signInWithPassword({ email, password })
    window.location.href = '/admin'
  }

  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#3b82f6]/15 border border-[#3b82f6]/30 mb-4">
            <TrendingUp size={28} className="text-[#3b82f6]" />
          </div>
          <h1 className="text-2xl font-bold text-[#f0f6fc]">RAFI Trading</h1>
          <p className="text-sm text-[#8b949e] mt-1">Acesse sua conta</p>
        </div>

        {/* Form */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6 space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-[#8b949e] font-medium">E-mail</label>
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#484f58]" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@rafi.trade"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-3 py-2.5 text-sm text-[#f0f6fc] placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6] transition-colors"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[#8b949e] font-medium">Senha</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#484f58]" />
              <input
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-10 py-2.5 text-sm text-[#f0f6fc] placeholder:text-[#484f58] focus:outline-none focus:border-[#3b82f6] transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPass(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#8b949e]"
              >
                {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            className="w-full bg-[#3b82f6] hover:bg-[#2563eb] text-white font-semibold py-2.5 rounded-xl text-sm transition-colors mt-2"
          >
            Entrar
          </button>

          <div className="text-center text-xs text-[#484f58]">
            Demo: clique em &quot;Entrar&quot; sem credenciais
          </div>
        </div>
      </div>
    </div>
  )
}
