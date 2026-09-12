import { Sidebar } from '@/components/sidebar'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-[#0d1117] overflow-hidden">
      <div className="hidden md:block">
        <Sidebar role="admin" />
      </div>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
