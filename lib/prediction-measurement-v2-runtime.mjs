// lib/prediction-measurement-v2-runtime.mjs
// ─────────────────────────────────────────────────────────────────────────────
// v2 MEASUREMENT APPLIER — the only place v2 touches the database.
//
// SEPARATION (Phase 2) — what this module cannot do
//   It has no broker import, no trade-manager import, no order path, no risk
//   path, no permit path and no protection path. Its single write is an UPDATE
//   of the additive v2 columns on `prediction_logs`, guarded by
//   `measurement_version IS NULL` so the first writer wins and every re-run is a
//   no-op. assertNoLiveAffectingColumns() refuses the write outright if the
//   payload would contain a live column, so `outcome` / `mfe_pips` / `mae_pips` /
//   `r_multiple` / `time_to_*_s` can never be touched even by a future edit.
//
// NO BACKFILL (Phase 10)
//   Selection is bounded by V2_LOOKBACK_MS (default 3h). Historical rows — the
//   preserved 200-row forensic sample — are outside that window by construction
//   and can never be selected, so they keep `measurement_version IS NULL`
//   forever. That NULL is their provenance, not a defect.
// ─────────────────────────────────────────────────────────────────────────────

import {
  measurePrediction, compareWithLegacy, assertNoLiveAffectingColumns,
  MEASUREMENT_VERSION, RESOLUTION_GRANULARITY_M5,
} from './prediction-excursion.mjs'
import {
  buildCandleHistoryRowsForCache, CANDLE_HISTORY_TABLE, CANDLE_HISTORY_TF,
} from './m5-candle-history.mjs'

/** Never reaches historical rows — the forensic sample is preserved untouched. */
export const V2_LOOKBACK_MS = 3 * 60 * 60 * 1000

/** Bounded per call so an EA sync is never held up by analytics. */
export const V2_MAX_ROWS = 25

/** Contract window, mirroring lib/prediction-contract.mjs PREDICTION_WINDOW_MS. */
export const V2_WINDOW_MS = 15 * 60 * 1000

/**
 * Symbol pip size. Mirrors workers/scalper.mjs pipSize() EXACTLY — including
 * check order, so a JPY pair is never mis-scaled. Kept local rather than
 * imported because the worker is an executable entrypoint, not a library.
 */
export function pipSizeOf(pair) {
  const p = String(pair ?? '')
  if (p.includes('JPY'))   return 0.01
  if (p.startsWith('XAU')) return 0.1
  if (p.startsWith('XAG')) return 0.01
  return 0.0001
}

