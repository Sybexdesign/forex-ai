# SybexForexAI — Phase 4.2.1 Remediation Traceability Matrix

**Phase:** 4.2.1 (consolidated remediation)
**Baseline HEAD:** `6c89bfe` (`HEAD` == `origin/main` at time of writing)
**Source documents:**
- Report A — `SYBEX_FOREX_AI_FULL_PRODUCTION_AUDIT.md` (Sections 0–M; 16 defects in §K; 10 ordered steps in §L)
- Report B — `SYBEX_FOREX_AI_PHASE42_VERIFICATION.md` (patches P-A…P-J; findings D1–D8, H-A, H-B)

**Purpose.** Every defect in Report A §K is carried forward here with its original ID, title, severity,
evidence, location, impact, required correction, dependencies, §L step, patch mapping, verification test and
final status. Nothing is renamed, merged, omitted or downgraded. Two Report-B findings (`H-A`, `H-B`) are the
*implementable form* of §K defects H-1 and M-1 respectively, so they are mapped onto those IDs rather than
treated as new defects. Work that has **no** §K parent is labelled `ADDITIONAL FINDING` and is confined to
Appendix A.

**Severity counts as received (unchanged):** 2 CRITICAL · 4 HIGH · 6 MEDIUM · 4 LOW = **16**

**Patch vocabulary**

| Prefix | Meaning |
|---|---|
| `P-A` … `P-J` | Exactly the ten patches defined in Report B §8. No redefinition here. |
| `A-1` … `A-6` | Implementations carrying a §K defect that Report B did not express as a P-patch, or an additional finding (Appendix A). |

**Dependency ordering.** Report A §L's ten-step order is preserved verbatim as the execution order (§2). One
safety dependency is **added** (not reordered): P-B must not land without P-C, because `null > -100 === true`
in JavaScript, so an unknown-aware daily P&L that reached `lib/indicators.ts` without the `typeof` guard would
*enable* trading on unknown data. Report B §8 states this; it is recorded here as hard gate **GATE-1** (§4).

**Status legend:** `IMPLEMENTED` (code + regression test in this repo) · `IMPLEMENTED (OWNER-GATED)` (code
prepared, cannot be activated without an owner action) · `BLOCKED` (cannot be closed without production access,
an environment change or a genuine broker event) · `DOCUMENTED` (accepted limitation, frozen by test).

---

## 1. Traceability matrix — the 16 §K defects

### C-1 — CRITICAL — "No net P&L has ever been produced; the accounting branch has never executed."

1. **Original defect ID:** `C-1`
2. **Original title:** *No net P&L has ever been produced; the accounting branch has never executed.*
3. **Severity:** CRITICAL (unchanged)
4. **Evidence (Report A §E, §M.1-4):** `commission`, `swap`, `other_fees`, `net_realised_pnl` NULL on
   1,284/1,284 rows; `accounting_complete` NULL on all rows; integrity endpoint `commission_swap = FAILED`
   (`withCompleteNetPnl: 0 / 98`); every row `execution_contract_version = 'execution_v1'`; Report B §5
   confirms NET_COMPLETE = **0** and `commission`/`swap`/`fee` non-null on **0 of 1,284** rows.
5. **Affected files / locations:** `public/SybexForexAI_EA_v9.4.mq5` (v2 payload contract);
   `supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql:409-441` (net derivation — correct);
   `lib/analytics-scope.mjs:120-148` (refuses to present net — also correct).
6. **Financial / operational impact:** no profitability figure in the product is net of broker costs, so a
   break-even strategy appears profitable. Nothing is *misreported* as net — the platform correctly refuses —
   but the business cannot state a net number.
7. **Required correction:** deploy EA v9.4 to the live terminal, let one position close, and reconcile that row
   against the MT5 deal report. This is an **EA deployment**, not a code fix.
8. **Dependencies:** §L step 5 (`RecoverOfflineCloses()`, mapped to P-J) must ship inside the same build;
   step 6 (deploy) must follow step 5. Also depends on the deployed RPC really being the 4.2 body — settled by
   the `md5(prosrc)` probe in `PHASE42_1_PRODUCTION_VERIFICATION.md` §1.
9. **§L step:** **6** (*Deploy EA v9.4 to the live terminal*) with **5** as prerequisite.
10. **Related patches:** `P-I` (persist `deal_count`/`volume_closed`/`partial_close` so aggregation is
    *evidenced* rather than merely claimed) and `P-J` (restart recovery, so a restart cannot drop the closure).
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **C-1** asserts the accounting gate can
    never be bypassed: a v1 row with no commission/swap can never classify `NET_CONFIRMED`, and a net-complete
    row requires `accounting_complete === true` **and** non-null `net_realised_pnl`. The production proof (one
    v2 close with non-null costs reconciled to the broker) is **NOT VERIFIED** — it cannot be produced locally.
12. **Final status:** **BLOCKED** — owner action required (EA deploy + one genuine closure). No code change can
    close it and fabricating a trade is forbidden. See `PHASE42_1_OWNER_ACTIONS.md` §3.

---

### C-2 — CRITICAL — "The 10-minute reconciliation scheduler is blocked by a missing worker secret."

