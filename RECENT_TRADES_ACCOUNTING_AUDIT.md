# RECENT TRADES — ACCOUNTING AUDIT

**Repository:** SybexForexAI
**Audit baseline commit:** `00cd0ab` (`main`, 3 commits ahead of `origin/main`)
**Audit type:** read-only trace. **No file was modified to produce this document.**
**Date:** 2026-12-11

---

## 0. What this audit is, and what it is not

This document records **how a genuine MT5 execution becomes (or fails to become) a
row in the dashboard's RECENT TRADES table**, with file:line evidence for every
claim. It does not assume that a trade missing from the dashboard is missing from
the database.

It is **not** a claim about production data. Production was not queried. Every
statement about production rows below is either (a) quoted from an existing
recorded finding, or (b) a *derivable consequence* of the code path, and is
labelled as such.

---

## 1. The live architecture (corrected)

The first correction matters more than any other in this document:

> **`app/api/mt5-sync/route.ts` is not the live ingestion path. It has no callers.**

Evidence:

| Evidence | Location |
|---|---|
| Every shipped EA posts directly to the Supabase RPC | `public/SybexForexAI_EA_v9.3.1.mq5:101`, `v9.4.mq5:101`, `v9.5.mq5:129` — `SYNC_URL = ".../rest/v1/rpc/mt5_webhook_sync"` |
| The RPC migration states it outright | `supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql:4-7` — "The shipping EA does NOT post to app/api/mt5-sync. It posts straight to public.mt5_webhook_sync … So the ONLY place a real close can be given its broker costs is this function." |
| The route never calls the RPC either | `grep '\.rpc(' app/api/mt5-sync/route.ts` → no matches |

**Therefore the authoritative ingestion path is:**

```
MT5 terminal
  → EA (SybexForexAI_EA_vX) builds p_payload: {balance, equity, prices, candles,
       completedOrders[], openPositions[], closedPositions[]}
  → POST /rest/v1/rpc/mt5_webhook_sync   (anon key + webhookToken)
  → public.mt5_webhook_sync(text, jsonb)  ← parses and WRITES trades
  → trigger trades_derive_accounting_trg  ← derives net_realised_pnl / accounting_complete
  → public.trades
  → GET /api/trades  → useForex → DashboardPage
```

Two of the three "writers" that a reader might expect are not on this path:

- `app/api/mt5-sync/route.ts` — dead code with respect to the EA. Its close logic
  (fuzzy match, `closed_at = now()`, no `broker_ticket`) is **not** what runs.
- `lib/broker-deal-ingest.mjs` — a fully specified, fully tested v2 deal-contract
  parser that **no production module imports**. `grep -rn "broker-deal-ingest"
  --include=*.ts --include=*.mjs app lib workers` returns only two comment lines
  inside `app/api/mt5-sync/route.ts`. The SQL RPC re-implements the contract in
  parallel (see §4, R-7).

---

## 2. Stage-by-stage traceability

Legend for **Verdict**: ✅ correct · ⚠️ correct but incomplete · ❌ defect.

### Stage 1 — MT5 order and deal history

| Expected | Actual | Verdict |
|---|---|---|
| Every closing deal of a position is enumerated | EA v9.5 aggregates **all** deals: `DEAL_ENTRY_OUT`, `DEAL_ENTRY_OUT_BY`, `DEAL_ENTRY_INOUT` (`v9.5.mq5:249-265`, `448-449`) | ✅ in v9.5 |
| ...but v9.3.1 reads only the first `DEAL_ENTRY_OUT` and `break`s | documented at `v9.5.mq5:186-187`, `605`; `20261113…sql:10-12` | ❌ in the shipped EA |
| Broker costs are sent separately and signed | v9.5 sends `commission`, `swap`, `fee` separately (`v9.5.mq5:393-395`) | ✅ in v9.5 |
| v9.3.1 folds `DEAL_PROFIT + DEAL_COMMISSION + DEAL_SWAP` into one `profit` | `20261113…sql:13-15` | ❌ in the shipped EA (irrecoverable) |

### Stage 2 — EA webhook payload

