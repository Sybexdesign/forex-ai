# SYBEX FOREX AI — FULL PRODUCTION AUDIT, MIGRATION VERIFICATION & END-TO-END INTEGRITY REVIEW

**Audit window:** 2026-11-13 ~08:30–09:00 UTC
**Auditor role:** independent verification (read-only; no production change made)
**Target:** https://forex.sybexdesigns.co.uk
**Repository:** `/Users/user/Desktop/forex-ai` (branch `main`)

## 0. Method and evidence rules

| Evidence class | How obtained |
|---|---|
| Live HTTP | `curl` against production (unauthenticated, read-only) |
| Live database | Supabase REST (PostgREST) reads with the publishable key, scoped `select` only — no writes, no RPC calls |
| Deployed code identity | byte-level comparison of served JS chunks vs a local build of HEAD |
| Code under review | files in the repository at HEAD `6c89bfe` |
| Tests | run locally only (never against production) |

**Not available to this auditor** (reported as NOT VERIFIED rather than assumed):
Supabase SQL Editor / `psql` (so `pg_proc.prosrc`, `pg_trigger`, `pg_index` and the
`supabase_migrations` ledger are unreadable), Vercel dashboard + env vars, VPS SSH/PM2, the MT5 terminal
journal, and the broker's own deal history.

**Safety:** no order placed, no EA deployed, no migration applied, no row written, no strategy, risk,
threshold or Trade Authority setting touched, `ORDER_AUTHORITY_ENFORCE` untouched. Local side effects were
build artefacts only (`.next/`, and `next-env.d.ts` which was restored).

---

## A. Executive Summary

**Verdict: PARTIALLY OPERATIONAL — REMEDIATION REQUIRED.**
(The financial accounting pipeline is additionally **implemented but NOT end-to-end verified**.)

The platform is alive and honest about most of its gaps, but it is **not yet financially trustworthy**,
for four independent reasons — each proven below:

1. **No net P&L has ever been produced.** Across all 1,284 trade rows, `commission`, `swap`,
   `other_fees`, `net_realised_pnl` and `accounting_complete` are **NULL on every single row** (0
   exceptions). The integrity endpoint itself reports `commission_swap = FAILED` with
   `withCompleteNetPnl: 0 / 98`. Net profitability is unverified, not merely unrounded.
2. **The 10-minute reconciliation scheduler does not run.** The VPS worker aborts the refresh each cycle
   because `CRON_SECRET` is **not set on the worker**; `worker_logs` holds 36 `BLOCKED` warnings, latest
   `2026-11-13T08:07:25Z`. The only refresh that happens is the **daily 04:00 UTC Vercel cron**
   (`outcome_reconciliation.updated_at` pinned to `2026-11-13T04:00:21`). Effective cadence 24 h, not 10 min.
3. **The Dashboard under-reports and mis-signs realised P&L.** `classifyTrade()` returns `OPEN` whenever the
   legacy `trade_status` column says `OPEN`, even for rows carrying `result=WIN/LOSS`, a `closed_at` and a
   realised `pl_usd`. In the 120-day window this hides **14 genuine MT5 closes worth +298.79** while showing
   **−23.86**; the reported figure is wrong in magnitude *and sign* (genuine population **+274.93 over 28
   trades** vs displayed **−23.86 over 14**).
4. **Order-authority evidence does not exist for a single submission.** `submission_source`, `request_id`,
   `authority_decision`, `authority_reason`, `authority_policy_version`, `submitted_by`, `submitted_at` are
   NULL on all 1,284 rows. The endpoint correctly reports `INSUFFICIENT_DATA`.

Healthy and verified: deployed code is exactly HEAD; EA→Supabase ingestion is live (payload 3.4 s old at
sample time); **zero duplicate broker tickets**; the RPC's legacy close path works (`trade_status='CLOSED'`
written for every close since 2026-09-24); `tsc`, `test:phase42` and `next build` all pass; reconciliation
authentication is genuinely hardened (timing-safe, no forgeable `x-vercel-cron` bypass); gross/net
population separation is conservative by construction.

Production integrity endpoint `overallStatus`: **FAILED** (1 FAILED, 4 WARNING/INCOMPLETE, 1 INSUFFICIENT_DATA).

## B. Deployment Verification

| Component | Expected version | Actual version | Verified? |
|---|---|---|---|
| Web application | latest Phase 4.2 (HEAD) | `6c89bfe`, build `zqqB2fjnCpMtAZ2E7ZnSL`, deployment `dpl_Y5duBGQFc8xKmPzEjPHS9dMGURvq` | **VERIFIED** (chunk md5) |
| API routes | latest Phase 4.2 (HEAD) | same deployment; `/api/production-integrity` serving 4.2E sections | **VERIFIED** (behavioural) |
| Supabase migrations | Phase 4.1 + 4.2 | 4.1 columns present 17/17; 4.2 function present and callable, body version unproven | **PARTIAL** |
| VPS worker | latest worker code | current (worker code identical `c90f672`→`6c89bfe`; runtime shows 4.2E recon logic) | **VERIFIED** |
| MT5 Expert Advisor | v9.4 | **unknown / almost certainly v9.3.1** — no v2 payload has ever arrived | **NOT VERIFIED** (strong negative indication) |
| Broker accounting RPC | Phase 4.2 body | function exists; v2 accounting branch never executed | **NOT VERIFIED** |
| Reconciliation scheduler | 10-minute worker cycle | **not running** (blocked on missing worker `CRON_SECRET`); only the daily 04:00 cron | **VERIFIED FAILURE** |

### B.1 Git state

```
branch              main
HEAD                6c89bfe266e5700cf8784c2eabcdb18da7ef6a94   2026-11-13 00:01:22 +0000
origin/main         6c89bfe266e5700cf8784c2eabcdb18da7ef6a94
ahead/behind        0 / 0
working tree        clean
```

```
6c89bfe  fix(analytics): make the Journal read the same scoped populations as the Dashboard
c90f672  fix(accounting): capture broker deal costs end-to-end, scope analytics populations,
         move reconciliation onto a scheduler that exists        <-- commit named in the brief
9b5f92b  fix(integrity): order authority, close accounting, lineage, real-fill risk, UK-time evidence
```

### B.2 Is production really running the expected commit?

The brief asked whether production runs `c90f672`. It runs the **next commit**, `6c89bfe`, proven by content
hashing rather than assumption:

```
local BUILD_ID                                   = zqqB2fjnCpMtAZ2E7ZnSL
served /                                         = HTTP 200, data-dpl-id="dpl_Y5duBGQFc8xKmPzEjPHS9dMGURvq"
served   /_next/static/chunks/1683bx2og-ppu.js   md5 = c38e8f925a39c4242c9fe7fe4af2187d
local    .next/static/chunks/1683bx2og-ppu.js    md5 = c38e8f925a39c4242c9fe7fe4af2187d   (identical)
```

`6c89bfe` changed only `JournalPage.tsx`, `lib/journal-stats.*`, `package.json` and tests, and the Journal
page is **unmounted** (`components/AppShell.tsx:9` and `:455` are commented out). So `c90f672` and
`6c89bfe` are behaviourally indistinguishable live, and the chunk hash proves the deployed bundle was built
from this exact tree. **No drift between repository and production.**

