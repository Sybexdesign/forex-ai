// tests/uk-time.test.mjs
// Phase 4.1F — UK local time for time-of-day analytics.
// Covers: GMT conversion, BST conversion, both 2026 DST transitions, the
// midnight boundary, and a broker offset change.
// Run: npm run test:uk-time
import assert from 'node:assert/strict'
import {
  UK_TIME_ZONE, isUkSummerTime, ukDateKey, ukHalfHourBucket, ukHour,
  ukMonthKey, ukOffsetMinutes, ukParts, ukSession, ukWeekKey, ukWeekdayIndex,
} from '../lib/uk-time.mjs'

// ── A — the 12 Nov 2026 evidence window is GMT ──────────────────────────────
{
  // BST ended 2026-10-25, so November is GMT and 02:25Z IS 02:25 UK.
  assert.equal(ukOffsetMinutes('2026-11-12T02:25:34Z'), 0, 'A: November = GMT')
  assert.equal(ukHour('2026-11-12T02:25:34Z'), 2, 'A: 02:25Z is 02:25 UK')
  assert.equal(ukDateKey('2026-11-12T02:25:34Z'), '2026-11-12', 'A')
  assert.equal(isUkSummerTime('2026-11-12T02:25:34Z'), false, 'A')
  assert.equal(ukHour('2026-11-12T02:32:20Z'), 2, 'A: ticket 3454458505 also lands in the 02:00 UK hour')
  console.log('PASS A: 12 Nov 2026 orders are 02:00 UK (GMT)')
}

// ── B — summer is BST, and the same UTC hour is a DIFFERENT UK hour ─────────
{
  assert.equal(ukOffsetMinutes('2026-07-12T02:25:00Z'), 60, 'B: July = BST')
  assert.equal(ukHour('2026-07-12T02:25:00Z'), 3, 'B: 02:25Z is 03:25 UK in summer')
  assert.equal(isUkSummerTime('2026-07-12T02:25:00Z'), true, 'B')
  assert.notEqual(ukHour('2026-07-12T02:25:00Z'), ukHour('2026-11-12T02:25:00Z'),
    'B: identical UTC hour, different UK hour — never bucket by UTC')
  console.log('PASS B: BST shifts the UK hour relative to UTC')
}

// ── C — spring-forward transition (2026-03-29 01:00 UTC) ───────────────────
{
  assert.equal(ukOffsetMinutes('2026-03-29T00:30:00Z'), 0, 'C: 00:30Z still GMT')
  assert.equal(ukHour('2026-03-29T00:30:00Z'), 0, 'C')
  assert.equal(ukOffsetMinutes('2026-03-29T01:30:00Z'), 60, 'C: 01:30Z is BST')
  assert.equal(ukHour('2026-03-29T01:30:00Z'), 2, 'C: clocks jumped to 02:30 — 01:00-01:59 UK does not exist')
  console.log('PASS C: spring-forward handled by the tz database, not by a hardcoded offset')
}

// ── D — fall-back transition (2026-10-25 01:00 UTC) ────────────────────────
{
  assert.equal(ukOffsetMinutes('2026-10-25T00:30:00Z'), 60, 'D: 00:30Z is BST (01:30 UK)')
  assert.equal(ukHour('2026-10-25T00:30:00Z'), 1, 'D')
  assert.equal(ukOffsetMinutes('2026-10-25T01:30:00Z'), 0, 'D: 01:30Z is GMT')
  assert.equal(ukHour('2026-10-25T01:30:00Z'), 1, 'D: 01:30 UK occurs twice — the repeated hour is expected')
  console.log('PASS D: fall-back transition produces the ambiguous repeated hour without crashing')
}

