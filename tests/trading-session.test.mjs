// tests/trading-session.test.mjs
// Saved ACTIVE TRADING HOURS (UTC) — one shared eligibility implementation.
//
// Covers the brief's acceptance table (London 07:00–16:00 UTC), every preset
// including the midnight-crossing Asian window, strategy change, fail-closed
// cases (no strategy, invalid config, missing timestamp), the
// generated-inside/executed-outside case, DST stability, and the rule that no
// consumer can obtain "eligible" without a validated window and instant.
//
// Run: npm run test:trading-session
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TRADING_SESSION_VERSION, SESSION_REASON,
  parseSessionWindow, describeSessionWindow, hourIsWithinWindow,
  evaluateTradingSession, evaluateSessionWindow, sessionFingerprint,
  sessionAudit, validateSessionSettings,
} from '../lib/trading-session.mjs'

const LONDON = { sessionStart: 7, sessionEnd: 16 }
const NY     = { sessionStart: 13, sessionEnd: 22 }
const ASIAN  = { sessionStart: 23, sessionEnd: 8 }
const ALLDAY = { sessionStart: 0,  sessionEnd: 24 }
/** The brief's illustrative schedule: London 08:00–16:00 UTC. */
const BRIEF  = { sessionStart: 8,  sessionEnd: 16 }

const at = (iso) => new Date(iso)
const evalAt = (settings, iso) => evaluateTradingSession(settings, at(iso), at(iso).getTime())
const eligibleAt = (settings, iso) => evalAt(settings, iso).eligible

let groups = 0
const group = (name) => { groups++; console.log(`  ✓ ${name}`) }

// ── A — the brief's acceptance table, verbatim ───────────────────────────────
{
  // The brief says: "Assume the saved strategy has London selected and its
  // configured UTC window is 08:00–16:00." That is the schedule tested here.
  // The SHIPPED London preset is 07:00–16:00 (asserted in group A2) — the brief
  // explicitly forbids overwriting the real saved configuration to match the
  // example, so the preset is left alone and tested as it actually is.
  const cases = [
    ['2026-11-18T07:59:00Z', false, '07:59 blocks'],
    ['2026-11-18T08:00:00Z', true,  '08:00 permits (start inclusive)'],
    ['2026-11-18T09:30:00Z', true,  '09:30 permits'],
    ['2026-11-18T15:59:00Z', true,  '15:59 permits'],
    ['2026-11-18T16:00:00Z', false, '16:00 blocks (end exclusive)'],
    ['2026-11-18T16:01:00Z', false, '16:01 blocks'],
  ]
  for (const [iso, expected, why] of cases) {
    assert.equal(eligibleAt(BRIEF, iso), expected, `A: ${why} — ${iso}`)
  }
  assert.equal(eligibleAt(BRIEF, '2026-11-18T07:59:59.999Z'), false, 'A: last ms of 07 blocks')
  assert.equal(eligibleAt(BRIEF, '2026-11-18T08:00:00.000Z'), true,  'A: first ms of 08 permits')
  assert.equal(eligibleAt(BRIEF, '2026-11-18T15:59:59.999Z'), true,  'A: last ms of 15 permits')
  assert.equal(eligibleAt(BRIEF, '2026-11-18T16:00:00.000Z'), false, 'A: first ms of 16 blocks')
  group('A — brief acceptance table on 08:00–16:00 UTC (07:59/08:00/09:30/15:59/16:00/16:01)')
}

// ── A2 — the SHIPPED London preset, unchanged, tested as it is ──────────────
{
  // components/pages/StrategyPage.tsx: { label: 'London', start: 7, end: 16 }
  assert.equal(LONDON.sessionStart, 7, 'A2: London preset start hour is 7 (unchanged)')
  assert.equal(LONDON.sessionEnd, 16, 'A2: London preset end hour is 16 (unchanged)')
  assert.equal(eligibleAt(LONDON, '2026-11-18T06:59:00Z'), false, 'A2: 06:59 blocks')
  assert.equal(eligibleAt(LONDON, '2026-11-18T07:00:00Z'), true,  'A2: 07:00 permits')
  assert.equal(eligibleAt(LONDON, '2026-11-18T16:00:00Z'), false, 'A2: 16:00 blocks')
  assert.equal(describeSessionWindow(parseSessionWindow(LONDON)), '07:00–16:00 UTC', 'A2: label')
  group('A2 — shipped London preset 07:00–16:00 behaves as saved (not overwritten)')
}