Availability: `/` = 200, `/api/production-integrity` = 200 (cache MISS, dynamic). Vercel build logs are not
readable without dashboard access → the deployment *identity* is verified, the *build log* is not.

### B.3 VPS worker liveness and version

```
worker_logs newest row          2026-11-13T08:32:35Z   (info) scalp-shadow: health → OBSERVER_RUNNING
sweep cadence                   ▶ Sweep #3048 · London · 908 checks · 5 alerts  (every ~30 s)
broker_configs.updated_at       2026-11-13T08:32:54Z   => EA→Supabase ingest age 3.4 s
```

The presence of the 4.2E scheduler code path (10-minute attempt constant, 30-minute stale-alert cooldown,
the exact warning text introduced in `c90f672`) proves the running worker is at least `c90f672`; since
`workers/` did not change between `c90f672` and `6c89bfe`, the worker is **version-current**. The process
manager (PM2/systemd) and restart history are NOT VERIFIED (no SSH).

---

## C. Database Migration Verification

Migration history (`supabase_migrations` ledger) is **not readable** from outside Supabase without SQL
access. Everything below was therefore verified against *observable database behaviour*, not filenames.

### C.1 Phase 4.1 — `20261112_phase41_order_authority_and_accounting.sql`

**Object existence: VERIFIED.** The migration adds exactly 17 columns; PostgREST introspection confirms all
17 exist and are queryable with the declared types:

| Group | Columns | Evidence |
|---|---|---|
| Order authority (7) | `submission_source` TEXT, `submitted_by` UUID, `request_id` TEXT, `authority_decision` TEXT, `authority_reason` TEXT, `authority_policy_version` TEXT, `submitted_at` TIMESTAMPTZ | `GET /trades?select=submission_source,...` → 200 |
| Accounting (4) | `net_realised_pnl` NUMERIC(14,2), `other_fees` NUMERIC(14,2), `accounting_complete` BOOLEAN, `accounting_missing` TEXT[] | `select` → 200; `accounting_missing` returns an array type |
| Real-fill risk (6) | `initial_entry_price`, `initial_sl_price`, `requested_entry_price`, `requested_sl_price` NUMERIC(18,6); `risk_calc_version` TEXT; `instrument_spec` JSONB | `select` → 200 |

Evidence query (read-only):

```sql
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='trades'
   AND column_name IN ('submission_source','submitted_by','request_id','authority_decision',
                       'authority_reason','authority_policy_version','submitted_at',
                       'net_realised_pnl','other_fees','accounting_complete','accounting_missing',
                       'initial_entry_price','initial_sl_price','requested_entry_price',
                       'requested_sl_price','risk_calc_version','instrument_spec');
-- expected 17 rows; equivalent verified via PostgREST: all 17 selectable, 0 errors
```

**Indexes / triggers / trigger functions / constraints: NOT VERIFIED.** These live in `pg_index`,
`pg_trigger` and `pg_proc` and cannot be read with the publishable key. Their *effects* are also
unobservable today because **no trade row has been written since the migration** (last trade:
`2026-11-12T02:36:05Z`; last account payload: seconds old, but the EA only writes `broker_configs` when
nothing closed). Consequence: "the trigger populates accounting fields for new submissions" is
**UNPROVEN** — there is not one row in production that proves the trigger fired.

**Historical records intact: VERIFIED.** 1,284 rows persist with their original spread across
`result` (WIN 60+ / LOSS / CLOSED / CANCELLED) and no NULL-out of pre-existing `opened_at`
(0 of 1,284 rows have `opened_at IS NULL`). No evidence of backfill or rewrite.

> Note: `commission` and `swap` are **not** in the 4.1 `ADD COLUMN` list — they pre-date it. Also note
> `lib/analytics-scope.mjs:125` reads `trade.accounting_status`, **a column that does not exist** in the
> deployed schema (a `select` on it returns HTTP 400). That error branch is therefore dead code; the
> `accounting_missing` route is the only live error signal. (See defect M-3.)

### C.2 Phase 4.2 — `20261113_phase42_rpc_broker_deal_accounting.sql`

| Claim to verify | Result | Evidence |
|---|---|---|
| Updated `public.mt5_webhook_sync` exists | **VERIFIED (existence)** | The function is invocable: the EA posts to it every second and `broker_configs` updates within 3.4 s — an absent function would 404 and stop ingestion |
| Deployed body == Phase 4.2 implementation | **NOT VERIFIED** | Requires `SELECT prosrc FROM pg_proc WHERE proname='mt5_webhook_sync'`. No SQL access |
| Accepts payload version 2 | **NOT VERIFIED** | No v2 payload has ever been posted (see C.3) |
| Reads `grossProfit`/`commission`/`swap`/`fee`/`netProfit`/`dealCount`/`dealTickets`/`volumeClosed`/`partial` | **NOT VERIFIED at runtime** | Source (lines 377–441) does parse all of these; no production row demonstrates it |
| Backward compatible with v9.3.1 | **VERIFIED (behaviourally)** | Every close since 4.2 still ingests correctly: `trade_status='CLOSED'`, `pl_usd` set, `result` WIN/LOSS — v1 payloads keep working |
| Costs only when payload version supports them | **VERIFIED (source) / consistent (data)** | `v_payload_version >= 2` gate at line 410; production shows NULL costs, never invented zeros |
| Idempotency guard | **VERIFIED (source)** | Close-path `UPDATE … WHERE … AND pl_usd IS NULL`; and **0 duplicate broker tickets** among 141 ticket-bearing rows |
| Historical rows not silently rewritten | **VERIFIED (data)** | `trade_status='CLOSED'` appears for the first time at `2026-09-24T10:35:05Z` and is present on every close after; nothing older was retro-patched (`trade_status='OPEN'` remains on 127 legacy rows) |
| Permissions/grants | **NOT VERIFIED** | Needs `\df+` / `information_schema.routine_privileges` |

### C.3 The strongest available proof of *which* RPC body is deployed

The 20261004 lineage added `trade_status = 'CLOSED'` to the rich close path. Production shows a clean
cut-over:

```
trade_status='CLOSED'   earliest 2026-09-24T10:35:05Z   14 rows, all with numeric MT5 tickets
trade_status='OPEN'     newest realised close 2026-09-23T15:42:46Z   (84 legacy rows)
```

So the deployed function **contains the 20261004 body at minimum** — the 4.x close-accounting lineage is
live. It cannot be shown to contain the **20261113 v2 accounting branch**, because that branch is only
reachable from a v2 payload and none has ever arrived. The 4.2 RPC is therefore *installed and
backward-compatible*, and its new behaviour is **untested in production**.

---

## D. MT5 Integration

### D.1 The real execution path (confirmed)

```
MT5 terminal (Exness/Fusion, account *-Live)
  └─ EA posts JSON to Supabase RPC  public.mt5_webhook_sync   (p_token + p_payload)
       └─ trades / broker_configs rows
            └─ accounting triggers (4.1)  →  outcome_reconciliation (daily cron)
                 └─ analytics scope (4.2C)  →  Dashboard / integrity endpoint
```

