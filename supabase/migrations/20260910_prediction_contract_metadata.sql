-- ============================================================
-- 20260910_prediction_contract_metadata.sql
-- Phase 2 — make the canonical prediction contract explicit in the
-- prediction_logs schema and support deterministic recovery of expired
-- unresolved predictions.
--
-- Purely ADDITIVE and non-destructive:
--   • no historical row is modified
--   • no existing column/constraint is changed
--   • historical rows simply keep NULL metadata (reported separately; never
--     silently backfilled)
--
-- Canonical contract (shared lib/prediction-contract.mjs):
--   M5 · entry = close of latest fully-closed M5 candle · 15-min window ·
--   up to 3 future M5 closes · TP before SL = WIN · SL before TP = LOSS ·
--   neither = INCONCLUSIVE
-- ============================================================

ALTER TABLE public.prediction_logs
  ADD COLUMN IF NOT EXISTS prediction_window_ms   BIGINT,
  ADD COLUMN IF NOT EXISTS prediction_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prediction_timeframe   TEXT,
  ADD COLUMN IF NOT EXISTS prediction_candles     SMALLINT,
  ADD COLUMN IF NOT EXISTS resolution_rule        TEXT,
  ADD COLUMN IF NOT EXISTS evaluated_candle_time  TIMESTAMPTZ;

-- The expired-pending scanner queries exactly this set: unresolved rows that
-- carry the canonical expiry. Partial index keeps it small and avoids touching
-- legacy rows without metadata.
CREATE INDEX IF NOT EXISTS prediction_logs_unresolved_expiry_idx
  ON public.prediction_logs (prediction_expires_at)
  WHERE outcome IS NULL AND prediction_expires_at IS NOT NULL;
