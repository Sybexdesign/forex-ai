// lib/trading-session.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — SAVED ACTIVE TRADING HOURS (UTC) ELIGIBILITY
//
// ONE implementation. Pure, synchronous, no I/O, no `next/server` import — so the
// signal route, the worker (ESM), the order route and the Strategy UI all import
// exactly this file. `tests/trading-session.test.mjs` exercises the same functions
// production calls; there is no test-only duplicate.
//
// WHY THIS MODULE EXISTS (see ACTIVE_TRADING_HOURS_AUDIT.md)
// ---------------------------------------------------------
// The saved setting `strategies.settings.sessionStart/sessionEnd` was written,
// displayed and then IGNORED. `lib/risk.ts` turned "outside hours" into
// `{ allowed: true, severity: 'WARN' }`, which `isTradeAllowed()` never blocks on,
// and neither the signal route, the worker nor `/api/orders` consulted the setting
// at all. Three further defects lived in the one existing comparison:
//
//   * a midnight-crossing window (Asian 23→08) was inverted — it reported every
//     hour of its own duration as "outside";
//   * the UI drew an INCLUSIVE end (`end - start + 1`) while the check used an
//     EXCLUSIVE end, so the picture and the rule disagreed;
//   * a non-numeric saved value made the comparison silently false, turning the
//     window into "no restriction" — fail-open by type confusion.
//
// SEMANTICS (fixed here, once)
// ----------------------------
//   * The window is a fixed UTC hour band: [start, end) — start hour INCLUSIVE,
//     end hour EXCLUSIVE. For 7→16: permitted at 08:00, blocked at 16:00.
//   * `start` ∈ 0..23, `end` ∈ 0..24. `end = 24` means "midnight, end of day".
//   * `start > end` is a legitimate wrap (23→8 = 23:00–23:59 and 00:00–07:59).
//   * `start === 0 && end === 24` is the only true all-day window.
//   * There is NO local-time conversion anywhere. The label says UTC and the
//     arithmetic is UTC. A named preset is just an hour band: it does not shift
//     with Europe/London DST, because shifting it would mean inventing an offset
//     the saved configuration does not contain.
//
// FAIL-CLOSED RULE
// ----------------
// Anything unknown denies: missing settings, non-numeric hours, fractional hours,
// out-of-range hours, an empty window, a missing/non-finite instant. `eligible` is
// false and `reason` names the problem. No branch returns eligible without both a
// validated window and a validated UTC instant.
// ─────────────────────────────────────────────────────────────────────────────

export const TRADING_SESSION_VERSION = 'trading_session_v1'

/** `start` is an hour of the day; `end` may be 24 to mean "midnight, end of day". */
const MIN_HOUR = 0
const MAX_START_HOUR = 23
const MAX_END_HOUR = 24

const HOUR_MS = 3_600_000
/** Boundaries fall on the hour, so a 7-day scan always finds one if it exists. */
const MAX_SCAN_HOURS = 24 * 7

/** Stable reason strings — persisted and asserted in tests. */
export const SESSION_REASON = {
  ELIGIBLE: 'within_session',
  OUTSIDE: 'outside_session',
  NOT_CONFIGURED: 'session_not_configured',
  START_INVALID: 'session_start_invalid',
  END_INVALID: 'session_end_invalid',
  EMPTY: 'session_window_empty',
  TIMESTAMP_INVALID: 'timestamp_invalid',
}

const isBlank = (v) => v === null || v === undefined || v === ''

/**
 * Parse one saved hour. Returns null for anything that is not a whole number in
 * range — including `NaN`, `Infinity`, 7.5 and junk strings. A clean numeric string
 * IS accepted (`'7'`), because a JSONB round-trip can yield one.
 */
function parseHour(value, max) {
  if (isBlank(value)) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return null
  if (!Number.isInteger(n)) return null
  if (n < MIN_HOUR || n > max) return null
  return n
}

function invalidWindow(reason, rawStart, rawEnd) {
  return {
    ok: false,
    reason,
    start: null,
    end: null,
    wraps: false,
    allDay: false,
    label: null,
    rawStart: rawStart ?? null,
    rawEnd: rawEnd ?? null,
    version: TRADING_SESSION_VERSION,
  }
}

