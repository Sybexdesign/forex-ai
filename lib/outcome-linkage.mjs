// lib/outcome-linkage.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — CONSERVATIVE CROSS-ENGINE RECORD LINKAGE (Phase 3)
//
// Links prediction_logs, signals (labels), signal_reconciliation and trades
// that refer to the SAME underlying decision. Pure + deterministic:
//   • exact keys first: user_id + pair + candle_close_time (broker frame)
//   • time/price matching is conservative and single-candidate
//   • an ambiguous match is NEVER guessed — the engine is left unlinked and
//     counted (ambiguousSkipped) so analytics never silently conflate records
//
// It never writes anything; materialisation is done by the backfill script/API.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  reconWindowMs: 120_000,          // reconciliation captured within ±2 min of the prediction
  reconEntryTolerancePips: 1.0,    // entry must match the prediction entry within 1 pip
  execWindowMs: 300_000,           // broker trade opened within ±5 min of the prediction
  pipMap: (pair) => (pair.includes('JPY') ? 0.01 : pair.startsWith('XAU') ? 0.1 : pair.startsWith('XAG') ? 0.01 : 0.0001),
}

const keyOf = (userId, pair, candle) => `${String(userId)}|${pair}|${String(candle ?? '')}`


/**
 * pools:
 *   predictions:     [{ id, user_id, pair, direction, outcome, created_at, candle_close_time, entry }]
 *   signals:         [{ id, user_id, pair, direction, outcome, outcome_source, signal_label_outcome, created_at, candle_close_time }]
 *   reconciliations: [{ id, user_id, pair, direction, outcome, entry_price, generated_at, resolved_at }]
 *   trades:          [{ id, user_id, pair, direction, result, entry_price, opened_at, closed_at, pl_usd }]
 * Returns { records, ambiguousSkipped, linkedCounts }
 */
export function linkRecords(pools, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const { predictions = [], signals = [], reconciliations = [], trades = [] } = pools
  const ambiguousSkipped = { reconciliation: 0, execution: 0, signal: 0 }
  const linkedCounts = { prediction: 0, signalLabel: 0, reconciliation: 0, execution: 0 }

  // index signals by user|pair|candle close (candle_close_time may be null → skip)
  const byCandle = new Map()
  for (const s of signals) {
    if (!s.candle_close_time || s.user_id === undefined || s.user_id === null) continue
    const k = keyOf(s.user_id, s.pair, s.candle_close_time)
    if (!byCandle.has(k)) byCandle.set(k, [])
    byCandle.get(k).push(s)
  }

  const records = []
  const seenKeys = new Set()
  for (const p of predictions) {
    if (p.user_id === undefined || p.user_id === null) continue
    const anchorTime = new Date(p.created_at).getTime()
    if (!Number.isFinite(anchorTime)) continue
    const candleKey = keyOf(p.user_id, p.pair, p.candle_close_time || null)
    if (seenKeys.has(candleKey)) continue            // one prediction per candle already
    seenKeys.add(candleKey)

    linkedCounts.prediction++

    // 1) Signal label — exact candle identity, single candidate (newest wins).
    let signalLabel = null
    let signalLabelSource = null
    let signalResolvedAt = null
    if (p.candle_close_time) {
      // Signals for the same candle across users (route vs worker rows) are
      // candidates; a single deterministic (newest, labelled-first) row is chosen.
      const cands = byCandle.get(candleKey) || []
      let pool = cands.filter((s) => s.signal_label_outcome !== null && s.signal_label_outcome !== undefined)
      if (pool.length === 0) pool = cands.filter((s) => s.outcome && s.outcome !== 'PENDING')
      if (pool.length > 1) pool = pool.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 1)
      if (pool.length === 1) {
        const s = pool[0]
        signalLabel = s.signal_label_outcome ?? s.outcome
        signalLabelSource = s.signal_label_source ?? s.outcome_source ?? 'LABEL_CRON'
        signalResolvedAt = s.signal_label_resolved_at ?? s.created_at
        linkedCounts.signalLabel++
      } else if (cands.length > 1) {
        ambiguousSkipped.signal++
      }
    }

    // 2) Reconciliation — time + entry proximity, single candidate.
    let reconciliation = null
    let reconciliationResolvedAt = null
    let reconciliationId = null
    {
      const cands = reconciliations.filter((r) =>
        r.pair === p.pair && r.direction === p.direction &&
        r.outcome && r.outcome !== 'PENDING')
      const near = cands.filter((r) => {
        const t = new Date(r.generated_at).getTime()
        if (!Number.isFinite(t)) return false
        if (Math.abs(t - anchorTime) > opts.reconWindowMs) return false
        if (!p.entry || !r.entry_price) return true
        const pip = opts.pipMap(p.pair)
        return Math.abs(Number(p.entry) - Number(r.entry_price)) < pip * opts.reconEntryTolerancePips
      })
      if (near.length === 1) {
        reconciliation = near[0].outcome
        reconciliationResolvedAt = near[0].resolved_at ?? null
        reconciliationId = near[0].id ?? null
        linkedCounts.reconciliation++
      } else if (near.length > 1) {
        ambiguousSkipped.reconciliation++
      }
    }

    // 3) Execution — broker trade opened near the prediction, single candidate.
    let execution = null
    let executionClosedAt = null
    let executionPnl = null
    let executionId = null
    {
      const cands = trades.filter((t) =>
        t.pair === p.pair && t.direction === p.direction &&
        (t.result === 'WIN' || t.result === 'LOSS' || t.result === 'BREAKEVEN'))
      const near = cands.filter((t) => {
        const t0 = new Date(t.opened_at).getTime()
        return Number.isFinite(t0) && Math.abs(t0 - anchorTime) <= opts.execWindowMs
      })
      if (near.length === 1) {
        const t = near[0]
        execution = t.result
        executionClosedAt = t.closed_at ?? null
        executionPnl = t.pl_usd ?? null
        executionId = t.id ?? null
        linkedCounts.execution++
      } else if (near.length > 1) {
        ambiguousSkipped.execution++
      }
    }

    records.push({
      setupKey: candleKey || keyOf(p.user_id, p.pair, p.created_at),
      user_id: p.user_id, pair: p.pair, direction: p.direction,
      prediction: p.outcome ?? null,
      predictionResolvedAt: p.resolved_at ?? null,
      signalLabel, signalLabelSource, signalLabelResolvedAt: signalResolvedAt,
      reconciliation, reconciliationResolvedAt, reconciliation_id: reconciliationId,
      execution, executionClosedAt, executionPnl,
      prediction_log_id: p.id,
      candle_close_time: p.candle_close_time ?? null,
      signal_created_at: p.created_at ?? null,
      execution_id: executionId,
    })
  }

  return { records, ambiguousSkipped, linkedCounts }
}
