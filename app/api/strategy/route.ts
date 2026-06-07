// app/api/strategy/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient, DEFAULT_STRATEGY } from '@/lib/supabase'

// Default auto-trade gate — safe-off so the worker never executes until the
// user explicitly flips auto_trade_enabled=TRUE in their strategies row.
const DEFAULT_AUTO_TRADE = {
  enabled:  false,
  sections: ['scalp'] as string[],
  pairs:    ['XAU/USD', 'XAG/USD'] as string[],
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ settings: DEFAULT_STRATEGY, autoTrade: DEFAULT_AUTO_TRADE })

  try {
    const admin = getAdminClient()
    const { data } = await admin
      .from('strategies')
      .select('settings, auto_trade_enabled, auto_trade_sections, auto_trade_pairs')
      .eq('user_id', userId)
      .single()
    return NextResponse.json({
      settings: data?.settings || DEFAULT_STRATEGY,
      autoTrade: {
        enabled:  data?.auto_trade_enabled  ?? DEFAULT_AUTO_TRADE.enabled,
        sections: data?.auto_trade_sections ?? DEFAULT_AUTO_TRADE.sections,
        pairs:    data?.auto_trade_pairs    ?? DEFAULT_AUTO_TRADE.pairs,
      },
    })
  } catch (e: any) {
    console.error('[strategy GET]', e?.message)
    return NextResponse.json({ settings: DEFAULT_STRATEGY, autoTrade: DEFAULT_AUTO_TRADE, isDefault: true })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, settings, autoTrade } = await req.json()
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

    const admin = getAdminClient()
    // Build upsert payload. settings is always updated. autoTrade fields are
    // optional — only included when the caller wants to change them, so
    // callers updating only settings don't accidentally clobber the
    // auto-trade gate or vice versa.
    const payload: Record<string, unknown> = {
      user_id: userId,
      settings,
      updated_at: new Date().toISOString(),
    }
    if (autoTrade && typeof autoTrade === 'object') {
      if (typeof autoTrade.enabled === 'boolean') payload.auto_trade_enabled  = autoTrade.enabled
      if (Array.isArray(autoTrade.sections))      payload.auto_trade_sections = autoTrade.sections
      if (Array.isArray(autoTrade.pairs))         payload.auto_trade_pairs    = autoTrade.pairs
    }
    const { error } = await admin
      .from('strategies')
      .upsert(payload, { onConflict: 'user_id' })

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
