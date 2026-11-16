# SybexForexAI — Phase 4.2 Database & Financial Integrity Verification

**Generated:** 2026-11-13T08:55Z
**Repository:** `/Users/user/Desktop/forex-ai` @ `6c89bfe` (`HEAD` == `origin/main`)
**Production project:** `lfurosnmkwvqtlifggaa` (`https://lfurosnmkwvqtlifggaa.supabase.co`), app `https://forex.sybexdesigns.co.uk`
**Mode:** verification only. **No production change was made** — no migration applied, no deployment, no trade created, no strategy/risk/lot/permission change, no RPC invoked with a valid token.

---

## 0. Evidence acquisition — and the hard limit

The task requires the *deployed function definition*, not the migration ledger. I attempted every
route to arbitrary SQL from this environment. All are closed:

| Access path attempted | Result |
|---|---|
| `POST /rest/v1/rpc/exec_sql {"sql":…}` (used by earlier sessions) | **HTTP 404 / PGRST202** — "Could not find the function public.exec_sql(sql)". The helper has been removed from the database. |
| `Accept-Profile: pg_catalog` → `/rest/v1/pg_proc` | **HTTP 406 / PGRST106** — "Only the following schemas are exposed: public, graphql_public" |
| `Accept-Profile: information_schema` → `routines` | **HTTP 406 / PGRST106** — same |
| `Accept-Profile: supabase_migrations` → `schema_migrations` | **HTTP 406 / PGRST106** — same |
| Supabase management PAT (`sbp_…`) for `api.supabase.com/v1/projects/{ref}/database/query` | Not present — absent from shell env, shell profiles, macOS Keychain, repo dotfiles and Vercel env |
| Postgres wire protocol (`psql` / `pg`) | `psql` not installed **and** no DB password exists in any reachable store |
| Vercel CLI (authenticated) `vercel env ls` | 22 production variables retrieved — **none is a database URL or password** |

**Consequence:** `pg_proc`, `pg_trigger`, `pg_index` and `pg_class` are unreachable from here, so
**no function body, trigger body, index or ACL can be read directly.** Everything below is therefore
built from three *independent* sources, never from the migration filename:

1. **Row-level production reads** via PostgREST with the service-role key (read-only).
2. **Live application self-report** — `GET /api/production-integrity` against the deployed app.
3. **Local source** of the migration, the EA and every consumer of P&L.

Section 3 closes this gap with a cryptographic fingerprint the owner can settle in **one read-only query**.

---

## 1. Phase 4.1 migration status — `20261112_phase41_order_authority_and_accounting.sql`

**Status: PARTIALLY VERIFIED**

### 1.1 Schema objects

All 17 declared columns exist and are queryable (single `select` of all 17 → HTTP 200, 17 columns returned):

| Group | Columns | Result |
|---|---|---|
| Order authority (7) | `submission_source`, `submitted_by`, `request_id`, `authority_decision`, `authority_reason`, `authority_policy_version`, `submitted_at` | **VERIFIED** |
| Accounting (4) | `net_realised_pnl`, `other_fees`, `accounting_complete`, `accounting_missing` | **VERIFIED** |
| Real-fill risk (6) | `initial_entry_price`, `initial_sl_price`, `requested_entry_price`, `requested_sl_price`, `risk_calc_version`, `instrument_spec` | **VERIFIED** |
| Pre-existing (not part of 4.1) | `commission`, `swap`, `execution_contract_version`, `broker_ticket` | **VERIFIED** (pre-date 4.1) |

`commission` and `swap` are **not** created by 4.1 — they are older columns that 4.1's trigger is meant to read.

### 1.2 Objects I could not verify

| Object | Status | Why |
|---|---|---|
| `trades_derive_accounting_trg` trigger exists / is enabled | **NOT VERIFIED** | `pg_trigger` unreachable |
| Trigger function body (the derivation formula) | **NOT VERIFIED** | `pg_proc` unreachable |
| Indexes and constraints | **NOT VERIFIED** | `pg_index` / `pg_constraint` unreachable |
| Column privileges | **NOT VERIFIED** | `information_schema` / `pg_class.relacl` unreachable |

### 1.3 The 4.1 trigger has never demonstrably fired

| Probe | Result |
|---|---|
| Rows with `net_realised_pnl` non-null | **0 of 1,284** |
| Rows with `accounting_complete` non-null | **0 of 1,284** |
| Rows with `accounting_missing` non-null | **0 of 1,284** |
| Rows with `submission_source` / `authority_decision` non-null | **0 of 1,284** |
| Newest trade row (`opened_at`) | `2026-11-12T02:36:05Z` — i.e. **before** any plausible 4.1 application date |

The deployed endpoint agrees and says so itself:

```
order_authority => INSUFFICIENT_DATA  "Every new order records submission_source + authority_decision.
                                       Rows predating 2026-11-12 carry neither."
```

So 4.1 is **installed to the extent of its columns**, but its *behaviour* — trigger derivation and
authority persistence — is **unproven in production**, because not one row has been written since the
migration. That is a statement about evidence, not about correctness.

---

## 2. Phase 4.2 migration status — `20261113_phase42_rpc_broker_deal_accounting.sql`

**Status: NOT VERIFIED (deployed body) — VERIFIED (file integrity, signature compatibility, v1 behaviour)**

### 2.1 The discrepancy being resolved

| Claim | Source | Verdict |
|---|---|---|
| "All Phase 4.1 and 4.2 migrations have been applied" | Owner | **Cannot be confirmed or refuted from outside the database** |
| "`20261113_…` is outstanding" | Prior audit report | **Also cannot be confirmed** — it was inferred from absence of v2 *data*, not from the ledger or the function body |

Neither statement is dischargeable with row data, and section 2.3 proves why. This is not a gap in
diligence; it is a property of the change itself.

### 2.2 What *is* verified about the 4.2 artefact

