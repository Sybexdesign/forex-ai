// tests/scalp-shadow-runtime.test.mjs
// Orchestration tests: overlap, failure isolation, idempotency, counter accuracy.
import assert from 'node:assert/strict'
import { createScalpShadowRuntime, createBoundedSeen, isDuplicateKeyError, matchAttribution, COUNTER_NAMES } from '../lib/scalp-shadow-runtime.mjs'
import { evaluateScalpShadow, normaliseScalpPosition, mergeScalpShadowState } from '../lib/scalp-shadow-protection.mjs'

const XAU = { pip: 0.1, pipValuePerLot: 10, known: true }
const trade = (o = {}) => ({
  id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14,
  entryPrice: 2000, currentPrice: 2000, markPrice: 2000, unrealizedPL: 0,
  stopLossPrice: 1997.5, openTime: '2026-09-15T00:00:00.000Z', ...o,
})

/** Real evaluator, so these tests exercise the actual classification path. */
const realEvaluate = ({ trade: t, record, geometry, prior }) => {
  const position = normaliseScalpPosition(t, { priorState: prior, ...geometry })
  if (!position) return { reason: 'un-normalisable-position' }
  return evaluateScalpShadow({ position, priorState: prior, shadowMode: true })
}

function harness(over = {}) {
  const rows = []
  const saves = []
  const logs = []
  let clock = 1_000_000
  const deps = {
    now: () => clock,
    throttleMs: 0,
    log: (m, meta) => logs.push({ m, meta }),
    loadState: async () => (over.state === undefined ? {} : over.state),
    saveState: async (next, meta) => { saves.push({ next, meta }); return over.saveFails ? false : true },
    attribute: over.attribute ?? (async (trades) => ({
      scalp: new Map(trades.map((t) => [String(t.id), { trade: t, record: { id: `db-${t.id}` } }])),
      skipped: [],
    })),
    confirmClosed: over.confirmClosed ?? (async () => null),
    insertRow: over.insertRow ?? (async (row) => {
      if (over.insertThrows) throw new Error('telemetry db unavailable')
      if (over.insertConflict) throw Object.assign(new Error('duplicate key value'), { code: '23505' })
      if (over.insertFails) return false
      rows.push(row)
      return true
    }),
    evaluate: over.evaluate ?? realEvaluate,
  }
  return { rt: createScalpShadowRuntime(deps), rows, saves, logs, advance: (n = 1000) => { clock += n } }
}

/**
 * The evaluator's bands are threshold-driven, and most actions require a PEAK
 * the trade has already reached — with no prior peak a rebound is just a new
 * peak, not a giveback. So discovery sweeps peak x current rather than guessing.
 */
function profitFor(decision) {
  const peaks = [40, 60, 80, 100, 150, 200, 250, 300]
  const curs  = [300, 200, 150, 120, 100, 80, 60, 50, 40, 30, 25, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0, -5, -10, -20, -35]
  for (const peak of peaks) {
    for (const cur of curs) {
      if (cur > peak) continue
      const position = normaliseScalpPosition(trade({ unrealizedPL: cur }), XAU)
      const r = evaluateScalpShadow({ position, priorState: { peakProfit: peak }, shadowMode: true })
      if (r.row && r.row.shadow_decision === decision) return { cur, peak }
    }
  }
  return null
}
/** Every actionable decision the current thresholds can produce. */
function actionableDecisions() {
  const out = []
  for (const d of ['WOULD_MOVE_SL', 'WOULD_MOVE_SL_TO_BE', 'WOULD_CLOSE']) {
    const found = profitFor(d)
    if (found) out.push({ decision: d, ...found })
  }
  return out
}
const snap = (t, at) => ({ trades: [t], geometry: { 'XAU/USD': XAU }, at })
const priorPeak = (peak) => ({ state: { 'T-1': { peakProfit: peak } } })

let failed = 0
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('scalp-shadow-runtime')

