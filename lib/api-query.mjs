/**
 * SybexForexAI — BOUNDED QUERY HELPERS
 *
 * WHY THIS EXISTS (Phase 4.2.1, defects M-4 / A-5)
 * `app/api/trades/route.ts` used a hard-coded `.limit(200)` with no signal to the
 * caller. Two failures followed from that one constant:
 *
 *   1. **Silent truncation.** Once a user passed 200 rows the *oldest* rows of
 *      the window simply disappeared, so `todayPL` and `winRate` were computed
 *      over an unknowable slice while being presented as the whole picture.
 *      A number nobody can bound is not evidence.
 *   2. **No bound on the other side either.** The moment the cap was lifted,
 *      an unbounded `?limit=` would let a caller ask for the entire table.
 *
 * The correction is an explicit, bounded, *reported* window: a caller states how
 * many rows it wants, the server clamps that request into a known range, and the
 * response says whether anything was withheld. The page is never silently short.
 *
 * Deliberately pure: no imports, no I/O, so it can be unit-tested directly and
 * cannot acquire a side effect later.
 */

/** Rows returned when the caller does not ask for a specific window. */
export const DEFAULT_LIMIT = 1000

/** Hard ceiling. A request above this is clamped, never honoured. */
export const MAX_LIMIT = 5000

/**
 * Parse a `?limit=` value into a usable window size.
 *
 * The rules are intentionally forgiving on input and strict on output:
 *   - missing / empty / non-numeric / non-finite  → `DEFAULT_LIMIT`
 *     (a typo must not yield zero rows, and must not yield the whole table)
 *   - fractional                                  → floored (a row count is whole)
 *   - zero or negative                            → `DEFAULT_LIMIT`
 *     (asking for no rows is almost certainly a bug, not an intent)
 *   - above `MAX_LIMIT`                           → `MAX_LIMIT`
 *
 * `DEFAULT_LIMIT` is always clamped into `1..MAX_LIMIT` as well, so a future
 * change to the constants cannot produce an unusable window.
 */
export function parseLimit(raw, { defaultLimit = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  const ceiling = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_LIMIT
  const fallback = Number.isFinite(defaultLimit) && defaultLimit >= 1
    ? Math.min(Math.floor(defaultLimit), ceiling)
    : Math.min(DEFAULT_LIMIT, ceiling)

  if (raw === null || raw === undefined) return fallback
  const text = String(raw).trim()
  if (text === '') return fallback

  const n = Number(text)
  if (!Number.isFinite(n)) return fallback
  const whole = Math.floor(n)
  if (whole < 1) return fallback
  return Math.min(whole, ceiling)
}

/**
 * Describe a page of rows: what was asked for, what was actually returned, and
 * whether anything was withheld.
 *
 * `limit` is the effective window, `rows` is the number of rows read, and
 * `truncated` is true when the caller asked for more than the cap allows OR when
 * the server had to stop at the cap. A reader can therefore tell the difference
 * between "this is everything" and "this is the newest N".
 */
export function describeWindow({ limit, rows, requested }) {
  const requestedLimit = Number.isFinite(requested) ? Math.floor(requested) : null
  const rowCount = Number.isFinite(rows) ? rows : 0
  return {
    limit,
    rows: rowCount,
    requested: requestedLimit,
    // `rows` is the count actually read (callers read `limit + 1` to detect a
    // cut), so "more than the window" is the cut. A request above the cap is
    // also a cut, even when this user happens to have fewer rows than the cap.
    truncated: rowCount > limit || (requestedLimit !== null && requestedLimit > limit),
  }
}