/**
 * Parse the saved strategy settings into a validated UTC window.
 *
 * @param {object|null|undefined} settings  a `strategies.settings` object
 * @returns {{ok:boolean, reason:string, start:number|null, end:number|null,
 *            wraps:boolean, allDay:boolean, label:string|null, version:string}}
 */
export function parseSessionWindow(settings) {
  const src = settings && typeof settings === 'object' ? settings : null
  const rawStart = src ? src.sessionStart : undefined
  const rawEnd = src ? src.sessionEnd : undefined

  if (!src || (isBlank(rawStart) && isBlank(rawEnd))) {
    return invalidWindow(SESSION_REASON.NOT_CONFIGURED, rawStart, rawEnd)
  }

  const start = parseHour(rawStart, MAX_START_HOUR)
  if (start === null) return invalidWindow(SESSION_REASON.START_INVALID, rawStart, rawEnd)

  const end = parseHour(rawEnd, MAX_END_HOUR)
  if (end === null) return invalidWindow(SESSION_REASON.END_INVALID, rawStart, rawEnd)

  if (start === end) return invalidWindow(SESSION_REASON.EMPTY, rawStart, rawEnd)

  const wraps = start > end
  const allDay = start === MIN_HOUR && end === MAX_END_HOUR

  return {
    ok: true,
    reason: SESSION_REASON.ELIGIBLE,
    start,
    end,
    wraps,
    allDay,
    label: describeSessionWindow({ start, end, wraps, allDay }),
    version: TRADING_SESSION_VERSION,
  }
}

/** `07:00–16:00 UTC` · `23:00–08:00 UTC (overnight)` · `00:00–24:00 UTC (all day)` */
export function describeSessionWindow(window) {
  if (!window || window.start === null || window.start === undefined) return null
  if (window.end === null || window.end === undefined) return null
  const pad = (h) => `${String(h).padStart(2, '0')}:00`
  const base = `${pad(window.start)}–${pad(window.end)} UTC`
  if (window.allDay) return `${base} (all day)`
  return window.wraps ? `${base} (overnight)` : base
}

/**
 * Is a given UTC hour inside the validated window?
 * Start inclusive, end exclusive; wraps when start > end. Invalid window ⇒ false.
 */