| Field required by the spec | v9.5 closedPositions entry | v9.3.1 |
|---|---|---|
| Genuine MT5 position ticket | `"ticket"` (`v9.5.mq5:385`) | present in `closedPositions` |
| Deal tickets | `"dealTickets"` (`v9.5.mq5:398`) | absent |
| Gross / commission / swap / fee / net | `grossProfit`, `commission`, `swap`, `fee`, `netProfit` (`v9.5.mq5:391-396`) | folded `profit` only |
| **Broker close timestamp** | `"closedAt"` = `TimeToString(agg.lastTime, …)` (`v9.5.mq5:401`) | absent |
| Volume closed / partial flag | `volumeClosed`, `partial` (`v9.5.mq5:399-400`) | absent |
| Contract version | `executionPayloadVersion: 2` (`v9.5.mq5:411`) | absent ⇒ treated as v1 (`lib/broker-deal-ingest.mjs:47-52`) |
| Recovery provenance | `provenance: "ea_recovered"`, `mfeMaeMeasured: false` (`v9.5.mq5:404-407`) | absent |

**v9.4 gap:** `v9.4.mq5` sends `executionPayloadVersion: 2` (line 848) but its
`closedPositions` entry contains **no `ticket` field** (`grep '"ticket":"'` → no
match). A v9.4 payload therefore cannot be ticket-matched server-side.

### Stage 3 — `public.mt5_webhook_sync` RPC

Read at `supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql`.

**`completedOrders[]` branch (lines 300-367)** — this is the *only* place
`broker_ticket` is ever written:

```sql
v_ticket := NULLIF(btrim(v_completed->>'ticket'), '');            -- :313
v_ticket_valid := v_ticket IS NOT NULL
              AND v_ticket ~ '^[0-9]+$' AND v_ticket !~ '^0+$'
              AND length(v_ticket) <= 20 AND v_ticket <> v_order_id;  -- :326-331
UPDATE trades SET ... broker_ticket = CASE WHEN v_ticket_valid
                                           THEN v_ticket ELSE broker_ticket END  -- :343-346
WHERE user_id = v_user_id AND oanda_trade_id = v_order_id AND result = 'OPEN'
```

**`closedPositions[]` branch (lines 369-458)** — this is where money is written:

```sql
v_cp_gross      := COALESCE(grossProfit, profit)           -- :390-391
v_cp_commission := NULLIF(...->>'commission','')::numeric  -- :393
v_cp_swap       := NULLIF(...->>'swap','')::numeric        -- :394
v_cp_fee        := NULLIF(...->>'fee','')::numeric         -- :395
v_cp_net        := CASE WHEN v_payload_version >= 2
                          AND commission IS NOT NULL AND swap IS NOT NULL
                    THEN ROUND(gross + commission + swap + COALESCE(fee,0), 2)
                    ELSE NULL END                          -- :409-415

UPDATE trades SET result = CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0
                                THEN 'WIN' ELSE 'LOSS' END,      -- :425
                  pl_usd = v_cp_profit,                          -- :426
                  commission = v_cp_commission,                  -- :431
                  swap = v_cp_swap, other_fees = v_cp_fee,       -- :432-433
                  closed_at = COALESCE(closed_at, now()),         -- :436
                  exit_price = v_cp_close_price,                  -- :437
                  trade_status = 'CLOSED',                        -- :438
                  realised_r = COALESCE(v_cp_net, v_cp_profit)/NULLIF(planned_risk_amount,0) -- :441
WHERE id = (SELECT id FROM trades
             WHERE user_id = v_user_id
               AND replace(pair,'/','') = v_cp_sym
               AND direction = v_cp_direction
               AND result IN ('OPEN','CLOSED')
               AND pl_usd IS NULL
               AND ABS(COALESCE(entry_price,0) - v_cp_open_price) < v_price_tol  -- XAU: 5.0
             ORDER BY opened_at DESC LIMIT 1)                    -- :442-452
```

Three facts follow directly:

1. **`broker_ticket` is never written by the close branch.** It can only arrive via
   a validated `completedOrders[].ticket`.
2. **`closedAt` in the payload is ignored.** `COALESCE(closed_at, now())` writes the
   *server's* receive time. The broker's close timestamp is discarded even when the
   EA sends it.
