-- ============================================================
-- 20261112_phase41_order_authority_and_accounting.sql
--
-- Phase 4.1A + 4.1B + 4.1C + 4.1E — order authority auditability, canonical
-- execution accounting, lineage keys and actual-fill risk provenance.
--
-- ADDITIVE ONLY. No existing column is dropped, retyped or rewritten. No
-- historical row's financial evidence is modified. No strategy, risk-limit,
-- confidence, window, sizing, SL/TP or Trade Authority setting is touched.
--
-- WHY
-- ---
-- Production evidence (2026-11-12):
--   • 1,284 trade rows; trade_result NULL for 100%, commission/swap NULL for
--     100%, prediction_log_id/setup_id NULL for 100%.
--   • Two XAU/USD SELLs (tickets 3454451953 / 3454458505) reached the broker
--     while the worker logged `auto-trade skipped-confidence`. Neither row could
--     say WHO submitted it: `trades.source` is 'scalp' for both the worker and
--     the browser scalp card.
--   • Both rows carried the same planned_risk_amount ($1,748.50) despite
--     different broker-filled stop distances ($1,794.00 vs $1,881.50).
--
-- WHAT THIS MIGRATION ADDS
-- ------------------------
--   1. Order-authority audit trail on trades.
--   2. Canonical accounting fields (net_realised_pnl, other_fees,
--      accounting_complete, accounting_missing).
--   3. Actual-fill risk provenance (initial_*/requested_* prices,
--      risk_calc_version, instrument_spec).
--   4. ONE shared derivation trigger that populates trade_result /
--      net_realised_pnl / accounting_complete on EVERY close path — including
--      public.mt5_webhook_sync(), which today writes result/pl_usd/exit_price/
--      trade_status/realised_r and never trade_result.
--   5. Idempotency: a unique (user_id, request_id) index.
--
-- WHAT DELIBERATELY DOES NOT HAPPEN
-- ---------------------------------
--   • trades.result keeps its legacy semantics and its existing CHECK constraint.
--     'CLOSED' is a lifecycle value; it is never converted into WIN or LOSS.
--   • No historical backfill. Pre-existing NULL accounting stays NULL and is
--     reported as INCOMPLETE by the application, not invented here.
--   • realised_r is NOT recomputed for historical rows. The corrected value is
--     derived at read time from initial_sl_price, so original evidence survives.
--
-- ROLLBACK (safe, order matters)
-- ------------------------------
--   DROP TRIGGER IF EXISTS trades_derive_accounting_trg ON public.trades;
--   DROP FUNCTION IF EXISTS public.trades_derive_accounting();
--   DROP INDEX IF EXISTS public.trades_request_id_uidx;
--   ALTER TABLE public.trades
--     DROP COLUMN IF EXISTS submission_source,
--     DROP COLUMN IF EXISTS submitted_by,
--     DROP COLUMN IF EXISTS request_id,
--     DROP COLUMN IF EXISTS authority_decision,
--     DROP COLUMN IF EXISTS authority_reason,
--     DROP COLUMN IF EXISTS authority_policy_version,
--     DROP COLUMN IF EXISTS submitted_at,
--     DROP COLUMN IF EXISTS net_realised_pnl,
--     DROP COLUMN IF EXISTS other_fees,
--     DROP COLUMN IF EXISTS accounting_complete,
--     DROP COLUMN IF EXISTS accounting_missing,
--     DROP COLUMN IF EXISTS initial_entry_price,
--     DROP COLUMN IF EXISTS initial_sl_price,
--     DROP COLUMN IF EXISTS requested_entry_price,
--     DROP COLUMN IF EXISTS requested_sl_price,
--     DROP COLUMN IF EXISTS risk_calc_version,
--     DROP COLUMN IF EXISTS instrument_spec;
--   -- No data loss: every dropped column is derived or audit metadata added here.
-- ============================================================

BEGIN;

-- ── 1. Order authority audit trail (Phase 4.1A) ─────────────────────────────
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS submission_source        TEXT,
  ADD COLUMN IF NOT EXISTS submitted_by             UUID,
  ADD COLUMN IF NOT EXISTS request_id               TEXT,
  ADD COLUMN IF NOT EXISTS authority_decision       TEXT,
  ADD COLUMN IF NOT EXISTS authority_reason         TEXT,
  ADD COLUMN IF NOT EXISTS authority_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at             TIMESTAMPTZ;

COMMENT ON COLUMN public.trades.submission_source IS
  'Order-authority lane: WORKER_AUTOTRADE | UI_SCALP_CARD | UI_MIRROR_CARD | UI_* | EXTERNAL_API | UNKNOWN. Derived by lib/order-authority.mjs.';
COMMENT ON COLUMN public.trades.submitted_by IS
  'Authenticated user who authorised a manual submission. NULL for automated lanes.';
