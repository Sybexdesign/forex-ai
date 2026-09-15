// lib/scalp-shadow-runtime.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Orchestration for the SCALP SHADOW observer — read-only, I/O-free, injectable.
//
// WHY THIS FILE EXISTS
//
// The observation cycle used to live inline in workers/scalper.mjs, where the
// only way to test it was to start the worker process. Every failure mode that
// actually matters here — an insert that 409s, a state write that times out, an
// evaluator that throws, two evaluations overlapping — is an I/O-boundary
// behaviour, so it has to be exercisable with fakes. It now is.
//
// THIS MODULE PERFORMS NO I/O AND OPENS NO SOCKETS.
//
// There is no `fetch`, no Supabase client, and no broker adapter anywhere in
// this file — every side effect arrives as an injected function. That is not a
// style preference, it is the safety boundary: the shadow observer cannot reach
// a broker, a position, or a network endpoint except through functions its
// caller chose to give it, and its caller is the worker's read-only block. A
// test asserts the absence of `fetch` in this file's source.
//
// WHAT IT GUARANTEES
//
//   1. A meaningful shadow action is ALWAYS a `decision` row, including on the
//      very first observation of a trade. `row_kind` is never downgraded to
//      `snapshot`; only redundant snapshots are suppressed.
//   2. One evaluation runs at a time. A snapshot arriving mid-evaluation
//      replaces any older pending one instead of queueing behind it, so there is
//      no backlog and no overlap.
//   3. The newest snapshot wins. An older evaluation cannot write state that a
//      newer one already advanced, because runs are serialised and the merge is
//      monotonic.
//   4. A failed close insert retains enough state to retry, and a duplicate-key
//      response is treated as success — so a restart cannot fabricate a second
//      close record.
//   5. Nothing here can throw into the caller. `observe()` always resolves.
// ─────────────────────────────────────────────────────────────────────────────

import {
  mergeScalpShadowState,
  assertScalpStateMonotonic,
  buildScalpCloseRow,
} from './scalp-shadow-protection.mjs'
import { snapshotSignature } from './profit-telemetry.mjs'

/**
 * A Set with bounded size AND TTL expiry, for per-ticket skip diagnostics.
 *
 * WHY NOT A PLAIN Set
 *
 * The previous implementation added one key per ticket that was ever skipped and
 * never removed it. On a long-lived worker observing an account that accumulates
 * tickets, that grows without bound — a slow leak in a process meant to run for
 * weeks. This is observability only: losing a key after the TTL simply means a
 * recurring skip gets logged again, and eligibility is untouched.
 *
 * Re-insertion refreshes recency, and the Map's insertion order makes eviction
 * cheapest-first (oldest), which is the LRU behaviour wanted here.
 */
