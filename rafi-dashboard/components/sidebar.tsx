'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, LineChart, Users, Settings,
  TrendingUp, LogOut, ChevronRight, BarChart2,
} from 'lucide-react'

interface NavItem { label: string; href: string; icon: React.ElementType }

const adminNav: NavItem[] = [
  { label: 'Dashboard',  href: '/admin',         icon: LayoutDashboard },
  { label: 'Gráfico RAFI', href: '/admin/chart', icon: BarChart2       },
  { label: 'Estratégia', href: '/admin/strategy', icon: TrendingUp      },
  { label: 'Clientes',   href: '/admin/clients',  icon: Users           },
  { label: 'Config',     href: '/admin/config',   icon: Settings        },
]

const clientNav: NavItem[] = [
  { label: 'Portfólio', href: '/client',          icon: LayoutDashboard },
  { label: 'Sinais',    href: '/client/signals',   icon: LineChart       },
]

interface Props { role: 'admin' | 'client' }

export function Sidebar({ role }: Props) {
  const path = usePathname()
  const nav  = role === 'admin' ? adminNav : clientNav

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-[#161b22] border-r border-[#30363d] h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-[#30363d]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#3b82f6]/20 border border-[#3b82f6]/30 flex items-center justify-center">
            <TrendingUp size={16} className="text-[#3b82f6]" />
          </div>
          <div>
            <div className="text-sm font-bold text-[#f0f6fc] tracking-wide">RAFI</div>
            <div className="text-[10px] text-[#484f58] uppercase tracking-widest">
              {role === 'admin' ? 'Admin' : 'Cliente'}
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ label, href, icon: Icon }) => {
          const active = path === href || (href !== '/admin' && href !== '/client' && path.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all group',
                active
                  ? 'bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/25'
                  : 'text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d]',
              )}
            >
              <div className="flex items-center gap-2.5">
                <Icon size={15} />
                {label}
              </div>
              {active && <ChevronRight size={12} className="opacity-60" />}
            </Link>
          )
        })}
      </nav>

      {/* User / Logout */}
      <div className="px-3 py-4 border-t border-[#30363d] space-y-1">
        {role === 'admin' && (
          <Link
            href="/client"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-[#484f58] hover:text-[#8b949e] hover:bg-[#21262d] transition-all"
          >
            <Users size={13} /> Ver como cliente
          </Link>
        )}
        <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-[#484f58] hover:text-red-400 hover:bg-red-500/10 transition-all">
          <LogOut size={13} /> Sair
        </button>
      </div>
    </aside>
  )
}