export function hourIsWithinWindow(window, hour) {
  if (!window || window.ok !== true) return false
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false
  const { start, end } = window
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/** Coerce a Date | ISO string | epoch ms to a finite Date, else null. */
function toInstant(at) {
  if (at instanceof Date) return Number.isFinite(at.getTime()) ? at : null
  if (typeof at === 'string' && at.trim()) {
    const d = new Date(at)
    return Number.isFinite(d.getTime()) ? d : null
  }
  if (typeof at === 'number' && Number.isFinite(at)) {
    const d = new Date(at)
    return Number.isFinite(d.getTime()) ? d : null
  }
  return null
}

function startOfUtcHour(ms) {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
}

function boundaryLabel(ms) {
  const d = new Date(ms)
  return {
    at: d.toISOString(),
    label: `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`,
    utcDate: d.toISOString().slice(0, 10),
  }
}

/**
 * First hour boundary (≥ the current hour) whose eligibility equals `want`.
 * Boundaries fall on UTC hour starts, so scanning hour starts is exact.
 */
function findNextBoundary(window, fromMs, want) {
  const base = startOfUtcHour(fromMs)
  for (let i = 0; i <= MAX_SCAN_HOURS; i++) {
    const t = base + i * HOUR_MS
    const eligible = hourIsWithinWindow(window, new Date(t).getUTCHours())
    if (eligible === want) return t
  }
  return null
}



/**
 * Evaluate the saved window at one instant.
 *
 * @param {object} window   from parseSessionWindow()
 * @param {Date|string|number} at  the authoritative UTC instant
 * @param {number} [nowMs]  reference for `inMinutes` (defaults to `at`)
 */
export function evaluateSessionWindow(window, at, nowMs) {
  const instant = toInstant(at)
  const base = {
    version: TRADING_SESSION_VERSION,
    start: window && window.start !== undefined ? window.start : null,
    end: window && window.end !== undefined ? window.end : null,
    wraps: window?.wraps === true,
    allDay: window?.allDay === true,
    label: describeSessionWindow(window),
    utcTimestamp: instant ? instant.toISOString() : null,
    utcHour: instant ? instant.getUTCHours() : null,
    eligible: false,
    active: false,
    reason: SESSION_REASON.TIMESTAMP_INVALID,
    nextOpen: null,
    nextClose: null,
  }

  if (!instant) return base

  if (!window || window.ok !== true) {
    return { ...base, reason: window?.reason || SESSION_REASON.NOT_CONFIGURED }
  }

  const eligible = hourIsWithinWindow(window, instant.getUTCHours())
  const ref = Number.isFinite(nowMs) ? nowMs : instant.getTime()
  const nextOpenMs = eligible ? null : findNextBoundary(window, instant.getTime(), true)
  const nextCloseMs = eligible ? findNextBoundary(window, instant.getTime(), false) : null

  const withEta = (ms) => (ms === null ? null : {
    ...boundaryLabel(ms),
    inMinutes: Math.max(0, Math.round((ms - ref) / 60_000)),
  })

  return {
    ...base,
    eligible,
    active: eligible,
    reason: eligible ? SESSION_REASON.ELIGIBLE : SESSION_REASON.OUTSIDE,
    nextOpen: withEta(nextOpenMs),
    nextClose: withEta(nextCloseMs),
  }
}

/** Convenience: saved settings → validated window → evaluation, in one call. */
export function evaluateTradingSession(settings, at, nowMs) {
  return evaluateSessionWindow(parseSessionWindow(settings), at, nowMs)
}

/**
 * Stable short fingerprint of the configuration that produced a decision.
 * Recorded with every refusal, so a later audit can prove WHICH window was in
 * force. FNV-1a/32 — not a security primitive, just a collision-resistant label.
 */
export function sessionFingerprint(settings) {
  const window = parseSessionWindow(settings)
  const material = window.ok
    ? `${TRADING_SESSION_VERSION}|${window.start}|${window.end}`
    : `${TRADING_SESSION_VERSION}|invalid|${window.reason}`
  let h = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `ts1-${h.toString(16).padStart(8, '0')}`
}

/**
 * The audit object attached to every refusal and every order response.
 * Flat, JSON-safe, written into an EXISTING JSONB column — no migration.
 */
export function sessionAudit(settings, at, nowMs) {
  const evaluation = evaluateTradingSession(settings, at, nowMs)
  return {
    version: TRADING_SESSION_VERSION,
    fingerprint: sessionFingerprint(settings),
    window: evaluation.label,
    startHour: evaluation.start,
    endHour: evaluation.end,
    wraps: evaluation.wraps,
    utcTimestamp: evaluation.utcTimestamp,
    utcHour: evaluation.utcHour,
    eligible: evaluation.eligible,
    reason: evaluation.reason,
    nextOpen: evaluation.nextOpen,
    nextClose: evaluation.nextClose,
  }
}

/**
 * Validation for the WRITE path (`POST /api/strategy`). Returns a normalised pair
 * or an error string — never throws, never silently coerces.
 */
export function validateSessionSettings(settings) {
  if (!settings || typeof settings !== 'object') return { ok: true }
  const hasStart = Object.prototype.hasOwnProperty.call(settings, 'sessionStart')
  const hasEnd = Object.prototype.hasOwnProperty.call(settings, 'sessionEnd')
  if (!hasStart && !hasEnd) return { ok: true }
  if (!hasStart || !hasEnd) {
    return { ok: false, error: 'sessionStart and sessionEnd must be saved together' }
  }
  const window = parseSessionWindow(settings)
  if (!window.ok) {
    return {
      ok: false,
      error: `Invalid trading hours: sessionStart must be 0-23 and sessionEnd 0-24, and they must differ (${window.reason})`,
    }
  }
  return { ok: true, start: window.start, end: window.end }
}

