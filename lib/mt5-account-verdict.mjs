// lib/mt5-account-verdict.mjs
// ── WHAT THE "TEST CONNECTION" BUTTON IS ALLOWED TO CLAIM ───────────────────
//
// The MT5 Direct / Exness path is push-only: the EA posts balance, equity and
// market data to Supabase, and the app only ever repeats what the last push
// said. That makes one failure mode very easy to misreport — the EA is alive and
// pushing every ~30s while the *account* numbers it sends are zero. The old copy
// ("account may not be funded or is a demo that hasn't been initialized") guessed
// at the cause from a single `updatedAt` field and, worse, read that field from
// the config snapshot the page loaded, so a connection could be called "online"
// long after the EA stopped.
//
// This module is the single place that turns the raw facts into a verdict:
//   - did the EA ever sync?           (lastSyncAt)
//   - is that push recent?            (EA_STALE_AFTER_MS)
//   - what balance did it report?     (balance/equity/currency)
//   - which account is it on?         (login/server)
//   - is market data still arriving?  (prices/candles counts)
//
// Everything here is pure: no clock reads, no fetching. `nowMs` is injected so
// the wording is reproducible in tests, and the UI never has to string-match a
// glyph to decide a colour — it gets `level` alongside `message`.

export const ACCOUNT_VERDICT = {
  OK:    'ok',
  WARN:  'warn',
  ERROR: 'error',
}

/**
 * How old an EA push may be before the connection is called offline.
 * Matches BALANCE_TTL in lib/brokers/mt5direct.adapter.ts and the staleness guard
 * in app/api/orders/route.ts — one number, three readers, no drift.
 */
export const EA_STALE_AFTER_MS = 5 * 60_000

const toNumber = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const money = (value, currency) => `${currency || 'USD'} ${toNumber(value).toFixed(2)}`

/** "12s ago" while the number is small enough to be believable, then minutes. */
export function describeAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now'
  const secs = Math.round(ageMs / 1000)
  if (secs < 90) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

/**
 * Age of a push that is already known to be stale — minutes, then hours, then
 * days. "9211m ago" is technically true and useless; an EA that died last week
 * should say so.
 */
function describeStaleAge(ageMs) {
  const mins = Math.round(ageMs / 60_000)
  if (mins < 90) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** "login 134374547 @ Exness-MT5Real9" — the only identity an EA push carries. */
function accountLabel(login, server) {
  const l = login ? String(login) : ''
  const s = server ? String(server) : ''
  if (l && s) return `login ${l} @ ${s}`
  return l ? `login ${l}` : s
}

const withLabel = (text, label) => (label ? `${text} · ${label}` : text)


/**
 * @param {object} o
 * @param {boolean} o.isMt5            broker_type is mt5direct | exness
 * @param {string}  o.brokerName       broker.name from /api/account
 * @param {string|null} [o.error]      /api/account returned an error
 * @param {number}  [o.balance]
 * @param {number}  [o.equity]
 * @param {string}  [o.currency]
 * @param {string}  [o.login]          account the EA is logged into (mt5 only)
 * @param {string}  [o.server]
 * @param {string|null} [o.lastSyncAt] ISO timestamp of the last EA push
 * @param {number}  [o.priceSymbols]   symbols in the last push (0 = unknown)
 * @param {number}  [o.candleSets]     candle cache keys in the last push
 * @param {number}  [o.nowMs]
 * @returns {{ level: 'ok'|'warn'|'error', message: string }}
 */
export function diagnoseBrokerConnection({
  isMt5 = false,
  brokerName = 'broker',
  error = null,
  balance = 0,
  equity = 0,
  currency = 'USD',
  login = '',
  server = '',
  lastSyncAt = null,
  priceSymbols = 0,
  candleSets = 0,
  nowMs = Date.now(),
} = {}) {
  if (error) return { level: ACCOUNT_VERDICT.ERROR, message: `✕ Error: ${error}` }

  const label = accountLabel(login, server)
  const bal   = toNumber(balance)
  const eq    = toNumber(equity)

  if (!isMt5) {
    if (bal > 0) {
      return { level: ACCOUNT_VERDICT.OK, message: withLabel(`✓ Connected — ${money(bal, currency)} via ${brokerName}`, label) }
    }
    return {
      level: ACCOUNT_VERDICT.WARN,
      message: `⚠ Connected to ${brokerName} but balance is $0 — check your broker API credentials`,
    }
  }

  // ── MT5 Direct / Exness: every claim below is derived from one push ────────
  if (!lastSyncAt) {
    return {
      level: ACCOUNT_VERDICT.WARN,
      message: '⚠ EA has not synced yet — step-by-step checklist:\n'
        + '1. EA is attached to a chart in MT5\n'
        + '2. MT5: Tools → Options → Expert Advisors → Allow WebRequest → add the webhook URL\n'
        + '3. Auto Trading is enabled in the MT5 toolbar',
    }
  }

  const pushMs  = new Date(lastSyncAt).getTime()
  const ageMs   = Number.isFinite(pushMs) ? nowMs - pushMs : NaN
  const ageText = describeAge(ageMs)

  if (!Number.isFinite(ageMs) || ageMs > EA_STALE_AFTER_MS) {
    return {
      level: ACCOUNT_VERDICT.WARN,
      message: Number.isFinite(ageMs)
        ? `⚠ EA last synced ${describeStaleAge(ageMs)} and appears offline — recheck that MT5 is open and the EA is attached to a chart`
        : `⚠ EA last synced at an unreadable timestamp (${lastSyncAt}) and appears offline — recheck that MT5 is open and the EA is attached to a chart`,
    }
  }

  if (bal > 0) {
    return {
      level: ACCOUNT_VERDICT.OK,
      message: withLabel(`✓ Connected — ${money(bal, currency)} via ${brokerName}`, label),
    }
  }

  // ── Alive, recent, and reporting zero ─────────────────────────────────────
  // Split the two facts instead of merging them into a guess: the EA/terminal is
  // provably running (a push this recent, and market data with it), and the
  // account it is attached to reports no money. Naming the login is the point —
  // it is the only way to tell "unfunded" from "MT5 is on the wrong account".
  const feeds = [
    priceSymbols > 0 ? `prices for ${priceSymbols} pair${priceSymbols === 1 ? '' : 's'}` : null,
    candleSets   > 0 ? `${candleSets} candle set${candleSets === 1 ? '' : 's'}` : null,
  ].filter(Boolean)

  const aliveClause = feeds.length
    ? `The EA is online (synced ${ageText}) and pushing ${feeds.join(' + ')}, so MT5 and the EA are running.`
    : `The EA is online (synced ${ageText}).`

  const equityClause = eq !== bal ? `, equity ${money(eq, currency)}` : ''

  return {
    level: ACCOUNT_VERDICT.WARN,
    message: `⚠ Account is not syncing money — ${label || 'the terminal'} reports balance ${money(bal, currency)}${equityClause}.\n`
      + `${aliveClause}\n`
      + `So this is account-side, not EA-side: either that account has no funds, or MT5 is logged into a different account from the one you are checking.`,
  }
}
