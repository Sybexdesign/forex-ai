-- Worker cache reset queue — admin requests a worker in-memory cache reset.
-- The scalper worker polls this table every ~30s and clears its in-memory
-- state (risk cache, HTF cache, cooldowns, pending signals) when a new
-- unconsumed row appears.
-- Run this in the Supabase SQL editor: https://supabase.com/dashboard/project/lfurosnmkwvqtlifggaa/sql

CREATE TABLE IF NOT EXISTS worker_cache_resets (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  consumed     BOOLEAN     DEFAULT FALSE,
  consumed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS worker_cache_resets_unconsumed_idx
  ON worker_cache_resets (consumed, requested_at DESC);

ALTER TABLE worker_cache_resets ENABLE ROW LEVEL SECURITY;

-- Service role (used by the admin API) can insert
CREATE POLICY "Service role insert worker cache resets"
  ON worker_cache_resets FOR INSERT
  WITH CHECK (true);

-- Service role can read (worker polls for unconsumed rows)
CREATE POLICY "Service role read worker cache resets"
  ON worker_cache_resets FOR SELECT
  USING (true);

-- Service role can update (worker marks rows consumed)
CREATE POLICY "Service role update worker cache resets"
  ON worker_cache_resets FOR UPDATE
  USING (true)
  WITH CHECK (true);