1. **Original defect ID:** `C-2`
2. **Original title:** *The 10-minute reconciliation scheduler is blocked by a missing worker secret.*
3. **Severity:** CRITICAL (unchanged) — an **environment** defect, explicitly not a code defect.
4. **Evidence (Report A §G, §M.1-6):** 36 × `warn "Outcome reconciliation refresh BLOCKED: CRON_SECRET not set
   on the worker"`, latest `2026-11-13T08:07:25Z`; `outcome_reconciliation.updated_at` pinned at
   `2026-11-13T04:00:21Z`; `scheduler_authentication.workerSchedulerVerified = 0`; only the daily
   `0 4 * * *` Vercel cron runs; reconciliation 4.4 h stale against a 10-minute design.
5. **Affected files / locations:** `workers/scalper.mjs` (`refreshOutcomeReconciliation`, `RECON_REFRESH_MS`,
   `RECON_STALE_WARN_MS`), `app/api/outcome-reconciliation/refresh/route.ts` (auth — verified sound:
   timing-safe, no forgeable `x-vercel-cron` path, 503 when unconfigured), `vercel.json`,
   `.do/app.yaml` (worker env manifest — secret absent).
6. **Financial / operational impact:** derived analytics up to 24 h stale; the platform advertises a cadence it
   does not deliver; missed closes are not back-filled.
7. **Required correction:** set `CRON_SECRET` in the worker environment to the Vercel value and restart the
   worker; confirm `workerSchedulerVerified = 1` and `updated_at` younger than 15 min. Code must not change —
   its fail-safe behaviour is correct.
8. **Dependencies:** none. Blocks M-6.
9. **§L step:** **1** (*Set `CRON_SECRET` on the VPS worker*).
10. **Related patches:** none from P-A…P-J; handled by an owner procedure (documented, not coded).
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **C-2** proves the *code* half: a missing
    secret blocks (never falls back), a wrong secret is rejected, a forged `x-vercel-cron` header is
    insufficient, the correct secret is accepted, and repeated refreshes stay idempotent. The environment half
    is unverifiable from this repo and is listed as an owner action.
12. **Final status:** **BLOCKED** — owner environment change. See `PHASE42_1_OWNER_ACTIONS.md` §1.

---

### H-1 — HIGH — "Genuine closed trades classified as `OPEN`, corrupting reported P&L and win rate."

1. **Original defect ID:** `H-1`
2. **Original title:** *Genuine closed trades classified as `OPEN`, corrupting reported P&L and win rate.*
3. **Severity:** HIGH (unchanged)
4. **Evidence (Report A §H.3; Report B `H-A`):** `lib/analytics-scope.mjs:110` returns `OPEN` whenever the
   legacy `trade_status` column says `OPEN`, even for rows carrying `result=WIN/LOSS`, a `closed_at` and a
   realised `pl_usd`. Window: 14 genuine closes (**+298.79**) hidden while 14 (**−23.86**) are displayed;
   corrected population **28 trades / +274.93**; the endpoint contradicts itself (`genuineExecutions: 98` vs
   `analytics_population.grossOnly: 14`). Report B adds that **36** rows with `result='LOSS'` +
   `trade_status='OPEN'` + realised `pl_usd` are dropped from every profitability figure.
5. **Affected files / locations:** `lib/analytics-scope.mjs:87-149` (`classifyTrade` ordering); consumers
   `components/pages/DashboardPage.tsx`, `lib/analytics-metrics.mjs`, `lib/journal-stats.mjs`,
   `app/api/production-integrity/route.ts`.
6. **Financial / operational impact:** displayed window P&L is wrong **in sign**; the win-rate denominator is
   half its true size; 36 real losses are invisible to performance review.
7. **Required correction:** prefer hard close evidence over the stale flag — a row is closed when `closed_at`
   **and** (`result ∈ {WIN, LOSS, CLOSED}` **or** `trade_status = 'CLOSED'`); `trade_status='OPEN'` decides only
   when no close evidence exists. No row is rewritten and no `result` is invented.
8. **Dependencies:** none for §L step 2; steps 3 and 7 depend on it (shared scope module).
9. **§L step:** **2** (*Fix `classifyTrade()` stale-status short-circuit + regression test*).
10. **Related patches:** `ADDITIONAL FINDING A-1` (the implementation). Prerequisite for `P-B`, `P-C`, `P-D`,
    `P-E`, which all consume the corrected populations.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **H-1 / A-1**:
    `{result:'WIN', trade_status:'OPEN', closed_at, pl_usd}` ⇒ contributes to gross (never `OPEN`);
    `{result:'LOSS', trade_status:'OPEN', closed_at, pl_usd:-40}` ⇒ counted as a loss;
    `{result:'CLOSED', trade_status:'CLOSED', closed_at, pl_usd:null}` ⇒ `ACCOUNTING_PENDING` (unknown, not 0);
    `{result:'OPEN', closed_at:null}` ⇒ `OPEN`; `{result:'OPEN', trade_status:'OPEN', closed_at:null}` ⇒ `OPEN`.
    `tests/analytics-scope.test.mjs` remains green (no existing population moves).
12. **Final status:** **IMPLEMENTED**.

---

### H-2 — HIGH — "Order-gating loss limit consumes unscoped `pl_usd || 0` data."

