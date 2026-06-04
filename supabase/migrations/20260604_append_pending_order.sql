-- Atomic append of a single order to broker_configs.config.pendingOrders.
-- Using a stored function avoids the read-modify-write race condition between
-- the close-trade API and the EA's PUSH handler, which both update the same
-- broker_configs.config column. Without this, the PUSH can overwrite a
-- close command that was just queued, silently losing it before the EA polls.

CREATE OR REPLACE FUNCTION public.append_pending_order(
  p_config_id uuid,
  p_order     jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE broker_configs
  SET config = jsonb_set(
    COALESCE(config, '{}'::jsonb),
    '{pendingOrders}',
    COALESCE(config->'pendingOrders', '[]'::jsonb) || jsonb_build_array(p_order)
  )
  WHERE id = p_config_id;
$$;

GRANT EXECUTE ON FUNCTION public.append_pending_order(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_order(uuid, jsonb) TO service_role;
