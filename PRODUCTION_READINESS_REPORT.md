# PRODUCTION READINESS REPORT — PHASE 4.2.1 (Recent Trades + Trading Hours)

**Date:** 2026-12-11
**Code commit:** `19c49ef` — *Phase 4.2.1: enforce saved trading hours; make Recent
Trades accounting-complete*
**Parent:** `00cd0ab` (SEC-1)
**Remote:** `main` is **4 ahead / 0 behind** `origin/main`; **not pushed**
**This report:** added in a docs-only commit immediately after `19c49ef`

---

## 1. Verdict, in the brief's four categories

| Category | Content |
|---|---|
| **IMPLEMENTED AND TESTED LOCALLY** | Trading-hours gate at all five stages; server-evaluated status endpoint; Recent Trades row contract, table, ordering and UTC day total; two new test suites wired into `test:phase42` |
| **PREPARED BUT NOT APPLIED** | `supabase/prepared/20261211_phase421_close_identity.sql` (R-1/R-2/R-3); `supabase/prepared/20261114_phase421_partial_close_proof.sql` (pre-existing, deal evidence) |
| **VERIFIED AGAINST PRODUCTION** | **Nothing.** Production was not queried, deployed to, or restarted. No EA installed. No order submitted. |
| **BLOCKED — OWNER ACTION REQUIRED** | Migration approval; EA v9.5 compile/deploy; broker evidence for pre-v9.4 rows; one genuine close to prove the chain; `git push` |

**Do not read this report as "production ready".** The accounting path is correct in
code and unproven in production, and the two most consequential database fixes are
unapplied by design.

---

## 2. Repository state

```
branch            main
HEAD              19c49ef
origin/main       6c89bfe (4 commits behind local)
working tree      clean, except two untracked documents from earlier sessions:
                  SYBEX_FOREX_AI_FULL_PRODUCTION_AUDIT.md
                  SYBEX_FOREX_AI_PHASE42_VERIFICATION.md
                  (deliberately not staged here — they are not part of this change)
next-env.d.ts     reverted after `next build` (known route-path churn)
```

Files in `19c49ef`:

| Type | Files |
|---|---|
| New library | `lib/trading-session.mjs`, `lib/trading-session.d.mts` |
| New UI | `components/RecentTradesTable.tsx` |
| New route | `app/api/trading-session/route.ts` |
| New tests | `tests/trading-session.test.mjs`, `tests/recent-trades-display.test.mjs` |
| New prepared SQL | `supabase/prepared/20261211_phase421_close_identity.sql` |
| Audits | `RECENT_TRADES_ACCOUNTING_AUDIT.md`, `ACTIVE_TRADING_HOURS_AUDIT.md` |
| Implementation records | `RECENT_TRADES_ACCOUNTING_IMPLEMENTATION.md`, `ACTIVE_TRADING_HOURS_IMPLEMENTATION.md` |
| Modified | `lib/risk.ts`, `lib/analytics-scope.mjs`(+`.d.mts`), `app/api/orders/route.ts`, `app/api/scalper/signal/route.ts`, `app/api/strategy/route.ts`, `app/api/trades/route.ts`, `hooks/useForex.ts`, `components/pages/DashboardPage.tsx`, `components/pages/StrategyPage.tsx`, `components/AppShell.tsx`, `workers/scalper.mjs`, `package.json`, `tests/phase421-remediation.test.mjs` |

---

## 3. Test results (exact)

`npm run test:phase42` → **exit 0**

```
analytics-scope: all groups passed
broker-deal-ingest: all groups passed
journal-stats: all groups passed
phase42-integrity-guards: all groups passed
phase421-remediation: all groups passed
trading-session: 18 groups passed          ← new
recent-trades-display: 10 groups passed     ← new
order-authority: 13/13 groups passed
trade-accounting: 17/17 groups passed
risk-from-fill: 10/10 groups passed
uk-time: 10/10 groups passed
execution-evidence: 10/10 groups passed
reconciliation-repair: 10/10 groups passed
phase41-migration: 9/9 groups passed
reconcile-close-accounting: all tests passed
```

Individual runs:

```
npm run test:trading-session    → trading-session: 18 groups passed
npm run test:recent-trades      → recent-trades-display: 10 groups passed
npm run test:analytics-scope    → all groups passed
npm run test:security           → (unchanged, in chain) passed
node tests/phase421-remediation.test.mjs → all groups passed
```