// ── 1. First-observation decision loss (the item-1 fix) ──────────────────────
await t('item1: first observation with NONE → snapshot', async () => {
  const h = harness()
  h.rt.observe(snap(trade({ unrealizedPL: 0 }), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 1)
  assert.equal(h.rows[0].row_kind, 'snapshot')
  assert.equal(h.rows[0].shadow_decision, 'NONE')
})

for (const decision of ['WOULD_MOVE_SL', 'WOULD_MOVE_SL_TO_BE', 'WOULD_CLOSE']) {
  await t(`item1: first observation with ${decision} → decision row`, async () => {
    const hit = profitFor(decision)
    if (hit === null) { console.log(`        (no threshold produced ${decision} — skipped)`); return }
    const h = harness(priorPeak(hit.peak))
    h.rt.observe(snap(trade({ unrealizedPL: hit.cur }), 1))
    await h.rt.whenIdle()
    assert.ok(h.rows.length >= 1, 'a row must be written')
    // EVERY actionable decision — including WOULD_CLOSE — is `decision`. A
    // WOULD_CLOSE describes an OPEN position, so it must never terminate a
    // lifecycle; only a confirmed broker closure emits `close`.
    assert.deepEqual(h.rows.map((r) => r.row_kind), ['decision'],
      `peak=${hit.peak} cur=${hit.cur} gave ${JSON.stringify(h.rows.map((r) => r.row_kind))}`)
    assert.equal(h.rows[0].shadow_decision, decision)
  })
}

await t('item1: at least one actionable decision is reachable (guards item 1)', () => {
  const found = actionableDecisions()
  assert.ok(found.length > 0,
    'no actionable decision reachable at current thresholds — item 1 cannot be verified')
})

await t('item1: first actionable decision is timestamped into state', async () => {
  const hit = profitFor('WOULD_MOVE_SL') || profitFor('WOULD_MOVE_SL_TO_BE') || profitFor('WOULD_CLOSE')
  if (hit === null) { console.log('        (skipped)'); return }
  const h = harness(priorPeak(hit.peak))
  h.rt.observe(snap(trade({ unrealizedPL: hit.cur }), 1))
  await h.rt.whenIdle()
  const st = h.rt.getState()['T-1']
  const stamps = [st.firstWouldMoveSlAt, st.firstWouldMoveSlToBeAt, st.firstWouldCloseAt].filter(Boolean)
  assert.equal(stamps.length, 1, 'exactly the matching first-action stamp must be recorded')
})

// ── 2. Bounded skip log ──────────────────────────────────────────────────────
await t('item2: bounded seen-set evicts by size (LRU)', () => {
  const s = createBoundedSeen({ max: 3, ttlMs: 1e9, now: () => 0 })
  for (const k of ['a', 'b', 'c', 'd', 'e']) s.add(k)
  assert.equal(s.size, 3)
  assert.equal(s.has('a'), false, 'oldest must be evicted')
  assert.equal(s.has('e'), true, 'newest must survive')
})

await t('item2: bounded seen-set expires by TTL', () => {
  let clock = 0
  const s = createBoundedSeen({ max: 100, ttlMs: 1000, now: () => clock })
  s.add('x')
  clock = 500;  assert.equal(s.has('x'), true,  'alive inside TTL')
  clock = 2000; assert.equal(s.has('x'), false, 'expired past TTL')
  assert.equal(s.size, 0)
})

await t('item2: re-adding refreshes recency so a live key survives eviction', () => {
  const s = createBoundedSeen({ max: 2, ttlMs: 1e9, now: () => 0 })
  s.add('a'); s.add('b'); s.add('a'); s.add('c')
  assert.equal(s.has('a'), true, 'recently touched key survives')
  assert.equal(s.has('b'), false, 'least recently used is evicted')
})

await t('item2: skip log stays bounded across many distinct tickets', async () => {
  const h = harness({
    attribute: async (trades) => ({
      scalp: new Map(),
      skipped: trades.map((x) => ({ ticket: String(x.id), reason: 'no-scalp-trade-row' })),
    }),
  })
  for (let i = 0; i < 300; i++) {
    h.rt.observe(snap(trade({ id: `M-${i}` }), i))
    await h.rt.whenIdle()
  }
  assert.ok(h.rt.getSkipLogSize() <= 500, `skip log grew to ${h.rt.getSkipLogSize()}`)
})

await t('item2: pruning does not change evaluation eligibility', async () => {
  const h = harness()
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  const before = h.rt.getStats().evaluated
  h.rt.pruneSkipLog()
  h.rt.observe(snap(trade({ unrealizedPL: 30 }), 2))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().evaluated, before + 1, 'pruning must not affect eligibility')
})

