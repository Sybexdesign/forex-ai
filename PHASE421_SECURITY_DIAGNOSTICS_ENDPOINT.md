# SEC-1 — `GET /api/production-integrity` was unauthenticated

**Status: FIXED in code, NOT YET RELEASED.**
**This is deliberately NOT part of the accounting release.** It is a separate commit, a separate
decision and a separate deploy approval. Nothing here changes strategy, risk, lot sizing, Trade
Authority or the order path.

| | |
|---|---|
| Endpoint | `GET /api/production-integrity` (`app/api/production-integrity/route.ts`) |
| Introduced | Phase 4.1, extended in 4.2C/4.2.1 (M-6 threshold reporting) |
| Defect | Reachable by an unauthenticated caller; returned aggregate trading performance, accounting counts, reconciliation state and deployment configuration state |
| Evidence it was reachable | The project's own production audit recorded live `200` responses from the deployed app (`SYBEX_FOREX_AI_FULL_PRODUCTION_AUDIT.md` availability row and the "GET /api/production-integrity → 200" table; `SYBEX_FOREX_AI_PHASE42_VERIFICATION.md`). There is no `middleware.ts` in the repository, so nothing gated it |
| Fix | Authentication required (operator secret **or** admin session); anonymous callers receive `401` with a body containing no data |
| Committed | the commit adding `lib/diagnostics-auth.mjs` — separate from `b7ee215` (remediation) and `b5202ca` (docs) |

---

## 1. Why "read-only" was not the same as "safe to publish"

The endpoint is read-only, has no connection to Trade Authority, and writes nothing. That framing is
correct, and it is also why the exposure was never questioned: a read-only endpoint feels like a
monitor. But the response is not a heartbeat — it is the trading record itself. `getAdminClient()` is
used for every query, so whatever policy governs `trades` for a signed-in browser session never applied
here: this route was the one path that turned the anon key into an aggregate of the whole account.


## 2. What an anonymous caller actually received

Inventory taken from the response body as the route builds it, not from documentation.

### 2a. Financial performance (120-day window)

| Field | Content |
|---|---|
| `analytics.net.*` | Confirmed **net profitability** over the window |
| `analytics.gross.*`, `netComplete.*`, `excluded.*` | Provisional gross, net-complete subset, excluded totals |
| `analytics.scope` | Row counts per population class, including how many rows were excluded and why |
| `tradingSessionEvidence.buckets[]` | Per UK entry hour: `executions`, `wins`, `losses`, `breakevens`, `winRate`, `net`, `median`, `profitFactor`, `maxDrawdown`, `maxConsecutiveLosses`, `excludingLargestWinnerNet`, `days`, `independentDays`, `independentWeeks`, `confidence` |
| `tradingSessionEvidence.weeks[]`, `.months[]` | The same figures across time |
| `tradingSessionEvidence.sensitivity` | Result with the largest winner removed |

This is the firm's edge, hour by hour, with its drawdown profile and its robustness check — the most
commercially sensitive artefact the system produces. The endpoint ranks buckets by sample size rather
than profit, so the disclosure is statistically honest too, i.e. more useful to a reader than a noisy
table would have been.

### 2b. Execution and accounting state

| Field | Content |
|---|---|
| `checks[trade_accounting].counts` | `genuineExecutions`, `withCanonicalResult` |
| `checks[commission_swap].counts` | `genuineExecutions`, `withCompleteNetPnl`, `missingCosts` |
| `checks[lineage].counts` | `totalRows`, `withExecutionSource` |
| `checks[broker_execution_coverage].counts` | `totalRows`, `ticketless` |
| `checks[actual_risk].counts`, `checks[accounting_errors].counts` | `closedRows`, `legacyClosed` |
| `checks[timezone_integrity].counts` | `invalidTimestamps`, UK offset, BST flag |

Total trade count, how many are genuinely broker-confirmed, how many are ticket-less, how many carry
legacy unknown profitability: an accurate census of the book, refreshed on demand.

### 2c. Operational and deployment state

| Field | Content |
|---|---|
| `checks[reconciliation_refresh].counts` | `rows`, `executionLinked`, `ageHours` |
| `reconciliation` | `lastUpdatedAt`, `ageHours`, `warnHours`, `status` |
| `checks[scheduler_authentication].counts` | **`cronSecretConfigured: 0/1`**, `workerSchedulerVerified` |
| `checks[order_authority].counts` | `sampledWithAuthority`, `approvedAutomated`, `approvedManual`, `rejected`, `workerLane`, `uiScalpLane` |
| `overallStatus`, `checks[].status`, `checks[].detail` | Which controls are failing, in prose |

`cronSecretConfigured` is the one that matters most: it told any caller whether the reconciliation
scheduler is currently blocked. Combined with `ageHours`, an anonymous observer could watch the owner
fix a deployment in real time.

### 2d. Schema disclosure on failure

The `500` path returned `error: error.message` — raw PostgREST text, which carries table and column
names. A caller could learn the schema by breaking a query.

## 3. What was NOT exposed

