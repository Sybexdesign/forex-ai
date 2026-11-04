// app/api/prediction-measure/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED PREDICTION MEASUREMENT v2 APPLIER.
//
// WHY THIS ROUTE EXISTS (production defect found 2026-11-04)
//   v2 measurement (candle-derived excursion + outcome classification) was only
//   reachable from `POST /api/mt5-sync`. The shipping EA (SybexForexAI_EA_v9.3.1)
//   pushes account data, prices and candles straight to the `mt5_webhook_sync`
//   RPC and NEVER calls /api/mt5-sync, so that block has not run since the
//   feature shipped:
//       m5_candle_history : 2,189 rows, frozen 2026-09-24 22:45
//       measurement_version = 2 : 39 rows, all created 2026-09-24
//   Every accuracy figure in the app was therefore still being produced by the
//   v1 ~10-second sweep sampler.
//
//   Independence from any single EA version is the point: this route reads the
//   same `broker_configs.config.candleCache` the RPC already maintains and is
//   driven by a Vercel cron (see vercel.json), not by EA traffic.
//
// SAFETY CONTRACT (unchanged, see lib/prediction-measurement-v2-runtime.mjs)
//   * writes ONLY the additive v2 columns on prediction_logs, guarded by
//     `measurement_version IS NULL` (first writer wins, re-runs no-op)
//   * never writes `outcome` / `mfe_pips` / `mae_pips` / `r_multiple` /
//     `time_to_*_s` — the live expectancy path is untouched
//   * cannot place, close, size or protect an order; it imports no broker,
//     order, risk or trade-management module
//   * a stale feed is refused rather than measured (selectMeasurableFeeds)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import {
  persistCandleHistory, applyV2Measurements, selectMeasurableFeeds, FRESH_FEED_MS,
} from '@/lib/prediction-measurement-v2-runtime.mjs'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // Same guard as the other cron endpoints: Vercel's cron header in production,
  // ?secret=CRON_SECRET for a manual run.
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    const cronHeader = req.headers.get('x-vercel-cron')
    if (!cronHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('broker_configs')
      .select('id, user_id, broker_type, is_active, label, config')
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    const feeds = selectMeasurableFeeds(data ?? [], Date.now())
    if (feeds.length === 0) {
      // Not an error: market closed, EA disconnected, or no MT5 account. The
      // absence of a fresh feed is reported explicitly so a silent no-op can
      // never be mistaken for "measurement is working".
      return NextResponse.json({
        ok: true, feeds: 0, measured: 0, reason: 'NO_FRESH_FEED',
        staleAfterMs: FRESH_FEED_MS,
      })
    }

    const results = []
    for (const feed of feeds) {
      const history = await persistCandleHistory(admin, feed.candleCache)
      const v2 = await applyV2Measurements(admin, { candleCache: feed.candleCache, userId: feed.userId })
      console.log(
        `[prediction-measure] user=${String(feed.userId).slice(0, 8)} feedAge=${Math.round(feed.ageMs / 1000)}s ` +
        `history attempted=${history.rows_attempted} inserted=${history.rows_inserted} err=${history.error ?? 'none'} | ` +
        `v2 considered=${v2.considered} measured=${v2.measured} notExpired=${v2.notExpired} noCandles=${v2.noCandles} ` +
        `disagree=${v2.disagreements} v1zero_v2pos=${v2.v1ZeroButV2Positive} failed=${v2.failed} err=${v2.error ?? 'none'}`,
      )
      if (v2.rls_blocked) {
        console.error('[prediction-measure] v2: 0 rows updated with 0 errors — the write did not land (RLS/service role)')
      }
      results.push({
        configId: feed.configId,
        userId: feed.userId,
        feedAgeMs: feed.ageMs,
        history,
        v2,
      })
    }

    return NextResponse.json({
      ok: true,
      feeds: results.length,
      measured: results.reduce((a, r) => a + (r.v2.measured ?? 0), 0),
      history_inserted: results.reduce((a, r) => a + (r.history.rows_inserted ?? 0), 0),
      results,
    })
  } catch (e) {
    // Measurement is analytics-only. A failure here must never look like a
    // trading outage, so it is logged and reported as a diagnostic payload.
    const message = e instanceof Error ? e.message : String(e)
    console.error('[prediction-measure] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