One pre-existing assertion was updated, not deleted: `phase421-remediation` group P-F
asserted a tooltip that lived in `DashboardPage`. Per-row rendering moved to
`RecentTradesTable`, so P-F now asserts the stronger rule there (no P&L is emitted at
all when accounting does not support one) **and** that the dashboard uses the shared
classifier.

---

## 4. TypeScript and build

```
npx tsc --noEmit   → exit 0 (no output)
npm run build      → exit 0, "✓ Compiled successfully in 3.9s"
                     /api/trading-session registered as a dynamic route
```

No new dependency was added. `next-env.d.ts` was reverted after the build.

---

## 5. Database verification status

**NOT VERIFIED.** This phase requires no schema change, so nothing was applied and
nothing was read. The following are owner-run read-only checks that settle the open
questions from the audit.

### 5.1 Is the RPC that this phase builds on actually deployed?

```sql
-- Expect: a non-null md5, and 'payload_v2_aware' if it reads grossProfit.
select md5(prosrc) as deployed_md5, length(prosrc) as body_len
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'mt5_webhook_sync';

select case when prosrc like '%grossProfit%' then 'payload_v2_aware'
            else 'pre_v2' end as deployment_state
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'mt5_webhook_sync';
```

### 5.2 How large is the R-1 exposure? (genuine closes with no broker ticket)

```sql
select count(*) filter (where broker_ticket is null or btrim(broker_ticket) = '') as ticketless_closes,
       count(*)                                                                       as all_closes
  from trades
 where result in ('WIN','LOSS','CLOSED')
   and pl_usd is not null;
```

Any non-zero `ticketless_closes` is money the dashboard cannot currently show.
**Do not repair these rows by hand** — the prepared patch fixes the *path*, not the
history, and history has no recoverable ticket.

### 5.3 How much is gross-only (R-4/R-9)?

```sql
select count(*) filter (where accounting_complete is true)  as net_complete,
       count(*) filter (where accounting_complete is false) as gross_only,
       count(*) filter (where commission is null)           as commission_missing,
       count(*) filter (where swap is null)                 as swap_missing
  from trades
 where result in ('WIN','LOSS','CLOSED') and broker_ticket is not null;
```

Every `gross_only` row will render `RESULT PENDING` + "gross only" — by design.

### 5.4 Where is `closed_at` coming from? (R-3)

```sql
-- A large median gap vs opened_at is expected; what matters is that it is stable
-- and that the newest close is not in the future.
select percentile_cont(0.5) within group (order by extract(epoch from (closed_at - opened_at))) as median_hold_seconds,
       max(closed_at) as newest_close
  from trades
 where closed_at is not null and opened_at is not null;
```

---

## 6. EA version and deployment status

| Item | Status |
|---|---|
| EA sources in repo | `v9.3.1`, `v9.4`, `v9.5` (plus older) |
| Post to `/rest/v1/rpc/mt5_webhook_sync` | all three; the TS route `app/api/mt5-sync` has **no callers** |
| `executionPayloadVersion: 2` | v9.4 and v9.5 |
| `closedPositions[].ticket` | **v9.5 only** — required by the prepared patch for identity matching |
| `closedAt` (broker close time) | v9.5, as broker-server local time with **no zone** |
| Compile / install / deploy | **NOT DONE** — owner action |
| Which EA is live in production | **Not verifiable from this repository** |
| Broker Connection page advertises | **v9.5** — from `lib/ea-version.mjs`, not hand-written JSX (see §13) |

Consequence: until v9.5 is deployed, the prepared patch can only take its
price-proximity fallback and can never populate a close time. That is stated in the
patch header, so applying it early is a safe no-op rather than a behaviour risk.

---

## 7. Worker scheduler status

**NOT VERIFIED.** The worker is a VPS process, not a Vercel cron. What this phase
changes there:

- the generation gate sits **after** the observability blocks (outcome resolution,
  prediction resolution, `outcome_reconciliation` refresh) so those keep running 24/7;
- the execution re-check sits inside `processSignal`;
- defaults changed `0/24` → `7/20`.

Owner checks:

```bash
# 1. Outside the saved window the log must show observability-only, with no AI call.
grep -E 'outside saved trading hours|skipped-outside-trading-session' worker.log | tail

# 2. Inside the window, generation must be unaffected.
grep -E 'session gate|skipped-outside' worker.log | tail

# 3. The worker must still be writing worker_logs while trading is closed.
select max(created_at) from worker_logs;
```


---

## 8. Remaining blockers (all owner actions)

| # | Blocker | Why it blocks acceptance |
|---|---|---|
| 1 | Apply `20261211_phase421_close_identity.sql` | Without it a genuine close can still be born ticket-less and disappear (R-1/R-2) |
| 2 | Compile + deploy **EA v9.5** | Supplies `ticket` and separate cost terms; the patch has nothing to bind to otherwise |
| 3 | Approve `20261114_phase421_partial_close_proof.sql` | Deal-level evidence and per-deal duplicate proof |
| 4 | One **genuine broker close** with the new EA | The only proof that gross + commission + swap + fee arrive and reconcile |
| 5 | Broker deal report for pre-v9.4 rows | The only lawful source for their missing costs (R-9) |
| 6 | `git push origin main` (4 commits) | Nothing is on the remote |
| 7 | Deploy approval | Not requested here; this report only records readiness |

---

## 9. Acceptance status against the brief's final criteria

**Recent Trades**

| Criterion | Status |
|---|---|
| Genuine executions correctly represented | Code yes; production proof **blocked** (R-1 needs the patch + v9.5) |
| Every closed trade has a verifiable result where evidence permits | Yes — and explicitly `RESULT PENDING` where it does not |
| Net P&L agrees with broker deal arithmetic | Arithmetic unchanged and tested; live proof **blocked** |
| Partial closes aggregated correctly | Yes on the v9.5 path; storage of the proof **prepared** |
| Missing accounting remains explicitly unknown | Yes — em dash, never 0 |
| Dashboard and API totals agree | Yes — one population, one UTC day, shared `describeTradeRow` |

**Active Trading Hours**

| Criterion | Status |
|---|---|
| Selected saved strategy is authoritative | Yes — read server-side; body used only when no row exists |
| London permits only the configured window | Yes (07:00–16:00 = the shipped preset, asserted) |
| Other sessions behave per their own saved window | Yes (NY, Asian wrap, All Day) |
| Signal generation blocked outside hours | Yes — before any AI call |
| Pending signals cannot bypass the restriction | Yes — re-evaluated at execution |
| Final order gate checks independently | Yes — second evaluation immediately before `placeOrder` |
| All components agree | Yes — one module, asserted by test group Q |
| **Production evidence** | **Blocked** — needs a deploy and an out-of-hours probe |

---

## 10. Production verification runbook (after approval)

1. **Deploy** `19c49ef` → confirm `/api/trading-session` answers.
2. **Status probe:** `curl -s "$BASE/api/trading-session?userId=$UID" | jq .session` —
   expect `eligible`, `window`, `utcTimestamp`, and `nextOpen` or `nextClose`.
3. **Out-of-hours order:** submit outside the saved window → expect **HTTP 422** with
   `code: 'OUTSIDE_TRADING_SESSION'` and a `session` object, and **no** broker ticket
   created.
4. **In-hours order:** inside the window → behaviour unchanged.
5. **Worker:** at the boundary confirm `⏸ … outside saved trading hours` and no AI
   spend, while `worker_logs` continues to update (observability still running).
6. **After applying the close patch:** one genuine close must produce a row with
   `broker_ticket` set, `commission`/`swap` non-null, `accounting_complete = true`, and
   `net_realised_pnl = pl_usd + commission + swap + other_fees`. Then confirm the row
   appears in RECENT TRADES as `NET COMPLETE` with a net figure, and that TODAY P/L
   changed by exactly that net amount.
7. **Regression:** `npm run test:phase42` still exits 0.

Record the raw output of steps 2-6. That evidence is what moves this report from
**IMPLEMENTED AND TESTED LOCALLY** to **VERIFIED AGAINST PRODUCTION**; until it exists,
the honest verdict remains **PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED**.

---

## 11. What this phase did not do

- Did not change entry/exit logic, indicators, AI prompts, confidence thresholds,
  XGBoost models, risk %, daily-loss limits, drawdown limits, prop-firm rules, lot
  sizes, SL/TP, break-even, partial-close or trailing-stop settings.