Stated so this decision is not over-claimed: no account login or number, no balance or equity, no
broker credentials or config, no user e-mail addresses, no row-level PII, no order payloads, no
prediction content, and no secret values. `cronSecretConfigured` is a boolean — the secret itself was
never returned.

## 4. Decision

**Authenticate the whole payload. Answer unauthenticated callers with a body that contains nothing
derived from data.**

Accepted credentials:

1. `Authorization: Bearer <CRON_SECRET>` — the operator secret the reconciliation scheduler already
   holds, compared with the timing-safe comparison in `lib/cron-auth.mjs` (no second implementation).
2. `Authorization: Bearer <supabase user JWT>` — a signed-in session, verified against the admin
   address, exactly the convention `app/api/admin/users/route.ts` already uses.

Unauthenticated, or unrecognised, gets `401` with `WWW-Authenticate: Bearer` and this body only:

```json
{
  "readOnly": true,
  "authenticationRequired": true,
  "error": "Unauthorized",
  "note": "Production diagnostics are not public. Send Authorization: Bearer <CRON_SECRET> or an authenticated admin session token. No counts, financial figures or deployment state are returned to an unauthenticated caller."
}
```

No status, no counts, no figures, no `cronSecretConfigured`, no timestamp. `lib/diagnostics-auth.mjs`
is pure and synchronous; the database round trip needed to verify an admin session stays in the route.

### Why not the alternatives

| Alternative | Why rejected |
|---|---|
| Trim the "sensitive-looking" fields | Leaves an anonymous endpoint whose remaining fields (counts, statuses, `cronSecretConfigured`) still describe the book and the deployment, and invites the field list to drift back |
| Public summary with `overallStatus` only | Still an oracle: `FAILED` vs `HEALTHY`, plus response timing, tracks when trades close and when the scheduler breaks |
| Vercel Deployment Protection | Not configured in this repository, not a substitute for application authorisation, and it does not follow the endpoint to another host |
| IP allow-list | The owner and the worker have no stable address, and it would live outside the codebase where it cannot be reviewed |
| Leave it and document it | The audit's own rule: an assumed deployment control is not a control |

### Why anonymous access costs nothing operationally

No consumer needed it: no page under `app/` fetches the route (a grep finds only comments referring to
it), no entry in `vercel.json`'s `crons` points at it, and `workers/scalper.mjs` does not call it. It
exists for the operator, who holds `CRON_SECRET` for the scheduler anyway.

## 5. Behaviour change the owner must expect

1. **`curl <deployment>/api/production-integrity` now returns `401`, not `200`.** That is the fix
   working, not a regression.
2. **`PHASE42_1_PRODUCTION_VERIFICATION.md` §7 now sends the secret** — that `jq` probe feeds the M-6
   sign-off, so it authenticates.
3. **If `CRON_SECRET` is unset in the deployment, the endpoint is `401` to everyone, including the
   owner.** Deliberate: it fails closed and loud. It also means this endpoint cannot be used as
   evidence that C-2 is configured *before* C-2 is configured — use an admin session token in that
   window.
4. **Nothing else changes.** Same figures, same order, same `readOnly: true`, plus `authorisedBy`
   (`operator_secret` / `admin_session`) so a response can be matched to a log line.


## 6. Verification (run after this commit is deployed)

```bash
D=https://<deployment>

# 6a. Anonymous — must be 401 and must contain no numbers.
curl -sS -w '\nHTTP %{http_code}\n' "$D/api/production-integrity"

# 6b. Operator secret — must be 200 with the full payload.
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $CRON_SECRET" \
  "$D/api/production-integrity" | jq '{authorisedBy, overallStatus}'

# 6c. Wrong secret — must be 401, and the body must not hint at why.
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer not-the-secret" \
  "$D/api/production-integrity"
```

`npm run test:security` (also part of `npm run test:phase42`) freezes all of the above behaviourally:
ten groups covering credential parsing, near-miss secrets, fail-closed-when-unset, session-token
handling, the absence of any number in the `401` body, authorise-before-read ordering in the route, the
separated error path, and the absence of any header, environment or query-string fallback.

## 7. Residual risk, accepted

* A caller who obtains `CRON_SECRET` gains this endpoint. That secret already permits the refresh
  route, so the endpoint adds no new blast radius: rotate the secret and both close.
* The figures remain visible to anyone with an admin session, by design.
* The response is still generated on demand from the service-role client; `Cache-Control: no-store` is
  set on the `401` path and the route remains `dynamic = 'force-dynamic'`.
* This document does not claim the endpoint is now the *only* exposure of aggregate data. It closes the
  one path that required no credential at all.

## 8. Release sequencing

Do **not** bundle this into the accounting release.

1. Accounting gates §1–§5 in `PHASE42_1_OWNER_ACTIONS.md` proceed unchanged on the accounting commit.
2. This security commit is reviewed and deployed **on its own**, with `CRON_SECRET` already present in
   the deployment so §6b can pass at the same time.
3. Only once §6a/§6b/§6c are recorded is SEC-1 closed. Until then its verdict is
   `IMPLEMENTED — AWAITING SEPARATE DEPLOY APPROVAL`.

