# ACTIVE TRADING HOURS — IMPLEMENTATION

**Repository:** SybexForexAI
**Baseline:** `00cd0ab` (main, 3 ahead of `origin/main`)
**Status:** IMPLEMENTED AND TESTED LOCALLY · not deployed
**Companion:** `ACTIVE_TRADING_HOURS_AUDIT.md`

---

## 1. One module, six consumers

New: **`lib/trading-session.mjs`** (+ `lib/trading-session.d.mts`). Pure, synchronous,
no I/O, no `next/server` import — so the same file is imported by the Next routes, the
ESM worker and the client component.

| Consumer | Call site | Effect |
|---|---|---|
| Risk guards (order path) | `lib/risk.ts` §5 | `severity: 'BLOCK'` when outside |
| Order submission | `app/api/orders/route.ts` ×2 | pre-check + **final** pre-submission re-check |
| Signal generation API | `app/api/scalper/signal/route.ts` | `HOLD` before any AI call |
| Worker (generation) | `workers/scalper.mjs` `runSweep()` | sweep stops before candidate building |
| Worker (execution) | `workers/scalper.mjs` `processSignal()` | `skipped-outside-trading-session` |
| Strategy UI + Dashboard | `GET /api/trading-session` | server-computed badge, clock, next boundary |

`tests/trading-session.test.mjs` group **Q** asserts these imports exist and are ordered
correctly, so a future refactor cannot reintroduce a second implementation.

---

## 2. The rule

```
eligible(hour) = start < end ? (hour >= start && hour < end)
                            : (hour >= start ||  hour < end)   // wraps (e.g. 23→8)
```

- `start ∈ 0..23`, `end ∈ 0..24` (`24` = midnight, end of day).
- **Start inclusive, end exclusive** — matches the brief's acceptance table and the
  previous server behaviour. For 7→16: permitted 07:00–15:59, blocked at 16:00.
- `start === end` is invalid (an empty window), not "all day".
- `0→24` is the only true all-day window.
- **Fail closed** on: missing settings, non-numeric, fractional, out-of-range, empty
  window, missing/unusable instant, unreadable strategy row.

---

## 3. Strategy configuration integration

- Source of truth: `strategies.settings.sessionStart/sessionEnd` — unchanged shape, no
  new setting, no new table.
- **Orders**: `/api/orders` now reads the saved row server-side and uses **only its two
  hour fields** — sizing, SL/TP, risk % and authority are taken from the request
  exactly as before. A DB read *error* blocks with `code: 'SESSION_UNVERIFIABLE'`; a
  *missing row* falls back to `DEFAULT_STRATEGY` (7→20), mirroring `GET /api/strategy`.
- **Signal route**: saved row when `userId` is present, `DEFAULT_STRATEGY` when the row
  is absent, and the forwarded hours when the caller is the worker (which has no
  `userId` on that path).
- **Write path**: `POST /api/strategy` now rejects an invalid window with HTTP 400
  (`validateSessionSettings`), so a bad value can never be stored and then fail open.
- **Worker defaults**: `sessionStart: 7, sessionEnd: 20` — previously `0/24`, which did
  not mirror `DEFAULT_STRATEGY` and meant "no restriction" before the first fetch.

---

## 4. Enforcement per stage

**A — Signal generation.** `/api/scalper/signal` evaluates before the market-health
gate, before candle/HTF fetches and before `llmComplete`. Refusal returns
`direction: 'HOLD'` with `outsideTradingSession: true`, records the decision in
`filter_rejections` (`filter_name: 'trading_session'`), and includes the audit payload.
No AI call is made.

**B — AI decision context.** The AI never receives authority over hours: the gate runs
before the prompt is built, so an eligible call is already inside the window. The AI
cannot re-enable trading, and no prompt instructs it to.

**C — Signal persistence.** Without a migration, the decision is written to the
existing `filter_rejections` table (JSON `indicator_snapshot` + `reason`) and to
`worker_logs.metadata` for worker decisions. The audit payload carries: version,
configuration fingerprint, window label, start/end hour, UTC instant, UTC hour,
eligibility, reason, next open/close. A dedicated columns migration was **not** created
because `filter_rejections` already stores a JSONB snapshot and no unapproved migration
may enter the application path.