1. **Original defect ID:** `H-2`
2. **Original title:** *Order-gating loss limit consumes unscoped `pl_usd || 0` data.*
3. **Severity:** HIGH (unchanged)
4. **Evidence (Report A §H.6; Report B §6.1-6.5):** `components/AppShell.tsx:157`
   `todayTrades.reduce((s, t) => s + (t.pl_usd || 0), 0)` → `useScanner({todayPL})` →
   `lib/indicators.ts:181` `dailyLossOk`; plus `app/api/orders/route.ts:267-276` (**D8**: sums 1,092
   simulation rows, Σ −2,019.59, into `lib/risk.ts:38` — a hard HTTP 422), `lib/propfirm.ts:106`
   (**D2/D3**), `components/pages/PropFirmPage.tsx:54,55,60` (**D2/D3/D4**), `app/api/admin/users/route.ts:40`
   (**D5**), `app/api/loss-diagnostics/route.ts:93` (**D6**), `components/pages/DashboardPage.tsx:333-334`
   (**D7**). `app/api/orders/route.ts:275-276` is **not** a defect today — its queries filter
   `.not('pl_usd','is',null)` (Report B §6.3) — and is not rewritten for stylistic reasons.
5. **Affected files / locations:** as listed in 4.
6. **Financial / operational impact:** two opposite failures from one number — (a) unknown losses read as `0`,
   so the guard **stays open after the limit is breached**; (b) simulation losses can **lock** live trading
   (account at 12.36 GBP, 2 % daily limit ≈ 0.25 GBP, so a single historical −963.50 simulation row blocks the
   day).
7. **Required correction:** unknown stays unknown (`null`), simulation never counts, genuine broker executions
   do, and **no threshold changes**.
8. **Dependencies:** GATE-1 — `P-B` and `P-C` are an atomic pair (`null > -100 === true`). All of
   `P-A`…`P-H` depend on `A-1` (shared population rule) — GATE-2.
9. **§L step:** **3** (*Fix order-gating `pl_usd || 0`*), depends on step 2.
10. **Related patches:** `P-A` (D8), `P-B` (D1), `P-C` (P-B's guard), `P-D` (D2/D3), `P-E` (D2), `P-F` (D7),
    `P-G` (D6), `P-H` (D5).
11. **Verification test:** `tests/phase421-remediation.test.mjs` groups **D8 / P-A**, **GATE-1 (P-B+P-C)**,
    **P-D**, **P-E**, **P-F**, **P-G**, **P-H** — the ten required cases (genuine loss counts, genuine profit
    counts, simulation loss ignored, ticket-less ignored, UUID ≠ numeric ticket, open position ignored,
    cancelled ignored, incomplete handled per policy, other account excluded, thresholds unchanged) plus the
    `null`/`undefined`/`0`/negative/positive/numeric-string/non-finite matrix.
12. **Final status:** **IMPLEMENTED** (all eight sites) with one documented residual: all-time drawdown can only
    be evaluated over *known* values because 43 genuine ticketed rows carry `closed_at` with `pl_usd IS NULL`;
    failing closed there would block trading permanently until an approved backfill, so the all-time figure is
    labelled incomplete while the **daily** gate — the one that blocks orders — fails closed.

---

### H-3 — HIGH — "Order-authority evidence absent for every submission."

1. **Original defect ID:** `H-3`
2. **Original title:** *Order-authority evidence absent for every submission.*
3. **Severity:** HIGH (unchanged)
4. **Evidence (Report A §F):** 0 of 1,284 rows carry `submission_source`, `request_id`,
   `authority_decision`, `authority_reason`, `authority_policy_version`, `submitted_by` or `submitted_at`;
   integrity `order_authority = INSUFFICIENT_DATA`; `lineage = INCOMPLETE`
   (`withExecutionSource: 141`); `trade_authority_decisions` (63,123 rows) is a decision snapshot and cannot
   substitute.
5. **Affected files / locations:** `app/api/orders/route.ts:88-145` (classification + decision), `:599-654`
   (persistence with a column-absent retry), `lib/order-authority.mjs`; callers
   `workers/scalper.mjs:2000-2050` (`submission_source: 'WORKER_AUTOTRADE'` — already sent),
   `components/pages/AutoTradePage.tsx:631,699,760,850`, `ScalpPage.tsx:330`, `MetalsPage.tsx:131`,
   `AnalysisPage.tsx:167`, `ScalperPage.tsx:538` (lane inferred from the `signal_id_ref` prefix).
6. **Financial / operational impact:** no submission can be attributed to a lane, so the 2026-11-12 incident
   class (an order the worker's own log says it did not place) cannot be reconstructed from data.
7. **Required correction:** nothing to *invent* — the write path already persists all seven fields
   (Phase 4.1A). The remediation is to prove the contract, forbid regressions, and state plainly that the
   evidence is absent only because **no order has been submitted since the columns existed**.
8. **Dependencies:** none. `ORDER_AUTHORITY_ENFORCE` stays disabled/unset (asserted by guard test).
9. **§L step:** **4** (*Persist order-authority fields on submission* — already satisfied in code).
10. **Related patches:** `ADDITIONAL FINDING A-4` (guard test + lane documentation). No behaviour change.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **H-3 / A-4** asserts the route writes all
    seven fields; the worker sends an explicit `WORKER_AUTOTRADE` lane; every UI caller resolves to a
    non-`UNKNOWN` lane via `classifySubmission`; `ORDER_AUTHORITY_ENFORCE` is compared only to `'true'`; and the
    retry path cannot insert a row that silently omits the lane.
12. **Final status:** **IMPLEMENTED** (contract verified and guarded) / production evidence pending until the
    next real submission creates a row carrying the fields.

---

### H-4 — HIGH — "EA restart recovery can still miss closes entirely (D.4)."

1. **Original defect ID:** `H-4`
2. **Original title:** *EA restart recovery can still miss closes entirely (D.4).*
3. **Severity:** HIGH (unchanged)
4. **Evidence (Report A §D.4):** `public/SybexForexAI_EA_v9.4.mq5:246` (`if(g_prevPosCount == 0) return "[]";`)
   and, more seriously, `:260` — candidates come **only** from `g_prevPos[]`, the snapshot taken by the previous
   `RefreshPrevPositions()`. After a restart that snapshot is rebuilt from currently-open positions, so anything
   that closed while the EA was down is unenumerable. Corroboration: 487 `result='CLOSED'` rows with no P&L
   (`legacyClosed`); 32 of 240 in-window rows `CLOSED` with `pl_usd IS NULL`.
5. **Affected files / locations:** `public/SybexForexAI_EA_v9.4.mq5:129-150` (`g_prevPos`), `:244-320`
   (`BuildClosedPositionsJSON`), `:639-730` (`OnInit`).
6. **Financial / operational impact:** any close that happens across an EA/VPS restart loses its gross **and**
   its costs permanently; net accounting can never be complete for that trade.
7. **Required correction:** a bounded deal-history sweep at init grouped by `DEAL_POSITION_ID`, emitted through
   the *same* `AggregatePositionDeals()` path, de-duplicated against a persisted `GlobalVariable` set.
8. **Dependencies:** must ship **before** §L step 6 (EA deployment) — Report A §L ordering rationale.
9. **§L step:** **5** (*Fix restart recovery, ship inside the v9.4 build*).
10. **Related patches:** `P-J` — implemented as `public/SybexForexAI_EA_v9.5.mq5`, owner-gated (compile +
    install + restart). Not deployable by this agent and no MQL5 compiler is available here.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **P-J** performs a static review of the new
    EA source: `RecoverOfflineCloses()` exists, is called from `OnInit()`, selects history by
    `DEAL_POSITION_ID`, routes through `AggregatePositionDeals()`, de-duplicates via `GlobalVariable`s and
    **never** emits a close without a `DEAL_ENTRY_OUT`/`DEAL_ENTRY_INOUT` deal. Compile and runtime behaviour
    are **NOT VERIFIED** (no MetaEditor here).
12. **Final status:** **IMPLEMENTED (OWNER-GATED)** — source prepared; cannot be compiled or installed here.

---

### M-1 — MEDIUM — "UUID values stored as `broker_ticket` inflate 'genuine executions' (H.4)."

1. **Original defect ID:** `M-1`
2. **Original title:** *UUID values stored as `broker_ticket` inflate "genuine executions" (H.4).*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §H.4; Report B §5.1/§6.1):** `broker_ticket` populated on 141 rows; only **30** hold a
   numeric MT5 ticket, **111** hold a UUID identical to the row's `oanda_trade_id` (2026-09: 109, 2026-10: 2,
   2026-11: 0). `isGenuineExecution()` tests only "ticket is non-null", so `broker_execution_coverage` and
   `lineage` read 141.
