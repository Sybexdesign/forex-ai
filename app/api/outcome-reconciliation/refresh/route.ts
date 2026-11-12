// app/api/outcome-reconciliation/refresh/route.ts
// Phase 4 — automatic incremental refresh of the analytical outcome_reconciliation
// layer. Called by Vercel cron (see vercel.json) and usable manually:
//   GET /api/outcome-reconciliation/refresh?secret=…&windowDays=2
//
// Recomputes linked records from SOURCE tables and merge-upserts them on
// setup_key — existing rows are UPDATED (execution arrives later, classifications
// evolve) instead of the old delete-and-reinsert / ignore-duplicates model.
// Source tables are NEVER modified.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { linkRecords } from '@/lib/outcome-linkage.mjs'
import { classifyRecord, diagnose } from '@/lib/outcome-reconciliation.mjs'
import { diffRefresh } from '@/lib/execution-truth.mjs'

export const dynamic = 'force-dynamic'

const REFRESH_FIELDS = 'setup_key,prediction_outcome,prediction_resolved_at,signal_label_outcome,signal_label_source,signal_label_resolved_at,reconciliation_outcome,reconciliation_resolved_at,execution_outcome,execution_closed_at,execution_pnl_usd,execution_r,agreement_class,disagreement_reasons,contract_versions'

// Last successful refresh, per warm server instance. Used to distinguish "the
// cron stopped running" from "the cron ran and changed nothing" — the previous
// single `refreshed: true` response could not tell those apart.
let lastSuccessfulRefreshAt: string | null = null
let lastRefreshError: { at: string, message: string } | null = null

