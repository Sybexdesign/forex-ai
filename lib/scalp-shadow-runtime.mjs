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
  // §2/§3 — observations refused because the broker gave no authoritative mark
  // price, or no usable P&L reading. Counted separately so a broken EA price
  // feed is unmistakable in the health output rather than looking like "no
  // trades". Neither is fabricated: the observation is skipped, not guessed.
  'markPriceSkips',
  'noProfitReadingSkips',
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

  // ── §9 OBSERVER HEALTH ────────────────────────────────────────────────────
  // Phase 2 could not tell "the observer never executed" from "the observer
  // executed and there was nothing to evaluate" — the two look identical from
  // outside. This makes the distinction explicit and CHEAP: each cycle sets a
  // discrete status, and a LOG LINE IS EMITTED ONLY ON A TRANSITION, so a
  // steady state costs nothing no matter how often observe() is called.
  const healthCounts = Object.create(null)
  let lastHealth     = null
  let lastHealthLoggedAt = -Infinity
  // A real cycle ALTERNATES states (OBSERVER_RUNNING → NO_OPEN_TRADES →
  // STATE_PERSISTED), so a pure transition trigger would still emit ~3 lines per
  // sweep. The rate limit is what makes it bounded: every state is COUNTED, but
  // at most one line is logged per interval. The periodic heartbeat summary is the
  // backstop that carries the full picture either way.
  const HEALTH_LOG_MIN_MS = 60_000
  function setHealth(status, detail) {
    healthCounts[status] = (healthCounts[status] || 0) + 1
    if (status === lastHealth) return          // steady state — silent
    lastHealth = status
    if (now() - lastHealthLoggedAt < HEALTH_LOG_MIN_MS) return   // counted, not logged
    lastHealthLoggedAt = now()
    try { log(`health → ${status}${detail ? ` (${detail})` : ''}`) } catch { /* diagnostics must never break observation */ }
  }

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
   * Normalise a state-load result. Accepts BOTH the structured result the worker
   * now returns and the legacy `state | null` contract, so the runtime cannot be
   * broken by an older caller.
   *
   * The distinction that matters: OK_EMPTY ("nothing saved yet") MUST proceed and
   * initialise, while a genuine infrastructure failure must stay fail-closed.
   */
  function interpretLoad(loaded) {
    if (loaded === null || loaded === undefined) {
      return { ok: false, detail: 'loader returned null (legacy failure contract)' }
    }
    if (typeof loaded !== 'object') {
      return { ok: false, detail: `unexpected loader result (${typeof loaded})` }
    }
    if (typeof loaded.status === 'string') {
      const state = loaded.state && typeof loaded.state === 'object' ? loaded.state : {}
      if (loaded.status === 'OK_EXISTING') return { ok: true, empty: false, state }
      if (loaded.status === 'OK_EMPTY')    return { ok: true, empty: true,  state }
      return { ok: false, detail: `${loaded.status}${loaded.detail ? `: ${loaded.detail}` : ''}` }
    }
    // Legacy: a plain state object.
    return { ok: true, empty: Object.keys(loaded).length === 0, state: loaded }
  }

  /**
   * One observation cycle.
   *
   * ── DISCOVERY vs EVALUATION (Phase 3.1) ─────────────────────────────────
   * This cycle used to RETURN EARLY when the throttle had not elapsed — before
   * the state load, before attribution, and before a first-seen position could be
   * registered. A position whose entire life fitted inside the throttle window was
   * therefore COMPLETELY INVISIBLE: no state, no telemetry, no log.
   *
   * The two concerns are now separated:
   *
   *   DISCOVERY   state load → attribution → first-seen registration → durability.
   *               Runs on EVERY sweep and is NEVER throttled.
   *   EVALUATION  the expensive R/stage/floor analysis and its telemetry.
   *               Throttled to `throttleMs`, with ONE exception: the first
   *               evaluation of a newly seen position is never throttled, so a
   *               short-lived trade still receives its baseline observation.
   */
  async function runOnce(snap) {
    stats.evaluations++
    setHealth('OBSERVER_RUNNING')

    // ── DISCOVERY: state load (NEVER throttled) ───────────────────────────
    // §8/§9 Returning on `null` used to increment `stateLoadFailures` and produce
    // NO log, while the counter was never surfaced — a persistently failing load
    // was indistinguishable from an observer that never ran. It is now
    // attributable (structured status) and observable.
    //
    // A GENUINE failure stays fail-closed: we never fabricate empty state, because
    // observing without durable state could count a trade twice. An OK_EMPTY first
    // run is NOT a failure and initialises normally.
    if (!stateLoaded) {
      const res = interpretLoad(await loadState())
      if (!res.ok) {
        stats.stateLoadFailures++
        setHealth('STATE_LOAD_FAILED', res.detail)
        noteSkip(`state-load-failed:${res.detail}`,
          `state store unavailable (${res.detail}) — observation abandoned this cycle; state/telemetry cannot be written until this recovers`, {})
        return
      }
      stateAll = res.state
      stateLoaded = true
      setHealth(res.empty ? 'STATE_INITIALISED' : 'STATE_RESTORED', `${Object.keys(stateAll).length} open scalp state(s)`)
      log(res.empty ? 'initialised empty scalp shadow state (first run)'
                    : `restored ${Object.keys(stateAll).length} open scalp state(s)`)
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
    // §9 — the three distinguishable "nothing happened" states.
    if (snap.trades.length === 0)   setHealth('NO_OPEN_TRADES')
    else if (scalp.size === 0)      setHealth('TRADE_NOT_ATTRIBUTED', `${snap.trades.length} open, 0 attributable to '${source}'`)
    else                            setHealth('TRADE_OBSERVED', `${scalp.size} scalp position(s)`)

    const prevAll   = { ...stateAll }
    const nextAll   = { ...stateAll }
    const rows      = []
    const eligible  = new Map()   // ticket → { trade, record, geometry } (geometry validated)
    const firstSeen = []          // tickets registered for the FIRST time this cycle
    let   stateDirty = false

    // ── DISCOVERY PASS — runs on EVERY sweep, NEVER throttled ──────────────
    // A first-seen position is registered into durable state immediately. Waiting
    // for the evaluation window is exactly what made a sub-interval lifecycle
    // invisible: the trade could open AND close without ever being seen.
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
        setHealth('TRADE_DATA_INCOMPLETE', refuseReason)
        noteSkip(`g:${ticket}:${refuseReason}`, `no telemetry for ${ticket} (${trade?.pair}) — ${refuseReason}`, { ticket, pair: trade?.pair, reason: refuseReason })
        continue
      }

      // Geometry is valid — this position is ELIGIBLE for observation.
      eligible.set(ticket, { trade, record, geometry })

      // ── FIRST-SEEN REGISTRATION (§5) ──────────────────────────────────────
      // Registered on the very first sweep that sees it, with the immutable
      // baseline needed to interpret the lifecycle later. This does NOT wait for
      // the evaluation throttle. `prior === null` is the first-seen signal.
      if (!stateAll[ticket]) {
        firstSeen.push(ticket)
        nextAll[ticket] = mergeScalpShadowState(null, {
          brokerTicket: ticket,
          tradeId:      record?.id ?? null,
          firstSeenAt:  new Date(snap.at ?? now()).toISOString(),
          // Deliberately NOT `++seq`: the evaluation merge below already allocates
          // the cycle's sequence number, and consuming a second one here would
          // double-increment `stateSeq` per cycle on a first-seen trade. stateSeq is
          // a monotonic watermark, so reusing the current value is safe.
          stateSeq:     seq,
        })
        stateDirty = true
      }
    }
    if (firstSeen.length > 0) setHealth('TRADE_FIRST_SEEN', `${firstSeen.length} registered`)

    // ── EVALUATION GATE (§4/§6) ───────────────────────────────────────────
    // Discovery above ALREADY happened and is already durable. Only the expensive
    // analysis is throttled — and a first-seen position bypasses that throttle for
    // its FIRST evaluation, so a short-lived trade still gets its baseline
    // observation instead of none at all.
    const evalDue = throttleMs <= 0
      || (now() - lastEvalAt) >= throttleMs
      || firstSeen.length > 0
    if (!evalDue) {
      stats.throttled++
      // Semantics are now precise: lifecycle DISCOVERY ran successfully; only the
      // scheduled expensive evaluation was not due. It no longer means "the trade
      // was never seen".
      setHealth('THROTTLED')
    } else {
      lastEvalAt = now()

    for (const [ticket, { trade, record, geometry }] of eligible) {
      // `prior` is the state as it was BEFORE this cycle's discovery, so a
      // first-seen ticket still reports `prior === null` to the evaluator.
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
        else if (reason === 'mark-price-unavailable') stats.markPriceSkips++
        else if (reason === 'no-profit-reading') stats.noProfitReadingSkips++
        else stats.geometrySkips++
        // A refused observation is left OUT of the sample entirely — it is not
        // written as a zeroed row, which would read as a real, flat market.
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
    }   // end of the throttled EVALUATION pass

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
      // §7 — the position is gone from the account snapshot but its OWN record does
      // not yet show a close. This is NOT a close: no close price is invented, and
      // the stored lifecycle is RETAINED (not silently deleted) while the
      // reconciliation path catches up. Reported explicitly so a stuck lifecycle is
      // visible rather than indistinguishable from an abandoned one.
      if (!closed?.closed_at) { setHealth('AWAITING_CLOSE_CONFIRMATION', `ticket ${ticket}`); continue }

      const row = {
        ...buildScalpCloseRow({
          finalState:   { ...st, brokerTicket: ticket, tradeId: closed.id ?? st.tradeId },
          // §4 — `st` is the durable lifecycle state and now carries the last
          // genuine position observation (`st.lastPosition`). Passing only
          // pair/direction here is what produced close rows with NULL
          // lots / open price / current price / profit in production. The trades
          // record's values stay as a last-resort fallback for lifecycles whose
          // last observation predates the repair.
          lastPosition: st.lastPosition ?? { pair: closed.pair, direction: closed.direction },
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
    //
    // §5 Discovery must be durable IMMEDIATELY, but a cycle that changed nothing
    // (evaluation throttled, no first-seen, no closure) must not write at all —
    // that keeps the durable-write rate exactly as it was before this repair.
    const shouldSave = evalDue || stateDirty
      // A close can DELETE a ticket (retry success / give-up / confirmed close).
      // Comparing key counts catches that without flagging every mutation site.
      || Object.keys(nextAll).length !== Object.keys(prevAll).length
    let saved = true
    if (shouldSave) {
      saved = false
      try {
        saved = await saveState(nextAll, { prevAll, seq })
      } catch (e) {
        log(`state write failed (ignored): ${e?.message || e}`, {})
        saved = false
      }
      if (!saved) { stats.stateWriteFailures++; setHealth('STATE_WRITE_FAILED') }
      else        setHealth('STATE_PERSISTED')
    }
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
      if (ok) { stats.rowsPersisted++; setHealth('TELEMETRY_PERSISTED', `${stats.rowsPersisted} row(s)`) }
      else    { stats.rowWriteFailures++; setHealth('TELEMETRY_FAILED') }
    }
  }

  return {
    observe,
    whenIdle,
    getStats: () => ({ ...stats }),
    /**
     * §9 — observable observer health. `status === null` means runOnce() has
     * NEVER executed, which is the one thing Phase 2 could not distinguish from
     * "executed with nothing to do". `counts` makes every state that ever
     * occurred auditable rather than only the current one.
     */
    getHealth: () => ({ status: lastHealth, counts: { ...healthCounts } }),
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

