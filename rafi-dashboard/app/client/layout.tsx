import { Sidebar } from '@/components/sidebar'

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-[#0d1117] overflow-hidden">
      <Sidebar role="client" />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
