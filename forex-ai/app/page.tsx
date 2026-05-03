'use client'
import dynamic from 'next/dynamic'

const AppShell = dynamic(() => import('@/components/AppShell'), {
  ssr: false,
  loading: () => null,
})

export default function Home() {
  return <AppShell />
}