**D — Worker execution.** `processSignal()` re-evaluates at the decision instant (not
the signal's generation instant) and refuses with `skipped-outside-trading-session`
before spending a direction-confirmation round trip.

**E — Order submission.** Two checks: the risk-guard `BLOCK`, then an independent final
evaluation immediately before `broker.placeOrder` using a fresh instant — because the
request has awaited quotes, sizing and authority since the first check.

**F — UI.** New `GET /api/trading-session?userId=` returns the server's evaluation from
the saved row. Strategy page shows state, saved window, current UTC, next open/close and
why generation is blocked. Dashboard shows the same strip. Neither page computes
eligibility locally.

---

## 5. Boundary, midnight and daylight-saving handling

| Concern | Behaviour |
|---|---|
| Boundaries | start inclusive, end exclusive; asserted at 07:59:59.999 / 08:00:00 / 15:59:59.999 / 16:00:00 |
| Midnight crossing | `23→8` wraps: 23:00–23:59 **and** 00:00–07:59. The old naive comparison reported its entire duration as "outside". |
| "All Day" | UI preset changed `0→23` → `0→24`; the legacy `0→23` value is still honoured literally and excludes 23:00–23:59 rather than being silently widened |
| Decorative bar | redrawn with the exclusive end so the picture matches the rule |
| DST | **No conversion.** The saved value is a UTC hour band, so eligibility is identical either side of both 2026 Europe/London transitions (asserted). No fixed local offset is invented. |
| Local clock | never read. Same instant expressed as `Z`, `+01:00`, `-05:00` or epoch ms yields one verdict (asserted). |

---

## 6. Regression tests

`tests/trading-session.test.mjs` — 18 groups, `npm run test:trading-session`, part of
`test:phase42`.

| Group | Covers |
|---|---|
| A | brief acceptance table on 08:00–16:00 (07:59/08:00/09:30/15:59/16:00/16:01) |
| A2 | shipped London preset **07:00–16:00**, unchanged and tested as it is |
| B | London vs NY on the same instant — proves the saved config decides |
| C | midnight-crossing Asian window (audit H-2) |
| D | 0→24 all-day; legacy 0→23 excluded honestly (H-3) |
| E | no/partial strategy configuration ⇒ deny |
| F | non-numeric, fractional, out-of-range, empty window, NaN/Infinity ⇒ deny (H-7) |
| G | missing/unusable timestamp ⇒ deny, no default clock |
| H | generated inside, executed outside ⇒ refused, eligibility not inherited |
| I | strategy changed while a signal is pending ⇒ new saved window decides |
| J | next open/close computed correctly, including across midnight |
| K | DST transitions cannot shift a UTC band; no invented local offset |
| L | same instant in three ISO offsets + epoch ms ⇒ one verdict |
| M | configuration fingerprint stable and selective |
| N | audit payload complete, JSON-safe |
| O | write validation consistent with read evaluation |
| P | all four entry points agree for the same input |
| Q | wiring: risk, orders, signal route, worker and UI all use this module |

`tests/recent-trades-display.test.mjs` group R additionally reviews the prepared
close-identity patch.

**Not tested here** (requires production): that the deployed EA sends `executionPayload
Version: 2`, and the live strategy row's actual saved hours. Both are owner
verification steps.

---

## 7. Behaviour change the owner must acknowledge before deploying

This is the first release in which the saved hours **can block a trade**. Concretely:

- A user whose saved window is 07:00–16:00 will have orders refused outside it, where
  previously they proceeded with a warning.
- A user whose saved window is the legacy `0→23` will be blocked 23:00–23:59 UTC.
- A user with no `strategies` row falls back to `DEFAULT_STRATEGY` (7→20), not 24 h.
- If the strategy row cannot be read, orders are blocked (`SESSION_UNVERIFIABLE`)
  rather than allowed.
- The worker no longer runs signal generation outside the window; observability jobs
  (outcome resolution, prediction resolution, reconciliation refresh) still run 24/7.

There is deliberately **no environment flag to disable the gate**: a bypass switch is a
fail-open path, and rollback is `git revert` of this commit.

---

## 8. Consistency statement (Part 6)

| Surface | Definition now used |
|---|---|
| Strategy UI status | `GET /api/trading-session` → `sessionAudit()` |
| Signal generation | same module, evaluated per request |
| Worker generation | same module, evaluated per sweep |
| Worker execution | same module, evaluated per decision |
| Order submission | same module, twice (pre-check + final) |
| Risk guards | same module |

No surface computes hours independently. The dashboard additionally uses one population
for money (`NET_CONFIRMED`) via `lib/analytics-scope.mjs`, shared with the Journal,
the prop-firm page and the order risk limits.

