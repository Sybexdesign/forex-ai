// app/api/account/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { getAdminClient } from '@/lib/supabase'

/**
 * Instruments the shadow study has ACTUAL pip geometry for.
 *
 * WHY AN EXPLICIT LIST AND NOT getPipValuePerLot() ALONE
 *
 * That helper returns a plausible default (10 / 0.0001) for any pair it does not
 * recognise, so a caller cannot tell a modelled instrument from a guessed one by
 * looking at the numbers. The shadow observer derives 1R — and therefore every R
 * multiple in the study — from this geometry, so it must skip an instrument
 * rather than divide by a fallback. This list is the authority for `known`.
 *
 * XAU/USD and XAG/USD are the only instruments the scalper trades; they are also
 * the only pairs modelled both by getPipValue (0.1 / 0.01) and getPipValuePerLot
 * (10 / 50). Adding a pair here is a deliberate act, not an accident of a
 * default branch. Nothing outside this route is affected.
 */
const SHADOW_MODELLED_PAIRS = new Set(['XAU/USD', 'XAG/USD'])

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(token)

    // Use allSettled so an open-trades failure doesn't block the whole response
    const [summaryResult, openTradesResult] = await Promise.allSettled([
      broker.getAccountSummary(),
      broker.getOpenTrades(),
    ])

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : { balance: 0, unrealizedPL: 0, realizedPL: 0, openTradeCount: 0, currency: 'USD', nav: 0 }
    const openTrades = openTradesResult.status === 'fulfilled' ? openTradesResult.value : []
    const brokerReliable = openTradesResult.status === 'fulfilled'

    // Non-blocking: sync any TP/SL-closed trades back to our DB.
    // Only for brokers that actually return live position data — MT5Direct and
    // SimulationBroker always return [] from getOpenTrades(), so we must NOT
    // use that to mark trades as closed (it would incorrectly close everything).
    if (token && brokerReliable && broker.supportsLivePositions) {
      syncClosedTrades(token, openTrades).catch(() => {})
    }

    // Surface the active broker_configs row's last_switched_at so the worker can
    // detect mid-session account switches AND same-broker reconfigure events that
    // the broker-name check alone misses. Also surface circuitBreakerUntil so the
    // worker can pause auto-trade after large-loss close events (Fix 3).
    let lastSwitchedAt:      string | null = null
    let circuitBreakerUntil: string | null = null
    let lastCbArmedAt:       string | null = null
    let lastCbArmedPair:     string | null = null
    let lastCbArmedPl:       string | null = null
    let lastCbArmedOneR:     string | null = null
    let profitFixedUsd:      number | null = null
    let profitTargetPct:     number | null = null
    if (token) {
      try {
        const parts = token.split('.')
        if (parts.length >= 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          const userId = payload?.sub
          if (userId) {
            const admin = getAdminClient()
            const { data: cfg } = await admin
              .from('broker_configs')
              .select('last_switched_at, config')
              .eq('user_id', userId)
              .eq('is_active', true)
              .limit(1)
              .maybeSingle()
            const c             = (cfg?.config as any) || {}
            lastSwitchedAt      = cfg?.last_switched_at ?? null
            circuitBreakerUntil = c.circuitBreakerUntil ?? null
            lastCbArmedAt       = c.lastCbArmedAt       ?? null
            lastCbArmedPair     = c.lastCbArmedPair     ?? null
            lastCbArmedPl       = c.lastCbArmedPl       ?? null
            lastCbArmedOneR     = c.lastCbArmedOneR     ?? null
            profitFixedUsd      = typeof c.profitFixedUsd  === 'number' ? c.profitFixedUsd  : null
            profitTargetPct     = typeof c.profitTargetPct === 'number' ? c.profitTargetPct : null
          }
        }
      } catch { /* metadata fetch is best-effort */ }
    }

    // Authoritative instrument geometry for the OPEN positions, so the scalper
    // worker can compute runtime 1R without duplicating pip tables it cannot
    // import (it is a plain .mjs process; these helpers live in TypeScript).
    // Without this the worker would have to hardcode a second copy of the pip
    // tables, and the two would silently drift — misstating the very number the
    // shadow study divides every R multiple by.
    // Additive only: no existing field changes, no new broker request.
    //
    // `known` flags whether the pair was actually MODELLED. getPipValue() falls
    // back to 0.0001 and getPipValuePerLot() to 10 for ANY unrecognised pair, so
    // a defaulted value is otherwise indistinguishable from a real one. An
    // R-based study must not divide by a guess, so the observer skips
    // `known: false` rather than deriving 1R from a fallback.
    const instrumentGeometry: Record<string, { pip: number; pipValuePerLot: number; known: boolean }> = {}
    for (const t of openTrades as Array<{ pair?: string }>) {
      if (t?.pair && !instrumentGeometry[t.pair]) {
        instrumentGeometry[t.pair] = {
          pip:             getPipValue(t.pair),
          pipValuePerLot:  getPipValuePerLot(t.pair),
          known:           SHADOW_MODELLED_PAIRS.has(t.pair),
        }
      }
    }

    return NextResponse.json({
      ...summary, broker: broker.name, openTrades, lastSwitchedAt,
      circuitBreakerUntil, lastCbArmedAt, lastCbArmedPair, lastCbArmedPl, lastCbArmedOneR,
      profitFixedUsd, profitTargetPct,
      instrumentGeometry,
    })
  } catch (error: any) {
    console.error('[account]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Compares DB-OPEN trades against broker positions and marks auto-closed ones (TP/SL) as CLOSED
async function syncClosedTrades(token: string, brokerPositions: any[]) {
  try {
    // Decode user ID from JWT (sub claim) — no library needed
    const parts = token.split('.')
    if (parts.length < 3) return
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const userId = payload?.sub
    if (!userId) return

    const admin = getAdminClient()

    const { data: dbOpen } = await admin
      .from('trades')
      .select('id, oanda_trade_id')
      .eq('user_id', userId)
      .eq('result', 'OPEN')

    if (!dbOpen?.length) return

    // Build set of broker-side open position IDs
    const brokerIds = new Set(brokerPositions.map((p: any) => p.id))

    // Trades in DB as OPEN but absent from broker → auto-closed by TP/SL
    const toClose = dbOpen.filter(t => t.oanda_trade_id && !brokerIds.has(t.oanda_trade_id))
    if (!toClose.length) return

    const now = new Date().toISOString()
    await Promise.all(
      toClose.map(t =>
        admin.from('trades')
          .update({ result: 'CLOSED', closed_at: now })
          .eq('id', t.id)
      )
    )
  } catch { /* ignore — sync is best-effort */ }
}
