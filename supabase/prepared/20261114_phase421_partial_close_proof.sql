-- SybexForexAI - PHASE 4.2.1 PATCH P-I - PERSIST PARTIAL-CLOSE PROOF
--
-- STATUS: **PREPARED - NOT APPLIED.** This file deliberately lives outside
-- `supabase/migrations/` so it cannot be picked up as part of the applied
-- sequence. Applying it is an owner action (see PHASE42_1_OWNER_ACTIONS.md §4).
--
-- WHY THIS PATCH EXISTS
-- A position does not always close in one deal. A partial close emits one
-- DEAL_ENTRY_OUT per leg, a stop-out emits DEAL_ENTRY_OUT_BY, and a reversal
-- emits DEAL_ENTRY_INOUT. EA v9.4 aggregates every deal and already transmits
--     dealCount, dealTickets, volumeClosed, partial
-- ... but the database keeps NONE of them. `trades` stores the aggregate money
-- (pl_usd / commission / swap / other_fees) and nothing about HOW MANY deals
-- produced it.
--
-- THE DEFECT THIS EXPOSES (C-1 evidence chain)
-- A single net P&L number cannot distinguish a position that closed cleanly in
-- one deal from one that closed in six partial legs, because both arrive as one
-- row with one sum. So "accounting is complete" rests on a claim the database
-- cannot audit: nothing in the row proves the aggregation was seen, only that
-- some numbers arrived. When a reviewer asks "was this the whole close?", the
-- answer is currently unprovable.
--
-- WHAT THIS ADDS
--   1. `trades.deal_count`, `volume_closed`, `partial_close`, `deal_tickets`
--      — the evidence, stored beside the money it justifies.
--   2. `trades.close_provenance` — 'ea_observed' | 'ea_recovered' | NULL.
--      'ea_recovered' means the close arrived via P-J restart recovery, so a
--      reviewer can see it was not seen live and weight it accordingly.
--   3. A read-only view `v_partial_close_audit` listing every close whose stored
--      evidence disagrees with itself. A disagreement is a data-quality finding,
--      never a silent correction.
--
-- SAFETY / IMPACT
--   * Additive only: no existing column, row, index, trigger or function is
--     dropped or altered. Every new column is nullable with no default, so
--     existing rows keep NULL — which reads as "evidence not recorded", never
--     as "zero deals".
--   * No backfill. Historical rows cannot be given evidence that was never
--     captured, and inventing it would be fabrication.
--   * No change to `trades_derive_accounting_trg`: `accounting_complete` still
--     means "gross + commission + swap present". Deal count is EVIDENCE, not a
--     gate, so applying this migration cannot move a single row between the
--     analytics populations.
--   * Reversible: the DOWN section is at the end, commented out.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. Evidence columns ────────────────────────────────────────────────────
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS deal_count       INTEGER,
  ADD COLUMN IF NOT EXISTS volume_closed    NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS partial_close    BOOLEAN,
  ADD COLUMN IF NOT EXISTS deal_tickets     TEXT,
  ADD COLUMN IF NOT EXISTS close_provenance TEXT;

COMMENT ON COLUMN public.trades.deal_count IS
  'Phase 4.2.1 P-I - number of MT5 deals (entry + every exit leg) the broker reported for this position. NULL = evidence not recorded (pre-P-I row or a v1 EA payload), never "zero deals".';
COMMENT ON COLUMN public.trades.volume_closed IS
  'Phase 4.2.1 P-I - sum of exit-leg volume from the broker, in lots. Compare with the entry volume to detect a partial close. NULL = not recorded.';
COMMENT ON COLUMN public.trades.partial_close IS
  'Phase 4.2.1 P-I - TRUE when the broker-reported exit volume is below the entry volume, i.e. the position closed in more than one step. NULL = not evaluated.';
COMMENT ON COLUMN public.trades.deal_tickets IS
  'Phase 4.2.1 P-I - comma-joined MT5 deal tickets behind the aggregate (audit trail). NULL = not recorded.';
COMMENT ON COLUMN public.trades.close_provenance IS
  'Phase 4.2.1 P-I - how the close reached us: ea_observed (seen live by the EA), ea_recovered (arrived via P-J restart recovery, so it was NOT seen live). NULL for rows written before this column existed.';

-- Range guards. A negative deal count or volume is a parse error, not data, so
-- it is refused at the boundary rather than averaged into a report later.
ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_deal_count_nonneg,
  ADD CONSTRAINT trades_deal_count_nonneg
      CHECK (deal_count IS NULL OR deal_count >= 0),
  DROP CONSTRAINT IF EXISTS trades_volume_closed_nonneg,
  ADD CONSTRAINT trades_volume_closed_nonneg
      CHECK (volume_closed IS NULL OR volume_closed >= 0),
  DROP CONSTRAINT IF EXISTS trades_close_provenance_valid,
  ADD CONSTRAINT trades_close_provenance_valid
      CHECK (close_provenance IS NULL OR close_provenance IN ('ea_observed', 'ea_recovered'));


-- ── 2. Audit view ─────────────────────────────────────────────────────────
-- Read-only. Reports disagreement; corrects nothing.
CREATE OR REPLACE VIEW public.v_partial_close_audit AS
SELECT
  t.id,
  t.user_id,
  t.pair,
  t.broker_ticket,
  t.closed_at,
  t.pl_usd,
  t.net_realised_pnl,
  t.accounting_complete,
  t.deal_count,
  t.volume_closed,
  t.partial_close,
  t.close_provenance,
  CASE
    WHEN t.deal_count IS NOT NULL AND t.deal_count < 1
      THEN 'deal_count_below_one'
    WHEN t.partial_close IS TRUE AND t.volume_closed IS NULL
      THEN 'partial_without_exit_volume'
    WHEN t.partial_close IS FALSE AND t.deal_count IS NOT NULL AND t.deal_count > 2
      THEN 'multi_deal_but_not_flagged_partial'
    WHEN t.close_provenance = 'ea_recovered' AND t.accounting_complete IS NOT TRUE
      THEN 'recovered_close_without_complete_costs'
    ELSE NULL
  END AS finding
FROM public.trades t
WHERE t.closed_at IS NOT NULL
  AND (
    (t.deal_count IS NOT NULL AND t.deal_count < 1)
    OR (t.partial_close IS TRUE AND t.volume_closed IS NULL)
    OR (t.partial_close IS FALSE AND t.deal_count IS NOT NULL AND t.deal_count > 2)
    OR (t.close_provenance = 'ea_recovered' AND t.accounting_complete IS NOT TRUE)
  );

COMMENT ON VIEW public.v_partial_close_audit IS
  'Phase 4.2.1 P-I - closes whose stored partial-close evidence disagrees with itself. A finding here is a data-quality signal for review, never an automatic correction.';

-- ── 3. DOWN (commented - run only to reverse this patch) ──────────────────
-- BEGIN;
--   DROP VIEW IF EXISTS public.v_partial_close_audit;
--   ALTER TABLE public.trades
--     DROP CONSTRAINT IF EXISTS trades_close_provenance_valid,
--     DROP CONSTRAINT IF EXISTS trades_volume_closed_nonneg,
--     DROP CONSTRAINT IF EXISTS trades_deal_count_nonneg,
--     DROP COLUMN IF EXISTS close_provenance,
--     DROP COLUMN IF EXISTS deal_tickets,
--     DROP COLUMN IF EXISTS partial_close,
--     DROP COLUMN IF EXISTS volume_closed,
--     DROP COLUMN IF EXISTS deal_count;
-- COMMIT;

COMMIT;
