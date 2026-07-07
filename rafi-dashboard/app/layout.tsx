import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'RAFI Trading',
  description: 'Plataforma de sinais RAFI — EURUSD',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
