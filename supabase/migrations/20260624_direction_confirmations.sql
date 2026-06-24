-- Per-pair, per-user direction-confirmation records produced by the manual
-- "TEST / CHECK MARKET DIRECTION" button on the AutoTrade page.
--
-- Acts as a deadman-switch on the 24/7 scalper worker: the worker refuses to
-- auto-execute unless a row exists for the pair with expires_at > now(). The
-- operator clicks the confirmation button at most every 5 minutes (the candle
-- window the analysis is bound to); skipping a click pauses auto-trade for
-- that pair until the next click.
--
-- Only 5m confirmations are inserted (1m is operator-advisory only and would
-- create an impractical 60-second deadman-switch). The check constraint
-- preserves that contract at the DB layer.

CREATE TABLE IF NOT EXISTS direction_confirmations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pair          TEXT NOT NULL,
  timeframe     TEXT NOT NULL CHECK (timeframe IN ('5m')),
  direction     TEXT NOT NULL CHECK (direction IN ('BUY','SELL','HOLD')),
  recommended   TEXT NOT NULL CHECK (recommended IN ('scalp','mirror')),
  confidence    INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  regime        TEXT,
  adx           NUMERIC,
  market_type   TEXT,
  analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker hot-path query: latest unexpired row for (user, pair). Composite
-- DESC index on expires_at makes the LIMIT 1 lookup a constant-time scan.
CREATE INDEX IF NOT EXISTS idx_direction_confirmations_user_pair_expires
  ON direction_confirmations (user_id, pair, expires_at DESC);

ALTER TABLE direction_confirmations ENABLE ROW LEVEL SECURITY;

-- Users can read their own confirmations from the browser.
CREATE POLICY "users read own direction_confirmations"
  ON direction_confirmations
  FOR SELECT
  USING (auth.uid() = user_id);

-- Inserts and the worker's hot-path SELECT use the service-role key
-- (server-side only), so no client-write policy needed.
