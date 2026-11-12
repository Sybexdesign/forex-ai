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
 * Authorisation.
 *
 * The previous check trusted the `x-vercel-cron` request header whenever
 * CRON_SECRET was absent — and that header is trivially forgeable by any caller.
 * Now:
 *   • if CRON_SECRET is configured, an exact match is REQUIRED (header ignored);
 *   • if it is NOT configured, production requests carrying the cron header are
 *     still allowed so the scheduled job keeps working, but the mode is reported
 *     as `header_only_INSECURE` so the weakness is visible, not silent.
 */
function authorise(req: NextRequest): { ok: boolean, authMode: string } {
  const secret = req.nextUrl.searchParams.get('secret')
  const configured = process.env.CRON_SECRET
  if (configured) return { ok: secret === configured, authMode: 'cron_secret' }
  if (process.env.NODE_ENV !== 'production') return { ok: true, authMode: 'development_open' }
  const hasHeader = !!req.headers.get('x-vercel-cron')
  return { ok: hasHeader, authMode: hasHeader ? 'header_only_INSECURE' : 'denied' }
}

export async function GET(req: NextRequest) {
  const auth = authorise(req)
  if (!auth.ok) {
    return NextResponse.json({ refreshed: false, error: 'Unauthorized', authMode: auth.authMode }, { status: 401 })
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