`/api/mt5-sync` is **not** the ingestion route (confirmed by the absence of any EA-side HTTP call to it and
by the RPC-shaped payload the server accepts). No OANDA live path is active: `broker_configs` holds
`server = FusionMarkets-Live` for the active user.

### D.2 EA version: is it v9.4?

| Probe | Result |
|---|---|
| Newest ingested payload | `2026-11-13T08:32:54Z` (3.4 s before sampling) → EA is running and posting |
| `executionPayloadVersion` ever seen | **never 2** — every trade row has `execution_contract_version = 'execution_v1'` |
| `broker_configs.config.eaVersion` | **absent** — the config blob has 14 keys and no `eaVersion`, so the EA build cannot be identified from stored state |
| Cost fields ever populated | `commission`/`swap`/`other_fees`/`net_realised_pnl` are **NULL on 1,284/1,284 rows** |
| Terminal journal | inaccessible |

**Conclusion: NOT VERIFIED, with a strong negative indication that the terminal is still on v9.3.1.** A v9.4
EA emits `executionPayloadVersion:2` and `eaVersion:"9.40"` in *every* payload
(`public/SybexForexAI_EA_v9.4.mq5:846-849`) which would populate costs on the next close. The last close
(`2026-11-12T02:36:05Z`) carries no costs at all — but that close predates the v9.4 file being written
(`2026-11-12 23:00`), and **no position has closed since**, so the EA version is genuinely unobservable
right now rather than proven old. What *is* certain: **as of today production has never ingested a v2
payload, so net accounting has never run.**

Required to settle this: the MT5 terminal `Experts` journal lines at EA init (`EA v9.4 …`), or
`broker_configs.config` gaining an `eaVersion` field on the next payload.

### D.3 `AggregatePositionDeals()` — deal completeness

Source review (v9.4, lines ~190–240): it re-selects deal history inside the function with a bounded
lookback, iterates **all** deals for the position, and accumulates:

```
agg.gross/commission/swap/fee/volEntry/volClosed/dealCount/exitDeals/lastClose/lastTime
agg.ok      = (dealCount > 0 && exitDeals > 0)
agg.partial = (volEntry > 0 && volClosed > 0 && volClosed < volEntry - 1e-8)
```

* partial exits are **aggregated, not dropped** (the v9.3.1 `break`-on-first-`DEAL_ENTRY_OUT` defect is
  fixed);
* `partial` is derived from volumes, so a partial close is labelled rather than guessed;
* on failure it **does not fabricate**: `BuildClosedPositionsJSON()` logs
  `"[acct] no deal history … retrying next sync rather than reporting a guess"` and `continue`s;
* deals are attributed by `POSITION_ID`, so reversal/close-by legs on the same ticket are included;
* `netProfit` is computed EA-side as `gross + commission + swap + fee` (line 290) and the server
  **recomputes** it independently — the client number is advisory only.

Judgement: **implementation correct, behaviour NOT VERIFIED in production** (no v2 payload has exercised it).

### D.4 The restart-recovery defect — still present in v9.4

```mql5
// public/SybexForexAI_EA_v9.4.mq5:244
string BuildClosedPositionsJSON()
{
   if(g_prevPosCount == 0) return "[]";          // line 246  <-- defect #1 (present)
   ...
   for(int i = 0; i < g_prevPosCount; i++)       // line 260  <-- defect #2 (present, deeper)
   {
      // Still open?  -> compare against PositionsTotal() snapshot
      if(stillOpen) continue;
      ...
   }
}
```

Two distinct problems, and deleting line 246 fixes only the cosmetic one:

1. **Line 246** early-returns when the previous snapshot was empty. Harmless on its own (an empty snapshot
   yields an empty loop), but it hides the real issue.
2. **Line 260 (the real defect).** The candidate set is *only* `g_prevPos[]` — the snapshot taken by the
   previous `RefreshPrevPositions()` call. After a restart/recompile/VPS reboot, `g_prevPos` is rebuilt from
   **currently open positions only** (`g_prevPosCount = 0` at init, then repopulated from
   `PositionsTotal()`). Any position that closed **while the EA was not running** is therefore absent from
   both the open set and the snapshot, so it can never be enumerated — no matter what line 246 does.
   The comment at lines 255–256 ("a slow sync or an EA restart cannot silently miss a close") is **false
   as written**.

**Production corroboration:** 487 rows are `result='CLOSED'` with no financial value
(integrity endpoint `accounting_errors.legacyClosed = 487`), and 32 of the 240 rows in the analytics window
are `result='CLOSED'` with `pl_usd IS NULL`. That is the exact signature a restart gap produces: the
position vanished from the terminal without a close event ever being reported.

**Proposed repair (NOT deployed — requires EA redeploy + terminal restart, needs approval):** add an
`RecoverOfflineCloses()` step in `OnInit()` that (a) `HistorySelect(now - LookbackSeconds, now)`,
(b) groups `DEAL_ENTRY_OUT`/`DEAL_ENTRY_INOUT` deals by `DEAL_POSITION_ID`, (c) keeps those whose position id
is not in the current open set, (d) emits them through the *same* `AggregatePositionDeals()` path so gross /
commission / swap / fee are computed identically, and (e) de-duplicates against a persisted
`GlobalVariable` set of already-reported position ids so a double restart cannot double-report. The
server-side `UPDATE … AND pl_usd IS NULL` guard already prevents double *accounting*, but the EA must not
re-emit either.

---

## E. Broker Accounting

### E.1 The model as implemented

`Net P&L = Gross + Commission + Swap + Other fees`, with the broker's signed values preserved
(`commission`, `swap`, `fee` written through untouched, never `abs()`-ed), and *net computable only when the
payload proves it*:

```sql
-- supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql:409-415
v_cp_net := CASE
  WHEN v_payload_version >= 2
    AND v_cp_commission IS NOT NULL
    AND v_cp_swap IS NOT NULL
  THEN ROUND(v_cp_gross + v_cp_commission + v_cp_swap + COALESCE(v_cp_fee, 0), 2)
  ELSE NULL
END;
```

```sql
-- :424-441
UPDATE trades
   SET result = CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0 THEN 'WIN' ELSE 'LOSS' END,
       pl_usd = v_cp_profit,                 -- ALWAYS gross, never the net
       commission = v_cp_commission,         -- NULL on a v1 payload
       swap       = v_cp_swap,               -- NULL on a v1 payload
       other_fees = v_cp_fee,
       trade_status = 'CLOSED',
       realised_r = COALESCE(v_cp_net, v_cp_profit) / NULLIF(planned_risk_amount, 0)
 WHERE … AND pl_usd IS NULL;                 -- idempotency
```

Status mapping is enforced downstream by `lib/analytics-scope.mjs`:

| Status | Condition (code) | Enters net metrics? |
|---|---|---|
| `NET_CONFIRMED` | `accounting_complete === true` AND `net_realised_pnl !== null` | yes |
| `GROSS_ONLY` | genuine + money present, costs unproven | no (provisional direction only) |
| `ACCOUNTING_PENDING` | genuine, `pl_usd` and `net_realised_pnl` both NULL | no |
| `ACCOUNTING_ERROR` | `accounting_missing` contains `error`/`invalid` | no |

