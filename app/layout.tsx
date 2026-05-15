import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Sybex Forex AI — Intelligent Trading Terminal',
  description: 'Sybex Forex AI — AI-powered personal forex trading assistant with live signals and risk management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