5. **Affected files / locations:** `lib/analytics-scope.mjs:74-76` (`isGenuineExecution`),
   `app/api/production-integrity/route.ts` (`withExecutionSource`, `ticketless`), `app/api/orders/route.ts`
   (ticket written from `orderResult.tradeId`).
6. **Financial / operational impact:** "141 genuine executions" overstates broker confirmation by ~4.7× and
   hides that 70 September rows with P&L sit in the `OPEN` bucket. Legacy artefact — no UUID ticket exists after
   October — but it corrupts the evidence grade quoted in review.
7. **Required correction:** make the identifier kind explicit (`MT5_POSITION` / `OTHER_BROKER_REF` / `NONE`),
   never let a UUID satisfy an MT5-ticket test, and **label** (never rewrite or delete) the historical rows.
8. **Dependencies:** §L step 7 depends on step 2 (shared classifier).
9. **§L step:** **7** (*Tighten `isGenuineExecution()` to numeric tickets; label legacy UUID rows*).
10. **Related patches:** `ADDITIONAL FINDING A-2`.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-1 / A-2** covers every identifier
    type: internal row `id` (uuid), `setup_id`, `signal_id_ref`, `prediction_log_id`, `oanda_trade_id` (UUID
    execution id), numeric MT5 position ticket, numeric deal ticket, short alphanumeric broker order id, and the
    empty/whitespace/null cases. A UUID is **never** `MT5_POSITION`; a 20-digit numeric string is;
    `isGenuineExecution` still returns true for a UUID broker ref (a real execution on a non-MT5 venue) while
    `isMt5TicketBacked` returns false — so no historical row is deleted and no count silently flips population.
12. **Final status:** **IMPLEMENTED** (classification + labelling), historical rows untouched. The *displayed*
    "broker executions" count is deliberately **not** re-based, because that would move 111 rows between
    populations in every consumer — a reporting change needing its own approval (owner decision).

---

### M-2 — MEDIUM — "`lineage` and `actual_risk` structurally incomplete."

