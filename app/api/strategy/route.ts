// app/api/strategy/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient, DEFAULT_STRATEGY } from '@/lib/supabase'
import { normaliseSizingSettings } from '@/lib/strategy-validation.mjs'

// Default auto-trade gate — safe-off so the worker never executes until the
// user explicitly flips auto_trade_enabled=TRUE in their strategies row.
const DEFAULT_AUTO_TRADE = {
  enabled:  false,
  sections: ['scalp'] as string[],
  pairs:    ['XAU/USD', 'XAG/USD'] as string[],
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ settings: DEFAULT_STRATEGY, autoTrade: DEFAULT_AUTO_TRADE, propFirm: { enabled: false } })

  try {
    const admin = getAdminClient()
    const { data } = await admin
      .from('strategies')
      .select('settings, auto_trade_enabled, auto_trade_sections, auto_trade_pairs')
      .eq('user_id', userId)
      .single()
    // Prop Firm Mode (single global row). When the row is absent the system
    // treats prop-firm as OFF — which also means the Overnight / Outside-Overlap
    // session restrictions are disabled (see workers/scalper.mjs gate).
    let propFirmEnabled = false
    try {
      const pf = await admin.from('prop_firm_settings').select('enabled').single()
      if (pf.data && typeof pf.data.enabled === 'boolean') propFirmEnabled = pf.data.enabled
    } catch { /* no row → prop firm OFF */ }
    return NextResponse.json({
      settings: data?.settings || DEFAULT_STRATEGY,
      autoTrade: {
        enabled:  data?.auto_trade_enabled  ?? DEFAULT_AUTO_TRADE.enabled,
        sections: data?.auto_trade_sections ?? DEFAULT_AUTO_TRADE.sections,
        pairs:    data?.auto_trade_pairs    ?? DEFAULT_AUTO_TRADE.pairs,
      },
      propFirm: { enabled: propFirmEnabled },
    })
  } catch (e: any) {
    console.error('[strategy GET]', e?.message)
    return NextResponse.json({ settings: DEFAULT_STRATEGY, autoTrade: DEFAULT_AUTO_TRADE, propFirm: { enabled: false }, isDefault: true })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, settings, autoTrade } = await req.json()
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

    const admin = getAdminClient()
    // Build upsert payload. BOTH settings and the autoTrade fields are now
    // optional — caller sends only what they want to change. Prevents two
    // distinct edit paths (Strategy slider save vs auto-trade toggle) from
    // clobbering each other when running concurrently or out of order.
    const payload: Record<string, unknown> = {
      user_id: userId,
      updated_at: new Date().toISOString(),
    }
    if (settings && typeof settings === 'object') {
      // Validate the sizing fields via the SHARED production module so the route,
      // the UI and the tests cannot disagree (a stale literal here previously
      // rejected every 1..10 lot save the UI accepted).
      const sizing = normaliseSizingSettings(settings)
      if (!sizing.ok) {
        return NextResponse.json({ error: sizing.error }, { status: 400 })
      }
      const normalisedSettings = sizing.normalised as typeof settings
      payload.settings = normalisedSettings
      // Mirror manualLots into the dedicated column so it can be queried/indexed
      // without parsing JSONB. settings.manualLots remains the source of truth at runtime.
      if (normalisedSettings.manualLots === null || normalisedSettings.manualLots === undefined) {
        payload.manual_lots = null
      } else {
        payload.manual_lots = normalisedSettings.manualLots
      }
    }
    if (autoTrade && typeof autoTrade === 'object') {
      if (typeof autoTrade.enabled === 'boolean') payload.auto_trade_enabled  = autoTrade.enabled
      if (Array.isArray(autoTrade.sections))      payload.auto_trade_sections = autoTrade.sections
      if (Array.isArray(autoTrade.pairs))         payload.auto_trade_pairs    = autoTrade.pairs
    }
    // No-op guard: if caller sent neither settings nor autoTrade, don't write.
    if (Object.keys(payload).length <= 2) {
      return NextResponse.json({ success: true, noop: true })
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