| Property | Result | Evidence |
|---|---|---|
| File exists, well-formed, one `CREATE OR REPLACE`, 532 lines | **VERIFIED** | File read; body extracted |
| Function signature matches what the database accepts | **VERIFIED** | PostgREST OpenAPI for `/rpc/mt5_webhook_sync` requires exactly `p_token text` (required) and `p_payload jsonb` (optional) — identical to the file's `(p_token text, p_payload jsonb DEFAULT NULL)` |
| Signature *discriminates* 4.0.x from 4.2 | **NO** | `20261003`, `20261004` and `20261113` declare the same signature — signature proves compatibility, not version |
| Grants declared in the file | **VERIFIED (source)** | `GRANT EXECUTE … TO anon` and `… TO authenticated`, lines 531–532 |
| Body identical to `20261004` outside the v2 branch | **VERIFIED (source)** | Full `diff` of both extracted bodies: **51 changed lines, all inside the `closedPositions` block** |

### 2.3 The decisive finding: 4.2 is a **no-op for v1 payloads**

The entire diff between the `20261004` body and the `20261113` body is 51 lines, all inside the
`closedPositions` branch. For a **v1 payload** (a v9.3.x EA — what production sends today) the two
bodies perform **identical writes**:

| Column | 20261004 body | 20261113 body | Same result on a v1 payload? |
|---|---|---|---|
| gross | `v_cp_profit := (e->>'profit')::numeric` | `v_cp_gross := COALESCE(NULLIF(e->>'grossProfit','')::numeric, NULLIF(e->>'profit','')::numeric)` | **Yes** — v1 has no `grossProfit`, so it falls back to `profit` |
| `commission`/`swap`/`other_fees` | not written | written from `e->>'commission'`, `'swap'`, `'fee'` | **Yes** — absent in v1 ⇒ `NULL` written over `NULL`; no change |
| `v_cp_net` | n/a | `CASE WHEN v_payload_version>=2 AND commission IS NOT NULL AND swap IS NOT NULL THEN … ELSE NULL END` | **Yes** — `NULL` in both |
| `result` | `CASE WHEN v_cp_profit >= 0` | `CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0` | **Yes** — `v_cp_net` is `NULL` ⇒ `COALESCE` yields `v_cp_profit` |
| `realised_r` | `v_cp_profit / NULLIF(risk,0)` | `COALESCE(v_cp_net, v_cp_profit) / NULLIF(risk,0)` | **Yes** |
| Token gate, PULL path, prices, candles, pending orders, config write-back, return object | unchanged | unchanged | **Yes** |

**Therefore, while the EA is v9.3.1, "4.2 applied" and "4.2 not applied" produce byte-identical
database state.** The migration only becomes observable when an `executionPayloadVersion: 2` payload
arrives carrying a non-empty `closedPositions`. None ever has (§5). The prior audit's "outstanding"
verdict was an inference from missing v2 data; it is *consistent* with 4.2 being applied but dormant,
and it cannot be upgraded to a confirmed discrepancy from data.

### 2.4 Duplicate-ingestion guard

| Probe | Result |
|---|---|
| Rows carrying a `broker_ticket` | 141 |
| Distinct `broker_ticket` values | 141 |
| **Duplicate tickets** | **0** |
| Distinct `oanda_trade_id` among those rows | 141 of 141 |

The source guard is `UPDATE … WHERE … AND pl_usd IS NULL` (idempotent close), and the data is
consistent with it: no ticket has ever been written twice. **VERIFIED (behavioural + source).**

### 2.5 Partial-close aggregation — a structural blind spot

`dealCount` and `partial` are **parsed and then discarded**:

```
line 183  v_cp_deals        int;
line 184  v_cp_partial      boolean;
line 396  v_cp_deals   := NULLIF(v_closed_entry->>'dealCount', '')::int;
line 397  v_cp_partial := COALESCE(NULLIF(v_closed_entry->>'partial', '')::boolean, false);
```

Neither variable appears in the `UPDATE trades` statement. There is **no `deal_count` / `volume_closed`
column**, and no deals table exists (26 exposed relations: `trades` carries aggregates only).

So even after v9.4 ships, the database will hold **no positive evidence that a close was assembled from
N deals**. Aggregation correctness will only ever be inferable by reconciling the single aggregate
`pl_usd` against MT5 account history — i.e. it is *auditable only externally*.
**Aggregates partial closing deals correctly: NOT VERIFIED**, and not verifiable from stored data.

---

## 3. Deployed RPC definition — verification matrix and the one-query close-out

### 3.1 Requirement-by-requirement

| Requirement | Status | Evidence |
|---|---|---|
| `public.mt5_webhook_sync` contains the Phase 4.2 implementation | **NOT VERIFIED** | Body unreadable (`pg_proc` unreachable). 4.2 is a no-op for v1 payloads (§2.3), so *no* data can answer this |
| Deployed definition matches the migration file | **NOT VERIFIED** — but now *decidable* via §3.2 | — |
| Function exists and is live | **VERIFIED** | PostgREST OpenAPI exposes it; `broker_configs.updated_at` advances every second (age 4–5 s at time of check) |
| Accepts `executionPayloadVersion: 2` argument contract | **VERIFIED (source)** / **NOT VERIFIED (runtime)** | `line 377: v_payload_version := COALESCE(NULLIF(p_payload->>'executionPayloadVersion','')::int, 0)`. Runtime: **0 payloads have ever carried it** — all 1,284 rows are `execution_v1` or `NULL` |
| Processes gross, commission, swap, fees, net **separately** | **VERIFIED (source)** / **NOT VERIFIED (runtime)** | Lines 390–397 parse 5 separate fields; line 411–413 computes `v_cp_net` only when every cost term is present. Runtime: `commission` non-null on **0 of 1,284** rows |
| Aggregates partial closing deals | **NOT VERIFIED** | See §2.5 — and `dealCount`/`partial` are not persisted, so it stays unverifiable |
| Duplicate ingestion prevented | **VERIFIED** | 0 duplicate tickets / 141; `pl_usd IS NULL` close guard |
| Permissions and grants correct | **PARTIALLY VERIFIED** | `anon`: **VERIFIED behaviourally** — the shipping EA authenticates with the **anon** key (`ANON_KEY` in `BuildHeaders()`), and ingestion is live (age 4–5 s), which is only possible if `anon` holds `EXECUTE`. `authenticated`: **NOT VERIFIED** (no user JWT available; low risk — no client path calls this RPC) |
| `SECURITY DEFINER` + `SET search_path = public` present | **VERIFIED (source)** lines 138–139 / **NOT VERIFIED (deployed)** | Security-relevant: if a re-serialisation dropped `SET search_path`, the function would be hijackable. Cannot be checked without catalog access |

