// app/api/account/route.ts
import { NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'

export async function GET() {
  try {
    const broker = await getBroker()
    const summary = await broker.getAccountSummary()
    return NextResponse.json({ ...summary, broker: broker.name })
  } catch (error: any) {
    console.error('[account]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
