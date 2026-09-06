-- ============================================================
-- 20260912_outcome_reconciliation.sql
-- Phase 3 — cross-engine outcome reconciliation layer + source attribution.
--
-- ADDITIVE ONLY:
--   • creates an analytical table (never writes to source engines)
--   • adds nullable attribution columns to signals for NEW writes
--   • does not alter/rewrite any historical outcome row
--   • does not change trading thresholds/strategy/risk/execution
-- ============================================================

-- ── 1. Analytical reconciliation layer ───────────────────────────────────────
-- One row per LINKED record (signal/prediction/reconciliation/execution that
-- belong to the same original setup). Source rows are NEVER updated from here.
CREATE TABLE IF NOT EXISTS public.outcome_reconciliation (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pair                      TEXT NOT NULL,
  direction                 TEXT,

  -- Lineage (nullable; old records may only have some pieces).
  signal_id                 TEXT,
  prediction_log_id         UUID,
  reconciliation_id         UUID,
  execution_id              UUID,
  setup_key                 TEXT,          -- deterministic link key (user|pair|candle)

  evaluated_candle_time     TIMESTAMPTZ,
  candle_close_time         TIMESTAMPTZ,
  signal_created_at         TIMESTAMPTZ,

  -- Engine outcomes (copies of source verdicts at materialisation time).
  prediction_outcome        TEXT,          -- WIN | LOSS | INCONCLUSIVE
  prediction_resolved_at    TIMESTAMPTZ,
  signal_label_outcome      TEXT,          -- WIN | LOSS
  signal_label_resolved_at  TIMESTAMPTZ,
  signal_label_source       TEXT,          -- LABEL_CRON | WORKER_TRACKER
  reconciliation_outcome    TEXT,          -- WIN | LOSS | INCONCLUSIVE
  reconciliation_resolved_at TIMESTAMPTZ,
  execution_outcome         TEXT,          -- WIN | LOSS | BREAKEVEN | OPEN
  execution_closed_at       TIMESTAMPTZ,
  execution_pnl_usd         NUMERIC(14,2),
  execution_r               NUMERIC(8,3),

  -- Classification (see lib/outcome-reconciliation.mjs).
  agreement_class           TEXT,          -- FULL_AGREEMENT | PARTIAL_AGREEMENT |
                                           -- DISAGREEMENT | NOT_COMPARABLE | PARTIAL_DATA
  disagreement_reasons      JSONB DEFAULT '[]'::jsonb,
  contract_versions         JSONB DEFAULT '{}'::jsonb,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (setup_key)
);

-- ── 2. Source attribution for signals (NEW writes only) ───────────────────────
-- Legacy signals.outcome stays untouched. New labelled/attributed fields make
-- it unambiguous WHO wrote a verdict and under WHICH contract.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS outcome_source           TEXT,  -- LABEL_CRON | WORKER_TRACKER | MANUAL
  ADD COLUMN IF NOT EXISTS signal_label_outcome     TEXT,  -- label-contract verdict (WIN|LOSS)
  ADD COLUMN IF NOT EXISTS signal_label_source      TEXT,  -- LABEL_CRON | WORKER_TRACKER
  ADD COLUMN IF NOT EXISTS signal_label_resolved_at TIMESTAMPTZ;