1. **Original defect ID:** `M-2`
2. **Original title:** *`lineage` and `actual_risk` structurally incomplete.*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §I.1/§I.2):** `trades.prediction_log_id` NULL on 1,284/1,284; `trades.setup_id` NULL
   on 1,284/1,284; `outcome_reconciliation.executionLinked = 3` of 1,194; `signal_id_ref` set on 430;
   `planned_risk_amount` historically derived from *requested* pips, not the filled stop.
5. **Affected files / locations:** `app/api/orders/route.ts:56,637-638` (accepts and persists
   `predictionLogId`/`setupId`), `:581-593` (1R anchored from the **filled** stop),
   `app/api/production-integrity/route.ts:150-164` (`lineage`, `actual_risk` checks).
6. **Financial / operational impact:** prediction→execution and setup→execution expectancy cannot be joined;
   setup-level performance is unanswerable. `actual_risk` is already correct for new rows.
7. **Required correction:** write the keys at submission time **where a prediction provably exists**; ambiguous
   rows stay unlinked (the conservative rule is correct and must not be loosened).
8. **Dependencies:** §L step 8 depends on step 4.
9. **§L step:** **8** (*Backfill `setup_id` / `prediction_log_id` where a prediction provably exists*).
10. **Related patches:** `ADDITIONAL FINDING A-4` (write path verified; only supplied UUID-shaped values are
    persisted, no inference). Historical backfill is **explicitly not performed** — it would be fabrication.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-2** asserts the route persists
    `prediction_log_id`/`setup_id` **as supplied**, never synthesises them, and writes a synthetic `signalId`
    (`mirror-XAUUSD-…`) to `signal_id_ref` rather than the `signals` UUID column.
12. **Final status:** **IMPLEMENTED** (write path) / **BLOCKED** (historical backfill — needs owner approval and
    unambiguous evidence, which does not exist in the data).

---

### M-3 — MEDIUM — "Dead error branch: `trade.accounting_status` does not exist."

1. **Original defect ID:** `M-3`
2. **Original title:** *Dead error branch: `trade.accounting_status` does not exist.*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §H.6 note; Report B §1.1):** `lib/analytics-scope.mjs:125` reads a column that is not in
   `trades` (selecting it returns HTTP 400). Phase 4.1 created `accounting_missing`, not `accounting_status`.
5. **Affected files / locations:** `lib/analytics-scope.mjs:124-129`.
6. **Financial / operational impact:** the `ACCOUNTING_ERROR` population could only ever be reached through
   `accounting_missing`; the status branch was unreachable, so a reader could believe a column exists.
7. **Required correction:** drop the dead predicate; route error evidence through `accounting_missing`. Nothing
   else may change.
8. **Dependencies:** none.
9. **§L step:** none (discovered in the §H review; implemented with step 2 because it edits the same function).
10. **Related patches:** `ADDITIONAL FINDING A-3`.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-3** asserts `ACCOUNTING_ERROR` is
    reached via `accounting_missing: ['error']` / `['invalid_broker_value']` and that the classifier no longer
    reads `accounting_status`; `tests/analytics-scope.test.mjs` group H is updated to the same contract.
12. **Final status:** **IMPLEMENTED**.

---

### M-4 — MEDIUM — "Analytics population silently truncated client-side."

1. **Original defect ID:** `M-4`
2. **Original title:** *Analytics population silently truncated client-side.*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §H.6):** `app/api/trades/route.ts:22` `.limit(200)`; `AppShell` computes
   `todayPL`/`winRate` from that slice and divides by `trades.length` (all statuses, all populations).
5. **Affected files / locations:** `app/api/trades/route.ts:17-27`, `components/AppShell.tsx:154-159`.
6. **Financial / operational impact:** once a user exceeds 200 rows the *oldest* rows of the window fall out
   silently, so the daily-loss figure can under-count; `winRate` mixes OPEN/CANCELLED/simulation.
7. **Required correction:** fetch by an explicit, bounded window instead of a fixed slice; compute any displayed
   ratio from scoped populations.
8. **Dependencies:** step 9 follows step 2 (needs the classifier for the ratio).
9. **§L step:** **9** (*Fix `/api/trades` authorisation and the 200-row cap*).
10. **Related patches:** `ADDITIONAL FINDING A-5` (bounded, explicit `limit` parameter — default raised, hard cap
    enforced, `truncated` flag returned instead of silent loss) and `P-B` (the `winRate` fix in `AppShell`).
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-4 / A-5** asserts the limit parser
    (`1..5000`, default 1000, non-numeric → default, negative/huge clamped) and that the response reports
    `truncated` when the cap is hit; group **P-B** asserts `winRate` uses decisive genuine executions only.
12. **Final status:** **IMPLEMENTED** (cap + ratio). Authorisation is M-5.

---

### M-5 — MEDIUM — "`/api/trades` authorises on a client-supplied `userId`."

1. **Original defect ID:** `M-5`
2. **Original title:** *`/api/trades` authorises on a client-supplied `userId`.*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §J.2):** service-role read scoped only by `?userId=`; no session check; anyone who
   learns a user UUID can read that user's trades.
5. **Affected files / locations:** `app/api/trades/route.ts:7-33`; callers `hooks/useForex.ts:169` and
   `components/pages/AutoTradePage.tsx:517` (plain `fetch`, **no** Authorization header),
   `components/pages/JournalPage.tsx:421` (`authFetch`, page unmounted).
