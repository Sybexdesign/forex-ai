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
 *   trades:          [{ id, user_id, pair, direction, result, trade_status, trade_result,
 *                       prediction_log_id, entry_price, opened_at, closed_at, pl_usd }]
 * Returns { records, ambiguousSkipped, linkedCounts, ambiguities }
 */
export function linkRecords(pools, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const { predictions = [], signals = [], reconciliations = [], trades = [] } = pools
  const ambiguousSkipped = { reconciliation: 0, execution: 0, signal: 0 }
  const linkedCounts = { prediction: 0, signalLabel: 0, reconciliation: 0, execution: 0 }
  // Per-record detail for the transparency panel (Workstream 4.1D fix 4).
  const ambiguities = []

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

    // 3) Execution — broker-confirmed linkage, STRONGEST IDENTIFIER FIRST.
    //
    // Two Phase 4.1D defects are fixed here:
    //
    //   (a) LEGACY 'CLOSED' WAS DISCARDED. The old candidate filter accepted only
    //       result ∈ {WIN, LOSS, BREAKEVEN}. Production carried 487 rows written
    //       by the "reconcile DB OPEN trades against EA live positions" branch of
    //       mt5_webhook_sync(), which sets result='CLOSED' and leaves pl_usd NULL.
    //       Those are CLOSED trades with UNKNOWN profitability — not non-events.
    //       Lifecycle (trade_status/result='CLOSED') and profitability
    //       (trade_result/pl_usd) are now interpreted separately.
    //
    //   (b) SAME-DIRECTION PAIRS SKIPPED EVERYTHING. Two SELLs in one window used
    //       to make near.length > 1 and abandon the link for every prediction.
    //       Explicit lineage now runs first; time is only supporting evidence.
    let execution = null
    let executionClosedAt = null
    let executionPnl = null
    let executionId = null
    let executionOutcomeRaw = null
    let executionMatch = null
    let ambiguity = null
    {
      const sameSetup = trades.filter((t) =>
        t.pair === p.pair && t.direction === p.direction && isClosedExecution(t))

      // (a) Explicit lineage — the only identifier that is not a heuristic.
      const lineage = sameSetup.filter((t) =>
        t.prediction_log_id !== null && t.prediction_log_id !== undefined &&
        String(t.prediction_log_id) === String(p.id))

      let chosen = null
      if (lineage.length === 1) {
        chosen = lineage[0]
        executionMatch = 'prediction_log_id'
      } else if (lineage.length > 1) {
        // Multiple trades legitimately share one prediction. Do not guess which
        // one represents the decision — keep the ambiguity and record it.
        ambiguity = { reason: 'MULTIPLE_LINEAGE_MATCHES', candidates: lineage.map((t) => String(t.id)) }
      }

      // (b) Fall back to broker time proximity, which is supporting evidence only.
      if (!chosen && !ambiguity) {
        const near = sameSetup.filter((t) => {
          const t0 = new Date(t.opened_at).getTime()
          return Number.isFinite(t0) && Math.abs(t0 - anchorTime) <= opts.execWindowMs
        })
        if (near.length === 1) {
          chosen = near[0]
          executionMatch = 'single_candidate'
        } else if (near.length > 1) {
          ambiguity = { reason: 'MULTIPLE_CANDIDATE_EXECUTIONS', candidates: near.map((t) => String(t.id)) }
        }
      }

      if (ambiguity) {
        // Preserved, never resolved arbitrarily. A later refresh can resolve it
        // once stronger evidence (lineage) arrives.
        ambiguousSkipped.execution++
        ambiguities.push({ setupKey: candleKey || keyOf(p.user_id, p.pair, p.created_at), ...ambiguity })
      }

      if (chosen) {
        executionOutcomeRaw = tradeOutcome(chosen)
        // 'UNKNOWN' means "closed, but profitability not established". That is
        // NOT a loss and NOT comparable — classifyRecord() receives null so it
        // reports NOT_COMPARABLE rather than inventing a verdict.
        execution = executionOutcomeRaw === 'UNKNOWN' ? null : executionOutcomeRaw
        executionClosedAt = chosen.closed_at ?? null
        executionPnl = chosen.pl_usd ?? null
        executionId = chosen.id ?? null
        linkedCounts.execution++
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
      // Phase 4.1D transparency: how the link was made, and the un-collapsed
      // profitability verdict (may be UNKNOWN even when execution is null).
      executionMatch,
      executionOutcomeRaw,
    })
  }

  return { records, ambiguousSkipped, linkedCounts, ambiguities }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Is this row a closed execution, regardless of how its legacy `result` column
 * spells it? Lifecycle and profitability are separate domains:
 * 'CLOSED' is a STATUS and must never be read as a profitability verdict.
 */
function isClosedExecution(t) {
  const status = String(t.trade_status ?? '').toUpperCase()
  const raw = String(t.result ?? '').toUpperCase()
  return status === 'CLOSED' || status === 'PARTIALLY_CLOSED' ||
    raw === 'WIN' || raw === 'LOSS' || raw === 'BREAKEVEN' ||
    raw === 'CLOSED' || raw === 'PARTIALLY_CLOSED'
}

/**
 * Profitability of a closed execution, strongest evidence first:
 *   1. canonical trade_result
 *   2. broker-confirmed realised P&L (gross, from the EA/RPC)
 *   3. UNKNOWN — never inferred from the legacy `result` field
 */
function tradeOutcome(t) {
  const explicit = String(t.trade_result ?? '').toUpperCase()
  if (explicit === 'WIN' || explicit === 'LOSS' || explicit === 'BREAKEVEN') return explicit

  const rawPnl = t.pl_usd
  if (rawPnl !== null && rawPnl !== undefined && rawPnl !== '') {
    const pnl = Number(rawPnl)
    if (Number.isFinite(pnl)) {
      if (Math.abs(pnl) <= 0.01) return 'BREAKEVEN'
      return pnl > 0 ? 'WIN' : 'LOSS'
    }
  }
  return 'UNKNOWN'
}

