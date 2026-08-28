-- ============================================================
-- 20260827_prediction_logs.sql
-- Audit Phase 4 (item 13): full auditable prediction record.
--
-- prediction_logs stores EVERY engine prediction (not just acted-on signals)
-- with its gating provenance and a resolution block: outcome, MFE/MAE in pips,
-- and the price sampled at 1/3/5/15 minutes after signal time. This powers the
-- Similar-Pattern Engine and the Phase 4 dashboards.
--
-- Also adds the audit-proposed reconciliation resolution columns
-- (sl/tp/mfe/mae/time_to_tp_s/time_to_sl_s) to signal_reconciliation.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.prediction_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pair                TEXT NOT NULL,
  timeframe           TEXT NOT NULL DEFAULT '5m',
  -- Final (gated) direction and the raw engine direction before gates.
  direction           TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'HOLD')),
  predicted_direction TEXT CHECK (predicted_direction IN ('BUY', 'SELL', 'HOLD')),
  gating_reasons      JSONB DEFAULT '[]'::jsonb,
  confidence          INTEGER,
  -- Execution levels used by the signal (mirrors signals.indicator_snapshot._computed).
  entry               NUMERIC(12, 6),
  sl                  NUMERIC(12, 6),
  tp                  NUMERIC(12, 6),
  candle_close_time   TIMESTAMPTZ,
  -- Phase 2/3 provenance: regime + agreement + ML routing so dashboards can
  -- slice the log by any factor that affected the prediction.
  regime              TEXT,
  agreement_score     INTEGER,
  ml_model            TEXT,
  ml_regime           TEXT,
  ml_calibration      TEXT,
  ml_model_auc        NUMERIC(6, 4),
  indicator_snapshot  JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Resolution block (populated by the worker at created_at + resolution window).
  outcome             TEXT CHECK (outcome IN ('WIN', 'LOSS', 'INCONCLUSIVE', 'PENDING')),
  resolved_at         TIMESTAMPTZ,
  -- Max favorable / adverse excursion in pips from entry.
  mfe_pips            NUMERIC(10, 2),
  mae_pips            NUMERIC(10, 2),
  -- Price sampled at fixed intervals after signal time (raw price units).
  price_after_1m      NUMERIC(12, 6),
  price_after_3m      NUMERIC(12, 6),
  price_after_5m      NUMERIC(12, 6),
  price_after_15m     NUMERIC(12, 6),
  -- Seconds from signal time until SL/TP first touched (NULL if never touched).
  time_to_tp_s        INTEGER,
  time_to_sl_s        INTEGER
);

-- Worker hot-path: find prediction logs that are due for resolution.
CREATE INDEX IF NOT EXISTS idx_prediction_logs_pending
  ON public.prediction_logs (created_at)
  WHERE outcome IS NULL OR outcome = 'PENDING';

-- Dashboard aggregations by regime / outcome / confidence.
CREATE INDEX IF NOT EXISTS idx_prediction_logs_analytics
  ON public.prediction_logs (outcome, regime, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prediction_logs_user
  ON public.prediction_logs (user_id, created_at DESC);

ALTER TABLE public.prediction_logs ENABLE ROW LEVEL SECURITY;

-- Users read their own prediction logs from the browser. Inserts and the
-- worker's resolution updates use the service-role key (server-side only).
CREATE POLICY "users read own prediction_logs"
  ON public.prediction_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================
-- signal_reconciliation additions (audit Phase 4): carry SL/TP + MFE/MAE so
-- the reconciliation rows can be sliced by distance-from-entry, not just
-- direction-moved outcome.
-- ============================================================
ALTER TABLE public.signal_reconciliation
  ADD COLUMN IF NOT EXISTS sl          NUMERIC(12, 6),
  ADD COLUMN IF NOT EXISTS tp          NUMERIC(12, 6),
  ADD COLUMN IF NOT EXISTS mfe_pips    NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS mae_pips    NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS time_to_tp_s INTEGER,
  ADD COLUMN IF NOT EXISTS time_to_sl_s INTEGER;