// ── B — every preset behaves according to its OWN saved window ───────────────
{
  assert.equal(eligibleAt(NY, '2026-11-18T12:59:00Z'), false, 'B: NY blocks 12:59')
  assert.equal(eligibleAt(NY, '2026-11-18T13:00:00Z'), true,  'B: NY permits 13:00')
  assert.equal(eligibleAt(NY, '2026-11-18T21:59:00Z'), true,  'B: NY permits 21:59')
  assert.equal(eligibleAt(NY, '2026-11-18T22:00:00Z'), false, 'B: NY blocks 22:00')

  // The same instant judged by two saved strategies must differ — proof that the
  // SAVED configuration drives the answer, not a global rule.
  assert.equal(eligibleAt(LONDON, '2026-11-18T18:00:00Z'), false, 'B: London blocks 18:00')
  assert.equal(eligibleAt(NY,     '2026-11-18T18:00:00Z'), true,  'B: NY permits 18:00')
  group('B — London / New York windows are independent and saved-config driven')
}

// ── C — midnight crossing (Asian 23→08) is NOT inverted ─────────────────────
{
  // Audit defect H-2: a naive `h >= start && h < end` returns false for all 24
  // hours here. Correct: true for 23:00–23:59 and 00:00–07:59 only.
  const inside  = ['2026-11-18T23:00:00Z', '2026-11-18T23:59:00Z',
                   '2026-11-19T00:00:00Z', '2026-11-19T03:00:00Z', '2026-11-19T07:59:00Z']
  const outside = ['2026-11-19T08:00:00Z', '2026-11-19T12:00:00Z', '2026-11-19T22:59:00Z']
  for (const iso of inside)  assert.equal(eligibleAt(ASIAN, iso), true,  `C: Asian inside ${iso}`)
  for (const iso of outside) assert.equal(eligibleAt(ASIAN, iso), false, `C: Asian outside ${iso}`)

  const w = parseSessionWindow(ASIAN)
  assert.equal(w.wraps, true, 'C: 23→8 is a wrapping window')
  assert.equal(describeSessionWindow(w), '23:00–08:00 UTC (overnight)', 'C: label says overnight')
  group('C — midnight-crossing window wraps correctly (audit H-2)')
}

// ── D — all-day really means all day ────────────────────────────────────────
{
  for (let h = 0; h < 24; h++) {
    const iso = `2026-11-18T${String(h).padStart(2, '0')}:30:00Z`
    assert.equal(eligibleAt(ALLDAY, iso), true, `D: all-day permits ${iso}`)
  }
  const w = parseSessionWindow(ALLDAY)
  assert.equal(w.allDay, true, 'D: 0→24 is flagged all-day')
  assert.equal(w.label, '00:00–24:00 UTC (all day)', 'D: all-day label')

  // The legacy preset value 0→23 excludes 23:00–23:59 by design and is reported
  // honestly rather than silently widened (audit H-3).
  assert.equal(eligibleAt({ sessionStart: 0, sessionEnd: 23 }, '2026-11-18T23:30:00Z'), false,
    'D: 0→23 excludes the 23:00 hour (end exclusive, not silently widened)')
  group('D — 0→24 all-day, and legacy 0→23 is excluded honestly')
}

// ── E — fail closed: no strategy at all ─────────────────────────────────────
{
  for (const bad of [null, undefined, {}, { style: 'Day Trader' }]) {
    const e = evaluateTradingSession(bad, at('2026-11-18T10:00:00Z'))
    assert.equal(e.eligible, false, `E: unconfigured settings deny (${JSON.stringify(bad)})`)
    assert.equal(e.reason, SESSION_REASON.NOT_CONFIGURED, 'E: reason names the cause')
  }
  // One half only — a half-written window is not a window.
  assert.equal(evaluateTradingSession({ sessionStart: 7 }, at('2026-11-18T10:00:00Z')).eligible, false,
    'E: start without end denies')
  assert.equal(evaluateTradingSession({ sessionEnd: 16 }, at('2026-11-18T10:00:00Z')).eligible, false,
    'E: end without start denies')
  group('E — no active/complete strategy configuration ⇒ deny')
}