6. **Financial / operational impact:** confidentiality gap on trade history; no integrity impact.
7. **Required correction:** derive the user from the Supabase session server-side.
8. **Dependencies:** none, but enforcing a session **today** would break the two unauthenticated callers — so
   the change is phased.
9. **§L step:** **9** (same step as M-4).
10. **Related patches:** `ADDITIONAL FINDING A-5` (phase 1: *opportunistic* cross-check — when a Bearer token is
    supplied it must resolve to the requested `userId`, otherwise 403; unauthenticated behaviour unchanged, so no
    caller breaks). Phase 2 (mandatory authentication + converting the two client callers to `authFetch`) is
    prepared as an owner decision because it changes who can read what.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-5** asserts the cross-check exists and
    fails closed on mismatch/malformed token, and that no code path widens query scope when an unverified
    `userId` is supplied.
12. **Final status:** **IMPLEMENTED (PHASE 1)** / **OWNER DECISION REQUIRED (PHASE 2)**.

---

### M-6 — MEDIUM — "Integrity endpoint reports `reconciliation_refresh: HEALTHY` at 4.4 h against a 10-minute design."

1. **Original defect ID:** `M-6`
2. **Original title:** *Integrity endpoint reports `reconciliation_refresh: HEALTHY` at 4.4 h against a
   10-minute design.*
3. **Severity:** MEDIUM (unchanged)
4. **Evidence (Report A §H.6, §G.2):** `app/api/production-integrity/route.ts:116` uses
   `ageH > 48 ? FAILED : ageH > 6 ? WARNING : HEALTHY`, so a 4.4 h stale reconciliation reports HEALTHY.
5. **Affected files / locations:** `app/api/production-integrity/route.ts:99-118`.
6. **Financial / operational impact:** stale derived analytics are invisible to the health surface that exists to
   detect exactly that.
7. **Required correction:** fail beyond ~30 min **but only after C-2 is fixed**, or the endpoint merely turns red
   without improving anything.
