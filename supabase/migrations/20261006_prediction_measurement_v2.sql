-- 20261006_prediction_measurement_v2.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PREDICTION MEASUREMENT v2 — parallel/shadow measurement path (Option A)
--
-- WHY
--   v1 derived MFE/MAE from ~10-second worker sweep prices. Reconstruction on
--   the active account (login 476906137, 2026-09-24) against authoritative M5
--   candle highs/lows found 15 stored `mfe_pips = 0` rows of which 13 had a
--   GENUINE favourable excursion the sampler never saw (largest >= 17.4 pips),
--   and EVERY reconstructed MAE was understated (up to ~2.3x). The BUY/SELL
--   formulas were correct — the market-data SOURCE was wrong.
--
-- THE CRITICAL CONSTRAINT — READ BEFORE TOUCHING THIS FILE
--   `prediction_logs.mfe_pips`, `mae_pips`, `outcome` and `r_multiple` are read
--   by lib/expectancy-engine.ts (lines ~302-313) and therefore feed
--   lib/trade-authority.ts, which is the LIVE expectancy veto.
--   `time_to_tp_s` / `time_to_sl_s` are read by lib/counterfactual.ts.
--
--   This migration therefore adds NEW COLUMNS ONLY. It does not alter, rename,
--   backfill or reinterpret any existing column, so the live expectancy input
--   is bit-for-bit unchanged. v2 writes exclusively to the columns below.
--
--   Invariant: LIVE EXPECTANCY VETO CHANGED = NO.
--
-- NO BACKFILL (deliberate)
--   The 200-row historical sample is preserved untouched for forensic
--   reproducibility. Rows written before this migration keep
--   `measurement_version IS NULL`, which is exactly how a downstream reader
--   distinguishes a v1 (sweep-sampled) observation from a v2 one. Never mix
--   them as though they were measured identically.
--
-- REVERSIBILITY
--   ALTER TABLE public.prediction_logs
--     DROP COLUMN IF EXISTS authoritative_mfe_pips,
--     DROP COLUMN IF EXISTS authoritative_mae_pips,
--     DROP COLUMN IF EXISTS strict_mfe_pips,
--     DROP COLUMN IF EXISTS strict_mae_pips,
--     DROP COLUMN IF EXISTS outcome_class,
--     DROP COLUMN IF EXISTS resolution_source,
--     DROP COLUMN IF EXISTS resolution_granularity,
--     DROP COLUMN IF EXISTS measurement_version,
--     DROP COLUMN IF EXISTS measurement_diag;
--   DROP TABLE IF EXISTS public.m5_candle_history;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Additive measurement columns on prediction_logs ──────────────────────
--
-- BOUNDS SEMANTICS (do not collapse these into one number)
--   authoritative_* = UPPER bound — computed over every M5 bar OVERLAPPING the
--                     window. Best estimate, but when the prediction was
--                     created partway through a bar that bar's high/low still
--                     contains pre-prediction movement. The exact overlap in ms
--                     is recorded in measurement_diag.partialFirstOverlapMs.
--   strict_*        = LOWER bound — computed over bars lying ENTIRELY inside the
--                     window. Zero pre-entry contamination; may understate by
--                     up to one bar. NULL when no bar qualifies.
--
-- NULL vs ZERO (Phase 7 — prospective only)
--   0    = measured, and the authoritative excursion was genuinely zero.
--   NULL = measurement unavailable / insufficient data / never evaluated.
--   These are different facts and must never be conflated.
ALTER TABLE public.prediction_logs
  ADD COLUMN IF NOT EXISTS authoritative_mfe_pips  numeric,
  ADD COLUMN IF NOT EXISTS authoritative_mae_pips  numeric,
  ADD COLUMN IF NOT EXISTS strict_mfe_pips         numeric,
  ADD COLUMN IF NOT EXISTS strict_mae_pips         numeric,
  ADD COLUMN IF NOT EXISTS outcome_class           text,
  ADD COLUMN IF NOT EXISTS resolution_source       text,
  ADD COLUMN IF NOT EXISTS resolution_granularity  text,
  ADD COLUMN IF NOT EXISTS measurement_version     integer,
  ADD COLUMN IF NOT EXISTS measurement_diag        jsonb;