This is exactly the behaviour the brief demands (8/9/10), and it is **verified in code and in the
integrity endpoint's own numbers**.

### E.2 Verification against genuine production records

```
GET /trades?select=…&broker_ticket=not.is.null&closed_at=not.is.null&order=closed_at.desc
```

| Broker ticket | Pair | Gross P&L | Commission | Swap | Fees | Net P&L | Accounting status | Broker matched? |
|---|---|---:|---:|---:|---:|---:|---|---|
| `345***05` | XAU/USD | +3,368.50 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO — no cost data ever received |
| `345***53` | XAU/USD | −175.50 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO |
| `344***15` | XAU/USD | +170.50 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO |
| `343***39` | XAU/USD | −25.00 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO |
| `343***78` | XAU/USD | +306.50 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO |
| `343***10` | XAU/USD | +38.00 | NULL | NULL | NULL | NULL | `GROSS_ONLY` | NO |

Tickets are masked (first 3 / last 2 digits); account identifiers are omitted.

Population totals across the **whole table**:

```
rows                          1,284
rows with commission IS NOT NULL        0
rows with swap       IS NOT NULL        0
rows with other_fees IS NOT NULL        0
rows with net_realised_pnl IS NOT NULL  0
rows with accounting_complete IS NOT NULL  0
trade rows created after 2026-11-12T02:36Z  0   (nothing to prove the trigger with)
```

### E.3 Point-by-point answers

| # | Question | Answer |
|---|---|---|
| 1 | v9.4 gross from all applicable closing deals | **Implemented** (`AggregatePositionDeals` sums every deal), **not exercised** |
| 2 | Partial close profits aggregated | **Yes in code**, `partial` flag derived from volumes; not exercised |
| 3 | Commission captured accurately | **No** — never captured (0 rows) |
| 4 | Swap captured accurately | **No** — never captured (0 rows) |
| 5 | Other fees captured | **No** — never captured (0 rows) |
| 6 | Net matches broker's final result | **Not verifiable** — no net exists and the broker's deal history is not accessible here |
| 7 | Duplicate payloads safe | **Yes** — `pl_usd IS NULL` guard + 0 duplicate tickets |
| 8 | Incomplete never presented as complete net | **Yes** — `NET_CONFIRMED` requires `accounting_complete=true`; dashboard net metric is `null` (`netMetricAvailable: 0`) |
| 9 | Missing cost never silently zero | **Yes** — `NULLIF(...)` → NULL, and `net` stays NULL; no `COALESCE(cost,0)` anywhere on commission/swap |
| 10 | Historical incomplete records remain identified | **Yes** — 98/98 genuine in-window rows are `GROSS_ONLY`, 487 `legacyClosed` flagged |

**Accounting pipeline status: implemented, internally consistent, conservative — and NOT YET
END-TO-END VERIFIED.** The single fact that would change this is one v9.4 close with non-null
commission/swap.

---

## F. Order Authority

### F.1 What the code does

`app/api/orders/route.ts` computes an authority verdict for every request:

```ts
// :128
if (authority.blocking && process.env.ORDER_AUTHORITY_ENFORCE === 'true') { … reject … }
```

Enforcement is therefore **opt-in and default-off** (strict equality with the string `'true'`). The trade
row is written with the authority evidence fields (`submission_source`, `request_id`,
`authority_decision`, `authority_reason`, `authority_policy_version`, `submitted_by`, `submitted_at`).

### F.2 What production contains

```
rows                                                      1,284
rows with submission_source   IS NOT NULL                     0
rows with authority_decision  IS NOT NULL                     0
rows with request_id          IS NOT NULL                     0
```

Integrity endpoint:

```
order_authority  INSUFFICIENT_DATA  {sampledWithAuthority: 0, approvedAutomated: 0,
                                     approvedManual: 0, rejected: 0,
                                     workerLane: 0, uiScalpLane: 0}
lineage          INCOMPLETE         {totalRows: 1284, withExecutionSource: 141}
```

`trade_authority_decisions` holds **63,123** rows, but it is a *scoring/decision snapshot* table
(`agreement_score, ai_probability, decision_reasons, expectancy_r, mode, regime, safety_score, session,
setup_id, signal_score, status, …`) — **not** an order-submission audit log, and it cannot substitute for
per-trade authority evidence.

### F.3 Assessment

* No submission source is recorded for any trade, from either lane. Browser scalp-card submissions and
  worker auto-trade submissions are **indistinguishable** in the data.
* `ORDER_AUTHORITY_ENFORCE`: code default is off; the **production value is NOT VERIFIED** (Vercel env not
  readable here). Nothing in the data suggests enforcement is on.
* Therefore: **order authority is implemented but not evidenced**, and must not be described as validated.

---

## G. Reconciliation and Scheduling

### G.1 The scheduler that actually exists

`workers/scalper.mjs` (4.2E) attempts the refresh every 10 minutes:

```js
const RECON_REFRESH_MS    = 10 * 60_000   // match the cadence the cron could not
const RECON_STALE_WARN_MS = 30 * 60_000   // 3 missed ticks before shouting
…
const secret = process.env.CRON_SECRET
if (!secret) { wlog('warn', 'Outcome reconciliation refresh BLOCKED: CRON_SECRET not set on the worker', …); return }
```

### G.2 Production evidence — the refresh is BLOCKED

```
worker_logs (message ilike '%reconcil%'): 36 rows, latest first
  2026-11-13T08:07:25Z  warn  Outcome reconciliation refresh BLOCKED: CRON_SECRET not set on the worker
  2026-11-13T07:37:24Z  warn  (same)
  2026-11-13T07:07:15Z  warn  (same)
  2026-11-13T06:36:57Z  warn  (same)
  … every ~30 min (10-min attempt, capped by the 30-min alert cooldown)

outcome_reconciliation.updated_at (newest 10 rows, identical):
  2026-11-13T04:00:21Z      <-- the DAILY Vercel cron, 04:00 UTC
```

| Question | Answer |
|---|---|
| Does the worker attempt every 10 min? | **Yes** — the attempt fires and is logged |
| Does the refresh succeed? | **No** — aborts on missing `CRON_SECRET` every cycle |
| What actually refreshes the data? | The **daily** Vercel cron at 04:00 UTC |
| Effective reconciliation interval | **24 hours**, not 10 minutes |
| Last successful refresh | `2026-11-13T04:00:21Z` → **4.4 h old** at 08:30 UTC |
| Is stale reconciliation detected? | **Yes** — worker logs `warn` + `tgSend`; nobody acted |
| Does the missing secret fail safe? | **Yes** — no forgeable fallback; ingestion and trading continue |

The endpoint's `scheduler_authentication` reports `{cronSecretConfigured: 1, workerSchedulerVerified: 0}` —
Vercel holds the secret, the **worker does not**. The endpoint cannot read the worker environment, which is
why those two numbers disagree.

### G.3 Authentication hardening (verified by code review)

`app/api/outcome-reconciliation/refresh/route.ts`:

* accepts `Authorization: Bearer`, `x-cron-secret`, or `?secret=` (query retained only as a documented manual fallback);
* **no** `x-vercel-cron` trust path remains — a forged header cannot authenticate;
* comparison is **timing-safe** (length check + constant-time XOR over the whole string);
* when `CRON_SECRET` is unset in production the request is **denied**;
* the response exposes `authMode`, so a rejection states why.

`vercel.json` keeps a single **daily** schedule, which is compatible with the deployed plan (a sub-daily
expression would silently never run — that was the original defect this design replaced).

### G.4 Duplicate protection

The refresh is a merge-upsert on `setup_key` with an unchanged-row filter, and the trade-close path is
guarded by `pl_usd IS NULL`. **0 duplicate broker tickets** among 141 ticket-bearing rows corroborates that
no duplicate ingestion has occurred.

---

## H. Analytics

### H.1 Architecture (verified)

* `lib/analytics-scope.mjs` — classification only (`classifyTrade`, `partitionTrades`);
* `lib/analytics-metrics.mjs` — arithmetic; refuses to put a non-net population into a net figure;
* `components/pages/DashboardPage.tsx` — uses `buildScopedAnalytics` (asserted by
  `tests/phase42-integrity-guards.test.mjs:138`);
* `components/pages/JournalPage.tsx` — uses `buildJournalStats` (same scope module) but is **unmounted**
  (`components/AppShell.tsx:9,455` commented out), so it is unreachable in the live UI;
* `/api/production-integrity` — same `buildScopedAnalytics`, 120-day window, 3,000-row cap.

### H.2 Live population, reproduced locally against the same 240 rows

```
{ NET_CONFIRMED: 0, GROSS_ONLY: 14, ACCOUNTING_PENDING: 0, ACCOUNTING_ERROR: 0,
  SIMULATION: 95, OPEN: 116, CANCELLED: 15 }            total 240
```

Breakdown (population × ticket format × gross):

| Population | n | numeric MT5 ticket | UUID-"ticket" | gross sum |
|---|---:|---:|---:|---:|
| `GROSS_ONLY` (with P&L) | 14 | 14 | 0 | **−23.86** |
| `OPEN` (with P&L) | 84 | **14** | 70 | −2,191.58 |
| `OPEN` (no P&L) | 32 | 2 | 30 | 0.00 |
| `CANCELLED` | 15 | 0 | 11 | 0.00 |
| `SIMULATION` (with P&L) | 3 | 0 | 0 | −2.17 |
| `SIMULATION` (no P&L) | 92 | 0 | 0 | 0.00 |

### H.3 Defect H-A: genuine closes classified as `OPEN` (HIGH)

`lib/analytics-scope.mjs:110`:

```js
if (rawResult === 'OPEN' || str(trade.trade_status).toUpperCase() === 'OPEN') {
  return { ...base, population: POPULATION.OPEN, reason: 'position_still_open' }
}
```

`trade_status` is a **stale legacy column** — only written from 2026-09-24 onwards. Every close before that
date still says `OPEN` even though `result`, `closed_at` and `pl_usd` prove it closed. The classifier trusts
the stale flag over the money.

Quantified on genuine (numeric-ticket) rows only:

```
excluded as "OPEN" but genuinely closed:  14 trades, gross +298.79   (2026-09-17 … 2026-09-23)
displayed as GROSS_ONLY:                  14 trades, gross  −23.86

correct genuine population:               28 trades, gross +274.93
displayed population:                     14 trades, gross  −23.86
```

**The dashboard's window P&L is wrong in both sign and magnitude, and the win-rate denominator is half its
true size.** The endpoint contradicts itself in the same response: `trade_accounting` reports
`genuineExecutions: 98` while `analytics_population` reports `grossOnly: 14`.

The defect is historical (all 14 excluded rows pre-date 2026-09-24; newer closes carry `trade_status='CLOSED'`),
but the 120-day window keeps them visible for ~3 more months, so it is a **current** reporting error.

### H.4 Defect H-B: non-ticket "broker tickets" inflate the genuine population (MEDIUM)

`broker_ticket` is populated on 141 rows, but only **30** hold a real MT5 ticket; **111** hold a UUID that is
identical to the row's `oanda_trade_id`. `isGenuineExecution()` tests only "ticket is non-null":

```
numeric MT5 tickets   30   (2026-09: 19, 2026-10: 2, 2026-11: 9)
UUID "tickets"       111   (2026-09: 109, 2026-10: 2, 2026-11: 0)
```

No UUID-ticket row exists after October, so this is a **legacy artefact, not a live bug** — but it is why
"141 genuine executions" overstates broker confirmation by ~4.7×, and why 70 Sept rows with P&L land in the
`OPEN` bucket. `broker_execution_coverage` (`ticketless: 1143/1284`) and `lineage`
(`withExecutionSource: 141`) read from the same weak predicate.

### H.5 What is correct in analytics

| Requirement | Status |
|---|---|
| Real executions separated from simulated | **Yes** — `SIMULATION` for no-ticket rows |
| Cancelled excluded from executed metrics | **Yes** — 15 rows in `CANCELLED` |
| Open excluded from closed performance | **Yes in principle** (but over-applied — H.3) |
| Unknown P&L never coerced to 0 | **Yes** in `lib/*`; **NO** in 4 legacy call sites (H.6) |
| Gross-only never labelled net | **Yes** — `contributesToNet: false`, net shown unavailable |
| Only `NET_CONFIRMED` enters net metrics | **Yes** — `netMetricAvailable: 0` |
| Empty population → null/unavailable | **Yes** |
| Profit factor with zero losses | **Yes** (`tests/analytics-scope.test.mjs`) |
| Simulation cannot inflate broker stats | **Yes** |
| No silent reclassification of history | **Yes** — no backfill found |
| London buckets / DST | **Yes** — `timezone_integrity: HEALTHY`, `ukOffsetNowMinutes: 0` (GMT in November) |
| Rankings suppressed below minimum sample | **Yes** (metrics module + tests) |

### H.6 Remaining inconsistent classification logic (not yet migrated)

| File | Line | Problem |
|---|---|---|
| `components/AppShell.tsx` | 157 | `todayPL = Σ (t.pl_usd \|\| 0)` → feeds `useScanner(…, {dailyLossOk})`, i.e. **order gating** |
| `components/AppShell.tsx` | 158-159 | `winRate = wins / trades.length` — denominator includes OPEN/CANCELLED/simulation |
| `app/api/orders/route.ts` | 275-276 | `todayPL`/`allTimePL` `\|\| 0` → prop-firm guards on the **order path** |
| `lib/propfirm.ts` | ~106 | `pl_usd \|\| 0` inside the prop-firm rule engine |
| `app/api/admin/users/route.ts` | 40 | `totalPL += pl_usd \|\| 0` (admin reporting) |
| `app/api/loss-diagnostics/route.ts` | 93 | `(row.pl_usd ?? 0) / …` |
| `components/pages/PropFirmPage.tsx` | 54-60 | `pl_usd \|\| 0` display maths |
| `components/pages/DashboardPage.tsx` | 333-334 | `t.pl_usd ?? 0` per-row P&L cell (display only) |