/**
 * Authorisation (Phase 4.2E).
 *
 * Three separate weaknesses existed and are all closed here:
 *
 *   1. The secret was read ONLY from the query string (`?secret=`). A query
 *      string is written to access logs, proxy logs, browser history and every
 *      Referer header, so a valid secret leaked itself. Headers are now the
 *      supported transport and the query string is kept only as a fallback for
 *      a deliberately hand-typed manual call.
 *   2. When CRON_SECRET was absent in production the check fell back to trusting
 *      the `x-vercel-cron` request header — which any caller can forge, so the
 *      "authentication" was decorative. That fallback is GONE. Unconfigured in
 *      production now denies, and says so.
 *   3. Comparison was a plain `===`. It is now timing-safe.
 *
 * Modes are returned so /api/production-integrity can report the real state
 * instead of a boolean that hides why a request was rejected.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

function authorise(req: NextRequest): { ok: boolean, authMode: string, configured: boolean } {
  const configured = process.env.CRON_SECRET
  const presented = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    || req.headers.get('x-cron-secret')?.trim()
    || req.nextUrl.searchParams.get('secret')?.trim()
    || ''

  if (configured) {
    const ok = presented.length > 0 && timingSafeEqual(presented, configured)
    return { ok, authMode: 'cron_secret', configured: true }
  }

  // No secret configured. Never open in production — an unauthenticated endpoint
  // that rewrites derived analytical rows is an open invitation.
  if (process.env.NODE_ENV !== 'production') return { ok: true, authMode: 'development_open', configured: false }
  return { ok: false, authMode: 'cron_secret_not_configured', configured: false }
}

export async function GET(req: NextRequest) {
  const auth = authorise(req)
  if (!auth.ok) {
    // 503 (not 401) when the secret is simply absent: this is a deployment
    // misconfiguration that an operator must fix, not a bad caller.
    const status = auth.authMode === 'cron_secret_not_configured' ? 503 : 401
    return NextResponse.json({
      refreshed: false,
      error: auth.authMode === 'cron_secret_not_configured'
        ? 'CRON_SECRET is not configured; refusing to refresh unauthenticated'
        : 'Unauthorized',
      authMode: auth.authMode,
    }, { status })
  }
  try {
    const windowDays = Math.max(1, Math.min(90, parseInt(req.nextUrl.searchParams.get('windowDays') || '2', 10) || 2))
    const limit = 2000
    const admin = getAdminClient()
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString()

    const [pred, sigResult, rec, trd] = await Promise.all([
      admin.from('prediction_logs').select('id, user_id, pair, direction, outcome, resolved_at, created_at, candle_close_time, entry')
        .gte('created_at', since).order('created_at', { ascending: false }).limit(limit),
      admin.from('signals').select('id, user_id, pair, direction, outcome, outcome_source, signal_label_outcome, signal_label_source, signal_label_resolved_at, created_at, candle_close_time')
        .gte('created_at', since).order('candle_close_time', { ascending: false, nullsFirst: false }).limit(limit),
      admin.from('signal_reconciliation').select('id, user_id, pair, direction, outcome, entry_price, generated_at, resolved_at')
        .gte('generated_at', since).order('generated_at', { ascending: false }).limit(limit),
      // trade_status / trade_result / prediction_log_id are READ here so legacy
      // result='CLOSED' rows can be evaluated on canonical fields (4.1D fix 2)
      // and explicit lineage can resolve ambiguity (4.1D fix 3).
      admin.from('trades').select('id, user_id, pair, direction, result, trade_status, trade_result, prediction_log_id, entry_price, opened_at, closed_at, pl_usd')
        .gte('opened_at', since).order('opened_at', { ascending: false }).limit(limit),
    ])
    const sourceErrors: string[] = []
    for (const [name, r] of [['prediction_logs', pred], ['signals', sigResult], ['signal_reconciliation', rec], ['trades', trd]] as const) {
      if (r.error) sourceErrors.push(`${name}: ${r.error.message}`)
    }
    if (sourceErrors.length > 0) throw new Error(`source read failed — ${sourceErrors.join('; ')}`)

    const { records, ambiguousSkipped, linkedCounts, ambiguities } = linkRecords({
      predictions: pred.data ?? [], signals: sigResult.data ?? [],
      reconciliations: rec.data ?? [], trades: trd.data ?? [],
    })
    const derivedRows = records.map((r: any) => ({
      user_id: r.user_id, pair: r.pair, direction: r.direction,
      prediction_log_id: r.prediction_log_id, reconciliation_id: r.reconciliation_id ?? null,
      execution_id: r.execution_id ?? null, setup_key: r.setupKey,
      candle_close_time: r.candle_close_time ?? null, signal_created_at: r.signal_created_at ?? null,
      prediction_outcome: r.prediction, prediction_resolved_at: r.predictionResolvedAt ?? null,
      signal_label_outcome: r.signalLabel, signal_label_source: r.signalLabelSource ?? null,
      signal_label_resolved_at: r.signalLabelResolvedAt ?? null,
      reconciliation_outcome: r.reconciliation, reconciliation_resolved_at: r.reconciliationResolvedAt ?? null,
      execution_outcome: r.execution, execution_closed_at: r.executionClosedAt ?? null,
      execution_pnl_usd: r.executionPnl ?? null,
      agreement_class: classifyRecord(r),
      disagreement_reasons: diagnose(r),
      contract_versions: { prediction: 'prediction_v2_phase2', signal_label: 'label_legacy', reconciliation: 'reconcile_v1', execution: null },
    }))

    const existingRes = await admin.from('outcome_reconciliation').select(REFRESH_FIELDS).limit(5000)
    if (existingRes.error) throw new Error(`outcome_reconciliation read failed — ${existingRes.error.message}`)
    const diff = diffRefresh(derivedRows, existingRes.data ?? [])

    let upserted = 0
    if (diff.inserted.length + diff.updated.length > 0) {
      const upsertRes = await admin.from('outcome_reconciliation')
        .upsert(derivedRows, { onConflict: 'setup_key' })
      if (upsertRes.error) throw new Error(`upsert failed — ${upsertRes.error.message}`)
      upserted = diff.inserted.length + diff.updated.length
    }

    lastSuccessfulRefreshAt = new Date().toISOString()
    lastRefreshError = null

    // Transparency block (4.1D fix 4). `refreshed: true` now always means the
    // derivation completed; `changed` tells you whether anything actually moved.
    return NextResponse.json({
      refreshed: true,
      lastSuccessfulRefreshAt,
      authMode: auth.authMode,
      windowDays,
      examined: {
        predictions: pred.data?.length ?? 0,
        signals: sigResult.data?.length ?? 0,
        reconciliations: rec.data?.length ?? 0,
        trades: trd.data?.length ?? 0,
      },
      derivedRows: derivedRows.length,
      inserted: diff.inserted.length,
      updated: diff.updated.length,
      unchanged: diff.unchanged.length,
      notInWindow: diff.deleted.length,
      upserted,
      changed: upserted > 0,
      executionLinks: linkedCounts.execution,
      resolved: derivedRows.filter((r: any) => r.execution_outcome !== null).length,
      pending: derivedRows.filter((r: any) => r.execution_outcome === null).length,
      ambiguous: ambiguousSkipped,
      ambiguities: ambiguities.slice(0, 50),
      note: 'Analytical layer only — source outcome tables are never modified.',
    })
  } catch (error: any) {
    lastRefreshError = { at: new Date().toISOString(), message: error?.message || 'refresh failed' }
    console.error('[outcome-reconciliation/refresh]', error?.message)
    // `refreshed: false` is explicit so a failure can never be mistaken for a
    // successful zero-change refresh.
    return NextResponse.json({
      refreshed: false,
      lastSuccessfulRefreshAt,
      error: error?.message || 'refresh failed',
      lastErrorAt: lastRefreshError.at,
    }, { status: 500 })
  }
}
