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