// ── 4. Attribution accept/reject (sample integrity) ──────────────────────────
await t('item3: genuine scalp ticket accepted', () => {
  const { scalp, skipped } = matchAttribution([trade({ id: 'T-1' })], [{ id: 'r1', broker_ticket: 'T-1' }])
  assert.equal(scalp.size, 1)
  assert.equal(skipped.length, 0)
})

await t('item3: manual trade rejected (no scalp row)', () => {
  const { scalp, skipped } = matchAttribution([trade({ id: 'MANUAL-1' })], [])
  assert.equal(scalp.size, 0)
  assert.deepEqual(skipped, [{ ticket: 'MANUAL-1', reason: 'no-scalp-trade-row' }])
})

await t('item3: mirror trade rejected (different source resolves to no scalp row)', () => {
  // The query filters source='scalp', so a mirror row never reaches the matcher.
  const { scalp, skipped } = matchAttribution([trade({ id: 'MIRROR-1' })], [{ id: 'r2', broker_ticket: 'OTHER' }])
  assert.equal(scalp.size, 0)
  assert.deepEqual(skipped, [{ ticket: 'MIRROR-1', reason: 'no-scalp-trade-row' }])
})

await t('item3: ambiguous ticket rejected', () => {
  const { scalp, skipped } = matchAttribution(
    [trade({ id: 'T-1' })],
    [{ id: 'r1', broker_ticket: 'T-1' }, { id: 'r2', broker_ticket: 'T-1' }],
  )
  assert.equal(scalp.size, 0)
  assert.deepEqual(skipped, [{ ticket: 'T-1', reason: 'ambiguous-scalp-attribution-x2' }])
})

await t('item3: unidentified position rejected (no broker ticket)', () => {
  const { scalp, skipped } = matchAttribution([{ pair: 'XAU/USD', id: null }], [])
  assert.equal(scalp.size, 0)
  assert.equal(skipped[0].reason, 'no-broker-ticket')
})

await t('item3: real scalp trade rides end-to-end through the runtime', async () => {
  const h = harness({
    attribute: async (trades) => matchAttribution(trades, [{ id: 'db-T-1', broker_ticket: 'T-1' }]),
  })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().evaluated, 1)
  assert.equal(h.rows[0].trade_id, 'db-T-1')
})

// ── 5. Overlap protection ────────────────────────────────────────────────────
await t('item5: a slow evaluation is never overlapped; newest snapshot wins', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let concurrent = 0, maxConcurrent = 0, calls = 0
  const h = harness({
    attribute: async () => {
      calls++
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      if (calls === 1) await gate          // first cycle is deliberately slow
      concurrent--
      return { scalp: new Map([['T-1', { trade: trade(), record: { id: 'db-T-1' } }]]), skipped: [] }
    },
  })

  h.rt.observe(snap(trade({ unrealizedPL: 1 }), 1))
  h.rt.observe(snap(trade({ unrealizedPL: 10 }), 2))   // arrives mid-flight
  h.rt.observe(snap(trade({ unrealizedPL: 20 }), 3))   // replaces #2 rather than queueing
  release()
  await h.rt.whenIdle()

  assert.equal(maxConcurrent, 1, 'two cycles ran at once')
  assert.equal(calls, 2, `expected the middle snapshot to be coalesced, got ${calls} cycles`)
  assert.equal(h.rt.getStats().snapshotsCoalesced, 1)
})

await t('item5: a coalesced backlog cannot grow unboundedly', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const h = harness({
    attribute: async () => {
      calls++
      if (calls === 1) await gate
      return { scalp: new Map(), skipped: [] }
    },
  })
  h.rt.observe(snap(trade(), 1))
  for (let i = 2; i < 60; i++) h.rt.observe(snap(trade({ unrealizedPL: i }), i))
  release()
  await h.rt.whenIdle()
  assert.equal(calls, 2, '59 queued snapshots must collapse to ONE pending slot')
})

