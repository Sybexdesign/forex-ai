// app/api/trading-session/route.ts
export const dynamic = 'force-dynamic'

/**
 * GET /api/trading-session?userId=…
 *
 * The AUTHORITATIVE answer to "is the saved ACTIVE TRADING HOURS (UTC) window
 * open right now?" — computed on the server, from the saved strategy row, with
 * the same `lib/trading-session.mjs` module that gates signal generation, worker
 * execution and order submission.
 *
 * WHY THIS ENDPOINT EXISTS
 * The Strategy page used to draw the window and say "AI will only generate
 * signals during these hours" while showing no clock, no state and no proof
 * (ACTIVE_TRADING_HOURS_AUDIT.md H-6). Deriving the badge in the browser would
 * have created a second implementation and let the UI disagree with the gate.
 * So the UI renders this response instead of computing anything.
 *
 * Read-only, no side effects, no trading action. Never 500s on a bad window: an
 * unusable configuration is a 200 with `eligible: false` and a named reason,
 * because "cannot evaluate" is a legitimate state the UI must display.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient, DEFAULT_STRATEGY } from '@/lib/supabase'
import { sessionAudit } from '@/lib/trading-session.mjs'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  const now = new Date()

  // No user → evaluate the same defaults GET /api/strategy would serve, so the
  // UI still shows an honest state before sign-in resolves.
  if (!userId) {
    return NextResponse.json({
      session: sessionAudit(DEFAULT_STRATEGY, now, now.getTime()),
      source: 'default-strategy',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('strategies')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    const settings = data?.settings && typeof data.settings === 'object'
      ? data.settings
      : DEFAULT_STRATEGY
    const source = data?.settings && typeof data.settings === 'object'
      ? 'saved-strategy'
      : 'default-strategy'

    return NextResponse.json({
      session: sessionAudit(settings, now, now.getTime()),
      source,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    // The strategy could not be read. Report the state as UNKNOWN-and-denied
    // rather than guessing or showing a fabricated "open" badge.
    console.error('[trading-session] read failed:', e?.message)
    return NextResponse.json({
      session: {
        version: 'trading_session_v1',
        fingerprint: null,
        window: null,
        startHour: null,
        endHour: null,
        wraps: false,
        utcTimestamp: now.toISOString(),
        utcHour: now.getUTCHours(),
        eligible: false,
        reason: 'saved_strategy_unreadable',
        nextOpen: null,
        nextClose: null,
      },
      source: 'unreadable',
      error: 'The saved strategy could not be read, so the trading window is unverified. Orders are blocked.',
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }
}
