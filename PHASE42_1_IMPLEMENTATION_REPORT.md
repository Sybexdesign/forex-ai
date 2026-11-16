# PHASE 4.2.1 — IMPLEMENTATION REPORT

**Project:** SybexForexAI · **Phase:** 4.2.1 (consolidated remediation) · **Prepared:** 2026-12-11
**Scope:** the 16 audit defects (C-1…L-4) from `SYBEX_FOREX_AI_FULL_PRODUCTION_AUDIT.md` §K, the ten
patches (P-A…P-J) defined in `SYBEX_FOREX_AI_PHASE42_VERIFICATION.md` §8, and additional findings A-1…A-9.
**Traceability:** every claim below maps to a section of `PHASE42_1_REMEDIATION_TRACEABILITY.md`.

**Verdict: PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED.**
Thirteen of sixteen defects now carry code plus a regression test that runs in this repository. Three
cannot be closed from a repository at all: C-1 (one genuine broker close after an EA deploy), C-2 (an
environment secret), and the historical half of M-2 (evidence that does not exist in the data). No strategy
rule, risk *setting*, threshold value or user-facing feature was changed.

---

## 1. What changed, by file

| File | Patch / defect | Change | Test |
|---|---|---|---|
| `lib/analytics-scope.mjs` | A-1 **H-1**, A-2 **M-1**, A-3 **M-3**, P-A | Close evidence outranks the stale `trade_status`; ticket kinds (`MT5_POSITION`/`OTHER_BROKER_REF`/`NONE`); phantom `accounting_status` branch removed; `EXECUTION_POPULATIONS` + `closedExecutions()` define "rows that count" once; `sumKnownPL()` defines what a total may claim; `isGenuineExecution()` delegates to the ticket kind | RUNTIME |
| `lib/analytics-scope.d.mts` | M-1, P-A | Type surface for the new exports (`brokerEvidence`, `ticketKinds`, `closedExecutions`, `sumKnownPL`, `EXECUTION_POPULATIONS`) | `tsc` |
| `app/api/orders/route.ts` | P-A **H-2**, M-2 | `RISK_COLUMNS` + `scopeRiskRows()`; P&L reads no longer require `pl_usd IS NOT NULL`; `todayPL`/`todayUnknownPLRows`/`allTimeUnknownPLRows`; `DAILY_PL_UNKNOWN` 422; `riskScope` disclosure; consistency-rule day totals narrowed to finite numbers | RUNTIME + STATIC |
| `lib/indicators.ts` | P-C | `todayPL: number \| null`; `dailyLossOk` requires `typeof === 'number' && Number.isFinite` | STATIC |
| `components/AppShell.tsx` | P-B **D1** | Unknown-aware `todayPL` via `closedExecutions`/`sumKnownPL`; em dash + tooltip on unknown; win rate over decisive broker executions only | STATIC |
| `app/api/scan/route.ts`, `hooks/useScanner.ts`, `components/pages/AnalysisPage.tsx` | P-C | Context and client checklist carry `number \| null` and mirror the server predicate | STATIC |
| `lib/risk.ts` | P-D | Nullable daily P&L; unknown is a **BLOCK**, not a pass | STATIC |
| `lib/propfirm.ts` | P-D **D2/D3** | Nullable daily P&L; `dailyPLEvaluated` added; an unevaluated day is a block reason | STATIC |
| `components/pages/PropFirmPage.tsx` | P-E | `closedExecutions`/`sumKnownPL`; honest `null`; `MetricBar.unevaluated` renders **UNKNOWN**, grey bar, "not evaluated" caption; consistency denominator uses known values only | STATIC |
| `components/pages/DashboardPage.tsx` | P-F | `?? 0` replaced with a neutral em dash + tooltip | STATIC |
| `app/api/loss-diagnostics/route.ts` | P-G | `rMultiple` is `null` unless `pl_usd` is finite and `R_DENOMINATOR > 0` | STATIC |
| `app/api/admin/users/route.ts` | P-H | Per-user `knownPL`/`unknownPL`/`knownTrades`; win rate over known rows; `totals` in the response | STATIC |
| `components/pages/AdminPage.tsx` | P-H | `knownPL` subtotal, `UNKNOWN P/L ROWS` tile, per-row `+N?` exclusion indicator | STATIC |
| `app/api/trades/route.ts` | A-5 **M-4/M-5** | Bounded, reported window (`?limit=`, default 1000, cap 5000, `truncated`); opportunistic Bearer check (403 on mismatch) | RUNTIME + STATIC |
| `lib/api-query.mjs` (+ `.d.mts`) | A-5 | Pure `parseLimit()` / `describeWindow()` | RUNTIME |
| `lib/cron-auth.mjs` (+ `.d.mts`) | **C-2** | The refresh authorisation, extracted so it can be *executed* by a test: timing-safe, no forgeable header, unconfigured production denies with 503 | RUNTIME |
| `app/api/outcome-reconciliation/refresh/route.ts` | C-2 | Delegates to `lib/cron-auth.mjs`; behaviour unchanged, testability added | RUNTIME + STATIC |
| `lib/integrity-thresholds.mjs` (+ `.d.mts`) | A-6 **M-6** | `reconWarnHours()` / `reconFailHours()` / `reconStatus()`, env-gated (`RECON_STALE_WARN_HOURS`), default = today's 6 h | RUNTIME |
| `app/api/production-integrity/route.ts` | M-6 | Uses the gated threshold and discloses `warnHours` in the response | RUNTIME + STATIC |
| `supabase/prepared/20261114_phase421_partial_close_proof.sql` | P-I **C-1 evidence** | **PREPARED, NOT APPLIED.** Additive columns + audit view; no backfill; no trigger change | STATIC |
| `public/SybexForexAI_EA_v9.5.mq5` | P-J **H-4**, A-7 | `RecoverOfflineCloses()` with a persisted, per-account watermark; closes committed only after a successful push; `provenance` on every close; `eaVersion` inside position entries | STATIC (no compiler here) |
| `tests/phase421-remediation.test.mjs` | all | 24 groups over every defect above | RUNTIME + STATIC |
| `tests/analytics-scope.test.mjs` | M-3 | Group H re-pointed at `accounting_missing` (it previously proved dead code) | RUNTIME |
| `tests/phase42-integrity-guards.test.mjs` | C-2 | Group B now asserts the wiring into `lib/cron-auth.mjs` instead of pattern-matching a comment | STATIC |