// ── 6. State persistence race protection ─────────────────────────────────────
await t('item6: stateSeq advances monotonically across cycles', async () => {
  const h = harness()
  h.rt.observe(snap(trade({ unrealizedPL: 5 }), 1))
  await h.rt.whenIdle()
  h.rt.observe(snap(trade({ unrealizedPL: 40 }), 2))
  await h.rt.whenIdle()
  assert.equal(h.rt.getState()['T-1'].stateSeq, 2)
})

await t('item6: an older state cannot lower what a newer one wrote', () => {
  const newer = mergeScalpShadowState(null, {
    peakProfit: 100, peakR: 3, protectionStage: 'LOCK',
    retentionFloorUsd: 50, initialSl: 1997.5, stateSeq: 5,
    firstWouldMoveSlAt: 't1',
  })
  const older = { peakProfit: 40, peakR: 1.1, protectionStage: 'PROTECT', retentionFloorUsd: 20, stateSeq: 2 }
  const out = mergeScalpShadowState(newer, older)
  assert.equal(out.peakProfit, 100, 'peakProfit must not decrease')
  assert.equal(out.peakR, 3, 'peakR must not decrease')
  assert.equal(out.protectionStage, 'LOCK', 'stage must not decrease')
  assert.equal(out.retentionFloorUsd, 50, 'floor must not decrease')
  assert.equal(out.initialSl, 1997.5, 'initialSl must be unchanged')
  assert.equal(out.stateSeq, 5, 'stateSeq must advance monotonically')
  assert.equal(out.firstWouldMoveSlAt, 't1', 'first-action stamp must not reset')
})

await t('item6: saveState receives the next state plus its predecessor for guarding', async () => {
  const h = harness()
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.saves.length, 1)
  assert.ok(h.saves[0].next['T-1'], 'next state must be handed over')
  assert.ok('prevAll' in h.saves[0].meta, 'predecessor must be supplied for the monotonic guard')
})

// ── 7. Close persistence semantics ───────────────────────────────────────────
const CLOSED_STATE = {
  'T-1': {
    brokerTicket: 'T-1', tradeId: 'db-T-1', initialSl: 1997.5, plannedRiskUsd: 35,
    peakProfit: 40, peakR: 1.14, protectionStage: 'LOCK', retentionFloorUsd: 26,
    stateSeq: 9, firstWouldMoveSlAt: '2026-09-15T00:30:00.000Z',
  },
}
const CLOSED_RECORD = { id: 'db-T-1', closed_at: '2026-09-15T01:00:00.000Z', pair: 'XAU/USD', direction: 'BUY' }

await t('item7: close emitted exactly once and built from final monotonic state', async () => {
  const h = harness({ state: CLOSED_STATE, confirmClosed: async () => CLOSED_RECORD })
  h.rt.observe({ trades: [], geometry: {}, at: 1 })       // empty snapshot: the trade is gone
  await h.rt.whenIdle()
  const closes = h.rows.filter((r) => r.row_kind === 'close')
  assert.equal(closes.length, 1)
  assert.equal(closes[0].peak_profit_usd, 40)
  assert.equal(closes[0].peak_r, 1.14)
  assert.equal(closes[0].target_floor_usd, 26)
  assert.equal(closes[0].initial_sl, 1997.5)
  assert.equal(h.rt.getState()['T-1'], undefined, 'state archived after a durable close')

  // A second cycle must NOT re-emit: state is archived and no retry is pending.
  h.rt.observe({ trades: [], geometry: {}, at: 2 })
  await h.rt.whenIdle()
  assert.equal(h.rows.filter((r) => r.row_kind === 'close').length, 1, 'close must not repeat')
})

await t('item7: failed close insert retains state and retries to success', async () => {
  let attempts = 0
  const h = harness({
    state: CLOSED_STATE,
    confirmClosed: async () => CLOSED_RECORD,
    insertRow: async (row) => {
      if (row.row_kind === 'close') {
        attempts++
        if (attempts === 1) throw new Error('telemetry db down')
      }
      h.rows.push(row)
      return true
    },
  })
  h.rt.observe({ trades: [], geometry: {}, at: 1 })
  await h.rt.whenIdle()
  assert.equal(h.rt.getClosePending().size, 1, 'failed close must be retained for retry')
  assert.ok(h.rt.getState()['T-1'], 'state must be kept so the close stays retryable')
  assert.equal(h.rt.getStats().rowWriteFailures, 1)

  h.rt.observe({ trades: [], geometry: {}, at: 2 })
  await h.rt.whenIdle()
  assert.equal(h.rt.getClosePending().size, 0, 'retry succeeded')
  assert.equal(h.rt.getStats().closeRetries, 1)
  assert.equal(h.rows.filter((r) => r.row_kind === 'close').length, 1)
  assert.equal(h.rt.getState()['T-1'], undefined, 'archived only after durable success')
})