### 3.2 The close-out: expected `md5(prosrc)` for each candidate body

I extracted each migration's dollar-quoted body exactly as `prosrc` stores it (the text between
`AS $$` and `$$;`) and hashed it. The owner can settle the whole question with **one read-only query**
in the Supabase SQL editor:

```sql
SELECT md5(prosrc)                          AS body_md5,
       length(prosrc)                       AS body_len,
       pg_get_function_identity_arguments(oid) AS args,
       prosecdef,                           -- must be true (SECURITY DEFINER)
       proconfig                            -- must contain search_path=public
  FROM pg_proc
 WHERE proname = 'mt5_webhook_sync';
```

| Candidate body | Body chars | Body lines | Expected `md5(prosrc)` |
|---|---|---|---|
| **`20261113` (Phase 4.2 — applied?)** | 16,060 | 390 | **`b3bf545aaf8c2caadc75d48d6bc7e5ca`** |
| `20261004` (reconcile close accounting) | 13,568 | 345 | `7913e62534ef6bb58c55a9bb51066f88` |
| `20261003` (native position ticket) | 13,410 | 342 | `f348b6622ed534c7b7f61e4859788401` |

Because a `CREATE OR REPLACE` always stores the pasted text verbatim, a match against the first row
proves 4.2 **is** applied and `NOT VERIFIED` becomes `VERIFIED`; a match against either of the other
two proves it is **not**. If a tooling layer re-serialised the body, use this version-independent
probe instead — it is decisive on its own:

```sql
SELECT (prosrc LIKE '%executionPayloadVersion%') AS has_v2_contract,
       (prosrc LIKE '%v_cp_commission%')         AS has_cost_columns,
       (prosrc LIKE '%dealCount%')               AS parses_deal_count
  FROM pg_proc WHERE proname = 'mt5_webhook_sync';
-- expected for 4.2: t | t | t      for 4.0.x: f | f | f
```

### 3.3 What the RPC is *provably* doing right now

| Observable | Value | Meaning |
|---|---|---|
| Ingestion cadence | `updatedAt` age **4–5 s** on two terminals | RPC executing successfully, in a loop |
| Auth model | EA sends the **anon** key | `GRANT … TO anon` is live and working |
| Payload shape accepted | `p_token` + `p_payload` | Signature matches all three candidate bodies |
| Config write-back | fixed 10-key object (lines 501–518) | `eaVersion` / `executionPayloadVersion` are **never persisted** — see §4.2 |

---

## 4. EA version and ingestion status

### 4.1 Ingestion: VERIFIED and healthy

| Terminal | `broker_type` | Login | Server | Balance | `updatedAt` | Age at check |
|---|---|---|---|---|---|---|
| MT5 Direct (EA) | `mt5direct` | 476520782 | Exness-MT5Trial9 | 10000.00 USD | 2026-08-16T23:27:35Z | **7,636,873 s (dead 89 days)** |
| Exness (MT5) | `exness` | 477680940 | Exness-MT5Trial9 | 102108.50 USD | 2026-11-13T08:48:43Z | **5 s** |
| **MT5 Direct (EA) - wkpc** | `mt5direct` | 489537 | **FusionMarkets-Live** | **12.36 GBP** | 2026-11-13T08:48:45Z | **4 s** |

All three rows are `is_active = true`; the first is a stale Exness **trial** config that last reported on
2026-08-16. **Two terminals are pushing concurrently into the same project** — an Exness trial
(102,108.50 USD) and the live Fusion Markets account (12.36 GBP). Any analytics that aggregates across
`trades` without a per-account filter mixes a demo and a live account.

Ingestion itself is unambiguously working: prices (11 symbols), candles (44 series × 100 bars), and
`openPositions` are refreshed every few seconds, which is only possible through
`public.mt5_webhook_sync`. **Supabase receives the payload → the RPC processes it: VERIFIED.**

### 4.2 EA build: NOT VERIFIED — and why the database cannot settle it

Both terminals send the account payload through the same fixed-key write-back. Five independent
attempts to pin the build all come back inconclusive:

| Attempted discriminator | Result |
|---|---|
| `config.eaVersion` (v9.4 line 849 sends `"9.40"`) | **Never persisted** — the write-back at lines 501–518 merges a fixed 10-key object and drops every other key |
| `config.executionPayloadVersion` (v9.4 line 848) | Same — dropped |
| `openPositions[].*` shape | **Identical** `BuildOpenPositionsJSON()` in v9.3.1 and v9.4 (ticket, symbol, type, lots, openPrice, sl, tp, profit) — no discriminator |
| `trades.execution_contract_version` | 141 rows `execution_v1`, 1,143 `NULL` — set by the *route* path, not by the RPC; says nothing about the EA build |
| `commission`/`swap`/`other_fees` non-null | **0 of 1,284** — proves no v2 payload has been *processed*, but not whether the binary is v9.4 (a v9.4 terminal that has closed nothing writes exactly this) |

The confounder is real and unavoidable: **the most recent realised close is `2026-11-12T02:36:05Z`**, and
both live terminals currently hold **0 open positions** (`openPositions = 0`). A v9.4 terminal that is
flat has literally nothing to report, so "no v2 costs" cannot distinguish
*"v9.4 not deployed"* from *"v9.4 deployed and flat since"*.

**Discriminating test (passive, no trade required):** the next genuine close on
`FusionMarkets-Live`. If `commission`/`swap` land non-null on that row, v9.4 + 4.2 are both live.
If they land `NULL` while `pl_usd` is set, the terminal is still v9.3.1.

