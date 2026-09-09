-- ============================================================
-- 20260916_profit_protection_telemetry.sql
-- Durable shadow profit-protection telemetry (observability only).
--
-- Stores one row per meaningful trade-management observation for open Auto
-- Trades so the shadow-mode study can be reproduced from DB records instead
-- of hosted app logs. ADDITIVE ONLY. Never gates, delays or alters trading:
-- writes are best-effort from mt5-sync after all management decisions and the
-- broker_configs update have already completed.
--
-- Values are written exactly as computed by lib/profit-protection.mjs and
-- lib/trade-manager.ts. `actual_*` vs `est_*` distinction lives at the
-- analysis layer (see lib/profit-telemetry.mjs) — this table stores raw
-- observations; row_kind separates lifecycle snapshots from close events.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profit_protection_telemetry (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Broker identity
  broker_ticket          TEXT,
  pair                   TEXT,
  direction              TEXT,                 -- BUY | SELL
  lots                   NUMERIC(14, 4),
  open_price             NUMERIC(20, 8),
  initial_sl             NUMERIC(20, 8),
  current_sl             NUMERIC(20, 8),
  current_price          NUMERIC(20, 8),
  -- P&L / R
  current_profit_usd     NUMERIC(14, 2),
  peak_profit_usd        NUMERIC(14, 2),
  planned_risk_usd       NUMERIC(14, 2),       -- exact runtime 1R
  current_r              NUMERIC(10, 4),
  peak_r                 NUMERIC(10, 4),
  retained_profit_pct    NUMERIC(8, 4),
  giveback_pct           NUMERIC(8, 4),
  -- Protection model
  protection_stage       TEXT,                 -- DEVELOP|EARLY_GIVEBACK_BE|PROTECT|LOCK|STRONG|EXCEPTIONAL
  target_floor_usd       NUMERIC(14, 2),       -- INTENT under normal execution, not guaranteed fill
  proposed_protection_sl NUMERIC(20, 8),
  existing_manager_action TEXT,                -- BE | PARTIAL_LOCK | ATR_TRAIL | null
  shadow_decision        TEXT,                 -- NONE|WOULD_MOVE_SL|WOULD_MOVE_SL_TO_BE|WOULD_CLOSE|
                                               -- MOVED_SL|EXISTING_RULE_MORE_PROTECTIVE|EXISTING_*_CLOSE
  protection_mode        TEXT,                 -- shadow | live
  row_kind               TEXT NOT NULL,        -- snapshot | decision | close
  state_seq              BIGINT,               -- broker_configs.config.stateSeq at observation time
  -- Safety assertion (must remain false while protection_mode = shadow)
  shadow_command_emitted BOOLEAN NOT NULL DEFAULT false,
  -- Optional context — populated only where already available (no added coupling)
  market_regime          TEXT,
  session                TEXT
);

CREATE INDEX IF NOT EXISTS ppt_created_idx
  ON public.profit_protection_telemetry (created_at DESC);
CREATE INDEX IF NOT EXISTS ppt_ticket_idx
  ON public.profit_protection_telemetry (broker_ticket, created_at);