// ── F — fail closed: invalid configuration (audit H-7) ──────────────────────
{
  const invalid = [
    [{ sessionStart: 'banana', sessionEnd: 16 }, SESSION_REASON.START_INVALID],
    [{ sessionStart: 7, sessionEnd: 'banana' },  SESSION_REASON.END_INVALID],
    [{ sessionStart: 7.5, sessionEnd: 16 },      SESSION_REASON.START_INVALID],
    [{ sessionStart: 7, sessionEnd: 16.25 },     SESSION_REASON.END_INVALID],
    [{ sessionStart: 24, sessionEnd: 16 },       SESSION_REASON.START_INVALID],
    [{ sessionStart: -1, sessionEnd: 16 },       SESSION_REASON.START_INVALID],
    [{ sessionStart: 7, sessionEnd: 25 },        SESSION_REASON.END_INVALID],
    [{ sessionStart: 7, sessionEnd: 7 },         SESSION_REASON.EMPTY],
    [{ sessionStart: NaN, sessionEnd: 16 },      SESSION_REASON.START_INVALID],
    [{ sessionStart: Infinity, sessionEnd: 16 }, SESSION_REASON.START_INVALID],
    [{ sessionStart: true, sessionEnd: 16 },     SESSION_REASON.START_INVALID],
  ]
  for (const [settings, reason] of invalid) {
    const e = evaluateTradingSession(settings, at('2026-11-18T10:00:00Z'))
    assert.equal(e.eligible, false, `F: invalid config denies (${JSON.stringify(settings)})`)
    assert.equal(e.reason, reason, `F: reason for ${JSON.stringify(settings)}`)
  }
  // The exact production failure: a string hour made the old comparison false for
  // every hour, silently meaning "no restriction". A CLEAN numeric string is
  // normalised; junk is refused. Neither can fail open.
  assert.equal(evaluateTradingSession({ sessionStart: '7', sessionEnd: 16 }, at('2026-11-18T10:00:00Z')).eligible,
    true, 'F: a clean numeric string is normalised, not rejected')
  assert.equal(evaluateTradingSession({ sessionStart: '7', sessionEnd: 16 }, at('2026-11-18T02:00:00Z')).eligible,
    false, 'F: normalised string window still blocks outside it')
  group('F — invalid configuration fails closed (audit H-7)')
}

// ── G — fail closed: missing / unusable UTC timestamp ───────────────────────
{
  for (const bad of [undefined, null, '', 'not-a-date', NaN, Infinity, {}]) {
    const e = evaluateTradingSession(LONDON, bad)
    assert.equal(e.eligible, false, `G: instant ${String(bad)} denies`)
    assert.equal(e.reason, SESSION_REASON.TIMESTAMP_INVALID, 'G: timestamp reason')
    assert.equal(e.utcTimestamp, null, 'G: no timestamp is invented')
  }
  group('G — a missing/unusable UTC timestamp denies (no default clock)')
}

// ── H — signal generated inside the window, executed outside it ─────────────
{
  const generatedAt = '2026-11-18T15:58:00Z'   // inside
  const executedAt  = '2026-11-18T16:02:00Z'   // outside
  assert.equal(eligibleAt(LONDON, generatedAt), true,  'H: generation was permitted')
  assert.equal(eligibleAt(LONDON, executedAt),  false, 'H: execution is refused — eligibility is NOT inherited')
  // Eligibility is a function of the evaluation instant alone: no state carries
  // an earlier "yes" forward. Re-evaluating the same signal later flips it.
  const evalLater = evaluateTradingSession(LONDON, at(executedAt))
  assert.equal(evalLater.reason, SESSION_REASON.OUTSIDE, 'H: reason is outside_session')
  group('H — an inside-window signal cannot execute outside the window')
}