`DashboardPage`'s headline metrics are scoped, but the **order-gating** figure in `AppShell` is not: a row
with unknown P&L is counted as `0.00` when deciding whether today's loss limit is breached. A **risk-control
path still consumes unscoped data** (HIGH).

---

## I. Data Integrity

### I.1 Pipeline record counts

| Stage | Table / object | Rows | Linked to the next stage |
|---|---|---:|---|
| Broker deal history | MT5 terminal | n/a (inaccessible) | — |
| EA payload | `public.mt5_webhook_sync` | live, 3.4 s old | — |
| Ingestion | `broker_configs` | 2 configs | 1 active (`FusionMarkets-Live`, balance 12.36) |
| Trade executions | `trades` | 1,284 | 141 with any "ticket", 30 with a real MT5 ticket |
| Predictions | `prediction_logs` | 26,656 | `trades.prediction_log_id` set: **0** |
| Signals | `signal_reconciliation` | 125,364 | `trades.signal_id_ref` set: 430 |
| Setups | — | — | `trades.setup_id` set: **0** |
| Outcome reconciliation | `outcome_reconciliation` | 1,194 | `executionLinked`: **3** |
| Authority decisions | `trade_authority_decisions` | 63,123 | `trades.submission_source`: **0** |

### I.2 Defects found

| Check | Result | Evidence |
|---|---|---|
| Duplicate tickets | **PASS** | 141 ticket rows → 141 distinct values, 0 duplicates |
| Duplicate ingestion | **PASS** | `pl_usd IS NULL` guard; no repeat of any ticket |
| Orphaned rows | **FAIL (by design, flagged)** | 1,143 ticketless rows (89% of the table) — simulation/model data mixed into the same table as executions |
| Prediction → execution linkage | **FAIL** | 0 of 26,656 predictions and 0 of 1,284 trades carry `prediction_log_id`; `outcome_reconciliation.executionLinked = 3` of 1,194 |
| Setup linkage | **FAIL** | `trades.setup_id` is NULL on every row, so setup-level expectancy cannot be attributed |
| Signal linkage | **PARTIAL** | 430 of 1,284 trades carry `signal_id_ref` (string `scalp-<PAIR>-<epochms>`) |
| Close timestamps | **PASS** | 0 invalid timestamps (`timezone_integrity.invalidTimestamps = 0`); closes monotonic with `opened_at` |
| Broker evidence | **WEAK** | only 30 rows carry a real MT5 ticket (H.4) |
| Gross/net classification | **CONSERVATIVE** | 0 rows claim net; see E |
| Stale reconciliation | **FAIL** | 4.4 h old, refreshed by the daily cron only (G.2) |
| Inconsistent outcomes | **FLAGGED, not silently fixed** | 487 `result='CLOSED'` rows with no P&L (`legacyClosed`) |
| Missing records (restart gaps) | **SUSPECTED** | 32 in-window rows `CLOSED` with `pl_usd IS NULL` — consistent with the D.4 defect |

Matching rules were **not** loosened and no ambiguous relationship was invented. `executionLinked: 3` is the
correct conservative answer given the missing keys — the defect is the absent linkage, not the matching.

---

## J. Test Results

All commands run **locally** in `/Users/user/Desktop/forex-ai`. No production data touched, no order placed.

| Command | Exit | Result |
|---|---:|---|
| `npm run test:phase42` | **0** | 15 suites: `analytics-scope`, `broker-deal-ingest`, `journal-stats`, `phase42-integrity-guards`, `order-authority`, `trade-accounting`, `risk-from-fill`, `uk-time`, `execution-evidence`, `reconciliation-repair`, `phase41-migration`, `prediction-contract`, `outcome-reconciliation`, `execution-truth`, `reconcile-close-accounting` — all `all tests passed` |
| `npx tsc --noEmit` | **0** | no TypeScript errors |
| `npm run build` | **0** | `✓ Compiled successfully in 3.2s`; 54 routes emitted |

Production checks (read-only, live):

| Check | Result |
|---|---|
| `GET /` | 200, 7,364 bytes, `dpl_Y5duBGQFc8xKmPzEjPHS9dMGURvq` |
| Served chunk md5 vs local build | identical (`c38e8f92…`) |
| `GET /api/production-integrity` | 200, `overallStatus: FAILED`, `readOnly: true` |
| Worker liveness | `Sweep #3048` at 08:32:24Z |
| Ingestion freshness | 3.4 s |
| Reconciliation freshness | 4.4 h (daily cron) |

### J.1 Why the passing tests did not catch the defects

* `tests/phase41-migration.test.mjs` and `phase42-integrity-guards.test.mjs` assert **source text** (that a
  column or call appears in a file), not deployed database state. They pass whether or not the migration ran.
* `tests/analytics-scope.test.mjs` builds synthetic rows where `trade_status` and `result` agree, so the
  `OPEN` short-circuit at line 110 is never exercised against the *stale* combination that exists in
  production (result=WIN, trade_status=OPEN). **Missing test: the stale-status case.**
* Nothing asserts the *worker environment* — `CRON_SECRET` presence on the VPS is untested by design.
* Nothing asserts that a real MT5 ticket is numeric, so H.4 is invisible to the suite.

### J.2 Security observations

* `refresh` route: timing-safe, no header-trust fallback, denies when unconfigured — **good**.
* `/api/trades` is unauthenticated apart from `userId` in the query string (`?userId=<uuid>`), and uses the
  **service-role** client. Anyone who learns a user UUID can read that user's trades (`.limit(200)`).
  This is a pre-existing authorisation weakness, out of scope to fix here, but it should be recorded.
* No secret, token or account number appears in this report.

---

## K. Outstanding Defects

Ranked by severity. No fix has been applied.

### CRITICAL

**C-1 — No net P&L has ever been produced; the accounting branch has never executed.**
* *Evidence:* `commission`, `swap`, `other_fees`, `net_realised_pnl` NULL on 1,284/1,284 rows;
  `accounting_complete` NULL on all rows; integrity `commission_swap = FAILED` (`withCompleteNetPnl: 0/98`);
  every row is `execution_contract_version = 'execution_v1'`.
* *Component:* MT5 EA → `mt5_webhook_sync` → `trades`.
* *Impact:* **no profitability figure in the product is net of broker costs**; a break-even strategy appears
  profitable.
* *Correction:* deploy EA v9.4 (it already emits `executionPayloadVersion:2`), let one position close, and
  reconcile that row against the MT5 deal report.
* *Migration:* no (4.2 installed). *Deployment/EA restart:* **yes**.

**C-2 — The 10-minute reconciliation scheduler is blocked by a missing worker secret.**
* *Evidence:* 36 × `warn "Outcome reconciliation refresh BLOCKED: CRON_SECRET not set on the worker"`, latest
  `2026-11-13T08:07:25Z`; `outcome_reconciliation.updated_at` pinned at `2026-11-13T04:00:21Z` (daily cron);
  `scheduler_authentication.workerSchedulerVerified = 0`.
* *Component:* `workers/scalper.mjs` → `/api/outcome-reconciliation/refresh`.
* *Impact:* derived analytics can be 24 h stale; the platform advertises a 10-minute cycle it does not deliver.
* *Correction:* set `CRON_SECRET` in the worker environment to the Vercel value, restart the worker, confirm
  `workerSchedulerVerified = 1` and `updated_at` younger than 15 min.
