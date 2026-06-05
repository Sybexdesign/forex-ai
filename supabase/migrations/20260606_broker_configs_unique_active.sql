-- Enforce that each user can have at most ONE active broker config.
-- Without this, two rows with is_active = true for the same user would silently
-- break getBroker()'s lookup (it expects exactly one) and could route trades
-- through the wrong account.

CREATE UNIQUE INDEX IF NOT EXISTS broker_configs_one_active_per_user
ON broker_configs(user_id)
WHERE is_active = true;
