-- ============================================================
-- 20260825_prediction_gating_columns.sql
-- Audit Phase 1.5: record gating reasons per signal.
-- Adds columns so we can distinguish the raw model prediction
-- from the final gated direction, and measure whether our
-- filters actually improve accuracy.
-- ============================================================

-- Raw engine direction BEFORE any downstream gate (discipline/ML).
-- NULL = not populated (legacy rows).
alter table public.signals
  add column if not exists predicted_direction text
  check (predicted_direction in ('BUY', 'SELL', 'HOLD'));

-- Human/machine-readable reasons why the direction was changed or blocked.
-- [] = no gate modified the signal.
alter table public.signals
  add column if not exists gating_reasons jsonb default '[]'::jsonb;

-- The candle close time the prediction was based on — authoritary
-- timestamp for detecting mid-candle churn / stale predictions.
alter table public.signals
  add column if not exists candle_close_time timestamptz;

-- Index for filter-effectiveness queries ("how did gated vs predicted perform?")
create index if not exists signals_predicted_direction_idx
  on public.signals (predicted_direction);