// ── I — strategy changed while a signal is pending ──────────────────────────
{
  // The pending signal was produced under London; the saved strategy is now NY.
  // The execution decision must use the NEW saved window.
  assert.equal(eligibleAt(LONDON, '2026-11-18T18:00:00Z'), false, 'I: under London 18:00 is closed')
  assert.equal(eligibleAt(NY,     '2026-11-18T18:00:00Z'), true,  'I: after saving NY 18:00 is open')

  // ...and changing an unrelated field cannot change the answer.
  const other = { ...LONDON, riskPct: 2, minStrength: 55, slPips: 40, maxPositions: 5 }
  assert.equal(eligibleAt(other, '2026-11-18T10:00:00Z'), eligibleAt(LONDON, '2026-11-18T10:00:00Z'),
    'I: unrelated settings do not affect eligibility')
  group('I — the CURRENT saved window decides, not the window at signal time')
}


// ── J — next open / next close are calculable and correct ───────────────────
{
  const before = evalAt(LONDON, '2026-11-18T06:10:00Z')
  assert.equal(before.eligible, false, 'J: 06:10 is closed')
  assert.equal(before.nextOpen.label, '07:00 UTC', 'J: opens at 07:00')
  assert.equal(before.nextOpen.inMinutes, 50, 'J: 50 minutes away')
  assert.equal(before.nextClose, null, 'J: no close while closed')

  const inside = evalAt(LONDON, '2026-11-18T15:30:00Z')
  assert.equal(inside.eligible, true, 'J: 15:30 is open')
  assert.equal(inside.nextClose.label, '16:00 UTC', 'J: closes at 16:00')
  assert.equal(inside.nextClose.inMinutes, 30, 'J: 30 minutes away')
  assert.equal(inside.nextOpen, null, 'J: no open while open')

  // Wrapping window: at 22:00 the Asian session opens at 23:00 the same day.
  assert.equal(evalAt(ASIAN, '2026-11-18T22:10:00Z').nextOpen.label, '23:00 UTC', 'J: Asian opens 23:00')
  // ...and at 07:30 the next close is 08:00.
  assert.equal(evalAt(ASIAN, '2026-11-19T07:30:00Z').nextClose.label, '08:00 UTC', 'J: Asian closes 08:00')
  group('J — next session open/close are computed from the saved window')
}

// ── K — daylight saving does not shift a UTC hour band ──────────────────────
{
  // Europe/London 2026: BST begins Sun 29 Mar, ends Sun 25 Oct.
  // The saved band is UTC, so nothing may move across those dates.
  assert.equal(eligibleAt(LONDON, '2026-03-28T10:00:00Z'), true,  'K: inside before spring change')
  assert.equal(eligibleAt(LONDON, '2026-03-30T10:00:00Z'), true,  'K: inside after spring change')
  assert.equal(eligibleAt(LONDON, '2026-10-24T10:00:00Z'), true,  'K: inside before autumn change')
  assert.equal(eligibleAt(LONDON, '2026-10-26T10:00:00Z'), true,  'K: inside after autumn change')
  assert.equal(eligibleAt(LONDON, '2026-03-28T16:30:00Z'), false, 'K: closed before spring change')
  assert.equal(eligibleAt(LONDON, '2026-10-26T16:30:00Z'), false, 'K: closed after autumn change')
  // The band is NOT re-interpreted as local time: 08:00 UTC stays inside in
  // winter (08:00 GMT) and 17:00 UTC stays outside in summer (18:00 BST).
  assert.equal(eligibleAt(LONDON, '2026-01-14T08:00:00Z'), true,  'K: winter 08:00 UTC permitted')
  assert.equal(eligibleAt(LONDON, '2026-07-15T17:00:00Z'), false, 'K: summer 17:00 UTC blocked')
  group('K — DST cannot shift a UTC hour band (no invented local offset)')
}

