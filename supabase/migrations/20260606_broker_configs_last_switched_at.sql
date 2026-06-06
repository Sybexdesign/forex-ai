-- Records when a broker_configs row was last set is_active=true. The worker
-- uses this to detect mid-session account switches and invalidate its cached
-- risk state immediately instead of waiting for the next 30s refresh window.

ALTER TABLE broker_configs
  ADD COLUMN IF NOT EXISTS last_switched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS broker_configs_last_switched_at_idx
  ON broker_configs(user_id, last_switched_at DESC);
