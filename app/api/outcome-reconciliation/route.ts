// app/api/outcome-reconciliation/route.ts
// Phase 3 — read-only cross-engine outcome reconciliation.
// GET /api/outcome-reconciliation?windowDays=30&pair=XAU/USD&direction=BUY
//
// Links prediction_logs, signals (labels), signal_reconciliation and executed
// trades for the SAME underlying decision and reports how often the engines
// agree/disagree and why. It NEVER writes to source engines.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { linkRecords } from '@/lib/outcome-linkage.mjs'
import { summarize, classifyRecord, AGREEMENT } from '@/lib/outcome-reconciliation.mjs'
import { OUTCOME_LABELS, OUTCOME_CONTRACTS, CONTRACT_VERSIONS } from '@/lib/outcome-contracts.mjs'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const windowDays  = Math.max(1, Math.min(365, parseInt(searchParams.get('windowDays') || '30', 10) || 30))
    const pair        = searchParams.get('pair') || undefined
    const direction   = searchParams.get('direction') || undefined
    const userId      = searchParams.get('userId') || undefined
    const limit       = Math.min(2000, parseInt(searchParams.get('limit') || '2000', 10) || 2000)

    const admin = getAdminClient()
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString()

    // Signals attribution columns exist only after migration 20260912. Query
    // with them; fall back to legacy columns when absent (route stays usable).
    let attributionAvailable = true
    let sigResult: any
    try {
      sigResult = await admin.from('signals')
        .select('id, user_id, pair, direction, outcome, outcome_source, signal_label_outcome, signal_label_source, signal_label_resolved_at, created_at, candle_close_time')
        .gte('created_at', since)
        .order('candle_close_time', { ascending: false, nullsFirst: false })
        .limit(limit)
      if (sigResult.error) throw sigResult.error
    } catch {
      attributionAvailable = false
      sigResult = await admin.from('signals')
        .select('id, user_id, pair, direction, outcome, created_at, candle_close_time')
        .gte('created_at', since)
        .order('candle_close_time', { ascending: false, nullsFirst: false })
        .limit(limit)
    }

    const [pred, rec, trd] = await Promise.all([
      admin.from('prediction_logs')
        .select('id, user_id, pair, direction, outcome, resolved_at, created_at, candle_close_time, entry')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit),
      admin.from('signal_reconciliation')
        .select('id, user_id, pair, direction, outcome, entry_price, generated_at, resolved_at')
        .gte('generated_at', since)
        .order('generated_at', { ascending: false })
        .limit(limit),
      admin.from('trades')
        .select('id, user_id, pair, direction, result, entry_price, opened_at, closed_at, pl_usd')
        .gte('opened_at', since)
        .order('opened_at', { ascending: false })
        .limit(limit),
    ])
    for (const r of [pred, sigResult, rec, trd]) if (r.error) throw r.error

    let predictions = (pred.data as any[] ?? [])
    let signals = (sigResult.data as any[] ?? [])
    let reconciliations = (rec.data as any[] ?? [])
    let trades = (trd.data as any[] ?? [])

    if (userId) {
      predictions = predictions.filter(x => x.user_id === userId)
      signals = signals.filter(x => x.user_id === userId)
      reconciliations = reconciliations.filter(x => x.user_id === userId)
      trades = trades.filter(x => x.user_id === userId)
    }
    if (pair) {
      predictions = predictions.filter(x => x.pair === pair)
      signals = signals.filter(x => x.pair === pair)
      reconciliations = reconciliations.filter(x => x.pair === pair)
      trades = trades.filter(x => x.pair === pair)
    }
    if (direction) {
      predictions = predictions.filter(x => x.direction === direction)
      reconciliations = reconciliations.filter(x => x.direction === direction)
    }

    const { records, ambiguousSkipped, linkedCounts } = linkRecords({
      predictions, signals, reconciliations, trades,
    })
    const summary = summarize(records)
    const fourClasses: Record<string, number> = {}
    for (const rec of records) {
      const c = classifyRecord(rec)
      fourClasses[c] = (fourClasses[c] || 0) + 1
    }

    return NextResponse.json({
      contract: {
        engines: {
          prediction:   OUTCOME_CONTRACTS.prediction_logs,
          signalLabel:  OUTCOME_CONTRACTS.signal_label_legacy,
          reconciliation: OUTCOME_CONTRACTS.reconciliation,
          execution:    OUTCOME_CONTRACTS.execution,
        },
        labels: OUTCOME_LABELS,
        versions: CONTRACT_VERSIONS,
      },
      filters: { windowDays, pair: pair ?? null, direction: direction ?? null, userId: userId ?? null, signalsAttributionAvailable: attributionAvailable },
      linkage: {
        predictionsLoaded: predictions.length,
        signalsLoaded: signals.length,
        reconciliationsLoaded: reconciliations.length,
        tradesLoaded: trades.length,
        recordsLinked: records.length,
        linkedCounts,
        ambiguousSkipped,
      },
      summary,
      fourEngineClassCounts: fourClasses,
      sample: records.slice(0, 10).map(r => ({
        setupKey: r.setupKey, pair: r.pair, direction: r.direction,
        prediction: r.prediction, signalLabel: r.signalLabel,
        signalLabelSource: r.signalLabelSource,
        reconciliation: r.reconciliation, execution: r.execution,
        executionPnl: r.executionPnl, prediction_log_id: r.prediction_log_id,
        candle_close_time: r.candle_close_time, signal_created_at: r.signal_created_at,
        agreementClass: classifyRecord(r),
      })),
      note: 'Read-only reconciliation layer. Source engines are never modified. ' +
            `Full agreement class: ${AGREEMENT.FULL}.`,
    })
  } catch (error: any) {
    console.error('[outcome-reconciliation]', error?.message)
    return NextResponse.json({ error: error?.message || 'reconciliation failed' }, { status: 500 })
  }
}