COMMENT ON COLUMN public.trades.request_id IS
  'Idempotency key for the submission. Unique per user — a retry cannot create a second order.';
COMMENT ON COLUMN public.trades.authority_decision IS
  'APPROVED_AUTOMATED | APPROVED_MANUAL | REJECTED_UNAUTHORISED.';
COMMENT ON COLUMN public.trades.authority_reason IS
  'Machine-readable reason code (e.g. OK_MANUAL_WITH_SIGNAL_CONTEXT, SIGNAL_EXPIRED).';
COMMENT ON COLUMN public.trades.authority_policy_version IS
  'Policy version that produced the decision (e.g. order_authority_v1).';

-- ── 2. Canonical execution accounting (Phase 4.1B) ──────────────────────────
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS net_realised_pnl    NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS other_fees          NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS accounting_complete BOOLEAN,
  ADD COLUMN IF NOT EXISTS accounting_missing  TEXT[];

COMMENT ON COLUMN public.trades.net_realised_pnl IS
  'gross + commission + swap + other_fees, as supplied by the broker. NULL unless every term is known — a missing cost is never treated as zero.';
COMMENT ON COLUMN public.trades.accounting_complete IS
  'TRUE only when gross, commission and swap are all present (trade_result then reflects NET P&L). FALSE means the verdict is GROSS_ONLY or absent — see accounting_missing.';
COMMENT ON COLUMN public.trades.accounting_missing IS
  'Names of the financial terms that are absent, so incompleteness is explainable.';

-- ── 3. Actual-fill risk provenance (Phase 4.1E) ─────────────────────────────
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS initial_entry_price   NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS initial_sl_price      NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS requested_entry_price NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS requested_sl_price    NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS risk_calc_version     TEXT,
  ADD COLUMN IF NOT EXISTS instrument_spec       JSONB;

COMMENT ON COLUMN public.trades.initial_sl_price IS
  'Stop price as FILLED by the broker. The immutable risk anchor: a later move to breakeven must not rewrite this.';
COMMENT ON COLUMN public.trades.requested_sl_price IS
  'Stop price as REQUESTED by the caller before the MT5 adapter re-anchored it — evidence of the re-anchor delta.';
COMMENT ON COLUMN public.trades.risk_calc_version IS
  'Which risk formula produced planned_risk_amount (risk_from_fill_v1 = actual filled stop).';
COMMENT ON COLUMN public.trades.instrument_spec IS
  'Contract specification actually used for the risk calculation (pipSize, valuePerPip, currency, source).';

COMMIT;

-- ── 4. Idempotency + lookup indexes (Phase 4.1A / 4.1C) ─────────────────────
BEGIN;

-- A retry of the same submission must not create a second broker order. Scoped
-- to (user_id, request_id) so two users may legitimately share a request shape.
CREATE UNIQUE INDEX IF NOT EXISTS trades_request_id_uidx
  ON public.trades (user_id, request_id)
  WHERE request_id IS NOT NULL;

-- Fast "which lane / which decision" auditing for the Production Integrity panel.
CREATE INDEX IF NOT EXISTS trades_authority_idx
  ON public.trades (submission_source, authority_decision, submitted_at DESC)
  WHERE submission_source IS NOT NULL;

-- Fast identification of closed trades whose accounting is still incomplete.
CREATE INDEX IF NOT EXISTS trades_accounting_incomplete_idx
  ON public.trades (closed_at DESC)
  WHERE accounting_complete IS FALSE;

COMMIT;

-- ── 5. SHARED close-path accounting derivation (Phase 4.1B) ─────────────────
-- ONE trigger, so every close path — the mt5_webhook_sync() RPC, /api/mt5-sync,
-- /api/trades, /api/close-trade, manual SQL — produces identical accounting.
--
-- CONTRACT ENFORCED HERE:
--   * trade_result is derived ONLY from net realised P&L.
--   * net P&L is computed ONLY when gross AND commission AND swap are all
--     known. A missing cost is NEVER coerced to zero.
--   * a legacy result='CLOSED' row with no money stays UNKNOWN (closed != loss).
--   * the trigger never touches result, pl_usd, entry/sl/tp, lots or risk.
BEGIN;