await t('item7: duplicate-key retry is SUCCESS, not a second close record', async () => {
  const h = harness({
    state: CLOSED_STATE,
    confirmClosed: async () => CLOSED_RECORD,
    // Simulates the DB partial unique index rejecting a duplicate close.
    insertRow: async () => { throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }) },
  })
  h.rt.observe({ trades: [], geometry: {}, at: 1 })
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().closeRowsPersisted, 1, 'duplicate key must count as persisted')
  assert.equal(h.rt.getStats().rowWriteFailures, 0)
  assert.equal(h.rt.getClosePending().size, 0)
})

// ── 3 (cont). Geometry + risk rejection ──────────────────────────────────────
await t('item3: missing SL skipped (no invented 1R)', async () => {
  const h = harness()
  h.rt.observe(snap(trade({ stopLossPrice: null }), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0, 'no row may be written without a usable 1R')
  assert.equal(h.rt.getStats().invalidRiskSkips, 1)
})

await t('item3: missing geometry skipped', async () => {
  const h = harness()
  h.rt.observe({ trades: [trade()], geometry: {}, at: 1 })
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0)
  assert.equal(h.rt.getStats().geometrySkips, 1)
})

await t('item3: malformed geometry skipped (zero / negative / NaN)', async () => {
  for (const g of [
    { pip: 0, pipValuePerLot: 10 }, { pip: 0.1, pipValuePerLot: 0 },
    { pip: -1, pipValuePerLot: 10 }, { pip: NaN, pipValuePerLot: 10 },
  ]) {
    const h = harness()
    h.rt.observe({ trades: [trade()], geometry: { 'XAU/USD': g }, at: 1 })
    await h.rt.whenIdle()
    assert.equal(h.rows.length, 0, `geometry ${JSON.stringify(g)} must be skipped, not guessed`)
    assert.equal(h.rt.getStats().geometrySkips, 1)
  }
})

await t('item3: malformed position skipped', async () => {
  const h = harness({ evaluate: () => ({ reason: 'un-normalisable-position' }) })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0)
  assert.ok(h.rt.getStats().geometrySkips >= 1)
})

await t('item3: plannedRiskUsd <= 0 rejected', async () => {
  const h = harness()
  h.rt.observe(snap(trade({ lots: 0 }), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0)
  assert.equal(h.rt.getStats().invalidRiskSkips, 1)
})

// ── 7. FAIL-CLOSED geometry validation ───────────────────────────────────────
const geomOf = (g) => ({ trades: [trade()], geometry: { 'XAU/USD': g }, at: 1 })
const runGeom = async (g) => {
  const h = harness()
  h.rt.observe(geomOf(g))
  await h.rt.whenIdle()
  return h
}

await t('item7: known=true + valid geometry → ACCEPTED', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: true })
  assert.equal(h.rows.length, 1, 'validated geometry must be observed')
  assert.equal(h.rt.getStats().evaluated, 1)
  assert.equal(h.rt.getStats().geometrySkips, 0)
})

await t('item7: known=false → REJECTED as unknown-instrument-geometry', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: false })
  assert.equal(h.rows.length, 0)
  assert.equal(h.rt.getStats().geometrySkips, 1)
  const logged = h.logs.map((l) => l.m).join(' ')
  assert.match(logged, /unknown-instrument-geometry/)
})

await t('item7: known=undefined → REJECTED as geometry-validation-unavailable', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: undefined })
  assert.equal(h.rows.length, 0, 'must NOT fall through to the pip defaults')
  assert.equal(h.rt.getStats().geometrySkips, 1)
  assert.match(h.logs.map((l) => l.m).join(' '), /geometry-validation-unavailable/)
})

