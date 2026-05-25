-- Patch mt5_webhook_sync: update trades table when EA confirms order execution.
-- Previously the RPC removed completedOrders from the queue but never wrote back
-- to the trades table, leaving all trades with UUID oanda_trade_ids forever.

CREATE OR REPLACE FUNCTION public.mt5_webhook_sync(
  p_token   text,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id              uuid;
  v_user_id         uuid;
  v_config          jsonb;
  v_now             text;
  v_latest_prices   jsonb;
  v_candle_cache    jsonb;
  v_pending_orders  jsonb;
  v_sym             text;
  v_price_entry     jsonb;
  v_tf              text;
  v_sym_tf          text;
  v_bars            jsonb;
  v_now_epoch       bigint;
  v_prices_count    int;
  v_candles_count   int;
  v_active_orders   jsonb;
  v_completed       jsonb;
  v_order_id        text;
  v_filled_price    numeric;
  v_success         boolean;
BEGIN
  -- ── Validate token ────────────────────────────────────────────────────────
  SELECT id, user_id, config
  INTO v_id, v_user_id, v_config
  FROM broker_configs
  WHERE (config->>'webhookToken') = p_token
    AND broker_type IN ('mt5direct', 'exness')
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Invalid token');
  END IF;

  -- ── PULL: return pending orders (no balance in payload) ───────────────────
  IF p_payload IS NULL OR (p_payload->>'balance') IS NULL THEN
    v_now_epoch := extract(epoch from now())::bigint;
    SELECT COALESCE(jsonb_agg(o), '[]'::jsonb)
    INTO   v_active_orders
    FROM   jsonb_array_elements(COALESCE(v_config->'pendingOrders', '[]')) o
    WHERE  (o->>'expiresAt') IS NULL
        OR (o->>'expiresAt')::bigint > v_now_epoch;

    IF jsonb_array_length(v_active_orders) <
       jsonb_array_length(COALESCE(v_config->'pendingOrders', '[]')) THEN
      UPDATE broker_configs
         SET config = jsonb_set(v_config, '{pendingOrders}', v_active_orders)
       WHERE id = v_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'pendingOrders', v_active_orders);
  END IF;

  -- ── PUSH: validate ────────────────────────────────────────────────────────
  IF jsonb_typeof(p_payload->'balance') != 'number' THEN
    RETURN jsonb_build_object('error', 'balance must be a number');
  END IF;

  v_now := to_char(now() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- ── Merge prices ──────────────────────────────────────────────────────────
  v_latest_prices := COALESCE(v_config->'latestPrices', '{}'::jsonb);
  IF (p_payload->'prices') IS NOT NULL
     AND jsonb_typeof(p_payload->'prices') = 'object' THEN
    FOR v_sym, v_price_entry IN
        SELECT key, value FROM jsonb_each(p_payload->'prices')
    LOOP
      IF (v_price_entry->>'bid') IS NOT NULL
         AND (v_price_entry->>'ask') IS NOT NULL THEN
        v_latest_prices := jsonb_set(
          v_latest_prices,
          ARRAY[v_sym],
          v_price_entry || jsonb_build_object('updatedAt', v_now)
        );
      END IF;
    END LOOP;
  END IF;

  -- ── Merge candle cache ───────────────────────────────────────────────────
  v_candle_cache := COALESCE(v_config->'candleCache', '{}'::jsonb);
  IF (p_payload->'candles') IS NOT NULL
     AND (p_payload->'candles'->>'timeframe') IS NOT NULL
     AND (p_payload->'candles'->'data') IS NOT NULL
     AND jsonb_typeof(p_payload->'candles'->'data') = 'object' THEN
    v_tf := p_payload->'candles'->>'timeframe';
    FOR v_sym, v_bars IN
        SELECT key, value FROM jsonb_each(p_payload->'candles'->'data')
    LOOP
      IF jsonb_typeof(v_bars) = 'array'
         AND jsonb_array_length(v_bars) >= 10 THEN
        v_sym_tf := v_sym || '_' || v_tf;
        v_candle_cache := jsonb_set(
          v_candle_cache,
          ARRAY[v_sym_tf],
          jsonb_build_object('candles', v_bars, 'updatedAt', v_now)
        );
      END IF;
    END LOOP;
  END IF;

  -- ── Process completed orders ─────────────────────────────────────────────
  v_pending_orders := COALESCE(v_config->'pendingOrders', '[]'::jsonb);
  IF (p_payload->'completedOrders') IS NOT NULL
     AND jsonb_array_length(p_payload->'completedOrders') > 0 THEN

    -- Update the trades table for each successfully filled order
    FOR v_completed IN
        SELECT value FROM jsonb_array_elements(p_payload->'completedOrders')
    LOOP
      v_order_id    := v_completed->>'id';
      v_success     := (v_completed->>'success')::boolean;
      v_filled_price := (v_completed->>'filledPrice')::numeric;

      IF v_success AND v_order_id IS NOT NULL AND v_user_id IS NOT NULL THEN
        UPDATE trades
           SET entry_price = COALESCE(v_filled_price, entry_price),
               opened_at   = COALESCE(opened_at, now()),
               result      = 'OPEN'
         WHERE user_id        = v_user_id
           AND oanda_trade_id = v_order_id
           AND result         = 'OPEN';
      ELSIF NOT v_success AND v_order_id IS NOT NULL AND v_user_id IS NOT NULL THEN
        -- Mark failed orders so they don't clutter the open trade list
        UPDATE trades
           SET result = 'CANCELLED',
               notes  = COALESCE(notes || ' | ', '') || 'MT5 rejected: ' || COALESCE(v_completed->>'error', 'unknown')
         WHERE user_id        = v_user_id
           AND oanda_trade_id = v_order_id
           AND result         = 'OPEN';
      END IF;
    END LOOP;

    -- Remove all completed orders from the pending queue (success or fail)
    SELECT COALESCE(jsonb_agg(o), '[]'::jsonb)
    INTO   v_pending_orders
    FROM   jsonb_array_elements(v_pending_orders) o
    WHERE  NOT (o->>'id' = ANY(
             SELECT elem->>'id'
             FROM   jsonb_array_elements(p_payload->'completedOrders') elem
           ));
  END IF;

  -- ── Count results ─────────────────────────────────────────────────────────
  SELECT count(*) INTO v_prices_count  FROM jsonb_object_keys(v_latest_prices);
  SELECT count(*) INTO v_candles_count FROM jsonb_object_keys(v_candle_cache);

  -- ── Write back ────────────────────────────────────────────────────────────
  UPDATE broker_configs
  SET
    config = v_config
      || jsonb_build_object(
           'balance',       p_payload->>'balance',
           'equity',        COALESCE(p_payload->>'equity', p_payload->>'balance'),
           'currency',      COALESCE(NULLIF(p_payload->>'currency',''), v_config->>'currency', 'USD'),
           'login',         COALESCE(NULLIF(p_payload->>'login',''),    v_config->>'login',    ''),
           'server',        COALESCE(NULLIF(p_payload->>'server',''),   v_config->>'server',   ''),
           'updatedAt',     v_now,
           'pendingOrders', v_pending_orders,
           'latestPrices',  v_latest_prices,
           'candleCache',   v_candle_cache,
           'openPositions', COALESCE(p_payload->'openPositions',
                                     v_config->'openPositions',
                                     '[]'::jsonb)
         ),
    updated_at = now()
  WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'prices', v_prices_count, 'candles', v_candles_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO authenticated;