### 4.3 Source-level contract between EA v9.4 and the 4.2 RPC — VERIFIED

The field names the EA emits match, character for character, what the RPC reads:

| EA v9.4 emits (`BuildClosedPositionsJSON`) | RPC reads (lines 390–397) | Match |
|---|---|---|
| `"grossProfit"` | `v_closed_entry->>'grossProfit'` | ✅ |
| `"commission"` | `v_closed_entry->>'commission'` | ✅ |
| `"swap"` | `v_closed_entry->>'swap'` | ✅ |
| `"fee"` | `v_closed_entry->>'fee'` | ✅ |
| `"dealCount"`, `"partial"` | `dealCount`, `partial` (parsed, **not persisted**) | ⚠️ |
| `"netProfit"` | **not read** — the RPC recomputes `gross + commission + swap + fee` | ✅ equivalent |

The EA also computes `netProfit = agg.gross + agg.commission + agg.swap + agg.fee`, and the RPC's
`v_cp_net` uses the same formula — so there is no gross/net sign convention mismatch.

### 4.4 Remaining EA-level defect (unchanged by the RPC)

`BuildClosedPositionsJSON` opens with **`if(g_prevPosCount == 0) return "[]";`** (v9.4 line **246**,
identical in v9.3.1 line 157). A position that closes while the terminal, VPS or EA is **restarted**
leaves `g_prevPos` empty, so the close is reported to nobody — the RPC never sees it and no amount of
server-side accounting can recover it. The `AggregatePositionDeals` retry (line 275–279,
`continue` → "retrying next sync rather than reporting a guess") is correct, but it only covers the case
where the *deal history* is temporarily unreadable, **not** the restart case.
**Closed-loop partial-close recovery: NOT VERIFIED — known gap at line 246.**

---

## 5. Genuine broker accounting statistics

No test trades were created; every figure below is read from the live `trades` table (1,284 rows total)
using the repository's own classifier (`lib/analytics-scope.mjs` → `classifyTrade`), so the report and
the UI cannot disagree.

### 5.1 Population counts — all 1,284 rows

| Category | Count | Notes |
|---|---|---|
| Rows with any `broker_ticket` (broker executions) | **141** | 30 numeric MT5 tickets + 111 UUID (non-MT5 broker) tickets |
| **NET_COMPLETE** (net confirmed by broker deal records) | **0** | Nothing has ever satisfied `net_realised_pnl IS NOT NULL` |
| **GROSS_ONLY** (costs not confirmed by broker) | **14** | All XAU/USD, all closed Sep 2026, all with `commission`/`swap`/`other_fees` NULL |
| **ACCOUNTING_PENDING** | **0** | 487 rows have `closed_at` set **and** `pl_usd IS NULL` (43 carrying a ticket, 444 not); the classifier files them as unknown/simulation and never counts them as losses, so none land in this bucket |
| **ACCOUNTING_ERROR** | **0** in classifier terms | The deployed endpoint reports these as `WARNING` — "Legacy result='CLOSED' rows are CLOSED trades with unrecorded profitability" (487 such rows) |
| SIMULATION (ticket-less / model rows) | **1,092** | Carries `pl_usd`, has no broker ticket |
| OPEN | **116** | Includes genuine closes mislabelled `trade_status='OPEN'` |
| CANCELLED | **62** | — |

Deployed self-report over the **120-day window** (`GET /api/production-integrity`, 240 rows) agrees:

```
analytics_population => WARNING
"14 broker executions | 0 net-complete | 14 gross-only | 95 simulated | 15 cancelled
 — net metrics are computed ONLY from net-complete executions"
commission_swap      => FAILED  "Complete net P&L requires commission AND swap from broker
                                  deal records. Until the EA supplies them net is unknowable"
net:   { basis: NET,   n: 0,  net: null,   confirmed: true  }   ← refuses to invent a net
gross: { basis: GROSS, n: 14, net: -23.86, confirmed: false }   ← correctly labelled provisional
```

### 5.2 The 30 numeric (genuine MT5) tickets — full inventory

Every one belongs to user `17035955…` and is XAU/USD. **28 closed, 2 open** (tickets `3252834056` and
`1058114016`, `result='CLOSED'`, `pl_usd IS NULL`).

| Metric | Value |
|---|---|
| Sum of `pl_usd` on the 28 closed numeric-ticket rows | **+274.93** |
| Rows with `commission` non-null | **0** |
| Rows with `swap` non-null | **0** |
| Rows with `other_fees` non-null | **0** |
| Rows with `net_realised_pnl` non-null | **0** |
| Newest realised close | `2026-11-12T02:36:05Z` — ticket `3454458505`, +3,368.50 |
| Previous close | `2026-11-12T02:27:00Z` — ticket `3454451953`, −175.50 |

The 14 GROSS_ONLY rows — the only rows the platform counts as broker-confirmed profitability:
5 wins / 9 losses, gross wins 4,430.50, gross losses 4,454.36, net −23.86, profit factor 0.9946,
max drawdown 3,706.86, longest losing streak 6.

### 5.3 Direct answers

| Question | Answer | Status |
|---|---|---|
| Number of broker executions | 141 rows with a ticket (30 genuine MT5, 111 UUID-broker) | **VERIFIED** |
| NET_COMPLETE records | **0** | **VERIFIED** |
| GROSS_ONLY records | **14** | **VERIFIED** |
| ACCOUNTING_PENDING records | **0** | **VERIFIED** |
| ACCOUNTING_ERROR records | **0** (classifier) / 487 legacy `result='CLOSED'` rows with unknown P&L | **VERIFIED** |
| Are commission and swap actually being received? | **No.** 0 of 1,284 rows carry either. No broker cost has ever reached the database | **VERIFIED (negative)** |
| Are partial closes being aggregated? | **Cannot be determined** — no `dealCount`/`partial`/`volume_closed` is stored, so a 3-leg close is indistinguishable from a single fill | **NOT VERIFIED** |
| Does broker net P&L match stored net P&L? | **Not testable.** There is no stored net P&L, and MT5 history lives on the VPS, unreachable from here. The only net figure the platform can produce (−23.86, gross-derived) has never been reconciled against a broker statement | **NOT VERIFIED** |
| Is the accounting pipeline fully verified? | **No.** It is wired end-to-end in source but has never carried a single broker cost value | **NOT VERIFIED** |