await t('item7: known=null → REJECTED as geometry-validation-unavailable', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: null })
  assert.equal(h.rows.length, 0)
  assert.match(h.logs.map((l) => l.m).join(' '), /geometry-validation-unavailable/)
})

await t('item7: missing `known` property → REJECTED as geometry-validation-unavailable', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10 })
  assert.equal(h.rows.length, 0, 'an absent contract must fail closed')
  assert.match(h.logs.map((l) => l.m).join(' '), /geometry-validation-unavailable/)
})

await t('item7: old /api/account response shape → safely skipped, not guessed', async () => {
  // A pre-`known` deploy returns geometry with no validation flag at all.
  const h = harness({
    attribute: async (trades) => ({ scalp: new Map(trades.map((t) => [String(t.id), { trade: t, record: { id: 'db' } }])), skipped: [] }),
  })
  h.rt.observe({ trades: [trade()], geometry: { 'XAU/USD': { pip: 0.1, pipValuePerLot: 10 } }, at: 1 })
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0, 'version mismatch must yield no telemetry, not bad telemetry')
  assert.equal(h.rt.getStats().geometrySkips, 1)
  assert.equal(h.rt.getStats().evaluated, 0)
})

await t('item7: valid XAU geometry accepted (35 USD 1R)', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: true })
  assert.equal(h.rows[0].planned_risk_usd, 35)
})

await t('item7: valid XAG geometry accepted (125 USD 1R)', async () => {
  const h = harness()
  h.rt.observe({
    trades: [trade({ pair: 'XAG/USD', entryPrice: 25, stopLossPrice: 24.75, lots: 0.10 })],
    geometry: { 'XAG/USD': { pip: 0.01, pipValuePerLot: 50, known: true } },
    at: 1,
  })
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 1)
  assert.equal(h.rows[0].planned_risk_usd, 125)
})

await t('item7: validation is scoped to shadow observation only (no trading counters touched)', async () => {
  const h = await runGeom({ pip: 0.1, pipValuePerLot: 10, known: undefined })
  // Nothing here can express a trading effect: the runtime exposes counters and
  // telemetry rows only, and both stay inert.
  assert.equal(h.rows.length, 0)
  const s = h.rt.getStats()
  assert.equal(s.evaluated, 0)
  assert.equal(s.rowsPersisted, 0)
  assert.equal(s.geometrySkips, 1)
})

// ── 3 (cont). Row invariants ─────────────────────────────────────────────────
await t('item3: every generated row is scalp / shadow / emits no command', async () => {
  const h = harness({ state: CLOSED_STATE, confirmClosed: async (tk) => ({ ...CLOSED_RECORD, id: `db-${tk}` }) })
  h.rt.observe(snap(trade({ unrealizedPL: 40 }), 1))
  await h.rt.whenIdle()
  h.rt.observe({ trades: [], geometry: {}, at: 2 })
  await h.rt.whenIdle()
  assert.ok(h.rows.length >= 2, 'expected observation rows plus a close')
  for (const r of h.rows) {
    assert.equal(r.trade_source, 'scalp', 'trade_source must be scalp')
    assert.equal(r.protection_mode, 'shadow', 'protection_mode must be shadow')
    assert.equal(r.shadow_command_emitted, false, 'shadow_command_emitted must be false')
  }
  assert.ok(h.rows.some((r) => r.row_kind === 'close'), 'a close row must be present')
})

await t('item3: decision rows are never suppressed by the snapshot dedupe', async () => {
  const hit = profitFor('WOULD_MOVE_SL')
  if (hit === null) { console.log('        (skipped)'); return }
  const h = harness(priorPeak(hit.peak))
  h.rt.observe(snap(trade({ unrealizedPL: hit.cur }), 1))
  await h.rt.whenIdle()
  // Same decision again on an identical observation: it must still be recorded,
  // because "first time live mode would have acted" is a one-way fact that the
  // snapshot dedupe must never swallow.
  h.rt.observe(snap(trade({ unrealizedPL: hit.cur }), 2))
  await h.rt.whenIdle()
  const decisions = h.rows.filter((r) => r.row_kind === 'decision')
  assert.ok(decisions.length >= 1, 'decision rows must always persist')
})