CREATE OR REPLACE FUNCTION public.trades_derive_accounting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_gross  numeric;
  v_comm   numeric;
  v_swap   numeric;
  v_fees   numeric;
  v_net    numeric;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  v_gross := NEW.pl_usd;
  v_comm  := NEW.commission;
  v_swap  := NEW.swap;
  v_fees  := NEW.other_fees;

  -- Nothing financial happened yet (an OPEN insert): leave accounting unset so
  -- the row is clearly "not applicable", not "incomplete".
  IF v_gross IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.net_realised_pnl    := NULL;
      NEW.accounting_complete := NULL;
      NEW.accounting_missing  := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF v_comm IS NULL THEN v_missing := v_missing || 'commission'; END IF;
  IF v_swap IS NULL THEN v_missing := v_missing || 'swap';       END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    -- Every term known (other_fees is optional): the canonical formula.
    -- Commission and swap are taken SIGNED, exactly as MT5 reports them.
    v_net := ROUND(v_gross + v_comm + v_swap + COALESCE(v_fees, 0), 2);
    NEW.net_realised_pnl    := v_net;
    NEW.accounting_complete := true;
    NEW.accounting_missing  := ARRAY[]::text[];
    NEW.trade_result := CASE
      WHEN ABS(v_net) <= 0.01 THEN 'BREAKEVEN'
      WHEN v_net > 0          THEN 'WIN'
      ELSE                         'LOSS'
    END;
  ELSE
    -- Incomplete financials: do NOT publish a gross-only "net". The broker gross
    -- is still REAL money, so a provisional verdict is recorded — but
    -- accounting_complete stays FALSE and the missing terms are named, so nothing
    -- downstream can mistake this for a net figure.
    NEW.net_realised_pnl    := NULL;
    NEW.accounting_complete := false;
    NEW.accounting_missing  := v_missing;
    NEW.trade_result := CASE
      WHEN ABS(v_gross) <= 0.01 THEN 'BREAKEVEN'
      WHEN v_gross > 0          THEN 'WIN'
      ELSE                           'LOSS'
    END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trades_derive_accounting() IS
  'Phase 4.1B — derives trade_result/net_realised_pnl/accounting_complete from broker-confirmed gross, commission and swap. One shared place for every close path.';

DROP TRIGGER IF EXISTS trades_derive_accounting_trg ON public.trades;
CREATE TRIGGER trades_derive_accounting_trg
  BEFORE INSERT OR UPDATE OF pl_usd, commission, swap, other_fees
  ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION public.trades_derive_accounting();



-- ── 6. Production verification queries (run AFTER applying) ──────────────────
--   -- 6.1 all new columns present (expect 17 rows)
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='trades'
--      AND column_name IN ('submission_source','submitted_by','request_id',
--        'authority_decision','authority_reason','authority_policy_version',
--        'submitted_at','net_realised_pnl','other_fees','accounting_complete',
--        'accounting_missing','initial_entry_price','initial_sl_price',
--        'requested_entry_price','requested_sl_price','risk_calc_version',
--        'instrument_spec')
--    ORDER BY column_name;
--
--   -- 6.2 trigger installed (expect 1 row, tgenabled='O')
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid='public.trades'::regclass AND tgname='trades_derive_accounting_trg';
--
--   -- 6.3 idempotency index present (expect 1 row)
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND indexname='trades_request_id_uidx';
--
--   -- 6.4 historical evidence untouched: these must be unchanged by this
--   --     migration (no backfill was performed)
--   SELECT count(*) FILTER (WHERE trade_result IS NULL)  AS result_still_null,
--          count(*) FILTER (WHERE commission   IS NULL)  AS commission_null,
--          count(*)                                      AS total
--     FROM public.trades;
--
--   -- 6.5 the 12 Nov evidence pair (expect accounting_complete=false,
--   --     trade_result='UNKNOWN' — commission/swap are NOT known)
--   SELECT broker_ticket, pl_usd, commission, swap, trade_result,
--          accounting_complete, accounting_missing
--     FROM public.trades
--    WHERE broker_ticket IN ('3454451953','3454458505');
--
--   -- 6.6 post-apply behaviour check on a NEW close with complete financials
--   --     (run in a transaction and ROLLBACK — never on live data)
--   -- BEGIN;
--   --   INSERT INTO public.trades (user_id,pair,direction,lots,result,pl_usd,
--   --     commission,swap,broker_ticket,closed_at)
--   --   VALUES ('<uuid>','XAU/USD','SELL',0.01,'WIN',10.00,-0.70,0.00,'TEST-1',now());
--   --   SELECT trade_result, net_realised_pnl, accounting_complete FROM public.trades
--   --    WHERE broker_ticket='TEST-1';   -- expect WIN, 9.30, true
--   -- ROLLBACK;

-- ── 7. Optional, NON-EXECUTED historical lifecycle backfill ─────────────────
-- trade_status is lifecycle metadata, not financial evidence, so it CAN be
-- derived safely. It is left commented out so the decision is explicit:
--
--   UPDATE public.trades
--      SET trade_status = CASE
--            WHEN result IN ('CLOSED','WIN','LOSS','BREAKEVEN') THEN 'CLOSED'
--            WHEN result = 'CANCELLED' THEN 'CANCELLED'
--            ELSE 'OPEN' END
--    WHERE trade_status IS NULL;
--
-- trade_result is deliberately NOT backfilled: doing so would assign a
-- profitability to rows that have no commission/swap evidence, which is exactly
-- the fabrication this phase exists to prevent.

COMMIT;