* *Migration:* no. *Restart:* yes (worker only; no trading logic touched).
* *Note:* an **environment** defect, not a code defect — the code's fail-safe behaviour is correct.

### HIGH

**H-1 — Genuine closed trades classified as `OPEN`, corrupting reported P&L and win rate.**
* *Evidence:* `lib/analytics-scope.mjs:110`; 14 genuine MT5 closes (+298.79) hidden while 14 (−23.86) are shown;
  correct population 28 trades / +274.93; endpoint self-contradiction `98` vs `14`.
* *Impact:* dashboard P&L wrong in sign; win-rate denominator halved.
* *Correction:* prefer hard close evidence over the stale flag — treat a row as closed when
  `closed_at && (result==='WIN' || result==='LOSS')`, using `trade_status` only when no `result` exists. Add a
  regression test with `result=WIN, trade_status=OPEN`.
* *Migration:* no. *Restart:* no (web deploy only).

**H-2 — Order-gating loss limit consumes unscoped `pl_usd || 0` data.**
* *Evidence:* `components/AppShell.tsx:157` → `useScanner(…, {dailyLossOk})`; also
  `app/api/orders/route.ts:275-276` and `lib/propfirm.ts:~106`.
* *Impact:* unknown-P&L and cancelled rows count as `0.00` when evaluating the daily loss limit — a **risk
  control** that can under-count a real loss.
* *Correction:* route through `partitionTrades()` and sum only `contributesToGross` genuine rows; unknown must
  fail safe (block), never be treated as zero.
* *Migration:* no. *Restart:* no.

**H-3 — Order-authority evidence absent for every submission.**
* *Evidence:* 0/1,284 rows with `submission_source` / `authority_decision` / `request_id`.
* *Impact:* cannot prove who or what submitted any order, nor that the worker lane obeys the same policy as
  the UI.
* *Correction:* persist the authority object the route already computes; add a per-lane submission-source enum.
  Enforcement stays off.
* *Migration:* no (columns exist). *Restart:* no.

**H-4 — EA restart recovery can still miss closes entirely (D.4).**
* *Evidence:* `public/SybexForexAI_EA_v9.4.mq5:246` and, more seriously, `:260` — candidates come only from the
  previous snapshot; 487 `legacyClosed` rows with no P&L.
* *Impact:* trades that close while the EA is down are never reported; gross and costs lost permanently.
* *Correction:* `RecoverOfflineCloses()` on `OnInit()` scanning deal history by `DEAL_POSITION_ID`, with
  persisted de-duplication (D.4).
* *Migration:* no. *Deployment/EA restart:* **yes** (requires approval).

### MEDIUM

**M-1 — UUID values stored as `broker_ticket` inflate "genuine executions" (H.4).**
111 rows, all ≤ 2026-10. *Evidence:* 30 numeric vs 111 UUID `broker_ticket` values.
*Correction:* tighten `isGenuineExecution()` to a numeric MT5 ticket and use `execution_source` for non-MT5
brokers. *Migration:* no. *Restart:* no. Historical rows must be **labelled** as legacy, never rewritten.

**M-2 — `lineage` and `actual_risk` structurally incomplete.**
`prediction_log_id` and `setup_id` are NULL on 100% of trades, so prediction→execution and setup→execution
cannot be joined; `executionLinked: 3` of 1,194. *Correction:* write those keys at submission time where a
prediction provably exists; ambiguous rows stay unlinked (the existing conservative rule is correct).

**M-3 — Dead error branch: `trade.accounting_status` does not exist.**
`lib/analytics-scope.mjs:125` reads a non-existent column (HTTP 400 if selected); only `accounting_missing`
can raise `ACCOUNTING_ERROR`. *Correction:* drop the dead predicate or add the column later.

**M-4 — Analytics population silently truncated client-side.**
`app/api/trades/route.ts:22` `.limit(200)`; `AppShell` then computes `todayPL`/`winRate` from that slice, and
`AppShell.tsx:158-159` divides by `trades.length` (all statuses). *Correction:* fetch by window and use the
scoped metrics for any displayed ratio.

**M-5 — `/api/trades` authorises on a client-supplied `userId`.**
Service-role read scoped only by `?userId=` with no session check. *Correction:* derive the user from the
Supabase session server-side.

**M-6 — Integrity endpoint reports `reconciliation_refresh: HEALTHY` at 4.4 h against a 10-minute design.**
The threshold is too loose to catch C-2. *Correction:* fail beyond ~30 min — but only **after** C-2 is fixed,
or it merely turns red without improving anything.

### LOW

**L-1** `other_fees` is optional in the net formula (`COALESCE(v_cp_fee, 0)`), so a payload omitting `fee` is
treated as fee-free. Acceptable (MT5 reports `DEAL_FEE` as 0 when absent) but worth documenting.

**L-2** `result` is `WIN` at exactly `0.00` (`>= 0`) — intentional and tested, but a zero-profit close counts
as a win.

**L-3** `netProfit` is computed by the EA *and* recomputed server-side; the client value is unused (harmless).

**L-4** The Journal page is unmounted, so the 4.2D work (`lib/journal-stats.mjs`) has **zero** runtime reach.

---

## L. Recommended Remediation Plan

Ordered by dependency. **None of these were executed during this audit.**

| # | Action | Depends on | Risk | Expected impact |
|---|---|---|---|---|
| 1 | **Set `CRON_SECRET` on the VPS worker**, restart it | none | Low — env change + worker restart; no trading logic touched | Restores the 10-minute cycle; clears 36 warnings; `workerSchedulerVerified → 1` |
| 2 | **Fix `classifyTrade()` stale-status short-circuit** + regression test | none | Low — web deploy; classification only, no data rewritten | Window P&L correct in sign and size (+274.93 vs −23.86); win-rate denominator doubles to 28 |
| 3 | **Fix order-gating `pl_usd \|\| 0`** in `AppShell`, `/api/orders`, `lib/propfirm.ts` | #2 (share the scope module) | Medium — touches the order path; review so only the loss-limit maths changes | Loss limit stops treating unknown as zero; risk control becomes sound |
| 4 | **Persist order-authority fields** on submission (UI + worker lanes) | none | Low — additive write; enforcement stays off | `order_authority` moves from `INSUFFICIENT_DATA` to measurable |
| 5 | **Fix restart recovery** (`RecoverOfflineCloses()`), ship **inside** the v9.4 build | none | Medium — EA code change; test on demo | Closes missed during restarts are recovered |
| 6 | **Deploy EA v9.4 to the live terminal** | #5 | **High** — terminal change; explicit approval, off-market window, verified rollback to the running build | First `NET_COMPLETE` rows; net P&L becomes real |
| 7 | Tighten `isGenuineExecution()` to numeric tickets; label legacy UUID rows | #2 | Low | "Genuine executions" becomes 30 (true), not 141 |
| 8 | Backfill `setup_id` / `prediction_log_id` where a prediction provably exists | #4 | Low — additive, conservative | `executionLinked` rises from 3 |
| 9 | Fix `/api/trades` authorisation and the 200-row cap | none | Low | Closes a data-exposure gap; correct client populations |
| 10 | Tighten the `reconciliation_refresh` threshold **after** #1 | #1 | Low | Stale-data detection that actually fires |

