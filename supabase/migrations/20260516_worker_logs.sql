-- Worker logs table — stores key events from the background scalper worker.
-- Run this in the Supabase SQL editor: https://supabase.com/dashboard/project/lfurosnmkwvqtlifggaa/sql

CREATE TABLE IF NOT EXISTS worker_logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  level       TEXT        NOT NULL DEFAULT 'info',   -- info | signal | alert | order | error | heartbeat
  pair        TEXT,
  session     TEXT,
  message     TEXT        NOT NULL,
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS worker_logs_created_at_idx ON worker_logs (created_at DESC);

ALTER TABLE worker_logs ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read all worker logs
CREATE POLICY "Auth users read worker logs"
  ON worker_logs FOR SELECT
  TO authenticated
  USING (true);

-- Service role (used by the worker) can insert
CREATE POLICY "Service role insert worker logs"
  ON worker_logs FOR INSERT
  WITH CHECK (true);
