-- mt5_webhook_sync: write mfe_usd / mae_usd from closedPositions
--
-- 2026-06-16 — the EA (v9.3) emits mfe and mae per closed position
-- (BuildClosedPositionsJSON in SybexForexAI_EA_v9.3.mq5), but the RPC's
-- closedPositions UPDATE block only writes result / pl_usd / closed_at.
-- All trades since the v9.3 EA install have mfe_usd / mae_usd = NULL, which
-- blocks trade-quality analytics. This migration re-defines the function with
-- the same body plus two added column writes; no other behaviour changes.

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
  v_tf_data         jsonb;
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
  v_reconciled      int;
  -- closedPositions processing
  v_closed_entry    jsonb;
  v_cp_sym          text;
  v_cp_direction    text;
  v_cp_open_price   numeric;
  v_cp_close_price  numeric;
  v_cp_profit       numeric;
  v_cp_mfe          numeric;
  v_cp_mae          numeric;
  v_price_tol       numeric;
  v_closed_count    int := 0;
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

    RETURN jsonb_build_object(
      'ok',              true,
      'pendingOrders',   v_active_orders,
      'profitTargetUsd', COALESCE((v_config->>'profitTargetUsd')::numeric, 0),
      'profitFixedUsd',  COALESCE((v_config->>'profitFixedUsd')::numeric,  0),
      'profitTargetPct', COALESCE((v_config->>'profitTargetPct')::int,      75)
    );
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
     AND jsonb_typeof(p_payload->'candles') = 'object' THEN

    IF (p_payload->'candles'->>'timeframe') IS NOT NULL THEN
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
    ELSE
      FOR v_tf, v_tf_data IN
          SELECT key, value
          FROM   jsonb_each(p_payload->'candles')
          WHERE  jsonb_typeof(value) = 'object'
      LOOP
        FOR v_sym, v_bars IN
            SELECT key, value FROM jsonb_each(v_tf_data)
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
      END LOOP;
    END IF;
  END IF;

  -- ── Process completed orders ─────────────────────────────────────────────
  v_pending_orders := COALESCE(v_config->'pendingOrders', '[]'::jsonb);
  IF (p_payload->'completedOrders') IS NOT NULL
     AND jsonb_array_length(p_payload->'completedOrders') > 0 THEN

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
        UPDATE trades
           SET result = 'CANCELLED',
               notes  = COALESCE(notes || ' | ', '') || 'MT5 rejected: ' || COALESCE(v_completed->>'error', 'unknown')
         WHERE user_id        = v_user_id
           AND oanda_trade_id = v_order_id
           AND result         = 'OPEN';
      END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(o), '[]'::jsonb)
    INTO   v_pending_orders
    FROM   jsonb_array_elements(v_pending_orders) o
    WHERE  NOT (o->>'id' = ANY(
             SELECT elem->>'id'
             FROM   jsonb_array_elements(p_payload->'completedOrders') elem
           ));
  END IF;

  -- ── Process closedPositions (EA v9+): record WIN/LOSS + MFE/MAE + net P/L
  IF p_payload->'closedPositions' IS NOT NULL
     AND v_user_id IS NOT NULL
     AND jsonb_array_length(p_payload->'closedPositions') > 0 THEN

    FOR v_closed_entry IN
        SELECT value FROM jsonb_array_elements(p_payload->'closedPositions')
    LOOP
      v_cp_sym         := regexp_replace(upper(v_closed_entry->>'symbol'), '[^A-Za-z]', '', 'g');
      v_cp_direction   := upper(COALESCE(v_closed_entry->>'type', 'BUY'));
      v_cp_open_price  := (v_closed_entry->>'openPrice')::numeric;
      v_cp_close_price := (v_closed_entry->>'closePrice')::numeric;
      v_cp_profit      := (v_closed_entry->>'profit')::numeric;
      -- v9.3 fields (NULL when EA didn't track this ticket, e.g. restart)
      v_cp_mfe         := NULLIF(v_closed_entry->>'mfe', '')::numeric;
      v_cp_mae         := NULLIF(v_closed_entry->>'mae', '')::numeric;

      CONTINUE WHEN v_cp_sym IS NULL
                 OR v_cp_open_price IS NULL
                 OR v_cp_profit IS NULL;

      v_price_tol := CASE
        WHEN v_cp_sym LIKE 'XAU%' THEN 5.0
        WHEN v_cp_sym LIKE 'XAG%' THEN 0.5
        WHEN v_cp_sym LIKE '%JPY'  THEN 1.0
        ELSE 0.0015
      END;

      UPDATE trades
         SET result    = CASE WHEN v_cp_profit >= 0 THEN 'WIN' ELSE 'LOSS' END,
             pl_usd    = v_cp_profit,
             mfe_usd   = COALESCE(v_cp_mfe, mfe_usd),
             mae_usd   = COALESCE(v_cp_mae, mae_usd),
             closed_at = COALESCE(closed_at, now())
       WHERE id = (
         SELECT id FROM trades
          WHERE user_id   = v_user_id
            AND replace(pair, '/', '') = v_cp_sym
            AND direction = v_cp_direction
            AND result   IN ('OPEN', 'CLOSED')
            AND pl_usd    IS NULL
            AND ABS(COALESCE(entry_price, 0) - v_cp_open_price) < v_price_tol
          ORDER BY opened_at DESC
          LIMIT 1
       );

      IF FOUND THEN
        v_closed_count := v_closed_count + 1;
      END IF;
    END LOOP;
  END IF;

  -- ── Reconcile DB OPEN trades against EA live positions ───────────────────
  IF p_payload->'openPositions' IS NOT NULL AND v_user_id IS NOT NULL THEN
    UPDATE trades t
       SET result    = 'CLOSED',
           closed_at = now()
      FROM (
        SELECT
          id,
          replace(pair, '/', '') AS raw_pair,
          direction,
          row_number() OVER (
            PARTITION BY replace(pair, '/',''), direction
            ORDER BY opened_at DESC
          ) AS rn
        FROM trades
        WHERE user_id  = v_user_id
          AND result   = 'OPEN'
          AND opened_at < now() - interval '2 minutes'
      ) d
      LEFT JOIN (
        SELECT
          regexp_replace(upper(ea->>'symbol'), '[^A-Za-z]', '', 'g') AS raw_sym,
          upper(COALESCE(ea->>'type', 'BUY'))                         AS direction,
          count(*)::int                                                AS cnt
        FROM jsonb_array_elements(p_payload->'openPositions') ea
        WHERE (ea->>'symbol') IS NOT NULL
        GROUP BY regexp_replace(upper(ea->>'symbol'), '[^A-Za-z]', '', 'g'),
                 upper(COALESCE(ea->>'type', 'BUY'))
      ) e ON e.raw_sym  = d.raw_pair
         AND e.direction = d.direction
     WHERE t.id = d.id
       AND d.rn > COALESCE(e.cnt, 0);

    GET DIAGNOSTICS v_reconciled = ROW_COUNT;
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

  RETURN jsonb_build_object(
    'ok',         true,
    'prices',     v_prices_count,
    'candles',    v_candles_count,
    'reconciled', COALESCE(v_reconciled, 0),
    'closed',     v_closed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO authenticated;