---

## 2. The three findings that shaped the implementation

**GATE-1 — P-B without P-C would have made things worse.**
`null > -100` is `true` in JavaScript, because `null` coerces to `0`. So a client that displays an unknown
daily P&L as `null` but still compares it to the loss limit would report *"comfortably within limit"* on a
day whose losses were never recorded — trading enabled by missing data. P-C (`typeof todayPL === 'number'`)
is what makes P-B safe. The suite asserts both the hazard (`null > -100 === true`) and the gate, and marks
them atomic.

**One definition, three consumers.**
The order guard, the header and the prop-firm page all need "which rows count". Three independent filters
are how the original defects diverged. There is now one implementation (`closedExecutions`) plus one
arithmetic statement (`sumKnownPL`), and a cross-surface group asserts that a six-row production mix yields
the same three executions, the same one unknown row and the same block decision everywhere.

**A recovered close is not a witnessed close.**
P-J reconstructs closes from deal history — the only way to stop a restart from hiding a loss. Letting that
reconstruction look like a live observation would be dishonest, so every close now carries `provenance`
(`ea_observed` / `ea_recovered`) and `mfeMaeMeasured`. A recovered close cannot claim a measured excursion:
the fields are zero **with a flag saying they were not measured**.

---

## 3. Verification performed in this repository

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | clean (only the pre-existing `.next/types` duplicate-file noise, filtered) |
| Phase 4.2 suite | `npm run test:phase42` | **exit 0** — 193 assertion lines (`PASS` / `ok`), including the new suite |
| New suite | `npm run test:phase421` | **exit 0** — 24 groups |
| Production build | `npm run build` | **exit 0** — all routes compiled |

---

## 4. Deliberate non-changes, and why

| Not changed | Reason |
|---|---|
| `app/api/orders/route.ts:275-276` | Verified **not** a defect during this phase; rewriting it would have been an unapproved behaviour change. |
| Re-basing the "executions" count in `isGenuineExecution` | Would move 111 UUID rows between populations in every consumer — a reporting change needing its own approval. The kind is exposed instead. |
| The net formula's treatment of an absent `other_fees` (L-1) | MT5 reports `DEAL_FEE` as 0 when absent; tightening it would make our net stricter than the broker's own arithmetic. Documented, frozen by test. |
| `result = 'WIN'` at exactly 0.00 (L-2) | The metrics layer treats zero as a breakeven, so the displayed rate is not inflated. Documented, frozen by test. |
| Journal page (L-4) | Re-enabling a page is a user-facing feature change, explicitly out of scope. |
| Write-path authorisation on `POST`/`PATCH /api/trades` (A-8) | Requires a product decision about who may write; recorded as an owner decision rather than silently implemented. |
| M-6's strict threshold value | Hard dependency on C-2: a red monitor before a working scheduler is noise, not safety. Env-gated, default unchanged. |

---

## 5. Residual limitations (stated, not hidden)

1. **C-1 is unproven in production.** No row in the database carries broker costs; the proof needs one
   genuine close after the EA is deployed. Fabricating a trade to close a defect would be a worse failure
   than the defect.
2. **C-2 is an environment fact.** The code half is proven by test; whether `CRON_SECRET` exists on the VPS
   worker is not observable from this repository.
3. **P-I is not applied.** The migration is written and reviewed but deliberately outside the applied
   sequence. Until it is applied, "how many deals produced this number" stays unanswerable.
4. **P-J is not compiled.** There is no MQL5 compiler here. The review covers control flow, watermark
   discipline and labelling; compilation and installation are owner actions.
5. **All-time P&L reads remain subject to the PostgREST 1000-row cap.** Pre-existing; now disclosed through
   `riskScope`, not silently assumed complete.
6. **Static tests are weaker than runtime tests.** They are used only where the code cannot execute in Node
   (Next handlers that build a Supabase client, React components, SQL, MQL5), and each fails on the specific
   defect returning rather than on formatting.

---

## 6. Verdict

**PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED.**

- **Implemented (13):** H-1, H-2, H-3, M-1, M-3, M-4, M-5 (phase 1), L-1…L-4 (documented + frozen), with
  P-J/A-7 prepared as owner-gated source and M-6 as owner-gated configuration.
- **Blocked (3):** C-1 (EA deploy + one genuine close), C-2 (worker environment), M-2 backfill (the evidence
  does not exist; inventing it would be fabrication).

The platform can now state what it does not know, which is the precondition for trusting anything it does
state. It cannot yet state a net figure, and no code change can change that: only a deployed EA and a real
broker close can.

| `package.json` | — | `test:phase421`; added to `test:phase42` | — |

Nothing in this table changes a strategy rule, a risk percentage, a lot-size formula, a production
threshold *value* (M-6 is opt-in and defaults to today), or navigation.