3. **`dealTickets` and `volumeClosed` are ignored.** Duplicate protection therefore
   rests entirely on `pl_usd IS NULL`, and partial closes cannot be reconstructed
   from stored deals.

**Position-absence fallback (lines 460-464):**

```sql
UPDATE trades t SET result = 'CLOSED', closed_at = now() FROM ( … row_number() … ) …
```

This is the honest "the position is gone but no deal history arrived" path. It
writes **no money** — correct — but it produces a `CLOSED` row with no P&L, which
classifies as `ACCOUNTING_PENDING` (§3).

### Stage 4 — derivation trigger

`trades_derive_accounting_trg` (Phase 4.1, `20261112_phase41_order_authority_and_accounting.sql`)
derives `net_realised_pnl`, `accounting_complete` and `accounting_missing[]` from
the columns the RPC just wrote. This is what makes a row eligible for
`POPULATION.NET_CONFIRMED` (`lib/analytics-scope.mjs:188-280`). The RPC deliberately
does **not** write `net_realised_pnl` itself — `v_cp_net` is used only for `result`
and `realised_r` — so the trigger is the single writer. ✅ by design.

### Stage 5 — `trades` table

Columns that exist (verified across migrations): `broker_ticket`, `commission`,
`swap`, `other_fees`, `net_realised_pnl`, `accounting_complete`,
`accounting_missing`, `trade_result`, `trade_status`, `exit_price`, `closed_at`,
`opened_at`, `realised_r`, `signal_at`, `source`, `prediction_log_id`, `setup_id`.
There is **no** column for deal tickets, closed volume, partial-close count, or a
broker close timestamp distinct from `closed_at`.

### Stage 6 — `GET /api/trades`

`app/api/trades/route.ts:76-81`:

```ts
let query = admin.from('trades').select('*').eq('user_id', userId)
  .order('opened_at', { ascending: false })
  .limit(limit + 1)          // default 1000, cap 5000
```

- Ordering is by **`opened_at`**, not by close. A position opened months ago and
  closed today sits at the *bottom* of the window and is cut off when the window
  truncates. The endpoint does return `truncated`, but nothing consumes it.
- `select('*')` is correct here — every accounting column reaches the client.

### Stage 7 — `useForex`

`hooks/useForex.ts:169` — `fetch('/api/trades?userId=' + userId)`, then
`setTrades(data.trades || [])`. No `limit`, no `truncated` handling, no
`Authorization` header. The 1000-row default window is silently assumed complete.

### Stage 8 — `DashboardPage` RECENT TRADES

`components/pages/DashboardPage.tsx`:

| Line | Behaviour | Assessment |
|---|---|---|
| 70-74 | `closedTrades = trades.filter(isGenuineExecution && result !== 'OPEN')` | **Correct population gate** — and the reason a ticket-less close is invisible (§4 R-1) |
| 75-81 | `todayPL` uses `new Date().toDateString()` on `t.closed_at` in **local** time | ❌ day boundary differs from UTC; a 23:30 UTC close lands on the wrong day west of Greenwich |
| 309-312 | sorts by `closed_at \|\| opened_at`, client-side, over the already-truncated window | ⚠️ correct comparator, wrong population |
| 318 | `<th>DATE · PAIR · DIR · LOTS · P/L · RESULT</th>` | ❌ six of the required fourteen columns |
| 334-348 | renders **`t.pl_usd`** only; `null` → `—` | ❌ net never shown; gross-only and net-complete look identical |
| 363 | renders raw `t.result` | ❌ a gross-only row's provisional direction reads as settled |
| 370-372 | empty state: *"No closed trades yet"* | ⚠️ shown even when rows exist but are simulated/incomplete — no explanation |
| — | no commission / swap / fees / ticket / entry / exit / status / strategy columns | ❌ |

### Stage 9 — Other consumers of the same rows

`buildScopedAnalytics` (`lib/analytics-metrics.mjs:120`) and `scopedEquityCurve`
(`:161`) are used by `DashboardPage` and by `lib/journal-stats.mjs` (the Journal).
`/api/orders` uses `closedExecutions` + `sumKnownPL` (`app/api/orders/route.ts:61-64`,
`RISK_COLUMNS` at `:49`) — the same scope library.

