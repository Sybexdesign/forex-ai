# PHASE 4.2.1 — OWNER ACTIONS

**Purpose.** Everything in this phase that cannot be closed from a repository. Each item states what to do,
how to confirm it worked, and what breaks if it is skipped. None of it is a suggestion: these are the
outstanding reasons the phase verdict is `PARTIALLY IMPLEMENTED` rather than `CLOSED`.

Order matters — §1 before §5 (a threshold without a scheduler is noise) and §2 before §3 (recovery must ship
inside the deployed build, not after it).

---

## §1 — Set `CRON_SECRET` on the VPS worker (closes the environment half of C-2)

**Why.** `outcome_reconciliation.updated_at` was pinned while the worker logged
`Outcome reconciliation refresh BLOCKED: CRON_SECRET not set on the worker` **36 times**, latest
`2026-11-13T08:07:25Z`. Every derived analytical figure in the product is computed from that stale layer. The
code is correct and fails closed; the *deployment* has no secret.

**Do.**

1. Generate a value once and never commit it: `openssl rand -hex 32`
2. Set the **same** value in both places:
   - Vercel → Project → Settings → Environment Variables → `CRON_SECRET` (Production), then redeploy.
   - The VPS worker's environment (systemd unit / `.env` / compose file — whichever it reads), then restart
     the worker so it re-reads its environment.
3. Confirm the worker's scheduler is enabled (it writes `workerSchedulerVerified = 1` to its status).

**Confirm.**

- `curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/outcome-reconciliation/refresh`
  returns `200` — not `401`, not `503`.
- `select now() - max(updated_at) from outcome_reconciliation;` shows < 15 minutes.
- Worker log grep for the BLOCKED line returns `0`.

**If skipped.** C-2 stays open, M-6 cannot be tightened (§5), and every "current" figure remains a figure
from an unknown past.

---

## §2 — Deploy EA v9.5 (closes H-4, and is the prerequisite for C-1)

**Why.** Closures are detected by comparing "what was open at the last snapshot" with "what is open now". A
restart, a reconnect or a weekend gap empties that snapshot, so a position that closed while the terminal was
down was **never reported**: the row stayed `OPEN`, the realised loss never reached `pl_usd`, and the
daily-loss limit never saw it. v9.5 adds `RecoverOfflineCloses()` with a persisted per-account watermark.

**Do.**

1. Compile `public/SybexForexAI_EA_v9.5.mq5` in MetaEditor. No compiler exists in this repository, which is
   why the source is reviewed statically only.
2. Verify the compile log shows **0 errors, 0 warnings** for the file. If a warning appears, paste it rather
   than suppressing it.
3. Confirm `#property version "9.50"` shows in MetaTrader → EA Properties → Version.
4. Attach v9.5 to **both** accounts, replacing v9.4. Remove v9.4 — do not run both.
5. Allow WebRequest for the Supabase RPC URL if the terminal prompts.

**Confirm.**

- Experts log contains `SybexForexAI EA v9.5 started`.
- Experts log contains `[recovery] watermark for SYBEX_LASTCLOSE_<login>_<magic> = <timestamp>`.
- Behavioural test: open a position, **restart the terminal before it closes**, let it close while the
  terminal is down, start the terminal again → the row still closes and the log shows
  `[recovery] N close(s) recovered from deal history`.
- `select account_configuration -> 'openPositions' -> 0 ->> 'eaVersion' from broker_configs;` reads `9.50`
  while a position is open. A flat account stores no entries — see §6, A-7.

**If skipped.** Restarts keep hiding losses, and a drawdown can pass unrecorded.

---

## §3 — Produce one genuine net-complete close (closes C-1)

**Why.** No row in the database has `commission`, `swap` or `net_realised_pnl`; the accounting branch has never
executed in production. One real close through the v2 payload is the only evidence that can close C-1.
**Fabricating a trade to close it would be a worse failure than the defect.**

**Do.**

1. Complete §1 and §2 first — the deployed RPC must be the Phase 4.2 body
   (`PHASE42_1_PRODUCTION_VERIFICATION.md` §1.1a).
2. Take **one** position on the account running v9.5 and let it close naturally (TP, SL or manual).
3. Do not edit the resulting row.

**Confirm.**

- `select net_realised_pnl, accounting_complete, accounting_missing from trades where id = '<row>';` shows a
  finite net and `accounting_complete = true`.
- The same gross / commission / swap figures appear on the MT5 terminal's deal report for that position.
- `select count(*) filter (where accounting_complete is true) from trades;` is now `> 0`.

