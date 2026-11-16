# RECENT TRADES — ACCOUNTING IMPLEMENTATION

**Repository:** SybexForexAI
**Baseline:** `00cd0ab` (main, 3 ahead of `origin/main`)
**Status:** IMPLEMENTED AND TESTED LOCALLY · nothing deployed · no migration applied
**Companion:** `RECENT_TRADES_ACCOUNTING_AUDIT.md` (the evidence this responds to)

---

## 1. What was changed, and what deliberately was not

| Area | Changed? | File |
|---|---|---|
| Row → display mapping | **Yes** (new) | `lib/analytics-scope.mjs` — `describeTradeRow`, `sortDescribedRows`, `utcDayKey`, `realisedPnlForUtcDay` |
| Recent Trades table | **Yes** (rebuilt) | `components/RecentTradesTable.tsx` (new), `components/pages/DashboardPage.tsx` |
| Today P&L | **Yes** (basis + timezone) | `components/pages/DashboardPage.tsx` |
| Read window / ordering | **Yes** | `app/api/trades/route.ts`, `hooks/useForex.ts` |
| Close identity, broker time (DB) | **Prepared only** | `supabase/prepared/20261211_phase421_close_identity.sql` |
| P&L arithmetic (`net = gross + comm + swap + fees`) | **No** — already correct | `lib/trade-accounting.mjs`, Phase 4.1 trigger |
| Population definitions (net/gross/simulated) | **No** — already correct | `lib/analytics-scope.mjs` |
| Lot sizing, SL/TP, break-even, trailing, risk % | **No** | — |
| Order authority / `ORDER_AUTHORITY_ENFORCE` | **No** | — |
| Historical rows | **No** — no UPDATE, no backfill | — |

---

## 2. Root causes addressed

Full evidence in the audit (§4). Summary:

| ID | Root cause | Resolution in this phase |
|---|---|---|
| R-1 | A close cannot write `broker_ticket`, so a genuine close can classify as SIMULATION and vanish | Prepared RPC patch (validated payload ticket persisted) |
| R-2 | Closes matched by price proximity, not identity | Prepared RPC patch (ticket-first, price fallback retained) |
| R-3 | `closed_at` = server receive time | Prepared RPC patch (zoned timestamps only) |
| R-4 | Provisional gross direction displayed as settled WIN/LOSS | **Fixed**: `RESULT PENDING` + "gross only" qualifier |
| R-5 | Truncated/mis-ordered table; six columns; local-day P&L | **Fixed**: ordering, window reporting, full row, UTC day |
| R-6 | No per-row accounting label | **Fixed**: ACCOUNTING column + missing-cost list + table note |
| R-7 | Two implementations of the v2 deal contract | **Recorded** as an owner decision (unchanged) |
| R-8 | Deal evidence has no columns | **Already prepared** (`20261114_phase421_partial_close_proof.sql`) |
| R-9 | Pre-v9.4 rows lack cost components | **Recorded**; requires broker evidence, never guessed |

---

## 3. P&L rules as implemented at the display boundary

`describeTradeRow()` is the only function that decides what a row may show. It
**computes no accounting**; it reads the population decided by `classifyTrade()`.

| Population | `pnl` shown | `pnlBasis` | `result` | `netPnl` |
|---|---|---|---|---|
| `NET_CONFIRMED` | `net_realised_pnl` | `NET` | WIN / LOSS / BREAKEVEN (ε = $0.01) | value |
| `GROSS_ONLY` | `pl_usd` | `GROSS` | **RESULT PENDING** + "gross only" | **null** |
| `ACCOUNTING_PENDING` | — | `NONE` | RESULT PENDING | null |
| `ACCOUNTING_ERROR` | — | `ERROR` | RESULT PENDING | null |
| `SIMULATION` | — | `NONE` | SIMULATED | null |
| `OPEN` | — | `NONE` | OPEN | null |
| `CANCELLED` | — | `NONE` | CANCELLED | null |

Rules enforced by code and by test:

- Net appears **only** for `NET_CONFIRMED`.
- A missing commission, swap or fee renders an em dash — **never `0.00`**.
- A gross-only row is never a settled WIN/LOSS, however large the gross.
- An open position never shows a result.
- A ticket-less row is labelled SIMULATED and excluded from totals, not silently
  dropped without explanation.


---

## 4. Partial closes and recovery

Nothing in the aggregation changed — it was already correct and is now asserted:

- `aggregateDeals()` (`lib/trade-accounting.mjs`) keys every deal by its broker deal
  ticket; a re-delivered deal increments `duplicateDeals` and is not counted twice; a
  deal with no ticket is refused.
