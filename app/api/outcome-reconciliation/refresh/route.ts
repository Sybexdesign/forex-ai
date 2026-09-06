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

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    const cronHeader = req.headers.get('x-vercel-cron')
    if (!cronHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      admin.from('trades').select('id, user_id, pair, direction, result, trade_status, entry_price, opened_at, closed_at, pl_usd')
        .gte('opened_at', since).order('opened_at', { ascending: false }).limit(limit),
    ])
    for (const r of [pred, sigResult, rec, trd]) if (r.error) throw r.error

    const { records, ambiguousSkipped } = linkRecords({
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
    if (existingRes.error) throw existingRes.error
    const diff = diffRefresh(derivedRows, existingRes.data ?? [])

    let upserted = 0
    if (diff.inserted.length + diff.updated.length > 0 && derivedRows.length > 0) {
      const upsertRes = await admin.from('outcome_reconciliation')
        .upsert(derivedRows, { onConflict: 'setup_key' })
      if (upsertRes.error) throw upsertRes.error
      upserted = derivedRows.length
    }

    return NextResponse.json({
      refreshed: true, windowDays, derivedRows: derivedRows.length,
      inserted: diff.inserted.length, updated: diff.updated.length,
      unchanged: diff.unchanged.length, ambiguousSkipped,
      upserted, note: 'Analytical layer only — source outcome tables are never modified.',
    })
  } catch (error: any) {
    console.error('[outcome-reconciliation/refresh]', error?.message)
    return NextResponse.json({ error: error?.message || 'refresh failed' }, { status: 500 })
  }
}