### 5.4 The "one genuine closure traced end-to-end" gate

**Not satisfied.** The most recent genuine closure (`3454458505`, 2026-11-12 02:36:05Z, +3,368.50) has
`pl_usd` and `exit_price` set but `commission`/`swap`/`other_fees`/`net_realised_pnl`/`accounting_complete`
all **NULL** — it is traceable trade-side, not accounting-side, because the EA that reported it (v9.3.x)
never transmitted costs. **Financial integrity cannot be claimed.**

---

## 6. Exact locations of the `pl_usd || 0` family of defects

Grep scope: `app/`, `components/`, `lib/`, `workers/`, `hooks/` — all fallback forms, case-insensitive.
Comments that *document* the defect (`lib/analytics-scope.mjs:9,16`, `lib/journal-stats.mjs:10,11,19`,
`components/pages/JournalPage.tsx:33`, `DashboardPage.tsx:56,60`) are listed separately in 6.3; they are
documentation, not live code.

### 6.1 Live occurrences, ranked by blast radius

| # | Location | Expression | Live | Affects |
|---|---|---|---|---|
| **D1** | `components/AppShell.tsx:157` | `todayTrades.reduce((s, t) => s + (t.pl_usd \|\| 0), 0)` | **YES — highest risk** | **Order eligibility + risk calculation + trade management** |
| **D2** | `components/pages/PropFirmPage.tsx:55` | `trades.reduce((s, t) => s + (t.pl_usd \|\| 0), 0)` | **YES** | **Prop-firm profitability, max-drawdown breach evaluation** |
| **D3** | `components/pages/PropFirmPage.tsx:54` | `trades.filter(closed today).reduce(s + (t.pl_usd \|\| 0))` | **YES** | Prop-firm **daily loss** evaluation |
| **D4** | `components/pages/PropFirmPage.tsx:60` | `.filter(t => t.closed_at && (t.pl_usd \|\| 0) > 0)` | **YES** | Best-day / consistency-rule calculation |
| **D5** | `app/api/admin/users/route.ts:40` | `userStats[t.user_id].totalPL += t.pl_usd \|\| 0` | **YES** | Admin dashboard performance |
| **D6** | `app/api/loss-diagnostics/route.ts:93` | `(row.pl_usd ?? 0) / (slPips * pipValue * (row.lots ?? 0.01))` | **YES** | Trade management — a LOSS with unknown P&L is diagnosed as **R = 0** instead of "unknown" |
| **D7** | `components/pages/DashboardPage.tsx:333-334` | `(t.pl_usd ?? 0) >= 0 ? green : red` and `currencySigned(t.pl_usd ?? 0, …)` | **YES** | Dashboard performance — renders **`$0.00`** for an unknown result **in green** |

### 6.2 Why D1 is the one that matters

```
components/AppShell.tsx:156-157
  const todayTrades = trades.filter(t => t.closed_at && new Date(t.closed_at).toDateString() === today)
  const todayPL = todayTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
        │
        ├─► hooks/useScanner.ts:46          context.todayPL
        │     └─► lib/indicators.ts:181     dailyLossOk = options.todayPL > -maxLossUSD
        │           └─► checklist gate — a FAILED check blocks the setup
        └─► lib/propfirm.ts:106             dailyLoss = Math.min(0, todayPL)
              └─► line 129  "Daily loss limit hit: … — trading blocked for today"
```

Two independent contaminations flow into that number:

1. **Unknowns become zero.** `todayTrades` filters only on `closed_at`; a row with `closed_at` set and
   `pl_usd IS NULL` contributes `0`. There are **487** such rows in the table. Every one of them is a
   closed trade whose result is *unknown* and is treated as *breakeven*.
2. **Simulation rows are counted as P&L.** `todayTrades` also picks up the **1,092 ticket-less model
   rows** (Σ `pl_usd` = **−2,019.59**). These are not broker executions at all, yet they move the gate
   that decides whether the broker account may trade.

Direction of risk: both contaminations are **permissive when the truth is a loss** — an unknown loss
reads as 0, so `dailyLossOk` stays `true` and the prop-firm block never fires. The failure mode is not a
wrong dashboard number; it is **the guard staying open after the limit is already breached**.

### 6.3 Checked and **not** a live defect (evidence of deliberate hardening)

| Location | Expression | Why it is safe |
|---|---|---|
| `app/api/orders/route.ts:275-276` | `s + (t.pl_usd \|\| 0)` | Both source queries carry `.not('pl_usd','is',null)` (lines 268, 270), so the fallback can never fire. **Correct, but fragile** — it depends on a filter 7 lines away; deleting that filter silently re-creates D1 inside the API |
| `lib/trade-accounting.mjs:258` | `d.netPnl ?? 0` | Guarded by `allComplete ? … : null`; returns `null` unless every deal has net P&L |
| `lib/brokers/mt5direct.adapter.ts:223`, `metaapi:114`, `capital:213`, `alpaca:106` | `p.profit \|\| 0`, `?? 0` | Unrealised marks for the *open* view; never persisted as realised accounting |
| `app/api/scalper/*`, `lib/counterfactual.ts` (`mfePips ?? 0`, `maePips ?? 0`) | excursion telemetry in pips | "No excursion observed" genuinely is 0 for these counters — not P&L |

### 6.4 The equivalent fallback families, and what each search found