/** `XAU/USD` → `XAUUSD`, matching the EA candleCache symbol keys. */
export function symbolOf(pair) {
  return String(pair ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * Forward-only, idempotent persistence of the existing M5 feed.
 * Never throws — returns a stats object so the caller can log and move on.
 *
 * INSTRUMENTATION: duration, rows attempted, rows actually written by the
 * server, and errors are all reported. `rows_inserted` is confirmed from the
 * write REPRESENTATION rather than assumed from the request size — which also
 * makes an RLS/service-role problem observable instead of silent (0 rows with no
 * error means the write did not land).
 */
export async function persistCandleHistory(sb, candleCache, nowMs = Date.now()) {
  const stats = {
    keys: 0, matched: 0, rows: 0, openSkipped: 0, invalid: 0, duplicates: 0,
    // instrumentation
    candle_history_ms: 0, rows_attempted: 0, rows_inserted: 0, errors: 0,
    rls_blocked: false, error: null,
  }
  const t0 = Date.now()
  try {
    const built = buildCandleHistoryRowsForCache(candleCache, nowMs, CANDLE_HISTORY_TF)
    Object.assign(stats, built.stats)
    stats.rows_attempted = built.rows.length
    if (!built.rows.length) { stats.candle_history_ms = Date.now() - t0; return stats }

    // `.select()` requests the representation: PostgREST returns ONLY the rows
    // actually inserted, so ignored duplicates are excluded. That is the honest
    // "rows newly written" figure and it proves idempotency in production.
    const { data: inserted, error } = await sb.from(CANDLE_HISTORY_TABLE)
      .upsert(built.rows, {
        onConflict: 'symbol,timeframe,bar_time',
        // Closed bars are immutable, so an already-stored bar is byte-identical.
        // ignore-duplicates makes re-ingestion a genuine no-op rather than a
        // rewrite, which is what lets this run on every EA sync.
        ignoreDuplicates: true,
      })
      .select('bar_time')

    if (error) { stats.errors++; stats.error = error.message }
    else {
      stats.rows_inserted = Array.isArray(inserted) ? inserted.length : 0
      // No error but nothing returned while rows were attempted means either a
      // full idempotent no-op (expected) or a blocked write. The distinction is
      // reported rather than guessed.
      stats.rls_blocked = stats.rows_inserted === 0 && stats.rows_attempted > 0
    }
  } catch (e) {
    stats.errors++
    stats.error = e?.message ?? String(e)
  }
  stats.candle_history_ms = Date.now() - t0
  return stats
}

/**
 * Resolve every fresh, window-ended, not-yet-measured prediction in candleCache.
 *
 * Writes ONLY the v2 additive columns. `outcome`, `mfe_pips`, `mae_pips`,
 * `r_multiple`, `time_to_tp_s` and `time_to_sl_s` are read for the comparison
 * record and never written.
 *
 * @param {any} sb Supabase client (server-side service role)
 * @param {{
 *   candleCache?: Record<string, any>,
 *   nowMs?: number,
 *   lookbackMs?: number,
 *   limit?: number,
 *   windowMs?: number,
 *   userId?: string | null,
 * }} [opts]
 */
export async function applyV2Measurements(sb, {
  candleCache, nowMs = Date.now(), lookbackMs = V2_LOOKBACK_MS,
  limit = V2_MAX_ROWS, windowMs = V2_WINDOW_MS, userId = null,
} = {}) {
  const stats = {
    // existing counters (kept: the route log line and shadow study read these)
    considered: 0, measured: 0, notExpired: 0, noCandles: 0,
    failed: 0, disagreements: 0, v1ZeroButV2Positive: 0, error: null,
    // instrumentation — production decides whether batching is needed
    v2_measurement_ms: 0, select_ms: 0, update_ms: 0,
    rows_attempted: 0, rows_updated: 0, rows_skipped: 0,
    errors: 0, rls_blocked: false,
  }
  const t0 = Date.now()
  // Attribution: the candleCache belongs to ONE account, so measuring another
  // account's predictions against it would be meaningless. Identity comes from
  // the token→broker_configs lookup in the caller, never from a request body.
  if (!userId) { stats.error = 'NO_USER_ID'; stats.v2_measurement_ms = Date.now() - t0; return stats }
  try {
    const cutoffIso = new Date(nowMs - lookbackMs).toISOString()
    // `measurement_version IS NULL` also selects historical rows in principle,
    // but the created_at floor excludes them all: the forensic sample predates
    // this window by days, not hours.
    const tSelect = Date.now()
    const { data, error } = await sb.from('prediction_logs')
      .select('id, pair, direction, entry, sl, tp, created_at, prediction_expires_at, mfe_pips, mae_pips, outcome')
      .eq('user_id', userId)
      .is('measurement_version', null)
      .gte('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(limit)
    stats.select_ms = Date.now() - tSelect
    if (error) { stats.errors++; stats.error = error.message; return stats }

    const rows = Array.isArray(data) ? data : []
    stats.considered = rows.length

    for (const row of rows) {
      const createdAtMs = new Date(row.created_at).getTime()
      if (!Number.isFinite(createdAtMs)) { stats.failed++; stats.errors++; continue }

      // Only measure a COMPLETE window. Measuring early would read a bar that
      // is still forming and produce a value we would then have to revise —
      // which immutability forbids.
      const expiresMs = row.prediction_expires_at
        ? new Date(row.prediction_expires_at).getTime()
        : createdAtMs + windowMs
      if (Number.isFinite(expiresMs) && expiresMs > nowMs) { stats.notExpired++; continue }

      const symbol = symbolOf(row.pair)
      const bars = candleCache?.[`${symbol}_${CANDLE_HISTORY_TF}`]?.candles
      if (!Array.isArray(bars) || bars.length === 0) { stats.noCandles++; continue }

      let payload
      try {
        payload = measurePrediction({
          candles: bars,
          entry: Number(row.entry), direction: row.direction,
          sl: Number(row.sl), tp: Number(row.tp),
          createdAt: createdAtMs, windowMs, pip: pipSizeOf(row.pair), nowMs,
        })
        // Phase 13 shadow comparison, stored inside the additive diag column so
        // no extra table is needed and the v1 columns stay frozen.
        payload.measurement_diag = {
          ...payload.measurement_diag,
          v1_source: 'SWEEP_SAMPLES',
          v1_comparison: compareWithLegacy(row, payload),
        }
        // Hard guard: refuse any payload that would touch the live path.
        assertNoLiveAffectingColumns(payload)
      } catch (e) {
        stats.failed++
        stats.errors++
        stats.error = stats.error ?? e?.message ?? String(e)
        continue
      }

      const cmp = payload.measurement_diag.v1_comparison
      if (cmp?.outcome_disagreement) stats.disagreements++
      if (cmp?.v1_zero_mfe_but_v2_positive) stats.v1ZeroButV2Positive++

      // `measurement_version IS NULL` guard → first writer wins, re-runs no-op.
      // `.select('id')` returns the representation so we can tell a landed write
      // from an idempotent skip AND from a silently blocked one.
      stats.rows_attempted++
      const tUpdate = Date.now()
      const { data: written, error: werr } = await sb.from('prediction_logs')
        .update(payload)
        .eq('id', row.id)
        .is('measurement_version', null)
        .select('id')
      stats.update_ms += Date.now() - tUpdate

      if (werr) {
        stats.failed++; stats.errors++
        stats.error = stats.error ?? werr.message
      } else if (Array.isArray(written) && written.length > 0) {
        stats.measured++
        stats.rows_updated++
      } else {
        // No error, no rows: another writer won the race (expected on re-runs).
        stats.rows_skipped++
      }
    }
  } catch (e) {
    stats.errors++
    stats.error = e?.message ?? String(e)
  }
  stats.v2_measurement_ms = Date.now() - t0
  // A non-zero attempted count with ZERO writes and zero skips is the signature
  // of a blocked (RLS / service-role) write rather than a normal no-op.
  stats.rls_blocked = stats.rows_attempted > 0 && stats.rows_updated === 0 && stats.rows_skipped === 0 && stats.errors === 0
  return stats
}

export { MEASUREMENT_VERSION, RESOLUTION_GRANULARITY_M5 }