> **Structural finding:** the *analytics* layer is consistent; the *display* layer is
> not. The cards and the table are computed from the same rows by different rules.

### Stage 10 — Refresh

`onRefreshTrades` is called after a manual close (`DashboardPage.tsx:109-110`) and by
the page-level refresh. There is no push subscription; a trade closed by MT5 while
the tab is open appears only on the next poll. Acceptable — but it must not be
described as live.

---

## 3. Row population map (as implemented, not as documented)

`lib/analytics-scope.mjs:188-280` `classifyTrade()` assigns exactly one population:

| Population | Trigger | Shown in RECENT TRADES? |
|---|---|---|
| `NET_CONFIRMED` | genuine ticket + `accounting_complete === true` | ✅ yes |
| `GROSS_ONLY` | genuine ticket, gross known, costs missing | ✅ yes |
| `ACCOUNTING_PENDING` | closed, no financial value | ✅ yes (as `CLOSED`, `—`) |
| `ACCOUNTING_ERROR` | value present but unusable | ✅ yes |
| `SIMULATION` | **no usable `broker_ticket`** | ❌ **hidden** |
| `OPEN` | still open | ❌ (separate OPEN POSITIONS panel) |
| `CANCELLED` | rejected before execution | ❌ correct |

`isGenuineExecution()` → `brokerTicketKind() !== NONE` (`analytics-scope.mjs:80-82`,
`128-134`). A row whose `broker_ticket` is empty, or is byte-identical to its own
`id`, is `NONE` → `SIMULATION` → filtered out of the table **and** out of every card.

---

## 4. Root causes

Each root cause states the evidence that proves it and the class of fix required.
**R-1 … R-6 are code-fixable in this repository. R-7 … R-9 need an owner decision, a
migration, or the EA.**

### R-1 — A close can never acquire a broker ticket (❌ code-fixable)

`broker_ticket` is written **only** in the `completedOrders` branch (`:343-346`),
and only when that branch finds a row by `oanda_trade_id`. The `closedPositions`
branch (`:424-452`) — the branch that actually closes the trade — cannot set it.

So any position that closes without a matching successful completion event keeps an
empty `broker_ticket`:

- a position opened manually in MT5 (no `completedOrders` entry ever),
- a position whose completion arrived while the EA was restarting,
- a position whose `completedOrders[].ticket` failed validation (`:326-331`),
- a position recovered from deal history after the terminal was down — exactly the
  v9.5 `provenance: "ea_recovered"` path (`v9.5.mq5:404`).

**Consequence:** such a row carries real broker money in `pl_usd` yet classifies as
`SIMULATION`, so it is invisible in RECENT TRADES and in every headline figure. This
is the most likely mechanism behind *"the trade exists in the DB but not on the
dashboard"* — and it is exactly what the spec forbids ("Do not assume that a trade is
missing from the database merely because it is missing from the dashboard").

**Fix class:** server-side, in the close branch — persist the payload's `ticket` when
it is a valid numeric MT5 ticket, using the same anti-fallback guard the
`completedOrders` branch already applies.

### R-2 — Closed positions are matched by price proximity, not identity (❌ code-fixable)

`ABS(entry_price - open_price) < v_price_tol`, with `v_price_tol = 5.0` for XAU
(`:417-422`), and `ORDER BY opened_at DESC LIMIT 1` (`:450-451`).

On a scalping pair, two same-direction positions opened within $5.00 of each other
are indistinguishable to this predicate. The newest open row with `pl_usd IS NULL`
wins — which may be the *other* position. Result: **P&L attributed to the wrong
row**, one row closed-looking and another left open. The payload's `ticket` (v9.5)
is available and unused.

Re-delivery of the same close is safe (`pl_usd IS NULL` guard) — that part is correct
and must be preserved.

**Fix class:** prefer ticket identity when the payload carries a valid MT5 ticket;
keep the existing predicate only as a fallback for v1/v9.4 payloads. Strictly
narrowing: it can only *reduce* mis-attribution.

### R-3 — `closed_at` is the server's clock, not the broker's (❌ code-fixable)

`:436` `COALESCE(closed_at, now())`. The EA sends `closedAt` (`v9.5.mq5:401`) and the
RPC never reads it. Consequences:

- RECENT TRADES "sorted by broker close timestamp" is in fact sorted by *arrival*;
  a recovered close arrives hours late and jumps to the top.
- `todayPL` (`DashboardPage.tsx:75-81`) can place a close on the wrong day.
- A delayed broker-close delivery is indistinguishable from a live one.

**Fix class:** write `closed_at` from a validated payload timestamp when present,
fall back to `now()`, never overwrite an existing `closed_at`.

### R-4 — WIN/LOSS is written from gross when net is unknown (⚠️ DB semantics; display must not lie)

`:425` `result = CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0 THEN 'WIN' ELSE 'LOSS'`.
On a v1 payload — every row written by the shipped v9.3.1 EA — `v_cp_net` is NULL, so
`result` is derived from **gross**.

The analytics layer already refuses to let a `GROSS_ONLY` row into a net figure
(`analytics-metrics.mjs:116-128`), so the *statistics* are honest. The *table* is not:
`DashboardPage.tsx:363` prints `t.result` with no qualification, so a provisional
gross direction reads as settled.

**Fix class:** display-only. Show `RESULT PENDING` for any closed row whose accounting
is not net-complete, keeping the gross direction as a qualified secondary. Do **not**
rewrite historical `result` values ("Do not overwrite historical financial values
merely to make the dashboard look complete").

### R-5 — The table is a truncated, mis-ordered, under-populated view (❌ code-fixable)

- `/api/trades` orders by `opened_at` (`:78`); the UI sorts by `closed_at` (`:311`).
  The window is chosen by one key and presented by another — a long-held position
  closed today can fall outside it.
- `useForex.ts:169` ignores `truncated`, so 1001+ rows silently look complete.
- Six columns; no entry/exit/volume/commission/swap/fees/net/ticket/status/strategy.
- `todayPL` uses the local day (`:75-79`).
- No loading state for the table; the empty state cannot distinguish "no trades" from
  "every trade is incomplete or simulated" (`:370-372`).

**Fix class:** API ordering + explicit pagination + a widened, accounting-driven row
renderer + a UTC day boundary.

### R-6 — Hidden rows are explained only at card level, not at row level (⚠️ partially fixable)

The spec requires simulated records to be *distinguishable* from genuine executions,
not merely absent. Today they are absent from the table. The population disclosure
(`scoped.scope.disclosure`) **is** rendered, but only above the cards
(`DashboardPage.tsx:173-196`) — the table itself carries no accounting label, no
explanation of the rows it omits, and no per-row indication that a WIN/LOSS came from
gross rather than net.

**Fix class:** per-row accounting status in the table, and an explicit note beside the
table when rows are hidden for lack of a broker ticket.

### R-7 — `lib/broker-deal-ingest.mjs` is a specification with no caller (⚠️ owner decision)

A tested, versioned parser for the v2 deal contract exists and is imported by nothing
in `app/`, `lib/` or `workers/`. The SQL RPC implements the same contract
independently. Two implementations of one contract is precisely the drift risk the
spec warns about ("There must be no conflicting implementations").

**Not fixed here**, because wiring it means either (a) moving the close path into the
TS route — which the EA does not call, so it is a deploy-and-EA change — or (b)
deleting the module and losing the executable specification. Recorded as an owner
decision.

### R-8 — Deal-level evidence has nowhere to live (⛔ migration required)

`dealTickets`, `volumeClosed`, `partial`, `dealCount` and `provenance` are produced by
the EA and dropped by the RPC, and there is no column to store them. Therefore:

- a duplicated *deal* (not a duplicated *position*) cannot be proven absent,
- a partial close cannot be reconstructed from storage,
- "multiple closing deals for one position" is verified only by trusting the EA's own
  arithmetic.

**Already prepared, correctly outside the applied path:**
`supabase/prepared/20261114_phase421_partial_close_proof.sql` (patch P-I) adds
`deal_count`, `volume_closed`, `partial_close`, `deal_tickets`, `close_provenance` plus
the read-only `v_partial_close_audit` view. It is not applied and needs no new work in
this phase — only the owner's approval.

### R-9 — Historical rows cannot be repaired without broker evidence (⛔ owner evidence)

Rows written before v9.4/v9.5 carry a folded `profit` and no cost components. Their
commission and swap are **not recoverable from the database** — only from the broker's
own deal report. Guessing them, or writing zero, is explicitly forbidden. They must
remain `GROSS_ONLY` forever unless the owner supplies deal history.

---

## 5. Impact on the analytics surfaces

| Surface | Population used | Consistent with RECENT TRADES? |
|---|---|---|
| Dashboard win rate / PF / expectancy | `NET_CONFIRMED` (gross fallback only when no net rows) — `analytics-metrics.mjs:120-145` | ✅ same rows, stricter rule |
| Dashboard equity curve | one population only — `scopedEquityCurve` | ✅ |
| Dashboard "today P&L" | `isGenuineExecution` + local day + per-row `net_realised_pnl ?? pl_usd` | ⚠️ **different rule** |
| Journal | `lib/journal-stats.mjs:96-97` scoped buckets | ✅ |
| `/api/orders` risk limits | `closedExecutions` + `sumKnownPL` — `orders/route.ts:61-64` | ✅ |
| Production integrity | `partitionTrades` counts | ✅ |

**One genuine inconsistency found:** `todayPL` selects `net_realised_pnl` **per row**
(`plKey` at `:76`) whenever any net row exists, so it mixes a net figure for one row
with a gross figure for the next. That is a *third* population rule and must be
replaced by a scoped day figure.

---

## 6. Defect → fix traceability matrix

| ID | Defect | Severity | Fix required | Production evidence needed |
|---|---|---|---|---|
| R-1 | Close cannot set `broker_ticket`; genuine trades classify as `SIMULATION` and vanish | **Critical** | RPC close branch persists a validated payload ticket | count of `result IN ('WIN','LOSS','CLOSED') AND pl_usd IS NOT NULL AND broker_ticket IS NULL` |
| R-2 | Price-proximity matching can attribute P&L to the wrong position | **High** | Ticket-first matching; price predicate retained as fallback | any same pair+direction+entry-time cluster in `trades` |
| R-3 | `closed_at` = server receive time; broker close time discarded | **High** | Persist validated `closedAt` | rows whose `closed_at` postdates the broker deal report |
| R-4 | Provisional gross direction displayed as settled WIN/LOSS | Medium | Display-only: `RESULT PENDING` + qualified gross | count of `GROSS_ONLY` rows |
| R-5 | Truncated/mis-ordered table; six columns; local-day P&L | Medium | API ordering + pagination + full row renderer + UTC day | `truncated` flag on the production row count |
| R-6 | Hidden rows unexplained; disclosure computed but never rendered | Medium | Render disclosure + hidden-reason note | `describeScope` output |
| R-7 | Two implementations of the v2 contract; one unused | Low | **Owner decision** (wire or retire) | none |
| R-8 | Deal-level fields have no columns | Medium | **Prepared migration only** | none |
| R-9 | Pre-v9.4 rows lack cost components | — | **Owner evidence only** (broker deal report) | count of `commission IS NULL` |

---

## 7. What must NOT be done

- Do not UPDATE `result` / `pl_usd` / `closed_at` on historical rows to make the table
  look complete.
- Do not write `0` for an unknown commission, swap or fee.
- Do not convert `ACCOUNTING_PENDING` rows to `CLOSED` with invented numbers.
- Do not widen `isGenuineExecution()` so ticket-less rows count — that would
  re-contaminate every metric with simulated rows.
- Do not change lot sizing, SL/TP, break-even, partial-close or trailing rules.

---

## 8. Reproducing every claim in this document

```bash
# §1 live path
grep -n 'SYNC_URL' public/SybexForexAI_EA_v9.5.mq5
grep -n '\.rpc(' app/api/mt5-sync/route.ts

# §2 stage 3, §4 R-1..R-4
sed -n '300,367p;369,458p' supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql

# §4 R-7
grep -rn 'broker-deal-ingest' --include='*.ts' --include='*.mjs' app lib workers

# §2 stages 6-8
sed -n '70,84p' app/api/trades/route.ts
sed -n '160,175p' hooks/useForex.ts
sed -n '70,82p;305,372p' components/pages/DashboardPage.tsx

# §2 stage 2
sed -n '380,413p' public/SybexForexAI_EA_v9.5.mq5
```