-- outcome_class vocabulary. ORDER_AMBIGUOUS is a FIRST-CLASS value: when both
-- TP and SL fall inside one M5 bar and no finer data exists, ordering is not
-- knowable and must not be guessed as WIN or LOSS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prediction_logs_outcome_class_chk'
  ) THEN
    ALTER TABLE public.prediction_logs
      ADD CONSTRAINT prediction_logs_outcome_class_chk
      CHECK (outcome_class IS NULL OR outcome_class IN (
        'TP_BEFORE_SL', 'SL_BEFORE_TP', 'NEITHER', 'ORDER_AMBIGUOUS', 'INSUFFICIENT_DATA'
      ));
  END IF;
END $$;

-- Provenance must be explicit so v1 and v2 observations can never be silently
-- mixed. Existing rows stay NULL for all three (that IS their provenance).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prediction_logs_resolution_source_chk'
  ) THEN
    ALTER TABLE public.prediction_logs
      ADD CONSTRAINT prediction_logs_resolution_source_chk
      CHECK (resolution_source IS NULL OR resolution_source IN ('BROKER_CANDLES'));
  END IF;
END $$;

-- Partial index for the v2 applier's "fresh, expired, not yet measured" scan.
-- Partial so it stays small: only rows the applier is ever allowed to touch.
CREATE INDEX IF NOT EXISTS idx_prediction_logs_v2_pending
  ON public.prediction_logs (created_at)
  WHERE measurement_version IS NULL;

-- ── 2. Forward-only M5 candle history ───────────────────────────────────────
--
-- The EA feeds candles into `broker_configs.config.candleCache`, which is a
-- ROLLING ~200-bar (≈16.7h) overwritten window. That is enough for the 15-minute
-- prediction contract but far too short to build a 100-200 prediction study, and
-- it means an old prediction can no longer be reconstructed at all.
--
-- This table freezes the EXISTING M5 feed. It is not a new data source:
--   * no M1 or tick collection (Excluded from this phase — needs an EA change)
--   * the EA feed itself is untouched
--
-- IMMUTABILITY → IDEMPOTENCY
--   Only bars that have already CLOSED are ever inserted (enforced in
--   lib/m5-candle-history.mjs). A closed M5 bar never changes value again, so
--   re-persisting the same rolling cache produces byte-identical rows. The
--   (symbol, timeframe, bar_time) primary key plus `resolution=ignore-duplicates`
--   on write makes the ingest a true no-op, safe to run on every EA sync.
--
-- NO UPDATE PATH IS PROVIDED ON PURPOSE. There is no `updated_at` column,
-- because a stored bar is never revised. If a bar's OHLC is ever found to be
-- wrong, the correct response is a new, explicitly authorised dataset — not a
-- silent rewrite of a forensic observation.
CREATE TABLE IF NOT EXISTS public.m5_candle_history (
  symbol        text        NOT NULL,
  timeframe     text        NOT NULL DEFAULT 'M5',
  -- Bar OPEN time, epoch SECONDS — the same unit the EA sends in `candleCache`
  -- (`t`) and the same unit mt5direct.adapter multiplies by 1000.
  bar_time      bigint      NOT NULL,
  open_price    numeric     NOT NULL,
  high_price    numeric     NOT NULL,
  low_price     numeric     NOT NULL,
  close_price   numeric     NOT NULL,
  volume        numeric     NOT NULL DEFAULT 0,
  persisted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT m5_candle_history_pkey PRIMARY KEY (symbol, timeframe, bar_time),
  -- A stored bar must be internally consistent. Cheap, and it makes a
  -- corrupt/incomplete feed row impossible to persist.
  CONSTRAINT m5_candle_history_ohlc_chk
    CHECK (high_price >= low_price AND high_price >= open_price AND
           high_price >= close_price AND low_price <= open_price AND
           low_price <= close_price)
);

-- RLS enabled with NO policies: all access is server-side via the service role
-- (which bypasses RLS). This makes the table unreachable from anon/client keys
-- by default rather than by convention.
ALTER TABLE public.m5_candle_history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.m5_candle_history IS
  'Forward-only, immutable M5 bar history frozen from the existing MT5 EA candle feed. '
  'Closed bars only; primary key (symbol, timeframe, bar_time) makes re-ingestion an idempotent no-op. '
  'No backfill was performed — rows exist only from this migration onward.';
