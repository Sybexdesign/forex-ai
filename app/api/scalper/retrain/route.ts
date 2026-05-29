// app/api/scalper/retrain/route.ts — proxy to ML service /worker/retrain
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8100'

export async function POST() {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const resp  = await fetch(`${ML_URL}/worker/retrain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const data = resp.ok ? await resp.json() : { status: 'error', code: resp.status }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ status: 'error', detail: e.message }, { status: 502 })
  }
}
