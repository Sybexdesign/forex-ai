-- Signal reconciliation table — captures scalp and mirror signal snapshots at
-- generation time, then resolves them against the live market price after the
-- stated timeframe (1m/5m) has elapsed. Used to compute rolling win-rate
-- comparisons between the scalp and mirror signal paths.
--
-- Each signal gets its OWN row (scalp and mirror are separate predictions
-- graded against the same outcome — they are not a single bet). This keeps
-- the table clean and allows independent aggregation per signal_type.
--
-- The noise threshold (min_movement_pips) determines whether a signal is
-- scored as WIN/LOSS or INCONCLUSIVE. A 0.3-pip drift either way is noise,
-- not signal confirmation — scoring it as a win/loss would corrupt the
-- accuracy stats.

CREATE TABLE IF NOT EXISTS signal_reconciliation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type     TEXT NOT NULL CHECK (signal_type IN ('scalp', 'mirror')),
  pair            TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'HOLD')),
  entry_price     NUMERIC NOT NULL,
  timeframe       TEXT NOT NULL CHECK (timeframe IN ('1m', '5m')),
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  signal_id       TEXT,                          -- optional reference to the source signal
  -- Resolution fields (populated by the worker at generated_at + timeframe)
  resolved_at     TIMESTAMPTZ,
  resolved_price  NUMERIC,
  outcome         TEXT CHECK (outcome IN ('WIN', 'LOSS', 'INCONCLUSIVE', 'PENDING')),
  movement_pips   NUMERIC,                       -- absolute price movement in pips
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Worker hot-path query: find signals that are due for resolution
CREATE INDEX IF NOT EXISTS idx_signal_recon_pending
  ON signal_reconciliation (generated_at, timeframe)
  WHERE outcome IS NULL OR outcome = 'PENDING';

-- Aggregation queries: rolling win-rate per signal_type
CREATE INDEX IF NOT EXISTS idx_signal_recon_type_outcome
  ON signal_reconciliation (signal_type, outcome, generated_at DESC);

ALTER TABLE signal_reconciliation ENABLE ROW LEVEL SECURITY;

-- Users can read their own reconciliation records from the browser
CREATE POLICY "users read own signal_reconciliation"
  ON signal_reconciliation
  FOR SELECT
  USING (auth.uid() = user_id);

-- Inserts and the worker's hot-path SELECT/UPDATE use the service-role key
-- (server-side only), so no client-write policy needed.