- Partial closure is inferred from reported volume (`PARTIALLY_CLOSED`).
- The RPC's `pl_usd IS NULL` guard keeps a re-delivered position close idempotent; the
  prepared patch preserves it on **both** match paths.
- EA recovery (`provenance: "ea_recovered"`) is honoured: a recovered close with a
  native ticket is a genuine execution; one without is SIMULATED.

---

## 5. Dashboard changes

`components/RecentTradesTable.tsx` (new) renders, per row:

`PAIR · DIR · VOL · ENTRY · EXIT · OPENED (UTC) · CLOSED (UTC) · GROSS · COMM · SWAP ·
FEES · NET · RESULT · ACCOUNTING · TICKET · SOURCE`

- **Ordering:** `sortDescribedRows()` sorts by broker close (fallback open), newest
  first; undated rows sort last, never first.
- **Pagination:** the component pages over the full described set, so no row is
  unreachable (asserted).
- **Empty state:** distinguishes "no broker executions" from "rows exist but are
  simulated/awaiting accounting".
- **Note under the table:** states the sorting key, the net-only rule, that an em dash
  is not zero, how many simulation rows were excluded, and how many closes today await
  accounting.
- **Today P&L** (`DashboardPage`): `realisedPnlForUtcDay()` — one population
  (`NET_CONFIRMED`), one **UTC** day boundary, `null` when there are no net rows
  (rendered as `—`, not `0.00`).

The old expressions removed:

```ts
// removed: local-time day boundary
const today = new Date().toDateString()
// removed: per-row net/gross mixing
const plKey = netBasis ? 'net_realised_pnl' : 'pl_usd'
trades.filter(t => isGenuineExecution(t) && new Date(t.closed_at).toDateString() === today)
      .reduce((s, t) => s + Number(t[plKey]), 0)
```

---

## 6. Database / API changes

**API**

- `GET /api/trades` now orders by `closed_at DESC NULLS LAST, opened_at DESC`, so the
  window is selected by the same timestamp the UI presents (R-5). `limit`/`truncated`
  are unchanged and are now consumed by `useForex` (`limit=2000`, `window` exposed).

**No schema change is applied or required by this phase.** One prepared patch:

`supabase/prepared/20261211_phase421_close_identity.sql` — a byte-identical copy of the
current `mt5_webhook_sync` with exactly one region replaced (the `closedPositions`
UPDATE) implementing R-1, R-2 and R-3. Its header states PREPARED — NOT APPLIED, lists
the guards preserved, and explains why an unzoned MT5 `closedAt` is **not** trusted.

Verify that only that region changed:

```bash
diff <(sed -n '200,$p' supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql) \
     <(tail -n +186 supabase/prepared/20261211_phase421_close_identity.sql)
# only the closedPositions UPDATE differs
```

---

## 7. Regression tests

New: `tests/recent-trades-display.test.mjs` — 10 groups covering the brief's 25 cases
plus a review of the prepared patch. Wired as `npm run test:recent-trades` inside
`test:phase42`.

| Brief case | Group |
|---|---|
| 1-4 closed win / loss / breakeven / open | 1-4 |
| 5-6 partial close, multiple closing deals | 5-6 |
| 7-12 commission, swap, fees present/missing | 7-12 |
| 13-15 duplicate webhook, delayed close, EA restart recovery | 13-15 |
| 16-19 MT5 ticket, internal UUID, simulated, cancelled | 16-19 |
| 20 multiple accounts | 20 |
| 21-22 pagination, broker-timestamp ordering | 21-22 |
| 23-24 unknown stays unknown, never a false WIN/LOSS | 23-24 |
| 25 totals agree with the eligible population | 25 |
| Prepared patch is unapplied and guard-preserving | R |

Also updated: `tests/phase421-remediation.test.mjs` group P-F, which previously asserted
a string that lived in `DashboardPage`; the em-dash contract moved to
`RecentTradesTable` and the assertion now checks the stronger rule (no P&L is emitted at
all when the accounting does not support one).

---

## 8. What is still outstanding (owner)

1. **Apply** `20261211_phase421_close_identity.sql` — after approval. Until then R-1 and
   R-2 are unmitigated in production (rows can still be born ticket-less).
2. **Approve** `20261114_phase421_partial_close_proof.sql` for deal-level evidence.
3. **EA v9.5** — carries `ticket` and the separate cost terms; without it the patch has
   nothing to bind to.
4. **Broker evidence** for pre-v9.4 rows (R-9). They stay GROSS ONLY until then.