- Did not enable `ORDER_AUTHORITY_ENFORCE`.
- Did not enable trading, place an order, or submit anything to a broker.
- Did not fabricate any historical P&L, ticket, commission, swap or fee.
- Did not apply a migration, change an environment variable, restart a service,
  deploy, or install an EA.
- Did not convert unknown P&L into £0/$0 anywhere — the new paths return `null` and
  the UI renders an em dash.


---

## 12. Deployment record — 2026-11-16T21:14Z

Pushed and deployed at the owner's explicit request. This section **supersedes §2's
"not pushed"** and narrows §1: the *status endpoint* is now verified in production;
everything else in §8 remains blocked.

### 12.1 Git

```
git push origin main
  6c89bfe..822b50b  main -> main      (5 commits: 00cd0ab SEC-1 … 822b50b docs)
```

### 12.2 Vercel — deployed automatically by the Git integration

Two projects build from this repository, both were created by `vercel[bot]` for
`822b50b` within seconds of the push, and **both report `success`**:

| Project | Deployment URL | State |
|---|---|---|
| Production – `forex-ai` | `https://forex-ksq5z6ir9-sybexdesigns-projects.vercel.app` | success |
| Production – `forex-work` | `https://forex-work-eybi6iz13-sybexdesigns-projects.vercel.app` | success |

Production alias: **`https://forex-ai-delta.vercel.app`** (repo homepage).

No CLI deploy was used: the stored Vercel CLI token in
`~/Library/Application Support/com.vercel.cli/auth.json` is **expired**
(`{"invalidToken": true}`, HTTP 403), and no `VERCEL_TOKEN` is present. The Git
integration is the deploy path. **That token should be rotated** — it is also no longer a
usable credential.

### 12.3 Live probe of the new endpoint (the runbook's step 2)

`GET https://forex-ai-delta.vercel.app/api/trading-session`, 21:15 UTC:

```json
{"session":{"version":"trading_session_v1","fingerprint":"ts1-bb2efc85",
 "window":"07:00–16:00 UTC","startHour":7,"endHour":16,"wraps":false,
 "utcTimestamp":"2026-11-16T21:15:09.120Z","utcHour":21,
 "eligible":false,"reason":"outside_session",
 "nextOpen":{"at":"2026-11-17T07:00:00.000Z","label":"07:00 UTC","utcDate":"2026-11-17","inMinutes":585},
 "nextClose":null},
 "source":"saved-strategy"}
```

`userId=c755a8f2…` → `window:"07:00–20:00 UTC"`, `reason:"outside_session"`.
`userId` omitted → `source:"default-strategy"`, `07:00–20:00`.
Unknown `userId` → `source:"default-strategy"` (no row ⇒ `DEFAULT_STRATEGY`, never 24h).

This confirms in production: the new route is deployed, the **saved** row is the
authority, per-user windows are honoured, unknown users fail to the default rather than
to an open window, and next-open maths is correct.

### 12.4 Saved windows read from production before deploying (safety pre-check)

The gate went live only after confirming no legacy `0→23` row exists:

| user_id | sessionStart | sessionEnd |
|---|---|---|
| `2fbdacfc…` | 7 | 16 |
| `17035955…` | 7 | 16 |
| `c755a8f2…` | 7 | 20 |

Therefore the "legacy `0→23` blocks 23:00–23:59" behaviour change flagged in §1 does
**not** affect current production data.

### 12.5 What is now enforcing, and what is still not

**Live now (Vercel):** `/api/orders` (pre-check + final gate), `/api/scalper/signal`
(before AI), `/api/strategy` validation, `/api/trading-session`, and the UI status panel.

**Live consequence to be aware of:** the VPS worker still runs the *old* code, but every
`/api/scalper/signal` it requests now passes through the deployed gate. Its AI generation
therefore stops outside 07:00–20:00 / 07:00–16:00 UTC **as of this deploy**, even before
the worker code is updated. That is the intended enforcement, not a fault — but it is a
real change in spend and cadence that starts now.

**Still not live:** R-1/R-2/R-3 (patch unapplied), any 24/7 observability assertion on the
worker (needs the worker redeploy), EA v9.5, and any net-P&L proof on a genuine close.

