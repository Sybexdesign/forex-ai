// lib/mt5-fill-attribution.mjs
// ── MT5 FILL → NATIVE POSITION TICKET PROPAGATION (Phase 3.3.1) ─────────────
//
// THE DEFECT THIS FIXES
//
// The shadow observer's attribution predicate was already correct:
//
//     String(openTrade.id) === String(trade.broker_ticket)
//
// but the two sides were different identity spaces:
//
//   openTrade.id          = native MT5 POSITION ticket   (adapter getOpenTrades: id: String(p.ticket))
//   trade.broker_ticket   = application correlation UUID (adapter placeOrder: tradeId = crypto.randomUUID())
//
// MT5 Direct QUEUES the order for the EA, so no native ticket exists at
// order-placement time. The EA reports the completion back carrying only the
// application id, and nothing ever persisted the native ticket — so attribution
// failed for 100% of positions (`no-scalp-trade-row`).
//
// The EA now returns the native POSITION ticket alongside the application id, and
// this module decides exactly one thing: given a completion payload, what (if
// anything) may be written to `trades.broker_ticket`.
//
// ── WHY THIS IS A SEPARATE PURE FUNCTION ───────────────────────────────────
//
// The persistence decision was inline in the Next route, where it could only be
// verified by reading it. Extracting it makes the identity transition provable,
// and lets the resulting trade row be fed into the REAL matchAttribution() as an
// end-to-end check that the two sides finally agree.
//
// ── CONTRACT ───────────────────────────────────────────────────────────────
//
//   * `oanda_trade_id` stays the APPLICATION correlation id and is never touched.
//   * `broker_ticket` becomes the NATIVE ticket only when one was genuinely
//     resolved. A missing/invalid ticket leaves it UNCHANGED (fail closed) so
//     attribution stays *unavailable* rather than becoming *ambiguous*.
//   * A native ticket is never fabricated from the symbol, time, lots, the
//     application id, or any fallback.

/** MT5 position tickets are `ulong` — digits only. */
const NATIVE_TICKET_RE = /^\d+$/

/**
 * Validate a native position ticket reported by the EA.
 *
 * @returns {{ok:true, ticket:string} | {ok:false, reason:string}}
 */
export function validateNativeTicket(raw, { appId = null } = {}) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'ticket-absent' }
  const s = String(raw).trim()
  if (s === '') return { ok: false, reason: 'ticket-empty' }
  if (appId !== null && appId !== undefined && s === String(appId)) {
    return { ok: false, reason: 'ticket-equals-application-id' }
  }
  if (!NATIVE_TICKET_RE.test(s)) return { ok: false, reason: 'ticket-not-numeric' }
  if (s === '0') return { ok: false, reason: 'ticket-zero' }
  return { ok: true, ticket: s }
}

/**
 * Phase 3.3.1 — SANITISED EA-SIDE EVIDENCE.
 *
 * `completedOrders[]` is the ONLY place the native position ticket is observable
 * before it reaches the database. Retaining a redacted copy of it makes the EA →
 * sync → DB chain independently diagnosable: if attribution later fails, this
 * line alone answers "did the EA actually report a ticket?" without needing the
 * `trades` row to have been updated.
 *
 * WHY THIS IS REDACTED RATHER THAN LOGGED RAW
 *
 * The raw payload is broker traffic carrying the account's execution detail. What
 * is needed for the acceptance chain is exactly two identifiers and a verdict:
 * which application correlation id, and which native ticket. Everything else is
 * withheld — so this emits:
 *
 *   * the application id PREFIX only (8 chars + ellipsis), enough to correlate
 *     with a `trades` row by eye while never retaining a full correlation UUID;
 *   * the resolved native ticket, or null;
 *   * the validation verdict;
 *   * the success flag.
 *
 * It deliberately excludes symbol, direction, volume, price, filled price,
 * balance, equity, login, server, and any other completion field — none of which
 * the chain needs and all of which are broker-account detail.
 *
 * @param {object} completed one entry from the EA's completedOrders payload
 * @returns {{idPrefix:string|null, ticket:string|null, ticketReason:string|null, success:boolean}}
 */
export function summariseCompletionDiagnostics(completed = {}) {
  const rawId = completed?.id != null ? String(completed.id) : ''
  const v = validateNativeTicket(completed?.ticket, { appId: rawId || null })
  return {
    idPrefix:    rawId ? `${rawId.slice(0, 8)}…` : null,
    ticket:      v.ok ? v.ticket : null,
    ticketReason: v.ok ? null : v.reason,
    success:     completed?.success === true,
  }
}

/** The one-line form used in logs; contains only redacted identifiers. */
export function completionDiagnosticLine(completed = {}) {
  const d = summariseCompletionDiagnostics(completed)
  return d.ticket
    ? `[native-ticket] ${d.idPrefix} → ${d.ticket} (EA-side proof: completedOrders carried a native position ticket)`
    : `[native-ticket] ${d.idPrefix} — no resolvable ticket (${d.ticketReason}); broker_ticket NOT updated, attribution unavailable for this fill`
}

/**
 * Map one `completedOrders[]` entry from the EA into the trade-row update.
 *
 * Mirrors the pre-existing fill updates exactly (entry_price / result /
 * opened_at) and ADDS `broker_ticket` only when a native ticket validated.
 *
 * @param {object} completed  one entry from the EA's completedOrders payload
 * @returns {{update:object, nativeTicket:string|null, reason:string|null,
 *            tradeMatcher:{oanda_trade_id:(string|null)}}}
 */
export function completionToTradeUpdate(completed = {}) {
  const appId = completed?.id != null ? String(completed.id) : null
  const update = {
    entry_price: completed?.filledPrice ?? null,
    result: 'OPEN',
    opened_at: new Date().toISOString(),
  }

  const v = validateNativeTicket(completed?.ticket, { appId })
  if (v.ok) update.broker_ticket = v.ticket

  return {
    update,
    nativeTicket: v.ok ? v.ticket : null,
    reason: v.ok ? null : v.reason,
    // The trade is located by the APPLICATION correlation id — never by ticket.
    tradeMatcher: { oanda_trade_id: appId },
  }
}
