// lib/uk-time.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — UK LOCAL TIME FOR TIME-OF-DAY ANALYTICS (Phase 4.1F)
//
// Pure. Uses the IANA `Europe/London` zone through Intl, so GMT/BST transitions
// are handled by the runtime's tz database. There is deliberately NO hardcoded
// UTC offset anywhere in this module.
//
// WHY
// ---
// The 02:00 UK question can only be answered if every execution is bucketed into
// the same civil hour. 2026-11-12 is GMT (BST ended 2026-10-25 01:00 UTC), so
// 02:25Z == 02:25 UK that day — but a trade in July is BST, when 01:25Z == 02:25
// UK. Bucketing both by raw UTC hour silently mixes two different local sessions.
//
// Timestamps are always STORED in UTC; this module converts for display and
// aggregation only.
// ─────────────────────────────────────────────────────────────────────────────

export const UK_TIME_ZONE = 'Europe/London'

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: UK_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', weekday: 'short',
})

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (value === undefined || value === null || value === '') return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

/**
 * Decompose an instant into UK civil-time parts.
 * @returns {{ year, month, day, hour, minute, second, weekday, weekdayIndex,
 *             dateKey, weekKey, monthKey, hourKey, minuteOfDay } | null}
 */
export function ukParts(value) {
  const d = toDate(value)
  if (!d) return null
  const out = {}
  for (const p of partsFmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  // hourCycle h23 can emit '24' for midnight in some ICU builds — normalise.
  const hour = out.hour === '24' ? 0 : Number(out.hour)
  const month = Number(out.month)
  const day = Number(out.day)
  const year = Number(out.year)
  const minute = Number(out.minute)
  const second = Number(out.second)
  const dateKey = `${year}-${pad(month)}-${pad(day)}`
  return {
    year, month, day, hour, minute, second,
    weekday: out.weekday,
    weekdayIndex: WEEKDAY_INDEX[out.weekday] ?? null,
    dateKey,
    weekKey: isoWeekKey(year, month, day),
    monthKey: `${year}-${pad(month)}`,
    hourKey: `${dateKey}T${pad(hour)}`,
    minuteOfDay: hour * 60 + minute,
  }
}

function pad(n) { return String(n).padStart(2, '0') }

/** ISO-8601 week key (YYYY-Www) computed from the UK civil date. */
export function isoWeekKey(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${pad(week)}`
}

export function ukHour(value) { return ukParts(value)?.hour ?? null }
export function ukDateKey(value) { return ukParts(value)?.dateKey ?? null }
export function ukWeekKey(value) { return ukParts(value)?.weekKey ?? null }
export function ukMonthKey(value) { return ukParts(value)?.monthKey ?? null }
export function ukWeekdayIndex(value) { return ukParts(value)?.weekdayIndex ?? null }

/** 30-minute bucket label in UK time, e.g. '02:00-02:29'. */
export function ukHalfHourBucket(value) {
  const p = ukParts(value)
  if (!p) return null
  const start = Math.floor(p.minute / 30) * 30
  const endMin = start + 29
  return `${pad(p.hour)}:${pad(start)}-${pad(p.hour)}:${pad(endMin)}`
}

/**
 * Effective UK UTC offset for an instant, in minutes (BST = +60, GMT = 0).
 * Derived by comparing the UK wall clock against the UTC wall clock — never
 * from a table of dates.
 */
export function ukOffsetMinutes(value) {
  const d = toDate(value)
  if (!d) return null
  const p = ukParts(d)
  if (!p) return null
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000)
}

/** True when the instant falls in UK summer time (BST). */
export function isUkSummerTime(value) {
  return ukOffsetMinutes(value) === 60
}

/** Trading-session label by UK hour — measurement vocabulary only. */
export function ukSession(value) {
  const h = ukHour(value)
  if (h === null) return null
  if (h >= 0 && h < 8) return 'Asian'
  if (h >= 8 && h < 12) return 'London'
  if (h >= 12 && h < 17) return 'LondonNYOverlap'
  if (h >= 17 && h < 21) return 'NewYork'
  return 'AfterHours'
}