### 12.6 Runbook status

| Step | State |
|---|---|
| 1. Deploy | ✅ done (§12.2) |
| 2. `/api/trading-session` probe | ✅ done (§12.3) |
| 3. Out-of-hours order → 422 | ⬜ not attempted — would need an authenticated POST and is **not** safe to fake |
| 4. In-hours order unchanged | ⬜ blocked until the window opens (07:00 UTC) |
| 5. Worker log + `worker_logs` | ⬜ owner (VPS) |
| 6. Genuine close after patch | ⬜ blocked (§8 items 1–4) |
| 7. `test:phase42` regression | ✅ exit 0 on this commit |


---

## 13. Broker Connection page now reflects EA v9.5 — 2026-11-17

### 13.1 The defect

The page hard-coded one EA version in five places (setup step 1, setup step 3, the
webhook-token label, the download button and its description). That version was
**v9.3.1**, which is:

- two payload generations behind the server (`executionPayloadVersion: 2` lands in v9.4);
- unable to report commission and swap separately, so every close it produces is
  gross-only by contract (`lib/broker-deal-ingest.mjs`);
- unable to put a `ticket` on a closed position, which is what R-1/R-2/R-3 need.

An operator following the page was therefore being told, by the product itself, to
install a build that cannot produce the accounting the product displays. §6 already
records that v9.5 is required; the UI did not.

### 13.2 What changed

| File | Change |
|---|---|
| `lib/ea-version.mjs` (new) | Single source of truth: `EA_BUILD` (version, `9.50` stamp, file name, download path, Experts-tab line, payload version), `parseEaBuild`, `extractReportedBuild`, `describeEaBuild` |
| `lib/ea-version.d.mts` (new) | Type surface for the above |
| `components/pages/BrokerPage.tsx` | All four hard-coded strings now derive from `EA_BUILD`; download link points at the shipped v9.5 file; new **BROKER-DEAL ACCOUNTING — EA BUILD** panel; per-config build chip |
| `tests/ea-version.test.mjs` (new) | 6 groups, 58 assertions |
| `package.json` | `test:ea-version`, added to `test:phase42` |

### 13.3 Where the "reported build" comes from (and its limit)

Not from a probe and not from a guess. v9.5 stamps `eaVersion` + `executionPayloadVersion`
into **every position entry** (A-7), and the sync RPC persists those entries into
`broker_configs.config.openPositions` ("Write back", migration `20261113`). The page reads
that array through the `/api/broker-config` payload it already loads — no new endpoint and
no new column.

The limit is stated on the page rather than hidden: a stale array written before the
upgrade carries no stamp, so the verdict is **UNKNOWN** — never "current". Three states:

| Reported | Verdict | What the operator is told |
|---|---|---|
| `9.50` (or newer) | `CURRENT` | ticket + separate cost terms are being reported |
| `9.40` / `9.3.1` | `OUTDATED` | closes stay gross-only until v9.5 is attached |
| absent | `UNKNOWN` | why it cannot be proven, and to check the Experts tab |

Note that v9.4 *does* send `eaVersion: "9.40"` at the payload root, but the RPC's
fixed-key write-back drops unknown top-level fields, so that copy never survives. Only the
per-entry stamp does — which is exactly why the page reads `openPositions` and not the root.

### 13.4 Verification

| Check | Result |
|---|---|
| `node tests/ea-version.test.mjs` | ✅ 6 groups passed |
| `npm run test:phase42` | ✅ exit 0 (41 ok lines) |
| `npx tsc --noEmit` | ✅ 0 errors (excluding stale `.next/types/* 2.ts` duplicates from a prior build) |
| `npm run build` | ✅ exit 0 |
| `public/SybexForexAI_EA_v9.5.mq5` exists | ✅ asserted by the test, so the link cannot 404 |
| Page contains v9.3.1 anywhere | ✅ no (`grep` + test) |

### 13.5 What this does NOT claim

The page states which build the product **requires** and which build the terminal
**last reported**. It does not prove v9.5 is compiled, attached or running — that remains
owner action §8, and the verdict stays `UNKNOWN` until a stamped position entry arrives.
The Recent Trades verdict is unchanged: **PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED**
until the genuine-close evidence of §12.6 step 6 exists.