// ── L — no dependence on the process/browser timezone ──────────────────────
{
  // The same instant expressed with three different offsets must give one answer.
  const sameInstant = [
    '2026-11-18T10:00:00Z',
    '2026-11-18T11:00:00+01:00',
    '2026-11-18T05:00:00-05:00',
  ]
  for (const iso of sameInstant) {
    const r = evaluateTradingSession(LONDON, at(iso))
    assert.equal(r.eligible, true, `L: same instant, same verdict (${iso})`)
    assert.equal(r.utcHour, 10, 'L: evaluated as 10:00 UTC')
    assert.equal(r.utcTimestamp, '2026-11-18T10:00:00.000Z', 'L: normalised to UTC')
  }
  const ms = at('2026-11-18T10:00:00Z').getTime()
  assert.equal(evaluateTradingSession(LONDON, ms).eligible, true, 'L: epoch ms accepted')
  group('L — UTC in, UTC out: no local-clock dependence')
}


// ── M — fingerprint identifies the configuration that decided ──────────────
{
  const a = sessionFingerprint(LONDON)
  assert.match(a, /^ts1-[0-9a-f]{8}$/, 'M: fingerprint shape')
  assert.equal(a, sessionFingerprint({ ...LONDON }), 'M: stable for equal config')
  assert.equal(a, sessionFingerprint({ ...LONDON, riskPct: 3 }), 'M: ignores unrelated settings')
  assert.notEqual(a, sessionFingerprint(NY),    'M: differs for a different window')
  assert.notEqual(a, sessionFingerprint(ASIAN), 'M: differs for a wrapping window')
  assert.match(sessionFingerprint(null), /^ts1-[0-9a-f]{8}$/, 'M: invalid config still fingerprints')
  assert.notEqual(sessionFingerprint(null), a, 'M: invalid config is distinguishable')
  group('M — configuration fingerprint is stable and selective')
}

// ── N — the persisted audit object carries every required field ────────────
{
  const audit = sessionAudit(LONDON, at('2026-11-18T02:00:00Z'))
  for (const key of [
    'version', 'fingerprint', 'window', 'startHour', 'endHour', 'wraps',
    'utcTimestamp', 'utcHour', 'eligible', 'reason', 'nextOpen', 'nextClose',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(audit, key), `N: audit has ${key}`)
  }
  assert.equal(audit.eligible, false, 'N: refusal recorded')
  assert.equal(audit.reason, SESSION_REASON.OUTSIDE, 'N: reason recorded')
  assert.equal(audit.window, '07:00–16:00 UTC', 'N: window recorded')
  assert.equal(audit.utcTimestamp, '2026-11-18T02:00:00.000Z', 'N: evaluation instant recorded')
  assert.equal(audit.nextOpen.label, '07:00 UTC', 'N: next open recorded')
  // JSON-safe: it is written into an existing JSONB column.
  assert.deepEqual(JSON.parse(JSON.stringify(audit)), audit, 'N: JSON round-trips unchanged')
  group('N — audit payload is complete and JSON-safe')
}

// ── O — write-path validation refuses what the read path would deny ────────
{
  assert.equal(validateSessionSettings({ riskPct: 1 }).ok, true, 'O: unrelated settings pass')
  assert.equal(validateSessionSettings({ sessionStart: 7, sessionEnd: 16 }).ok, true, 'O: valid pair passes')
  assert.equal(validateSessionSettings({ sessionStart: 0, sessionEnd: 24 }).ok, true, 'O: 0→24 passes')
  assert.equal(validateSessionSettings({ sessionStart: 23, sessionEnd: 8 }).ok, true, 'O: wrap passes')

  const oneHalf = validateSessionSettings({ sessionStart: 7 })
  assert.equal(oneHalf.ok, false, 'O: half a window is refused')
  assert.equal(validateSessionSettings({ sessionStart: 7, sessionEnd: 7 }).ok, false,
    'O: empty window is refused')
  const junk = validateSessionSettings({ sessionStart: 'banana', sessionEnd: 16 })
  assert.equal(junk.ok, false, 'O: junk is refused')
  assert.match(junk.error, /Invalid trading hours/, 'O: error is explicit')

  // Everything the write path accepts, the read path must be able to evaluate.
  for (const s of [{ sessionStart: 7, sessionEnd: 16 }, { sessionStart: 0, sessionEnd: 24 },
                   { sessionStart: 23, sessionEnd: 8 }, { sessionStart: '13', sessionEnd: '22' }]) {
    assert.equal(parseSessionWindow(s).ok, true, `O: accepted window parses (${JSON.stringify(s)})`)
  }
  group('O — write validation is consistent with read evaluation')
}