8. **Dependencies:** **hard dependency on C-2** (Report A §L: tighten the threshold *after* #1).
9. **§L step:** **10**.
10. **Related patches:** `ADDITIONAL FINDING A-6` — implemented as an **environment-gated threshold**
    (`RECON_STALE_WARN_HOURS`, default `6` = today's behaviour, so nothing changes until the owner opts in) with
    the strict value (`0.5`) documented for use after C-2. Deliberately **not** flipped in code, because turning
    a monitor red before the scheduler can be fixed adds noise, not safety.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **M-6 / A-6** asserts the default equals
    current behaviour (no accidental change), that the configured override is honoured, and that an invalid value
    cannot make the check silently permissive.
12. **Final status:** **IMPLEMENTED (OWNER-GATED)** — the strict threshold is an owner action after C-2.

---

### L-1 — LOW — "`other_fees` is optional in the net formula."

1. **Original defect ID:** `L-1`
2. **Original title:** *`other_fees` is optional in the net formula (`COALESCE(v_cp_fee, 0)`).*
3. **Severity:** LOW (unchanged)
4. **Evidence (Report A §E.1, §K L-1):** `20261113_phase42_rpc_broker_deal_accounting.sql:409-415` computes net
   only when `commission` **and** `swap` are non-null, treating an absent `fee` as fee-free.
5. **Affected files / locations:** that migration; `tests/phase42-integrity-guards.test.mjs` group E
   (`ELSE NULL` assertion).
6. **Financial / operational impact:** a payload omitting `fee` is treated as fee-free — acceptable because MT5
   reports `DEAL_FEE` as 0 when absent, but it must be documented rather than assumed.
7. **Required correction:** documentation only; **no** change to the net formula (tightening it would make every
   future net stricter than the broker's own arithmetic).
8. **Dependencies:** none.
9. **§L step:** none (accepted limitation).
10. **Related patches:** none.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **L-1** asserts the migration still gates
    net on `commission` **and** `swap`, still `COALESCE`s only the fee, and still returns `ELSE NULL` — the
    accepted limitation is frozen so a future edit cannot quietly drop the gate.
12. **Final status:** **DOCUMENTED** (accepted; frozen by test).

---

### L-2 — LOW — "`result` is `WIN` at exactly `0.00`."

1. **Original defect ID:** `L-2`
2. **Original title:** *`result` is `WIN` at exactly `0.00` (`>= 0`) — a zero-profit close counts as a win.*
3. **Severity:** LOW (unchanged)
4. **Evidence (Report A §K L-2):** `20261113_…sql:424-441`
   `result = CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0 THEN 'WIN' ELSE 'LOSS' END`.
5. **Affected files / locations:** that migration; `lib/analytics-metrics.mjs` (breakevens are excluded from the
   win/loss rate, which is why the display is not inflated).
6. **Financial / operational impact:** a `0.00` close is labelled `WIN` in the `result` column while the metrics
   layer counts it as a breakeven. Intentional and tested.
7. **Required correction:** none — documented and frozen by test so nobody "fixes" the metric to match the label.
8. **Dependencies:** none.
9. **§L step:** none.
10. **Related patches:** none.
11. **Verification test:** `tests/analytics-scope.test.mjs` group E (unchanged) plus
    `tests/phase421-remediation.test.mjs` group **L-2**, which asserts `computeStats([0, 10, -10])` still reports
    one breakeven, one win, one loss and a 0.5 win rate.
12. **Final status:** **DOCUMENTED**.

---

### L-3 — LOW — "`netProfit` is computed by the EA *and* recomputed server-side."

1. **Original defect ID:** `L-3`
2. **Original title:** *`netProfit` is computed by the EA and recomputed server-side; the client value is unused.*
3. **Severity:** LOW (unchanged)
4. **Evidence (Report A §D.3, §K L-3):** `public/SybexForexAI_EA_v9.4.mq5:290` computes
   `netProfit = agg.gross + agg.commission + agg.swap + agg.fee`; the server recomputes independently and ignores
   the client figure.
5. **Affected files / locations:** the EA; the RPC migration.
6. **Financial / operational impact:** none (the advisory value is never trusted).
7. **Required correction:** none. Keeping the EA value is useful as a cross-check when the first v2 close lands.
8. **Dependencies:** none.
9. **§L step:** none.
10. **Related patches:** none.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **L-3** asserts the RPC computes
    `v_cp_net` itself and never reads `netProfit` from the payload.
12. **Final status:** **DOCUMENTED**.

---

### L-4 — LOW — "The Journal page is unmounted."

1. **Original defect ID:** `L-4`
2. **Original title:** *The Journal page is unmounted, so the 4.2D work (`lib/journal-stats.mjs`) has zero runtime
   reach.*
3. **Severity:** LOW (unchanged)
4. **Evidence (Report A §H.1, §K L-4):** the Journal import and route in `components/AppShell.tsx` are commented
   out.
5. **Affected files / locations:** `components/AppShell.tsx`, `lib/journal-stats.mjs`,
   `components/pages/JournalPage.tsx`.
6. **Financial / operational impact:** none — the code is dormant and its tests still pass, so it cannot rot
   silently.
7. **Required correction:** none in this phase. **Re-enabling the page is explicitly out of scope** (the brief
   forbids changing navigation or user-facing features outside remediation scope).
8. **Dependencies:** none.
9. **§L step:** none.
10. **Related patches:** none.
11. **Verification test:** `tests/phase421-remediation.test.mjs` group **L-4** asserts the Journal import and
    route stay commented out — so an accidental re-enable (which would surface an unaudited page) fails the suite.
12. **Final status:** **DOCUMENTED** (frozen).

---

## 2. §L ten-step order — preserved, with implementation reality

| §L # | Action (verbatim intent) | Depends on | This phase | Status |
|---|---|---|---|---|
| 1 | Set `CRON_SECRET` on the VPS worker, restart it | none | Owner procedure only | **BLOCKED (owner)** |
| 2 | Fix `classifyTrade()` stale-status short-circuit + regression test | none | `A-1` (+ `A-3`) | **IMPLEMENTED** |
| 3 | Fix order-gating `pl_usd \|\| 0` in `AppShell`, `/api/orders`, `lib/propfirm.ts` | #2 | `P-B`+`P-C` (GATE-1), `P-A`, `P-D`, `P-E`, `P-F`, `P-G`, `P-H` | **IMPLEMENTED** |
| 4 | Persist order-authority fields (UI + worker lanes) | none | `A-4` (contract verified + guarded) | **IMPLEMENTED** / production evidence pending |
| 5 | Fix restart recovery (`RecoverOfflineCloses()`), ship inside the build | none | `P-J` → `SybexForexAI_EA_v9.5.mq5` | **IMPLEMENTED (OWNER-GATED)** |
| 6 | Deploy the EA to the live terminal | #5 | Owner procedure only | **BLOCKED (owner)** |
| 7 | Tighten `isGenuineExecution()` to numeric tickets; label legacy UUID rows | #2 | `A-2` | **IMPLEMENTED** (count re-basing deferred) |
| 8 | Backfill `setup_id` / `prediction_log_id` where a prediction provably exists | #4 | `A-4` write path; backfill **not** performed | **IMPLEMENTED** / backfill **BLOCKED** |
| 9 | Fix `/api/trades` authorisation and the 200-row cap | none | `A-5` (cap + opportunistic authz) | **IMPLEMENTED** (phase 1) |
| 10 | Tighten `reconciliation_refresh` threshold **after** #1 | #1 | `A-6` (env-gated, default unchanged) | **IMPLEMENTED (OWNER-GATED)** |

**Order changes made:** none. **Dependencies added:** GATE-1 (`P-B` ⟺ `P-C`, atomic) and GATE-2
(`P-A`/`P-B`/`P-D` require `A-1`, because they consume the corrected population rule). Both are additional
constraints, not reorderings, and both follow from Report B §8 (GATE-1) and from the fact that `P-B`'s
`isGenuineExecution` filter only becomes correct once H-1 is fixed (GATE-2).

---

## 3. Patch → defect matrix (Report B §8 + additions)

| Patch | Report B intent | §K defects addressed | Depends on | Status |
|---|---|---|---|---|
| `P-A` | Scope the server-side order guard to broker executions (D8) | **H-2** (D8) | `A-1` | IMPLEMENTED |
| `P-B` | Client daily P&L scope-aware and unknown-aware (D1) | **H-2** (D1) | `A-1`, **`P-C` (atomic)** | IMPLEMENTED |
| `P-C` | `dailyLossOk` must refuse to pass on an unknown day | **H-2** | **`P-B` (atomic)** | IMPLEMENTED |
| `P-D` | Fail closed in the prop-firm evaluator (D2/D3) | **H-2** | `A-1` | IMPLEMENTED |
| `P-E` | PropFirmPage display honesty (D2/D3/D4) | **H-2** | `P-D` | IMPLEMENTED |
| `P-F` | Dashboard per-row cell: unknown renders as `—`, not green `$0.00` (D7) | **H-2** (D7) | — | IMPLEMENTED |
| `P-G` | Loss diagnostics: R unknown, not R 0 (D6) | **H-2** (D6) | — | IMPLEMENTED |
| `P-H` | Admin totals: known-only sum + unknown counter (D5) | **H-2** (D5) | — | IMPLEMENTED |
| `P-I` | Persist partial-close proof (`deal_count`, `volume_closed`, `partial_close`) | **C-1**, **H-4** (evidence) | owner approval | PREPARED (not applied) |
| `P-J` | EA restart recovery | **H-4** | compile + install (owner) | PREPARED (`v9.5` source) |
| `A-1` | `classifyTrade` close-evidence ordering (Report B `H-A`) | **H-1** | — | IMPLEMENTED |
| `A-2` | Ticket-kind classification (Report B `H-B`) | **M-1** | — | IMPLEMENTED |
| `A-3` | Remove dead `accounting_status` branch | **M-3** | — | IMPLEMENTED |
| `A-4` | Order-authority + lineage write-path contract | **H-3**, **M-2** | — | IMPLEMENTED |
| `A-5` | `/api/trades` cap + opportunistic authorisation | **M-4**, **M-5** | — | IMPLEMENTED (phase 1) |
| `A-6` | Reconciliation staleness threshold, env-gated | **M-6** | **C-2** | IMPLEMENTED (owner-gated) |

**Coverage check:** C-1 ✅ (P-I/P-J + owner deploy) · C-2 ✅ (owner env) · H-1 ✅ (A-1) · H-2 ✅ (P-A…P-H) ·
H-3 ✅ (A-4) · H-4 ✅ (P-J) · M-1 ✅ (A-2) · M-2 ✅ (A-4, backfill blocked) · M-3 ✅ (A-3) · M-4 ✅ (A-5) ·
M-5 ✅ (A-5 phase 1) · M-6 ✅ (A-6, owner-gated) · L-1 ✅ · L-2 ✅ · L-3 ✅ · L-4 ✅ — **16 of 16 have a
documented disposition; none is dropped, merged or downgraded.**

---

## 4. GATE-1 — the atomicity of P-B and P-C (safety gate)

`null > -100` evaluates to **`true`** in JavaScript (`null` → `0`); `undefined > -100` is `false` only because
`undefined` becomes `NaN`. Therefore:

* `P-B` alone converts an unknown day from `0` (a lie that keeps the guard open) into `null`, and the unguarded
  comparison in `lib/indicators.ts` would then **pass** — enabling trading on unknown data.
* `P-C` alone is inert but harmless, and is what makes `P-B` safe.

**Enforcement:** `tests/phase421-remediation.test.mjs` group **GATE-1** fails the build if either half is
missing. It asserts `components/AppShell.tsx` imports the scope predicate **and** `lib/indicators.ts` contains
`typeof options.todayPL === 'number'`, and it asserts the runtime behaviour (`dailyLossOk === false` for `null`,
`undefined`, `NaN`, `Infinity`). Both halves are in this change set; neither is committable alone.

---

## 5. Absolute restrictions observed

Recorded so a reader can verify compliance instead of taking it on trust. **No** change was made to: trading
strategy · entry/exit conditions · indicators or periods · XGBoost behaviour · LLM decision rules · confidence
thresholds · minimum signal strength · market/timeframe selection · stop-loss logic · take-profit logic ·
break-even (1.0R) · partial close (1.5R) · ATR trailing (1.0×) · position sizing · `MAX_LOTS=10` ·
`FIXED USD TARGET=0` · risk percentages · daily-loss **thresholds** · prop-firm restrictions · Trade Authority
policy · broker permissions · live order execution permissions · `ORDER_AUTHORITY_ENFORCE` (still absent/false).

**No** production migration applied · **no** deployment · **no** VPS or EA restart · **no** environment variable
changed · **no** trade created, closed or modified · **no** fabricated broker record.

---

## Appendix A — `ADDITIONAL FINDING` items with no §K parent

| ID | Finding | Origin | Disposition |
|---|---|---|---|
| `A-7` | Fixed-key configuration write-back drops `eaVersion`, so the running EA build cannot be identified from stored state; the `openPositions` JSON is identical across versions and both accounts are flat, so "no v2 costs" cannot distinguish *not deployed* from *deployed and flat* | Report B §4 / U5 | EA source fix included in `SybexForexAI_EA_v9.5.mq5` (persist `eaVersion`); verification is an owner action |
| `A-8` | The `POST`/`PATCH` handlers in `app/api/trades/route.ts` accept an arbitrary body with **no** user scoping | found while tracing M-4/M-5 | Recorded, **not** changed: write-path authorisation is a behaviour change outside this phase's approved scope; owner decision in `PHASE42_1_OWNER_ACTIONS.md` §6 |
| `A-9` | The `openPositions` payload carries no EA version or payload-level cost evidence, so "ingestion is live" is not "accounting is live" | Report B §5.3 | Recorded as a verification limitation; no code change |

*End of traceability matrix.*