| Pattern | Result |
|---|---|
| `pl_usd \|\| 0` | 4 live sites (D1, D2, D3, D5) + 1 guarded (`orders` route) + comments |
| `pl_usd ?? 0` | 2 live sites (D6, D7) |
| `plUsd \|\| 0`, `pnl \|\| 0`, `profit \|\| 0`, `netPnl \|\| 0` | Only broker-adapter unrealised marks and the guarded `trade-accounting.mjs:258` |
| **Gross P&L treated as net P&L** | **No live occurrence.** `lib/analytics-metrics.mjs` keeps `NET_CONFIRMED` and `GROSS_ONLY` in separate populations with separate labels; `netComplete:false` stops the net block from reporting at all (§5.1 output proves this at runtime) |
| **Incomplete accounting treated as a completed trade** | **Present — but via the classifier, not `\|\| 0`.** `classifyTrade` short-circuits on `trade_status === 'OPEN'` *before* checking financial completeness, so **36 genuinely closed rows** (`result='LOSS'`, `trade_status='OPEN'`, realised `pl_usd`) are labelled `OPEN` and dropped from every profitability figure. That is the mirror image of `\|\| 0` — a **real result treated as unknown** — but the same root cause: reading a status field for a meaning it does not carry |

### 6.5 D8 — the highest-severity site, and it is server-side

The complete fallback sweep only looks dangerous on the client. Tracing the **order-blocking path**
reveals a worse one that contains no `|| 0` at all:

```
app/api/orders/route.ts:267-268
  admin.from('trades').select('pl_usd').eq('user_id', userId)
       .gte('closed_at', today + 'T00:00:00').not('pl_usd', 'is', null)      ← NO broker_ticket filter
        │
        ▼
  app/api/orders/route.ts:349   runRiskGuards({ todayRealizedPL: todayPL, … })
        ▼
  lib/risk.ts:38                if (maxLossUSD > 0 && todayRealizedPL <= -maxLossUSD)
        ▼                         → { blocked: true, reason: "Daily loss limit hit …" }
  app/api/orders/route.ts:355   if (!isTradeAllowed(riskChecks)) → HTTP 422, order refused
```

`todayPL` here sums **every** closed row with a non-null `pl_usd` — including all **1,092 simulation
rows** (Σ **−2,019.59**) and the 111 UUID-broker rows. The null-exclusion is correct (unknowns are not
zeroed here), but the *population* is wrong: **model-generated losses can lock the live account**, and
`lib/risk.ts:38` is a **hard 422**, not one vote out of eight.

---

## 7. Financial and operational impact

### 7.1 Population mixing — the numbers

| Sum as computed today | Value | Meaning |
|---|---|---|
| Σ `pl_usd` over **all** rows (`\|\| 0`) — what `PropFirmPage:55` shows as all-time P&L | **−4,235.03** | mixes demo, live, simulation and unknown |
| Σ over rows with a `broker_ticket` | **−2,215.44** | still includes 111 UUID rows from a non-MT5 broker |
| Σ over the **30 genuine MT5 tickets** | **+274.93** | the only figure traceable to Fusion Markets / Exness |
| Σ over ticket-less simulation rows | **−2,019.59** | model artefacts, counted as trading results |

The prop-firm page therefore reports **−4,235.03** where the broker-verifiable answer is **+274.93** — a
**4,509.96** distortion, and a sign inversion.

### 7.2 Impact by function

| Function | Defect(s) | Impact |
|---|---|---|
| **Order eligibility** | **D8** | `todayPL` includes simulation rows → `lib/risk.ts:38` can return a **hard 422 "Daily loss limit hit"** driven by model P&L. With the live account at **12.36 GBP**, a 2 % daily limit is **~0.25 GBP**, so a *single* closed simulation row of the size seen historically (e.g. −963.50 on 2026-09-16) locks real trading for the rest of the day |
| **Order eligibility** | D1 | `todayPL` feeds `indicators.dailyLossOk`, one of 8 checks with `canTrade = passCount >= 6` (`lib/indicators.ts:186`). Because unknowns become 0 and simulations are folded in, the vote is unreliable in both directions |
| **Risk calculations** | D8, D2, D4 | `maxDailyPLEver` (consistency rule) and total drawdown are computed from the mixed population; a simulation win can mask a real drawdown |
| **Trade management** | D6 | A losing trade with unknown P&L is diagnosed at **R = 0**, suppressing the loss-diagnosis path instead of flagging "accounting incomplete" |
| **Dashboard performance** | D7 | Unknown results render as **green `$0.00`** — a closed trade with no known outcome is displayed as a breakeven, win-coloured row |
| **Profitability** | none live | Correctly hardened in 4.2C: `net` returns `null` with `n=0`; `gross` is labelled `confirmed:false`. **No gross-as-net leak found** |
| **Reconciliation** | §4.4 | A close during an EA/VPS restart is never reported (`g_prevPosCount == 0 → return "[]"`); and the 10-minute reconciliation cron cannot run on the DO worker (`CRON_SECRET` absent from `.do/app.yaml`), so missed closes are not back-filled either |
| **Financial reporting integrity** | §5 | 0 of 1,284 rows carry a broker cost. Every net figure the platform could show is unknowable, and the one endpoint that says so (`commission_swap => FAILED`) is correct to do so |

### 7.3 What has *not* been harmed

Nothing in this review indicates corrupted or fabricated broker data. `pl_usd`, `exit_price` and
`broker_ticket` on the 30 genuine tickets are internally consistent, no ticket is duplicated, and the
verdict surfaces that matter (`NET_CONFIRMED` / `GROSS_ONLY`) are honest. The risk is *misclassification
and mixed populations*, not invented numbers — with one exception: **the `|| 0` fallbacks do invent a
number (0) for an unknown outcome**, which is why the impact is framed as permissive.

---

## 8. Safe recommended fixes — prepared, NOT applied

Every patch below preserves all strategy, risk, lot-size, execution and Trade Authority settings:
**no threshold, percentage, lot or authority rule is touched.** They change which *rows* are summed and
what happens to an *unknown* value. Ordered by risk-reduction per line changed.

### P-A — D8: scope the server-side order guard to broker executions *(3 lines, highest value)*

`app/api/orders/route.ts`, lines 267–272:

```diff
-          admin.from('trades').select('pl_usd').eq('user_id', userId)
-            .gte('closed_at', today + 'T00:00:00').not('pl_usd', 'is', null),
+          admin.from('trades').select('pl_usd').eq('user_id', userId)
+            .gte('closed_at', today + 'T00:00:00').not('pl_usd', 'is', null)
+            .not('broker_ticket', 'is', null),
-          admin.from('trades').select('pl_usd, closed_at').eq('user_id', userId).not('pl_usd', 'is', null),
+          admin.from('trades').select('pl_usd, closed_at').eq('user_id', userId)
+            .not('pl_usd', 'is', null).not('broker_ticket', 'is', null),
-          admin.from('trades').select('closed_at').eq('user_id', userId).not('closed_at', 'is', null),
+          admin.from('trades').select('closed_at').eq('user_id', userId)
+            .not('closed_at', 'is', null).not('broker_ticket', 'is', null),
```

**Trade-off the owner must decide:** this makes the guard measure *broker reality*. A user who trades
only paper (no ticket) would then have no daily-loss protection. If paper trading must stay protected,
scope on `submission_source` / `execution_contract_version` instead. Thresholds are untouched either way.

### P-B — D1: make the client daily P&L scope-aware and unknown-aware

`components/AppShell.tsx`, lines 154–157:

```diff
   const today = new Date().toDateString()
   const todayTrades = trades.filter(t => t.closed_at && new Date(t.closed_at).toDateString() === today)
-  const todayPL = todayTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
+  // Phase 4.2D — only broker executions move the daily-loss gate, and an
+  // unknown result must stay unknown rather than becoming a zero-profit day.
+  const todayExecuted = todayTrades.filter((t: any) => isGenuineExecution(t))
+  const todayUnknown  = todayExecuted.filter((t: any) => typeof t.pl_usd !== 'number').length
+  const todayPL = todayUnknown > 0
+    ? null
+    : todayExecuted.reduce((s: number, t: any) => s + t.pl_usd, 0)
```

`isGenuineExecution` is already exported from `lib/analytics-scope.mjs:74`, and the client already
receives every column (`app/api/trades/route.ts:19` uses `select('*')`), so this needs one added import
and no type changes.

### P-C — make `dailyLossOk` refuse to pass on an unknown day *(: must ship with P-B)*

`lib/indicators.ts`, lines 151 and 181:

```diff
-    todayPL: number
+    todayPL: number | null
...
-  const dailyLossOk   = options.todayPL > -maxLossUSD
+  // Phase 4.2D — an UNKNOWN daily P&L is not a passing daily P&L.
+  const dailyLossOk   = typeof options.todayPL === 'number' && options.todayPL > -maxLossUSD
```

**Without P-C, P-B actively enables trading**: `null > -100` evaluates to `true` in JavaScript because
`null` coerces to 0. These two must be reviewed and shipped as a pair. `hooks/useScanner.ts:46` also
needs `todayPL: number | null` in its context type.

### P-D — D2/D3/D4: fail closed in the prop-firm evaluator

`lib/propfirm.ts`, line 95 and lines 106–129:

```diff
-  todayPL: number,
+  todayPL: number | null,
...
-  const dailyLoss = Math.min(0, todayPL)
+  const dailyPLKnown = typeof todayPL === 'number'
+  const dailyLoss = dailyPLKnown ? Math.min(0, todayPL) : 0
...
-  if (dailyLossLimitHit) {
+  if (!dailyPLKnown) {
+    blockReasons.push('Daily P&L is not yet known for a closed execution today — the daily loss limit cannot be evaluated, so entries are blocked until accounting completes')
+  } else if (dailyLossLimitHit) {
```

### P-E … P-H — display and diagnostic honesty *(no gating impact)*

| Patch | File | Change |
|---|---|---|
| P-E | `components/pages/PropFirmPage.tsx:53-60` | same `isGenuineExecution` + unknown-→`null` scoping as P-B; `allTimePL` becomes `null` when any genuine close is unknown |
| P-F | `components/pages/DashboardPage.tsx:333-334` | render `'—'` and a neutral colour when `t.pl_usd === null`, instead of `currencySigned(0)` in green |
| P-G | `app/api/loss-diagnostics/route.ts:92-94` | `Number.isFinite(row.pl_usd) ? row.pl_usd / (…) : null` → "R unknown", not R 0 |
| P-H | `app/api/admin/users/route.ts:40` | `if (typeof t.pl_usd === 'number') totalPL += t.pl_usd` plus an `unknownPL` counter displayed beside it |

### P-I — persist the partial-close proof *(schema migration — approval required)*

Add `deal_count int`, `volume_closed numeric`, `partial_close boolean` to `trades`, and write
`v_cp_deals` / `volumeClosed` / `v_cp_partial` in `mt5_webhook_sync`. Without this, partial-close
aggregation can never be evidenced from the database (§2.5). **Only change requiring a migration.**

### P-J — EA restart recovery *(recompile + redeploy the EA — approval required)*

Replace the `if(g_prevPosCount == 0) return "[]";` early return (v9.4 line 246) with a bounded
deal-history sweep, so a close that happens across a restart is still reported.

**Sequencing:** P-C + P-B as one unit → P-A → P-D → P-E…P-H. P-I and P-J are separate decisions and
should not be bundled with a verification-driven fix. **Nothing above has been applied.**

---

## 9. What remains unverified