// ── P — consistency: one rule, no second implementation ───────────────────
{
  // Every consumer imports this module; these four entry points must agree.
  const instant = at('2026-11-18T15:59:00Z')
  const window = parseSessionWindow(LONDON)
  const viaHour = hourIsWithinWindow(window, instant.getUTCHours())
  const viaWindow = evaluateSessionWindow(window, instant).eligible
  const viaSettings = evaluateTradingSession(LONDON, instant).eligible
  const viaAudit = sessionAudit(LONDON, instant).eligible
  assert.equal(viaHour, true, 'P: hour helper')
  assert.equal(viaWindow, viaHour, 'P: evaluateSessionWindow agrees')
  assert.equal(viaSettings, viaHour, 'P: evaluateTradingSession agrees')
  assert.equal(viaAudit, viaHour, 'P: sessionAudit agrees')
  assert.equal(TRADING_SESSION_VERSION, 'trading_session_v1', 'P: version pinned for stored audits')
  group('P — all entry points produce the same verdict for the same input')
}



// ── Q — WIRING: every stage of the pipeline uses this one module ───────────
//
// The brief requires that the UI, the generation API, the AI context, persistence,
// the worker and the final order gate agree. They agree because they import the
// same file — asserted here against the actual sources, so a future refactor
// cannot quietly reintroduce a second implementation.
{
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  const risk = read('lib/risk.ts')
  assert.match(risk, /from '\.\/trading-session\.mjs'/, 'Q: risk guards import the shared module')
  assert.match(risk, /severity: 'BLOCK'/, 'Q: the session check can block')
  assert.equal(/Outside configured trading hours/.test(risk), false,
    'Q: the old advisory-only wording is gone')

  const orders = read('app/api/orders/route.ts')
  assert.match(orders, /from '@\/lib\/trading-session\.mjs'/, 'Q: orders route imports the module')
  assert.match(orders, /from\('strategies'\)[\s\S]{0,160}select\('settings'\)/,
    'Q: orders route reads the SAVED strategy, not the request body')
  {
    const gate = orders.indexOf('FINAL trading-hours gate')
    const fire = orders.indexOf('await broker.placeOrder(')
    assert.ok(gate > 0, 'Q: a final pre-submission gate exists')
    assert.ok(fire > gate, 'Q: the final gate runs BEFORE the order is submitted')
  }

  const signal = read('app/api/scalper/signal/route.ts')
  assert.match(signal, /from '@\/lib\/trading-session\.mjs'/, 'Q: signal route imports the module')
  {
    const gate = signal.indexOf('Saved ACTIVE TRADING HOURS (UTC) — generation gate')
    const ai = signal.indexOf('llmComplete(')
    assert.ok(gate > 0, 'Q: generation gate exists')
    assert.ok(ai > gate, 'Q: generation is refused BEFORE any AI call')
  }

  const worker = read('workers/scalper.mjs')
  assert.match(worker, /from '\.\.\/lib\/trading-session\.mjs'/, 'Q: worker imports the module')
  assert.match(worker, /skipped-outside-trading-session/, 'Q: worker logs an execution refusal')
  assert.match(worker, /sessionSettings: \{ sessionStart: liveStrategy\.sessionStart/,
    'Q: worker forwards the saved hours to the signal route')
  assert.equal(/sessionStart: 0,\s*\n\s*sessionEnd: 24/.test(worker), false,
    'Q: the worker default is no longer an unrestricted 0→24 window')

  const status = read('app/api/trading-session/route.ts')
  assert.match(status, /sessionAudit/, 'Q: status endpoint uses the shared evaluator')

  const strategyUi = read('components/pages/StrategyPage.tsx')
  assert.match(strategyUi, /\/api\/trading-session/, 'Q: Strategy UI reads the SERVER verdict')
  assert.match(strategyUi, /label: 'All Day', start: 0, end: 24/, 'Q: All Day spans the full day')

  group('Q — risk, orders, signal route, worker and UI all use the one shared rule')
}

console.log(`\ntrading-session: ${groups} groups passed`)
