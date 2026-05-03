// app/api/broker/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker, BROKER_INFO } from '@/lib/brokers'
import type { BrokerKey } from '@/lib/brokers'

export async function GET() {
  const key = (process.env.TRADING_BROKER || 'simulation') as BrokerKey
  const broker = await getBroker()
  const info = BROKER_INFO[key] || BROKER_INFO.simulation

  // Check which env vars are set
  const configured: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(BROKER_INFO)) {
    configured[k] = v.envVars.every(e => !!process.env[e])
  }

  return NextResponse.json({
    active: key,
    activeName: broker.name,
    supportedPairs: broker.supportedPairs,
    info,
    allBrokers: Object.entries(BROKER_INFO).map(([k, v]) => ({
      key: k,
      ...v,
      configured: configured[k],
      active: k === key,
    })),
  })
}
