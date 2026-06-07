-- Server-side auto-trade gating columns. Lets the worker (workers/scalper.mjs)
-- decide whether to autonomously place orders when WORKER_MODE=live. Defaults
-- guarantee no behaviour change on existing rows — auto_trade_enabled must be
-- explicitly flipped to TRUE per user before the worker will execute anything.

ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS auto_trade_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_trade_sections TEXT[]      NOT NULL DEFAULT ARRAY['scalp']::TEXT[],
  ADD COLUMN IF NOT EXISTS auto_trade_pairs    TEXT[]      NOT NULL DEFAULT ARRAY['XAU/USD','XAG/USD']::TEXT[];
