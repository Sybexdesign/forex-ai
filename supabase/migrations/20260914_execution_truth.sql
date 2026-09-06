-- ============================================================
-- 20260914_execution_truth.sql
-- Phase 4 — execution truth layer: lifecycle vs profitability + lineage.
--
-- ADDITIVE ONLY. No historical row is rewritten. `trades.result` keeps its
-- legacy semantics (OPEN / WIN / LOSS / BREAKEVEN and the EA's 'CLOSED'); new
-- columns carry the canonical lifecycle + profitability + provenance:
--   trade_status   — lifecycle  (OPEN / CLOSED / PARTIALLY_CLOSED / …)
--   trade_result   — profitability (derived ONLY from net realised P&L)
--   planned_risk_amount / realised_r — risk-normalised execution metrics
--   lineage        — broker_ticket, prediction_log_id, setup_id
-- ============================================================

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS trade_status              TEXT,
  ADD COLUMN IF NOT EXISTS trade_result              TEXT,
  ADD COLUMN IF NOT EXISTS execution_source          TEXT,
  ADD COLUMN IF NOT EXISTS execution_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS planned_risk_amount       NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS realised_r                NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS broker_ticket             TEXT,
  ADD COLUMN IF NOT EXISTS prediction_log_id         UUID,
  ADD COLUMN IF NOT EXISTS setup_id                  TEXT,
  ADD COLUMN IF NOT EXISTS commission                NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS swap                      NUMERIC(14, 2);

-- Fast lookup of closed executions that still need linking/refreshing.
CREATE INDEX IF NOT EXISTS trades_execution_link_idx
  ON public.trades (trade_status, pair, direction)
  WHERE trade_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS trades_closed_at_idx
  ON public.trades (closed_at DESC)
  WHERE closed_at IS NOT NULL;
