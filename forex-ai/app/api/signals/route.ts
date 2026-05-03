// app/api/signals/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('signals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw error
    return NextResponse.json({ signals: data || [] })
  } catch {
    return NextResponse.json({ signals: generateDemoSignals(), simulated: true })
  }
}

function generateDemoSignals() {
  const pairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']
  const timeframes = ['5m', '15m', '1H', '4H']
  const directions = ['BUY', 'SELL', 'WAIT']
  const outcomes = ['WIN', 'LOSS', 'PENDING', 'SKIPPED']
  return Array.from({ length: 15 }, (_, i) => ({
    id: `sig-${i + 1}`,
    user_id: 'demo',
    pair: pairs[Math.floor(Math.random() * pairs.length)],
    timeframe: timeframes[Math.floor(Math.random() * timeframes.length)],
    direction: directions[Math.floor(Math.random() * directions.length)],
    confidence: Math.floor(Math.random() * 35) + 50,
    checklist_score: Math.floor(Math.random() * 4) + 4,
    acted_on: Math.random() > 0.4,
    outcome: outcomes[Math.floor(Math.random() * outcomes.length)],
    created_at: new Date(Date.now() - i * 5400000).toISOString(),
  }))
}