// ── E — midnight boundary ──────────────────────────────────────────────────
{
  assert.equal(ukDateKey('2026-11-12T23:59:59Z'), '2026-11-12', 'E')
  assert.equal(ukDateKey('2026-11-13T00:00:00Z'), '2026-11-13', 'E: UTC midnight is UK midnight in GMT')
  assert.equal(ukDateKey('2026-07-01T23:30:00Z'), '2026-07-02', 'E: BST pushes 23:30Z into the next UK day')
  assert.equal(ukHour('2026-07-01T23:30:00Z'), 0, 'E')
  console.log('PASS E: midnight boundary respects the local day, not the UTC day')
}

// ── F — week / month keys and weekday come from UK civil time ──────────────
{
  assert.equal(ukWeekKey('2026-11-12T10:00:00Z'), ukWeekKey('2026-11-12T22:00:00Z'), 'F: same UK week')
  assert.notEqual(ukWeekKey('2026-11-12T10:00:00Z'), ukWeekKey('2026-11-19T10:00:00Z'), 'F: different weeks')
  assert.match(ukWeekKey('2026-11-12T10:00:00Z'), /^2026-W\d{2}$/, 'F: ISO week format')
  assert.equal(ukMonthKey('2026-11-12T10:00:00Z'), '2026-11', 'F')
  assert.equal(ukWeekdayIndex('2026-11-12T10:00:00Z'), 4, 'F: 2026-11-12 is a Thursday')
  assert.equal(ukWeekdayIndex('2026-11-15T10:00:00Z'), 0, 'F: Sunday')
  console.log('PASS F: week / month / weekday keys are UK civil, not UTC')
}

// ── G — 30-minute buckets ──────────────────────────────────────────────────
{
  assert.equal(ukHalfHourBucket('2026-11-12T02:25:34Z'), '02:00-02:29', 'G: ticket 3454451953')
  assert.equal(ukHalfHourBucket('2026-11-12T02:32:20Z'), '02:30-02:59', 'G: ticket 3454458505')
  assert.equal(ukHalfHourBucket('2026-11-12T02:30:00Z'), '02:30-02:59', 'G: boundary')
  assert.equal(ukHalfHourBucket('2026-11-12T02:29:59Z'), '02:00-02:29', 'G: boundary')
  console.log('PASS G: the two 12 Nov tickets fall in adjacent 30-minute buckets')
}

// ── H — session labels are UK-based ────────────────────────────────────────
{
  assert.equal(ukSession('2026-11-12T02:25:00Z'), 'Asian', 'H')
  assert.equal(ukSession('2026-11-12T09:00:00Z'), 'London', 'H')
  assert.equal(ukSession('2026-11-12T13:00:00Z'), 'LondonNYOverlap', 'H')
  assert.equal(ukSession('2026-11-12T18:00:00Z'), 'NewYork', 'H')
  assert.equal(ukSession('2026-11-12T22:00:00Z'), 'AfterHours', 'H')
  console.log('PASS H: session labels use UK hours')
}

// ── I — a broker/UTC offset change cannot re-bucket a trade ────────────────
{
  const before = '2026-03-28T10:00:00Z'
  const after = '2026-03-30T10:00:00Z'
  assert.equal(ukOffsetMinutes(before), 0, 'I: pre-transition GMT')
  assert.equal(ukOffsetMinutes(after), 60, 'I: post-transition BST')
  assert.notEqual(ukHour(before), ukHour(after), 'I: the UK hour genuinely moved 10 -> 11')
  assert.equal(ukHour(after), 11, 'I: 10:00Z in BST is 11:00 UK')
  console.log('PASS I: a broker offset change cannot silently re-bucket trades')
}

// ── J — unparseable input is refused, not coerced to "now" ─────────────────
{
  assert.equal(ukParts(null), null, 'J')
  assert.equal(ukParts('not-a-date'), null, 'J')
  assert.equal(ukHour(undefined), null, 'J')
  assert.equal(ukHalfHourBucket('garbage'), null, 'J')
  assert.equal(UK_TIME_ZONE, 'Europe/London', 'J: the zone is explicit')
  console.log('PASS J: invalid timestamps return null')
}

console.log('\nuk-time: 10/10 groups passed')

