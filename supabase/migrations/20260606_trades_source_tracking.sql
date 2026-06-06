-- Attribute every trade row to the code path that placed it (scan, scalp,
-- mirror, worker, manual) and persist the source signal's intent so audits
-- can reconstruct: was the trade clamped? was it latent? was the source
-- confident? Pre-this-migration, no field on the trade row distinguished
-- these paths, making the mirror-quality audit literally impossible.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS source            TEXT,
  ADD COLUMN IF NOT EXISTS source_sl_pips    NUMERIC,
  ADD COLUMN IF NOT EXISTS source_tp_pips    NUMERIC,
  ADD COLUMN IF NOT EXISTS signal_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signal_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS signal_id_ref     TEXT;

-- CHECK constraint added separately so the migration is replayable even if
-- the column already exists from an earlier partial run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'trades_source_check' AND table_name = 'trades'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_source_check
      CHECK (source IS NULL OR source IN ('scan','scalp','mirror','worker','manual'));
  END IF;
END$$;

-- Indexes for the two most common audit dimensions
CREATE INDEX IF NOT EXISTS trades_source_idx              ON trades(source);
CREATE INDEX IF NOT EXISTS trades_signal_confidence_idx   ON trades(signal_confidence);