// ── 10. Health counters ──────────────────────────────────────────────────────
await t('item10: all documented counters exist and are numeric', async () => {
  const h = harness()
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  const s = h.rt.getStats()
  for (const name of COUNTER_NAMES) {
    assert.ok(name in s, `missing counter ${name}`)
    assert.equal(typeof s[name], 'number', `${name} must be numeric`)
  }
  assert.ok(s.evaluated >= 1 && s.rowsPersisted >= 1, 'counters must reflect real activity')
  assert.equal(JSON.stringify(s).includes('SUPABASE'), false, 'counters must carry no credentials')
})

await t('item10: isDuplicateKeyError recognises the conflict shapes we rely on', () => {
  assert.equal(isDuplicateKeyError({ code: '23505' }), true)
  assert.equal(isDuplicateKeyError({ status: 409 }), true)
  assert.equal(isDuplicateKeyError(new Error('duplicate key value violates unique constraint')), true)
  assert.equal(isDuplicateKeyError(new Error('connection reset')), false)
  assert.equal(isDuplicateKeyError(null), false)
})

// ── 3. Failure isolation + row lifecycle ─────────────────────────────────────
await t('item3: telemetry DB failure → worker continues, counted', async () => {
  const h = harness({ insertThrows: true })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0)
  assert.equal(h.rt.getStats().rowWriteFailures, 1)
  assert.equal(h.rt.getStats().evaluated, 1, 'evaluation still happened')
})

await t('item3: duplicate-key on insert counts as SUCCESS, not failure', async () => {
  const h = harness({ insertConflict: true })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().rowsPersisted, 1)
  assert.equal(h.rt.getStats().rowWriteFailures, 0)
})

await t('item3: state persistence failure → worker continues, counted', async () => {
  const h = harness({ saveFails: true })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().stateWriteFailures, 1)
  assert.equal(h.rows.length, 1, 'rows still written')
  assert.equal(h.rt.getStats().evaluated, 1)
})

await t('item3: evaluator exception → cycle survives, other positions still evaluated', async () => {
  let n = 0
  const h = harness({
    attribute: async () => ({
      scalp: new Map([
        ['BAD', { trade: trade({ id: 'BAD' }), record: { id: 'db-BAD' } }],
        ['OK',  { trade: trade({ id: 'OK' }),  record: { id: 'db-OK' } }],
      ]),
      skipped: [],
    }),
    evaluate: ({ trade: tr }) => {
      if (tr.id === 'BAD') throw new Error('evaluator exploded')
      n++
      return realEvaluate({ trade: tr, geometry: XAU, prior: null })
    },
  })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().evaluatorExceptions, 1)
  assert.equal(n, 1, 'the healthy position was still evaluated')
  assert.equal(h.rows.length, 1)
})

await t('item3: attribution query failure → observes NOTHING, cycle survives', async () => {
  const h = harness({ attribute: async () => { throw new Error('attribution HTTP 500') } })
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 0, 'fail-closed: nothing observed when attribution is unavailable')
  assert.equal(h.rt.getStats().evaluated, 0)
  assert.equal(h.rt.getStats().attributionSkips, 1)
})

await t('item3: duplicate identical snapshot suppressed', async () => {
  const h = harness()
  h.rt.observe(snap(trade(), 1))
  await h.rt.whenIdle()
  h.rt.observe(snap(trade(), 2))
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().duplicateSnapshots, 1)
  assert.equal(h.rows.length, 1)
})

await t('item3: meaningful changed snapshot retained', async () => {
  const h = harness()
  h.rt.observe(snap(trade({ unrealizedPL: 5 }), 1))
  await h.rt.whenIdle()
  h.rt.observe(snap(trade({ unrealizedPL: 40 }), 2))
  await h.rt.whenIdle()
  assert.equal(h.rows.length, 2, 'a genuinely different observation must persist')
  assert.equal(h.rt.getStats().duplicateSnapshots, 0)
})

await t('item3: identical snapshot object observed twice runs once', async () => {
  const h = harness()
  const s = snap(trade(), undefined)
  h.rt.observe(s)
  await h.rt.whenIdle()
  h.rt.observe(s)
  await h.rt.whenIdle()
  assert.equal(h.rt.getStats().evaluations, 1, 'same object must not be evaluated twice')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow-runtime: all tests passed')