export function createBoundedSeen({ max = 500, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
  const m = new Map()

  function prune() {
    const t = now()
    for (const [k, at] of m) {
      if (t - at > ttlMs) m.delete(k)
      else break // insertion order == age order, so the first live key ends the scan
    }
    while (m.size > max) m.delete(m.keys().next().value)
    return m.size
  }

  return {
    has(k) {
      const at = m.get(k)
      if (at === undefined) return false
      if (now() - at > ttlMs) { m.delete(k); return false }
      return true
    },
    add(k) {
      if (m.has(k)) m.delete(k)   // refresh recency
      m.set(k, now())
      prune()
    },
    prune,
    clear() { m.clear() },
    get size() { return m.size },
  }
}

/** The health counters surfaced for first-lifecycle verification (item 10). */
export const COUNTER_NAMES = [
  'snapshotsObserved',
  'snapshotsCoalesced',
  'duplicateSnapshots',
  'evaluations',
  'throttled',
  'evaluated',
  'rowsPersisted',
  'rowWriteFailures',
  'attributionSkips',
  'geometrySkips',
  'invalidRiskSkips',
  'stateLoadFailures',
  'stateWriteFailures',
  'evaluatorExceptions',
  'closeRowsPersisted',
  'closeRetries',
  'closeGaveUp',
]

function freshCounters() {
  const c = {}
  for (const n of COUNTER_NAMES) c[n] = 0
  return c
}

/** Treats a duplicate-key error as success — the row is already there. */
export function isDuplicateKeyError(e) {
  if (!e) return false
  const code = e.code ?? e.status ?? e.statusCode
  if (code === 409 || code === '23505' || code === '409') return true
  return /duplicate key|already exists|conflict/i.test(String(e.message || ''))
}

/**
 * Attribute open broker positions to scalp trades.
 *
 * Extracted from the worker so the accept/reject rules — which decide what
 * enters the study sample — are unit-testable rather than only observable in
 * production. Pure: no I/O, no clock.
 *
 * OPT-IN, NOT OPT-OUT. A position enters the sample only if EXACTLY ONE scalp
 * trade row matches its broker ticket. Everything else is skipped with a
 * reason, because the broker returns every position on the account — manual
 * trades, mirror trades, anything else — and a misattributed position silently
 * pollutes the sample in a way no later analysis can detect.
 *
 * @param {Array} trades — broker open positions (need `id` and `pair`)
 * @param {Array} rows   — `trades` table rows with source='scalp'
 * @returns {{scalp: Map<string, {trade: object, record: object}>, skipped: Array<{ticket: string, reason: string}>}}
 */
export function matchAttribution(trades, rows) {
  const scalp   = new Map()
  const skipped = []
  const all     = Array.isArray(trades) ? trades : []

  for (const t of all) {
    if (!t || t.id == null || t.id === '') {
      skipped.push({ ticket: String(t?.pair ?? 'unknown'), reason: 'no-broker-ticket' })
    }
  }

  const byTicket = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r?.broker_ticket)
    if (!byTicket.has(k)) byTicket.set(k, [])
    byTicket.get(k).push(r)
  }

  for (const t of all) {
    if (!t || t.id == null || t.id === '') continue
    const matches = byTicket.get(String(t.id)) || []
    if (matches.length === 0) {
      skipped.push({ ticket: String(t.id), reason: 'no-scalp-trade-row' })
    } else if (matches.length > 1) {
      skipped.push({ ticket: String(t.id), reason: `ambiguous-scalp-attribution-x${matches.length}` })
    } else {
      scalp.set(String(t.id), { trade: t, record: matches[0] })
    }
  }

  return { scalp, skipped }
}

/**
 * The handoff boundary between risk and observation.
 *
 * WHY THIS IS A SEPARATE, IMPORTABLE FUNCTION
 *
 * Inline in the worker this could only be tested by starting the worker process,
 * so the one thing that most needs proving — that observation cannot influence a
 * risk result — was untestable. Extracting ONLY the handoff (not any of the
 * existing risk arithmetic) makes it exercisable with fakes while leaving
 * `fetchRiskState()` computing and returning exactly what it did before.
 *
 * CONTRACT
 *
 *   * takes the ALREADY-FETCHED account response; it performs no I/O of its own
 *     and contains no `fetch`, no broker adapter, no `/v1/positions`, no
 *     `/api/orders`, and nothing that can write to a broker;
 *   * returns `undefined` unconditionally — there is no value a caller could
 *     accidentally route into a risk decision;
 *   * cannot throw, even if the response is malformed, and cannot produce an
 *     unhandled rejection (observe() is pre-caught);
 *   * a missing `openTrades` yields an empty observation; missing geometry makes
 *     the observer skip rather than guess.
 */
export function createShadowHandoff(runtime, { now = Date.now } = {}) {
  if (!runtime || typeof runtime.observe !== 'function') {
    throw new Error('createShadowHandoff: a runtime with observe() is required')
  }
  return function handleFreshRiskSnapshotForShadow(accountResponse) {
    try {
      const trades   = Array.isArray(accountResponse?.openTrades) ? accountResponse.openTrades : []
      const geometry = accountResponse?.instrumentGeometry
      runtime
        .observe({ trades, geometry: geometry && typeof geometry === 'object' ? geometry : {}, at: now() })
        .catch(() => {})   // belt-and-braces: observe() already never rejects
    } catch {
      // Observation is a side effect. It must never affect risk processing.
    }
    // Returns nothing, by design.
  }
}


/**
 * Build the observer runtime.
 *
 * Every side effect is injected, so the caller decides what the shadow observer
 * can reach. There is deliberately no default for `loadState`, `saveState`,
 * `attribute`, `confirmClosed`, `insertRow` or `evaluate`: a missing dependency
 * fails loudly at construction instead of silently doing nothing at runtime.
 */
