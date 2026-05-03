import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ForexAI — Intelligent Trading Terminal',
  description: 'AI-powered personal forex trading assistant with live signals and risk management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