**If skipped.** C-1 stays **BLOCKED**. The product still cannot state a net figure, so a break-even strategy
still looks profitable on a gross basis.

---

## §4 — Apply the P-I partial-close migration (optional; closes the C-1 *evidence* gap)

**Why.** `supabase/prepared/20261114_phase421_partial_close_proof.sql` is **prepared, not applied** and sits
deliberately outside `supabase/migrations/`. It stores `deal_count`, `volume_closed`, `partial_close`,
`deal_tickets` and `close_provenance` so that "accounting is complete" can be *audited* rather than trusted.
Without it, the database cannot distinguish a one-deal close from a six-leg partial close.

**Do.**

1. Review the file. It is additive: five nullable columns, three CHECK constraints, one read-only view.
2. Apply it during a quiet window. It rewrites, backfills and deletes nothing, and it does not touch
   `trades_derive_accounting_trg`, so **no row can change analytics population**.
3. Note: the ingestion path does not yet write the new columns (that wiring is a separate change). Until it
   does, the columns stay NULL, which reads as "evidence not recorded" — never as "zero deals".

**Confirm.**

- `select * from v_partial_close_audit limit 20;` returns only rows where evidence disagrees with itself.
- `select count(*) from trades where deal_count is not null;` stays `0` until the ingest wiring lands. That is
  expected and must not be reported as a failure of the migration.

**If skipped.** Nothing breaks. C-1 remains provable only by manual reconciliation against the MT5 report.

---

## §5 — Tighten the reconciliation threshold **after** §1 (closes M-6)

**Why.** The endpoint reported `reconciliation_refresh: HEALTHY` at 4.4 h against a 10-minute design. The
strict value is shipped but **not activated**, because a permanently red monitor before the scheduler works
teaches the reader to ignore it.

**Do.** Only after §1 is confirmed working, set `RECON_STALE_WARN_HOURS=0.5` in Vercel (Production) and
redeploy.

**Confirm.**

- `/api/production-integrity` reports `reconciliation.warnHours = 0.5`.
- A layer 4.4 h stale reads `WARNING`, not `HEALTHY`.

**If skipped.** M-6 stays open (owner-gated). Nothing is worse than before — that is the point of the gate.

---

## §6 — Decisions this phase deliberately did not make

| # | Decision | Why it is yours, not the engineer's | Default if you do nothing |
|---|---|---|---|
| **A-8** | Authorising `POST`/`PATCH /api/trades` (today: an arbitrary body, no user scoping) | It changes **who may write** trade records — a product/security decision, not a defect fix. Implementing it unasked would be an unapproved behaviour change. | Unchanged: any caller can write. Recorded as a known gap. |
| **M-5 phase 2** | Mandatory authentication on `GET /api/trades` (today: opportunistic — a supplied token must match, but none is required) | Enforcing a session breaks `hooks/useForex.ts` and `AutoTradePage.tsx`, which fetch without an `Authorization` header. Those callers must be converted first. | Unchanged: unauthenticated reads still work; a mismatched token is refused with 403. |
| **M-1 count** | Re-basing the displayed "broker executions" count from 141 to 30 MT5 tickets | It moves 111 rows between populations in every consumer — a reporting change needing its own approval, not a silent correction. | The count is unchanged; `mt5TicketExecutions` (30) is available beside it and must be quoted for any MT5 claim. |
| **L-4** | Re-enabling the dormant Journal page | Navigation and user-facing features are out of scope for a remediation phase. | Page stays unmounted; its module and tests stay live and honest. |
| **M-2 backfill** | Populating historical `setup_id` / `prediction_log_id` | The linking evidence does not exist in the data. A guess would be indistinguishable from a fact. | Columns stay NULL; lineage counts stay low, and are reported as low. |

---

## §7 — What "done" looks like

| Defect | Closes when |
|---|---|
| C-1 | §1 + §2 + one genuine close (§3), net reconciled against the MT5 deal report |
| C-2 | §1 confirmed: `200` from the refresh, freshness < 15 min, 0 BLOCKED lines in the worker log |
| H-4 | §2 confirmed: v9.5 start-up line, and a close survives a terminal restart |
| M-6 | §1 then §5: `warnHours = 0.5`, a 4.4 h-stale layer reads `WARNING` |
| Everything else | Already closed by code + regression test in this repository (`npm run test:phase42`) |

Then re-run `PHASE42_1_PRODUCTION_VERIFICATION.md` §9 and replace the verdict with the observed state. Until
that table carries pasted output, the honest verdict is
**PARTIALLY IMPLEMENTED — OWNER ACTIONS REQUIRED**.