export function createScalpShadowRuntime(deps = {}) {
  const {
    now = Date.now,
    throttleMs = 60_000,
    source = 'scalp',
    maxClosePending = 50,
    maxCloseAttempts = 5,
    skipMax = 500,
    skipTtlMs = 6 * 60 * 60 * 1000,
    log = () => {},
    loadState, saveState, attribute, confirmClosed, insertRow, evaluate,
  } = deps

  for (const [name, fn] of Object.entries({ loadState, saveState, attribute, confirmClosed, insertRow, evaluate })) {
    if (typeof fn !== 'function') throw new Error(`scalp-shadow-runtime: missing dependency '${name}'`)
  }

  const stats        = freshCounters()
  const skipSeen     = createBoundedSeen({ max: skipMax, ttlMs: skipTtlMs, now })
  const closePending = new Map()   // ticket → { row, attempts }  — bounded
  const lastSnapSig   = new Map()  // ticket → signature of the last persisted snapshot

  let stateAll      = null    // null until first successful load
  let stateLoaded   = false
  let lastEvalAt    = 0
  let seq           = 0
  let running       = false
  let pending       = null
  let lastObserved  = null
  let lastSnapshotAt = null
  let idleWaiters   = []

  function noteSkip(key, message, meta) {
    if (skipSeen.has(key)) return
    skipSeen.add(key)
    try { log(message, meta) } catch { /* diagnostics must never break observation */ }
  }

  function settleIdle() {
    if (running || pending) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Resolves once no evaluation is in flight and none is queued. */
  function whenIdle() {
    if (!running && !pending) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  /**
   * Hand the runtime a fresh openTrades snapshot. NEVER throws, never rejects,
   * never blocks — this sits on the worker's hot path.
   *
   * A snapshot arriving while an evaluation is in flight REPLACES any older
   * pending snapshot instead of queueing behind it, so a slow evaluation cannot
   * build a backlog and the newest data always wins.
   */
  function observe(snapshot) {
    try {
      if (!snapshot || !Array.isArray(snapshot.trades)) return Promise.resolve()
      // The same response must not be observed twice, even if the caller fires
      // this from more than one place. `at` identifies a genuine fresh fetch;
      // object identity catches callers that omit it.
      if (snapshot === lastObserved) { stats.duplicateSnapshots++; return whenIdle() }
      lastObserved = snapshot
      if (snapshot.at != null && snapshot.at === lastSnapshotAt) { stats.duplicateSnapshots++; return whenIdle() }
      lastSnapshotAt = snapshot.at

      stats.snapshotsObserved++
      if (pending) stats.snapshotsCoalesced++
      pending = snapshot
      return running ? whenIdle() : pump()
    } catch (e) {
      // observe() is on the worker's hot path — it must be incapable of throwing.
      stats.evaluatorExceptions++
      try { log(`observe failed (ignored): ${e?.message || e}`) } catch { /* ignore */ }
      return Promise.resolve()
    }
  }

  async function pump() {
    if (running) return whenIdle()
    running = true
    try {
      while (pending) {
        const snap = pending
        pending = null
        try {
          await runOnce(snap)
        } catch (e) {
          stats.evaluatorExceptions++
          try { log(`evaluation failed (ignored): ${e?.message || e}`, {}) } catch { /* ignore */ }
        }
      }
    } finally {
      running = false
      settleIdle()
    }
  }

  /**
   * One observation cycle. Throttled, and wrapped by pump() so an exception
   * here cannot escape into the worker.
   */
  async function runOnce(snap) {
    stats.evaluations++
    if (throttleMs > 0 && now() - lastEvalAt < throttleMs) { stats.throttled++; return }
    lastEvalAt = now()

    // Load durable state once per process. `null` means the store is
    // unavailable: observing without it would risk counting a trade twice, so
    // the cycle is abandoned rather than guessed at. A restart MUST restore the
    // peaks, stages and floors, which is why this is not optional.
    if (!stateLoaded) {
      const loaded = await loadState()
      if (loaded === null) { stats.stateLoadFailures++; return }
      stateAll = loaded && typeof loaded === 'object' ? loaded : {}
      stateLoaded = true
      log(`restored ${Object.keys(stateAll).length} open scalp state(s)`)
    }

    let attributed
    try {
      attributed = await attribute(snap.trades)
    } catch (e) {
      // Attribution is the guard that keeps manual/mirror trades out of the
      // sample. If it is unavailable we observe NOTHING this cycle rather than
      // observing everything unattributed. Fail-closed on sample integrity.
      stats.attributionSkips += snap.trades.length
      noteSkip(`attr:err:${e?.message}`, `attribution unavailable — 0 positions observed (${e?.message})`, {})
      return
    }

    const scalp   = attributed?.scalp || new Map()
    const skipped = attributed?.skipped || []
    stats.attributionSkips += skipped.length
    for (const s of skipped) {
      noteSkip(`a:${s.ticket}:${s.reason}`, `skipped ${s.ticket} — ${s.reason}`, s)
    }
    if (scalp.size === 0 && snap.trades.length > 0) {
      noteSkip('zero-attributed', `0 of ${snap.trades.length} open position(s) attributable to source='${source}'`, {})
    }

    const prevAll = { ...stateAll }
    const nextAll = { ...stateAll }
    const rows    = []

    for (const [ticket, entry] of scalp) {
      const trade  = entry?.trade
      const record = entry?.record

      // FAIL CLOSED on geometry. Every R-based conclusion divides by these
      // numbers, so an unvalidated instrument is skipped rather than measured.
      //
      // The three refusal reasons are deliberately distinct, because they mean
      // different things operationally:
      //
      //   no-instrument-geometry          the API returned no geometry at all
      //   unknown-instrument-geometry     the API EXPLICITLY says not modelled
      //   geometry-validation-unavailable the validation contract is ABSENT —
      //                                   almost always a worker/API version
      //                                   mismatch, which must be visible rather
      //                                   than silently tolerated
      //
      // The last case is the one that used to be dangerous: a missing `known`
      // flag used to fall through to getPipValuePerLot()'s generic defaults and
      // produce a plausible-looking 1R for an instrument nobody validated.
      const geometry = snap.geometry?.[trade?.pair]
      const refuseReason = !geometry ? 'no-instrument-geometry'
        : geometry.known === false ? 'unknown-instrument-geometry'
        : geometry.known !== true ? 'geometry-validation-unavailable'
        : (!(Number(geometry.pip) > 0) || !(Number(geometry.pipValuePerLot) > 0)) ? 'invalid-instrument-geometry'
        : null

      if (refuseReason) {
        stats.geometrySkips++
        noteSkip(`g:${ticket}:${refuseReason}`, `no telemetry for ${ticket} (${trade?.pair}) — ${refuseReason}`, { ticket, pair: trade?.pair, reason: refuseReason })
        continue
      }

      const prior = stateAll[ticket] || null
      let result
      try {
        result = evaluate({ trade, record, geometry, prior })
      } catch (e) {
        stats.evaluatorExceptions++
        noteSkip(`e:${ticket}`, `evaluator threw for ${ticket} (ignored): ${e?.message || e}`, { ticket })
        continue
      }

      if (!result || result.reason) {
        const reason = result?.reason || 'no-result'
        if (reason === 'no-risk') stats.invalidRiskSkips++
        else stats.geometrySkips++
        noteSkip(`g:${ticket}:${reason}`, `no telemetry for ${ticket} (${trade?.pair}) — ${reason}`, { ticket, reason })
        continue
      }

      stats.evaluated++
      const merged = mergeScalpShadowState(prior, {
        ...result.stateDelta,
        tradeId: record?.id ?? prior?.tradeId ?? null,
        stateSeq: ++seq,
      })
      nextAll[ticket] = merged

      const row = { ...result.row, trade_id: record?.id ?? null, trade_source: source, state_seq: seq }

      // ONLY redundant snapshots are suppressed, and this is the fix for lost
      // first actions: `row_kind` is never DOWNGRADED here. If the module
      // already classified this as `decision` — which it does whenever the first
      // calculation is WOULD_MOVE_SL / WOULD_MOVE_SL_TO_BE / WOULD_CLOSE — that
      // is a one-way fact about when live mode would first have acted, and it is
      // persisted even on the very first observation of the trade. Likewise a
      // `close` row always persists.
      if (row.row_kind === 'snapshot') {
        const sig = snapshotSignature(row)
        if (lastSnapSig.get(ticket) === sig) { stats.duplicateSnapshots++; continue }
        lastSnapSig.set(ticket, sig)
      }
      rows.push(row)
    }

    // ── §Closure — retries first, then newly-closed detection ─────────────────
    // A close is CONFIRMED by the trade's own record showing closed_at, so this
    // reuses the existing reconciliation of truth rather than adding a second
    // broker-close detector. A missing or empty snapshot is NOT a close.
    for (const [ticket, p] of [...closePending]) {
      stats.closeRetries++
      let ok = false
      try { ok = await insertRow(p.row) } catch (e) { ok = isDuplicateKeyError(e) }
      if (ok) {
        closePending.delete(ticket)
        stats.closeRowsPersisted++
        delete nextAll[ticket]   // archive only once the close row is durable
        log(`close row for ${ticket} persisted on retry`)
      } else {
        p.attempts++
        if (p.attempts >= maxCloseAttempts) {
          closePending.delete(ticket)
          stats.closeGaveUp++
          delete nextAll[ticket]
          log(`giving up on close row for ${ticket} after ${p.attempts} attempts`, { ticket })
        }
      }
    }

    const observed = new Set(scalp.keys())
    for (const [ticket, st] of Object.entries(stateAll)) {
      if (observed.has(ticket)) continue
      // Already resolved EARLIER IN THIS CYCLE — a successful retry above (or a
      // give-up) removed it from nextAll. Without this guard the detection loop
      // would immediately re-detect the same ticket and emit a SECOND close row
      // in the same pass. Production would be saved only by the unique index;
      // this keeps the in-memory logic correct on its own.
      if (!(ticket in nextAll)) continue
      if (closePending.has(ticket)) continue   // queued for retry — never re-detect
      let closed = null
      try {
        closed = await confirmClosed(ticket)
      } catch (e) {
        log(`close check failed for ${ticket} (ignored): ${e?.message || e}`, { ticket })
        continue   // keep state; try again next cycle
      }
      if (!closed?.closed_at) continue   // still open, or not yet reconciled — keep state

      const row = {
        ...buildScalpCloseRow({
          finalState:   { ...st, brokerTicket: ticket, tradeId: closed.id ?? st.tradeId },
          lastPosition: { pair: closed.pair, direction: closed.direction },
          closedAt:     closed.closed_at,
          shadowMode:   true,
        }),
        trade_source: source,
      }

      let ok = false
      try { ok = await insertRow(row) } catch (e) { ok = isDuplicateKeyError(e) }
      if (ok) {
        stats.closeRowsPersisted++
        delete nextAll[ticket]
        log(`${ticket} confirmed closed — final state archived, close row persisted`)
      } else {
        // Retain enough state to RETRY. Without this a single failed insert would
        // permanently lose the only record of how the lifecycle ended. Bounded so
        // a permanently-failing row can never grow without limit; the DB-side
        // unique index (not this map) is what guarantees one logical close.
        stats.rowWriteFailures++
        if (closePending.size >= maxClosePending) {
          const oldest = closePending.keys().next().value
          closePending.delete(oldest)
          stats.closeGaveUp++
          log(`closePending full — dropped oldest (${oldest})`, { ticket: oldest })
        }
        closePending.set(ticket, { row, attempts: 1 })
        log(`close row for ${ticket} not persisted — retained for retry`, { ticket })
      }
    }


    // State BEFORE rows: a crash between the two loses at most a telemetry row,
    // never the observation itself.
    let saved = false
    try {
      saved = await saveState(nextAll, { prevAll, seq })
    } catch (e) {
      log(`state write failed (ignored): ${e?.message || e}`, {})
      saved = false
    }
    if (!saved) stats.stateWriteFailures++
    // In-memory state advances either way — the merge already happened, and
    // refusing to advance would just re-derive the same values next cycle.
    stateAll = nextAll

    for (const row of rows) {
      let ok = false
      try {
        ok = await insertRow(row)
      } catch (e) {
        // A duplicate-key response means the row is already persisted, which is
        // success for our purposes — not a failure to retry.
        ok = isDuplicateKeyError(e)
        if (!ok) log(`telemetry write failed (ignored): ${e?.message || e}`, { ticket: row.broker_ticket })
      }
      if (ok) stats.rowsPersisted++
      else stats.rowWriteFailures++
    }
  }

  return {
    observe,
    whenIdle,
    getStats: () => ({ ...stats }),
    getState: () => (stateAll ? { ...stateAll } : null),
    getSkipLogSize: () => skipSeen.size,
    pruneSkipLog: () => skipSeen.prune(),
    getClosePending: () => new Map(closePending),
    /** Admin cache reset: forget in-memory caches, never the durable facts. */
    resetMemory() {
      stateAll = null; stateLoaded = false; lastEvalAt = 0
      lastObserved = null; lastSnapshotAt = null
      lastSnapSig.clear(); skipSeen.clear()
      idleWaiters = []
    },
    source,
  }
}

