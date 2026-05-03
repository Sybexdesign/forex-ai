// app/api/trades/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .order('opened_at', { ascending: false })
      .limit(200)

    if (error) throw error
    return NextResponse.json({ trades: data || [] })
  } catch (error: any) {
    // Return demo data if DB not configured
    return NextResponse.json({ trades: generateDemoTrades(), simulated: true })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').insert(body).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...updates } = body
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').update(updates).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function generateDemoTrades() {
  const pairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']
  const trades = []
  for (let i = 0; i < 20; i++) {
    const win = Math.random() > 0.42
    const pips = win ? +(Math.random() * 60 + 10).toFixed(1) : -(Math.random() * 30 + 5).toFixed(1)
    const pl = +(+pips * 0.9).toFixed(2)
    const openDate = new Date(Date.now() - (20 - i) * 86400000 * 1.2)
    trades.push({
      id: `demo-${i + 1}`,
      user_id: 'demo',
      pair: pairs[Math.floor(Math.random() * pairs.length)],
      direction: Math.random() > 0.5 ? 'BUY' : 'SELL',
      entry_price: +(1.08 + Math.random() * 0.01).toFixed(5),
      exit_price: +(1.08 + Math.random() * 0.01).toFixed(5),
      tp_price: +(1.09).toFixed(5),
      sl_price: +(1.075).toFixed(5),
      lots: 0.05,
      pips: +pips,
      pl_usd: pl,
      result: win ? 'WIN' : 'LOSS',
      rules_followed: Math.random() > 0.25,
      checklist_score: Math.floor(Math.random() * 3) + 5,
      ai_confidence: Math.floor(Math.random() * 30) + 55,
      notes: win ? 'Clean entry at key level, hit TP' : 'Stopped out — news spike',
      opened_at: openDate.toISOString(),
      closed_at: new Date(openDate.getTime() + Math.random() * 14400000).toISOString(),
    })
  }
  return trades
}
