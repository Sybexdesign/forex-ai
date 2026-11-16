# PHASE 4.2.1 — PRODUCTION VERIFICATION PROCEDURE

**Status of this document:** a *procedure*, not a result. Nothing in it has been executed against production
from this session, because this work was performed in a repository without database or terminal access. Every
item states what to run, what a pass looks like, and what a **fail would mean**, so a reader cannot mistake an
empty result for a green tick.

**Rule for the whole document:** copy the raw output. A summary that cannot be re-derived from pasted
evidence is an opinion, and this phase exists because opinions were accepted as evidence.

---

## 1. Is the deployed RPC the Phase 4.2 body? (the md5(prosrc) probe)

The accounting fix lives in `public.mt5_webhook_sync`
(`supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql`). A migration *existing in the
repository* does not prove the function *in production* is that body: `pg_proc`-based probes previously
returned HTTP 404/406 for this project, so the deployed text has never been compared. The comparison is a
hash of the function source.

**Run (Supabase SQL editor, service role):**

```sql
-- 1a. Does the function exist, and is the deployed body the 4.2 body?
select p.oid::regprocedure                                  as signature,
       md5(p.prosrc)                                        as deployed_md5,
       length(p.prosrc)                                     as source_len,
       (p.prosrc like '%v_payload_version >= 2%')            as reads_payload_version,
       (p.prosrc like '%v_cp_commission IS NOT NULL%')       as gates_net_on_commission,
       (p.prosrc like '%v_cp_swap IS NOT NULL%')             as gates_net_on_swap,
       (p.prosrc like '%COALESCE(v_cp_fee, 0)%')             as coalesces_only_fee
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'mt5_webhook_sync';
```

**Pass looks like:** exactly one row; all four boolean columns `true`. Record `deployed_md5` — it is the value
future deployments must be compared against.

**Fail means:** the function is missing (`0 rows`) or is a pre-4.2 body (`source_len` far below the repository
file, any boolean `false`). In that case **no conclusion about C-1 is admissible** — the EA cannot produce a
net figure through a function that does not compute one, and the migration must be applied first.

```sql
-- 1b. Are the Phase 4.1/4.2 columns present? (a 42703 error voids every downstream claim)
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'trades'
   and column_name in ('commission','swap','other_fees','net_realised_pnl','accounting_complete',
                       'accounting_missing','realised_r','broker_ticket','execution_contract_version',
                       'submission_source','authority_decision','authority_reason',
                       'authority_policy_version','request_id','submitted_at','submitted_by',
                       'requested_entry_price','prediction_log_id','setup_id','trade_status','trade_result');
```

**Pass looks like:** 21 rows. Note which are absent — an absent audit column is why
`app/api/orders/route.ts` inserts with a documented fallback, and it must be reported, not assumed.

---

## 2. C-2 — is the scheduler actually running?

This is the one defect where the code is already correct and the *deployment* is not.

```sql
-- 2a. Freshness of the derived layer.
select max(updated_at)                                  as last_refresh,
       now() - max(updated_at)                          as age,
       count(*) filter (where execution_id is not null)  as execution_linked,
       count(*)                                          as rows
  from public.outcome_reconciliation;
```

**Pass:** `age` < 15 minutes with `execution_linked > 0`.
**On 2026-11-13 the observed value was `age ≈ 4.4 h` with the row count pinned — a fail.**

```bash
# 2b. Does the refresh endpoint accept the configured secret?
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/outcome-reconciliation/refresh?windowDays=2"
```

| Response | Meaning |
|---|---|
| `200` | secret matches; the scheduler can authenticate |

---

## 3. C-1 — has any net P&L ever been produced?

```sql
-- 3a. The accounting gate, as the database sees it.
select count(*)                                                             as rows_total,
       count(commission)                                                    as commission_present,
       count(swap)                                                          as swap_present,
       count(other_fees)                                                    as fee_present,
       count(net_realised_pnl)                                              as net_present,
       count(*) filter (where accounting_complete is true)                   as net_complete_rows,
       count(*) filter (where execution_contract_version = 'execution_v1')   as v1_contract_rows
  from public.trades;
```

**On 2026-11-13 every count except `rows_total` was 0.** Until `net_complete_rows > 0` **and** the row
reconciles against the MT5 deal report, C-1 is **NOT VERIFIED** — the platform correctly refuses to state a
net figure, and that refusal is not a pass.

```sql
-- 3b. The first v2 close, once one exists: does the stored net equal the broker's arithmetic?
select id, broker_ticket, opened_at, closed_at,
       pl_usd as gross, commission, swap, other_fees,
       round(pl_usd + commission + swap + coalesce(other_fees, 0), 2) as recomputed_net,
       net_realised_pnl, accounting_complete, accounting_missing
  from public.trades
 where accounting_complete is true
 order by closed_at desc
 limit 5;
```

**Pass:** `net_realised_pnl = recomputed_net` for the row, and the same three figures appear on the MT5
terminal's deal report for that position. Paste both.

---

## 4. H-4 / P-J — is the deployed EA build v9.5, and did recovery run?

```sql
-- 4a. Which build is stored? (A-7: the version now rides INSIDE openPositions)
select updated_at,
       account_configuration -> 'openPositions' -> 0 ->> 'eaVersion'                       as ea_version,
       account_configuration -> 'openPositions' -> 0 ->> 'executionPayloadVersion'         as payload_version,
       jsonb_array_length(coalesce(account_configuration -> 'openPositions', '[]'::jsonb)) as open_positions
  from public.broker_configs
 order by updated_at desc
 limit 5;
```

**Pass:** `ea_version = 9.50` on the account running the EA. **A flat account returns `null` here even on
v9.5** — that is the A-7 limitation, and it must be reported as *unverifiable from stored state*, never as
"old build". The terminal's Experts log is the authority:

```text
SybexForexAI EA v9.5 started | FillMode=...        <- proves the compiled EX5 is v9.5
[recovery] watermark for SYBEX_LASTCLOSE_<login>_<magic> = <timestamp>
[recovery] N close(s) recovered from deal history  <- or: no undelivered closes since <timestamp>
```

Behavioural test: open a position, restart the terminal before it closes, let it close while the terminal is
down, then start the terminal. **Pass:** the row still closes and is labelled recovered. **When P-I is
applied,** `close_provenance = 'ea_recovered'` is the machine-checkable form of that label.

---

## 5. H-1 / M-1 — does the corrected population match production?

```sql
-- 5a. The stale-status rows H-1 is about.
select trade_status, result, count(*), round(sum(pl_usd)::numeric, 2) as pl
  from public.trades
 where closed_at is not null
   and trade_status = 'OPEN'
 group by 1, 2
 order by 3 desc;
```

**Pass:** the rows returned here are the ones the UI now counts (they are no longer `OPEN`). Cross-check the
displayed window P&L against `sum(pl_usd)` over
`closed_at is not null and (result in ('WIN','LOSS','CLOSED') or trade_status = 'CLOSED')`.

```sql
-- 5b. The ticket-kind split M-1 is about.
select case when broker_ticket ~ '^[0-9]{1,20}$'                     then 'MT5_POSITION'
            when broker_ticket is null or btrim(broker_ticket) = ''  then 'NONE'
            else 'OTHER_BROKER_REF' end                             as kind,
       count(*)
  from public.trades
 group by 1
 order by 2 desc;
```

**Expected on the 2026-11 data:** `NONE ≈ 1143`, `OTHER_BROKER_REF ≈ 111`, `MT5_POSITION ≈ 30`. Any
"MT5-confirmed executions" claim must quote the third number, never the sum of the first two.

| `401` | secret configured but does not match — the worker's value differs |
| `503` | `CRON_SECRET` is **not set in that runtime** — this is C-2 itself |

Then look for the defect's own signature in the worker log:

```bash
grep -c "Outcome reconciliation refresh BLOCKED: CRON_SECRET not set on the worker" <worker log>
```

**Pass:** `0`. **On 2026-11-13 there were 36 such lines, the latest at 08:07:25Z.**

---

## 6. P-A / GATE-1 — does the order guard refuse an unknown day?

The behaviour is proven by test (`npm run test:phase421`). In production it is observable in logs and in the
response body:

```bash
# 6a. Any refusals recorded?
grep -c "UNKNOWN DAILY P&L" <deployment function log>
```

```jsonc
// 6b. What the order endpoint now discloses about its own evidence:
{
  "riskScope": {
    "todayPL": -123.45,          // a number when known, null when the day is unknown
    "todayUnknownPLRows": 0,
    "allTimePL": -1234.5,
    "allTimeUnknownPLRows": 0
  }
}
```

**Pass:** `todayUnknownPLRows > 0` is always accompanied by a refusal
(`code: "DAILY_PL_UNKNOWN"`, HTTP 422), never by a permitted order.
**Fail:** an order is accepted while `todayPL` is `null`.

---

## 7. M-6 — the reconciliation threshold (owner-gated, off by default)

```bash
# 7a. What the integrity endpoint says it used.
curl -sS "<deployment>/api/production-integrity" | jq '.reconciliation | {ageHours, warnHours, status}'
```

**Before opt-in:** `warnHours` must be `6` — identical to the pre-4.2.1 behaviour, nothing changed.
**After setting `RECON_STALE_WARN_HOURS=0.5`:** `warnHours` must be `0.5`, and a layer 4.4 h stale must read
`WARNING`. An invalid value must fall back to `6`, never to a more permissive number.

---

## 8. What cannot be verified from production either

| Item | Why |
|---|---|
| M-2 historical backfill | `trades.setup_id` / `prediction_log_id` are NULL on every historical row and the linking evidence does not exist. Inventing it would be fabrication, so it stays NULL and the lineage counts stay low. |
| C-1 net proof before a deploy | Requires a genuine broker close through the v2 payload. Nothing else can produce it. |
| A-9 payload-level cost evidence | `openPositions` carries no cost terms, so "ingestion is live" is not "accounting is live". Recorded as a limitation, not measured as a pass. |
| All-time P&L completeness | PostgREST caps reads at 1000 rows; the response now discloses unknown rows within the window it read and does not claim completeness beyond it. |

---

## 9. Sign-off table (to be completed by the owner, not by this document)

| # | Check | Where | Expected | Observed | Date | Verdict |
|---|---|---|---|---|---|---|
| 1 | Deployed RPC is the 4.2 body | §1 1a | one row, four booleans true | | | |
| 2 | Audit columns present | §1 1b | 21 rows | | | |
| 3 | Reconciliation fresh | §2 2a | age < 15 min | | | |
| 4 | Refresh authenticates | §2 2b | `200` | | | |
| 5 | Worker secret warnings | §2 grep | `0` | | | |
| 6 | Any net-complete row | §3 3a | `net_complete_rows > 0` | | | |
| 7 | Net reconciles to broker | §3 3b | equal | | | |
| 8 | EA build identified | §4 4a + log | `9.50` | | | |
| 9 | Recovery ran | §4 log | `[recovery]` line | | | |
| 10 | Stale-status rows are counted | §5 5a | matches UI | | | |
| 11 | Ticket kinds split | §5 5b | 1143 / 111 / 30 | | | |
| 12 | Unknown day blocks orders | §6 | 422 + no order | | | |
| 13 | Threshold default unchanged | §7 | `warnHours = 6` | | | |

**Until rows 1–7 carry pasted output, the phase verdict stays
`PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED`.**

