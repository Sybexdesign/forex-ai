// app/api/scalper/direction-confirm/route.ts
// ── AUTOMATED DIRECTION VALIDATION (VALIDATION ENGINE, not the manual trigger) ─
//
// Design split, per the phase brief:
//
//   VALIDATION ENGINE      lib/direction-validation.mjs (pure, no I/O)
//   MANUAL TRIGGER         /api/scalper/direction-check   (operator button — unchanged)
//   AUTOMATED TRIGGER      this route                     (worker-initiated)
//
// Both triggers feed the SAME engine and persist the SAME short-lived permit
// shape, so they cannot drift apart. Only the trigger and the `source` differ.
//
// ACCOUNT ISOLATION: the owning user is resolved from the caller's bearer token
// via Supabase, NEVER from the request body — a client cannot ask for another
// account's validation. Market data is fetched with that same token, so
// getMarketCandles resolves the caller's own broker_configs row.
//
// CLOSED CANDLES ONLY: selectLatestClosedCandle() (already tested) strips the
// forming bar; the validator never sees it and therefore can never grant a
// permit from an unfinished candle.
//
// FAIL CLOSED: every unresolved condition returns status UNAVAILABLE and
// persists nothing.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { getMarketCandles } from '@/lib/marketdata'
import { selectLatestClosedCandle } from '@/lib/market-health'
import { calculateIndicators } from '@/lib/indicators'
import { evaluateDirectionPermit, HOLD } from '@/lib/direction-validation.mjs'

const M5_SPAN_MS  = 5 * 60_000
const HTF_TF      = '15m'
const HTF_SPAN_MS = 15 * 60_000
const MIN_BARS    = 60
// TTL is deliberately the EXISTING 5-minute candle window — not extended.
const PERMIT_TTL_MS = 300_000

const unavailable = (pair: string, reason: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ pair, status: 'UNAVAILABLE', direction: HOLD, persisted: false, reason, ...extra }, { status: 200 })

export async function POST(req: NextRequest) {
  try {
    // ── 1. Server-side identity — never a client-supplied user id ───────────
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') || ''
    if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const admin = getAdminClient()
    const { data: { user } } = await admin.auth.getUser(token)
    if (!user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id

    const body = await req.json().catch(() => ({}))
    const pair = String(body?.pair ?? '').trim()
    const candidateDirection = String(body?.candidateDirection ?? HOLD).toUpperCase()
    if (!pair) return NextResponse.json({ error: 'pair required' }, { status: 400 })
    if (!['BUY', 'SELL', 'HOLD'].includes(candidateDirection)) {
      return NextResponse.json({ error: 'candidateDirection must be BUY|SELL|HOLD' }, { status: 400 })
    }

    // ── 2. Account-scoped market data (the caller's own broker_config) ──────
    const [m5, htf] = await Promise.all([
      getMarketCandles(token, pair, '5m', 200),
      getMarketCandles(token, pair, HTF_TF, 200),
    ])
    if (m5?.simulated || htf?.simulated) {
      return unavailable(pair, 'simulated-feed', { detail: 'live data required for a permit' })
    }
    if (!Array.isArray(m5?.candles) || m5.candles.length < MIN_BARS) {
      return unavailable(pair, 'insufficient-market-data')
    }

    const nowMs = Date.now()
    const selM5 = selectLatestClosedCandle(m5.candles, M5_SPAN_MS, nowMs, `${pair}:5m`)
    if (selM5.none || !selM5.closedCloseTime || !selM5.closedCount) {
      return unavailable(pair, 'no-closed-candle')
    }
    // Closed bars ONLY — the forming bar is excluded by design.
    const m5Closed  = m5.candles.slice(0, selM5.closedCount)
    const selHtf    = Array.isArray(htf?.candles)
      ? selectLatestClosedCandle(htf.candles, HTF_SPAN_MS, nowMs, `${pair}:${HTF_TF}`) : null
    const htfClosed = selHtf && !selHtf.none ? htf.candles.slice(0, selHtf.closedCount) : []

    // ADX from the same closed-bar set, using the project's existing indicator layer.
    let adx = 0
    try { adx = Number(calculateIndicators(m5Closed)?.adx ?? 0) } catch { adx = 0 }

    // ── 3. Independent validation (candidate is NOT an input to the direction) ─
    const verdict = evaluateDirectionPermit({ m5Closed, htfClosed, adx }, candidateDirection)

    // ── 4. Short-lived permit — persisted only for a real validation outcome ─
    const analyzedAt = new Date(nowMs)
    const expiresAt  = new Date(nowMs + PERMIT_TTL_MS)
    try {
      const { error } = await admin.from('direction_confirmations').insert({
        user_id:     userId,
        pair,
        timeframe:   '5m',                 // table CHECK constraint
        direction:   verdict.direction,    // BUY | SELL | HOLD (HOLD = denial)
        recommended: 'scalp',              // the automated path validates the scalp direction
        confidence:  Math.max(0, Math.min(100, Math.round(verdict.confidence))),
        regime:      null,
        adx:         Number.isFinite(adx) ? adx : null,
        market_type: null,
        analyzed_at: analyzedAt.toISOString(),
        expires_at:  expiresAt.toISOString(),
        source:      'automated',
      })
      if (error) {
        console.error('[direction-confirm] persist failed:', error.message)
        // No persisted permit means the worker cannot proceed — report it rather
        // than returning a verdict that cannot be acted on.
        return unavailable(pair, 'persist-failed', { detail: error.message })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[direction-confirm] persist threw:', msg)
      return unavailable(pair, 'persist-failed', { detail: msg })
    }

    // §10 observability — one line reconstructs the whole decision. No JWT logged.
    console.log(
      `[direction-confirm] pair=${pair} candidate=${candidateDirection} ` +
      `derived=${verdict.direction} status=${verdict.status} ` +
      `votes=${verdict.bull}/${verdict.votes.length} adx=${adx.toFixed(1)} ` +
      `closedCandle=${selM5.closedCloseTime} source=automated persisted=true`
    )

    return NextResponse.json({
      pair,
      status:          verdict.status,          // CONFIRMED | HOLD | MISMATCH
      direction:       verdict.direction,
      candidateDirection,
      confidence:      verdict.confidence,
      bull:            verdict.bull,
      bear:            verdict.bear,
      votes:           verdict.votes,
      reasons:         verdict.reasons,
      adx,
      closedCandleTime: selM5.closedCloseTime,
      analyzedAt:      analyzedAt.toISOString(),
      expiresAt:       expiresAt.toISOString(),
      source:          'automated',
      persisted:       true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[direction-confirm]', msg)
    return NextResponse.json({ status: 'UNAVAILABLE', reason: 'internal-error' }, { status: 500 })
  }
}