| # | Unverified item | Why it cannot be closed from here | How it closes |
|---|---|---|---|
| U1 | Deployed `mt5_webhook_sync` body == `20261113` | `pg_proc` unreachable; and the change is a provable no-op for v1 payloads, so no data can reveal it | §3.2 `md5(prosrc)` query — **one read-only query** |
| U2 | Phase 4.1 trigger `trades_derive_accounting_trg` exists and derives net correctly | `pg_trigger`/`pg_proc` unreachable; 0 rows have ever exercised it | `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='public.trades'::regclass;` + one real close |
| U3 | `SECURITY DEFINER` + `SET search_path = public` survive deployment | `prosecdef` / `proconfig` unreachable | Included in the §3.2 query |
| U4 | `GRANT EXECUTE … TO authenticated` | No user JWT available; `anon` is verified behaviourally | `proacl` in the §3.2 query |
| U5 | Whether the VPS terminal runs EA **v9.4** | `eaVersion` is dropped by the fixed-key write-back, `openPositions` JSON is identical across versions, and no close has occurred since 2026-11-12 to expose v2 costs | Next genuine close: `commission`/`swap` non-null ⇒ v9.4 live. Or read the `Experts` log on the VPS |
| U6 | Whether partial closes are aggregated correctly | `dealCount`/`partial`/`volumeClosed` are parsed and discarded (§2.5) | P-I (needs approval) + one partial close reconciled against MT5 history |
| U7 | Broker net P&L == stored net P&L | No stored net P&L exists; MT5 history is on the VPS | First v2 close, reconciled line-by-line against MT5 account history |
| U8 | The 10-minute reconciliation cron | `CRON_SECRET` absent from `.do/app.yaml`; only the Vercel `0 4 * * *` cron runs | Add the secret to the worker env (permission change — needs approval) |
| U9 | EA restart-close recovery (line 246) | Source-level gap; no restart was traced in available data | Log correlation on the VPS across a restart |

**None of U1–U9 can be closed by fabricating a trade or applying a migration**, which is why no such
action was taken.

---

## 10. Final production-readiness verdict

### 10.1 Status summary

| Area | Status |
|---|---|
| Phase 4.1 — columns | **VERIFIED** |
| Phase 4.1 — trigger, indexes, permissions, behaviour | **NOT VERIFIED** |
| Phase 4.2 — file integrity, signature compatibility, v1 no-op property | **VERIFIED** |
| Phase 4.2 — deployed body matches the file | **NOT VERIFIED** (decidable via §3.2) |
| Phase 4.2 — processes gross/commission/swap/fees/net separately (source) | **VERIFIED** |
| Phase 4.2 — same, at runtime | **NOT VERIFIED** (0 of 1,284 rows) |
| Partial-close aggregation | **NOT VERIFIED** (and unprovable until P-I) |
| Duplicate ingestion prevention | **VERIFIED** (0 duplicates / 141 tickets) |
| RPC grants — `anon` | **VERIFIED** (live EA traffic) |
| RPC grants — `authenticated` | **NOT VERIFIED** |
| EA version v9.4 | **NOT VERIFIED** |
| EA → Supabase → RPC ingestion path | **VERIFIED** (4–5 s freshness; prices/candles/positions flowing) |
| Genuine broker accounting (commission/swap received) | **FAILED** — nothing ever received |
| Net P&L reconciled against broker history | **NOT VERIFIED** |
| `pl_usd \|\| 0` defect family — locations identified | **VERIFIED** (D1–D8) |
| Gross-as-net leak | **NOT APPLICABLE** (no live occurrence; hardened in 4.2C) |
| Order-gating population integrity | **FAILED** — D8 mixes 1,092 simulation rows into a hard-422 gate |

### 10.2 Verdict

> **PARTIALLY VERIFIED — NOT PRODUCTION-READY FOR FINANCIAL INTEGRITY.**

The schema work of Phase 4.1 and the accounting *design* of Phase 4.2 are sound, well-hardened and
internally consistent; the ingestion pipeline is alive and the EA v9.4 payload contract matches the RPC
field-for-field. But three independent facts stand between this system and a defensible claim of
financial integrity:

1. **No broker cost has ever reached the database.** 0 of 1,284 rows carry `commission`, `swap` or
   `other_fees`; `NET_COMPLETE` is 0. Net profitability is unknowable, and the platform correctly
   refuses to state one.
2. **The order gate is fed by the wrong population.** `app/api/orders/route.ts:267-270` sums 1,092
   simulation rows into the daily realised P&L that drives a **hard 422 block** in `lib/risk.ts:38`, and
   the client paths additionally convert unknown outcomes into zero.
3. **The closure that would settle it has not happened yet.** The most recent genuine close
   (`3454458505`, 2026-11-12T02:36:05Z, +3,368.50) predates any v2 payload and carries no cost data, so
   no closure has been traced end-to-end and reconciled against broker history.

**Financial integrity is therefore not claimed.** Equally, the Phase 4.2 migration should be marked
neither *outstanding* nor *verified* on the strength of this report: §3.2 settles that question in one
read-only query, and the accounting question is settled only by the first genuine closure after EA v9.4
is confirmed running — reconciled against the broker's own statement.

### 10.3 Immediate, zero-risk actions for the owner

1. Run the §3.2 query in the Supabase SQL editor (read-only, ~1 s) and record `body_md5`.
2. Deploy the v9.4 binary to the VPS and confirm the loaded build in the terminal's `Experts` tab.
3. Freeze: no new migrations and no code deploy until one genuine closure has landed.
4. Approve or reject P-C + P-B as a pair, then P-A — the three smallest changes that stop unknown results
   and simulation rows from influencing whether the live account may trade.

---

## Appendix — reproducibility

| Evidence | Command / source |
|---|---|
| Ingestion freshness, configs, `openPositions` | PostgREST `GET /rest/v1/broker_configs` |
| Population counts, 30-ticket inventory, duplicate check | PostgREST `GET /rest/v1/trades` + `lib/analytics-scope.mjs:classifyTrade` |
| Live integrity self-report | `curl https://forex.sybexdesigns.co.uk/api/production-integrity` |
| RPC signature | PostgREST OpenAPI at `GET /rest/v1/` (definitions → `rpc/mt5_webhook_sync`) |
| Body fingerprints | `md5(text between 'AS $$' and '$$;')` of each migration file |
| Fallback sweep | `grep -rn -E '(pnl\|profit\|pl_usd\|plUsd\|netPnl\|loss)[A-Za-z_]*[[:space:]]*(\|\|\|\?\?)[[:space:]]*0\b' app components lib workers hooks` |
| P&L gate chain | `AppShell.tsx:157 → useScanner.ts:46 → indicators.ts:181` and `orders/route.ts:267 → risk.ts:38 → 422` |

*Report generated without creating, modifying or deleting any production record. No migration applied,
no deployment performed, no RPC invoked with a valid token.*