**Ordering rationale.** #1 and #2 are cheap, reversible, and remove the two defects that make today's displayed
numbers wrong. #3 is the only fix touching a live control path, so it follows the analytics fix it depends on.
#6 must not precede #5, or v9.4 would ship with the restart gap still inside it.

**Every step needs its own approval.** Steps 1, 5 and 6 change production behaviour; step 6 additionally needs
the owner's explicit go-ahead for an EA deployment to a live account carrying **12.36** balance — a
low-balance live account, so a botched rollout is not merely a reporting problem.

---

## M. Final Verdict

### VERDICT: **PARTIALLY OPERATIONAL — REMEDIATION REQUIRED**

The deployed platform (`6c89bfe`) **runs**, ingests live MT5 data, keeps its accounting conservative, and
fails safe. It is **not** delivering net P&L, **not** running its advertised reconciliation cadence, and
**not** reporting correct P&L from the trades it already holds. Broker accounting is **implemented but not
end-to-end verified**.

### M.1 Answers to the required questions

**1. Is the deployed build the audited commit?**
**Yes.** Production HTML carries `dpl_Y5duBGQFc8xKmPzEjPHS9dMGURvq`; the served JS chunk md5 is byte-identical
to the chunk produced by a local build of `6c89bfe`; `origin/main` == `HEAD` == `6c89bfe`; working tree clean.

**2. Did Phase 4.1 implement the MT5 execution contract?**
**Yes, at the schema level.** All 17 columns exist and are queryable, and all 1,284 historical rows survived
with `opened_at` intact (no NULLs). **Not verified:** indexes, triggers and constraints — no direct SQL access
was available.

**3. Does Phase 4.2's net-accounting branch work?**
**Cannot be proven, and shows no evidence of ever having run.** The RPC exists and is callable; v1 backward
compatibility is proven by the `trade_status='CLOSED'` cut-over on 2026-09-24; **every** row is still
`execution_v1` and **0** rows have any of commission/swap/other_fees/net_realised_pnl/accounting_complete. The
v2 branch has never been exercised by real traffic, and the RPC body could not be read, so it is **NOT
VERIFIED**.

**4. Is broker accounting producing net P&L?**
**No.** 0 of 1,284 rows have complete broker costs; `commission_swap: FAILED`; `withCompleteNetPnl: 0`. Every
displayed figure is **gross-only** and is correctly labelled as such — but the product has no net number.

**5. Does the MT5 EA report every required field?**
**v9.4 the file does; the running EA does not.** Local `public/SybexForexAI_EA_v9.4.mq5` emits
`executionPayloadVersion:2` with commission/swap/fee. Production ingest shows only v1 payloads, so either v9.4
is not deployed or it has not had a position close since deployment. **Deployment state is NOT VERIFIED.**

**6. Is reconciliation running on schedule?**
**No.** The worker attempts every 10 minutes and is **blocked every time** by a missing `CRON_SECRET` (36
logged warnings). The only successful refresh is the **daily 04:00 UTC** Vercel cron — last run
`2026-11-13T04:00:21Z`, 4.4 h stale at audit time. Authentication itself is sound (timing-safe, no forged-header
path, denies when unconfigured).

**7. Are the analytics correct?**
**No — one HIGH defect makes the window P&L wrong in sign.** Genuine closes are hidden by a stale
`trade_status='OPEN'` short-circuit: 14 real closes worth **+298.79** are excluded while 14 worth **−23.86** are
shown. True population **28 trades / +274.93** vs displayed **14 / −23.86**. The endpoint contradicts itself in
a single response (`genuineExecutions: 98` vs `grossOnly: 14`). Everything else in the scope/metrics layer is
conservative and correct — including never labelling gross as net.

**8. Is order authority enforced?**
**Unknown, and unevidenced either way.** **0** of 1,284 rows carry any authority field, so no submission can be
attributed to a lane. The code's enforcement flag (`ORDER_AUTHORITY_ENFORCE`) defaults to **off**, and its
production value is not readable here. `trade_authority_decisions` (63,123 rows) is a decision-snapshot table
and cannot substitute.

**9. Is data integrity intact?**
**Partly.** No duplicate tickets and no duplicate ingestion (**PASS**). But **0** prediction→execution links,
**0** setup links, **0** authority links, only **3** of 1,194 outcome-reconciliation rows execution-linked, and
**487** closed rows with no P&L. 89% of the trades table is ticketless simulated/model data mixed into the
execution table.

**10. Do the tests prove the system works?**
**No — they prove the code compiles and the modules behave on synthetic input.** All 15 suites pass (exit 0),
`tsc --noEmit` passes (exit 0), `build` passes (exit 0). **This was all local.** The suites assert source text
and synthetic rows where `trade_status` and `result` agree, so they are structurally incapable of catching
H-1, C-2 or H-4. A green suite is **not** evidence of a correct production pipeline.

**11. Was any production change made during this audit?**
**No.** Every production interaction was a read: HTTP `GET`s to the public deployment and read-only queries via
the integrity/trades endpoints and local scripts. No migration was applied, no repository file was modified for
behaviour, no EA was touched, no order was placed, no environment variable was changed, and nothing was
deployed. The only file written is this report.

**12. Can this platform be described as production-ready?**
**No.** It is a working ingestion-and-display system with an honest, conservative analytics layer, but it has
(a) no net accounting ever produced, (b) a dead 10-minute scheduler, (c) a P&L sign error in the dashboard,
(d) unscoped data feeding a live risk control, (e) no order-authority evidence, and (f) no prediction/setup
lineage. It is **operational for monitoring and inert for decision-making**.

### M.2 What would change the verdict

The platform reaches **OPERATIONAL (gross)** once items #1 and #2 of the remediation plan land: a truthful
P&L sign, a live 10-minute reconciliation cadence, and `workerSchedulerVerified = 1`. It reaches
**OPERATIONAL (net)** only after #5/#6 put v9.4 on the terminal and at least one row becomes `NET_CONFIRMED`
with costs that reconcile to the broker's own deal report. Until then **no net figure should be quoted to
anyone**, and the loss-limit logic in the order path should be treated as advisory, not protective.

### M.3 Scope statement

This audit covered deployment identity, Phase 4.1/4.2 migration state, the MT5 EA contract and restart
behaviour, broker accounting coverage, reconciliation scheduling and authentication, analytics classification
and metrics, order authority, data integrity/lineage, local test gates, and read-only production health.

**Explicitly NOT verified:** the RPC function body, database indexes/triggers/constraints, Vercel and VPS
environment variables, the EA's actually-running build, MT5 deal history directly, and any broker-side
statement.

### M.4 One-line summary

> The platform ingests real trades correctly and refuses to lie about money it does not have — but it has never
> computed a net figure, its 10-minute reconciliation is dead on a missing secret, and its dashboard hides half
> of its own genuine trades behind a stale status flag.

*Report ends. No production change was made.*











