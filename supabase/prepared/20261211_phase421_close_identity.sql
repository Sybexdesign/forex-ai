-- SybexForexAI - PHASE 4.2.1 - CLOSE IDENTITY AND BROKER TIME (RPC PATCH)
--
-- STATUS: **PREPARED - NOT APPLIED.** This file deliberately lives outside
-- `supabase/migrations/` so it cannot be picked up as part of the applied
-- sequence. Applying it is an owner action and requires separate approval
-- (RECENT_TRADES_ACCOUNTING_IMPLEMENTATION.md §6, PRODUCTION_READINESS_REPORT.md).
--
-- WHAT THIS IS
-- A byte-for-byte copy of the CURRENT function definition in
--     supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql
-- with exactly ONE region replaced: the `closedPositions` UPDATE. Everything
-- else — token auth, FOR UPDATE, broker restrictions, PULL/PUSH, prices, candles,
-- completedOrders, correlation ids, native-ticket validation, pending orders,
-- broker_configs write-back, openPositions persistence, counters, return value —
-- is unchanged. Verify with:
--
--     diff <(sed -n '1,400p' supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql) \
--          <(sed -n '1,400p' supabase/prepared/20261211_phase421_close_identity.sql)
--
-- (the only difference will be the header comment and the replaced block).
--
-- WHY (see RECENT_TRADES_ACCOUNTING_AUDIT.md §4)
--   R-1  The close branch cannot write `broker_ticket`, so a genuine close whose
--        fill never produced a validated completion stays ticket-less, classifies
--        as SIMULATION, and vanishes from Recent Trades and from every metric.
--   R-2  Closes are matched by price proximity (|entry-open| < 5.0 for XAU) with
--        ORDER BY opened_at DESC LIMIT 1, so two same-direction positions opened
--        within that tolerance can have their P&L written onto the wrong row. The
--        payload carries the native position ticket (v9.5) and it was unused.
--   R-3  `closed_at = COALESCE(closed_at, now())` records the SERVER's receive
--        time, not the broker's close time, so "sort by broker timestamp" is
--        really sorted by arrival.
--
-- WHAT CHANGES (exactly three behaviours, all inside the close branch)
--   1. `broker_ticket` is filled from a VALIDATED payload ticket — digits only,
--      non-zero, <= 20 chars, never equal to an application id — and only when
--      the row has no ticket yet. An existing ticket is never overwritten.
--   2. Matching prefers ticket IDENTITY, falling back to the existing price
--      predicate for v1/v9.4 payloads that carry no ticket. The `pl_usd IS NULL`
--      guard is preserved on BOTH paths, so a re-delivered close still cannot
--      overwrite an accounted row.
--   3. `closed_at` uses the payload's `closedAt` ONLY when it is ISO-8601 with an
--      explicit `Z` or numeric offset. MT5's TimeToString emits broker-server
--      local time with no zone ("2026.11.18 09:42:00"); treating that as UTC
--      would shift every close by the broker's offset, so an unzoned value still
--      falls back to now() — unchanged behaviour, no invented timezone.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
--   * No table, column, index, trigger or view is created, dropped or altered.
--   * No historical row is read, rewritten or deleted. No backfill.
--   * No money is recomputed: pl_usd / commission / swap / other_fees /
--     net_realised_pnl and the WIN/LOSS derivation are untouched.
--   * No trading rule, lot size, SL/TP, risk limit, Prop Firm rule or execution
--     gate is referenced, let alone changed.
--   * v9.3.1 payloads keep producing gross-only rows (their folded `profit`
--     cannot be decomposed), so applying this BEFORE the EA upgrade is safe.
--   * Safe to re-apply: CREATE OR REPLACE on one function, idempotent body.
--
-- PRECONDITION
--   None for the RPC itself. R-1 only becomes *observable* for payloads that
--   carry `ticket` (EA v9.5). Applying this earlier changes nothing for v9.3.1
--   payloads and is therefore not a behaviour risk, only a no-op for them.
--
-- ============================================================================
-- BELOW: the full function definition, copied from 20261113 with the single
-- close-branch replacement. Do not edit by hand; regenerate if 20261113 moves.
-- ============================================================================

-- SybexForexAI - PHASE 4.2B - BROKER DEAL-LEVEL ACCOUNTING IN THE LIVE PATH
--
-- WHY THIS MIGRATION EXISTS
-- The shipping EA does NOT post to app/api/mt5-sync. It posts straight to
-- public.mt5_webhook_sync (SYNC_URL in SybexForexAI_EA_v9.4.mq5, and
-- tests/mt5-native-ticket-migration.test.mjs, which proved it in Phase 3.3.2).
-- So the ONLY place a real close can be given its broker costs is this function.
--
-- Two defects were in the incoming DATA, not in this function:
--   1. EA v9.3.1 read only the FIRST DEAL_ENTRY_OUT it found and `break`ed, so a
--      partially-closed position reported one leg of its P&L and silently
--      dropped the rest. Fixed in EA v9.4, which aggregates every deal.
--   2. EA v9.3.1 sent DEAL_PROFIT + DEAL_COMMISSION + DEAL_SWAP folded into a
--      single `profit` field. The server could not decompose it, so commission
--      and swap stayed NULL and every row was correctly refused as net-complete.
--
-- THIS CHANGE (function body only)
--   * reads executionPayloadVersion from p_payload;
--   * takes gross from grossProfit (falling back to profit for v1 payloads);
--   * writes commission, swap and other_fees when the payload carries them;
--   * computes realised_r from confirmed NET when available, else gross;
--   * leaves a v1 payload exactly as before - gross-only, no invented costs;
--   * the Phase 4.1 trigger trades_derive_accounting_trg then derives
--     net_realised_pnl / accounting_complete / trade_result from those columns.
--
-- SAFETY / IMPACT
--   * No table, column, index or trigger is created, dropped or altered.
--   * CREATE OR REPLACE on ONE function; the other ~400 lines are byte-identical
--     to 20261004_reconcile_close_accounting.sql.
--   * No historical row is read, rewritten or deleted.
--   * No trading rule, lot size, stop, target, filter or execution gate touched.
--   * An EA that has not been upgraded yet keeps producing gross-only rows, so
--     this is safe to apply BEFORE the EA binary is replaced.
--   * Idempotent: the match predicate still requires pl_usd IS NULL, so a
--     re-delivered close cannot overwrite an already-accounted row.
--
-- STATUS: prepared for approval (Phase 4.2 section 2.2). NOT applied.

-- ============================================================
-- 20261004_reconcile_close_accounting.sql
--
-- FORWARD-ONLY close-accounting completeness fix.
--
-- WHY
--
-- Genuine MT5 closures reconciled through the rich `closedPositions` branch of
-- mt5_webhook_sync() recorded authoritative realised P&L, MFE/MAE and closed_at,
-- but never wrote `exit_price`, `trade_status` or `realised_r`. Production rows
-- therefore carried result=WIN|LOSS with pl_usd set, while trade_status stayed
-- 'OPEN' and exit_price/realised_r stayed NULL. `exit_price` in particular was
-- already PARSED from the payload (v_cp_close_price) and then discarded.
--
-- WHAT CHANGES
--
-- Exactly three assignments added to the existing rich closedPositions UPDATE:
--
--     exit_price   = v_cp_close_price
--     trade_status = 'CLOSED'
--     realised_r   = v_cp_profit / NULLIF(planned_risk_amount, 0)
--
-- `realised_r` uses v_cp_profit (the authoritative broker-realised value) and NOT
-- pl_usd, because pl_usd is assigned in the same UPDATE and would resolve to its
-- pre-update value. NULLIF makes NULL *and* zero planned_risk_amount yield NULL.
-- `planned_risk_amount` is the immutable entry-time risk anchor; no moved SL,
-- telemetry floor, target floor or unrealised mark is ever used.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
--
--   * result keeps WIN/LOSS semantics (never 'CLOSED' in the rich path) — the
--     daily-loss gate and analytics aggregation key on these values.
--   * pl_usd / mfe_usd / mae_usd / closed_at writes are preserved verbatim.
--   * match predicates result IN ('OPEN','CLOSED') and pl_usd IS NULL are
--     preserved, so a fallback-closed row stays enrichable by a later genuine
--     rich event and duplicate rich events stay idempotent.
--   * the position-absence fallback branch is UNCHANGED and remains
--     accounting-incomplete: it never fabricates pl_usd/exit_price/realised_r.
--   * every other block (token auth, FOR UPDATE, broker restrictions, PULL/PUSH,
--     latestPrices, candle cache, completedOrders, correlation ID, native-ticket
--     fail-closed guard, pending-order handling, broker_configs write-back,
--     openPositions persistence, counters, return object) is byte-identical to
--     20261003_mt5_native_position_ticket.sql.
--
-- NO HISTORICAL BACKFILL. Forward-only. Pre-existing rows with NULL accounting
-- are intentionally left untouched; unrealised telemetry is never promoted to
-- realised P&L.
--
-- ACCOUNTING ONLY — no trading, risk, signal, entry, sizing, SL/TP, Prop Firm or
-- profit-protection behaviour is touched.
-- ============================================================

-- ── body below inherited unchanged from 20261003_mt5_native_position_ticket.sql ──

-- mt5_webhook_sync: persist the NATIVE MT5 position ticket on confirmed fills
--
-- 2026-10-03 — PHASE 3.3.3. Deterministic scalp attribution requires the SAME
-- identity on both sides of the app<->broker boundary:
--
--     shadow observer:  String(openTrade.id) === String(trade.broker_ticket)
--
-- where `openTrade.id` (from /api/account -> mt5direct.getOpenTrades) is the
-- native MT5 POSITION ticket. But until now no live path ever persisted that
-- ticket: `app/api/mt5-sync/route.ts` has no callers, and the EA posts completed
-- orders HERE, to this RPC. The RPC read only id/success/filledPrice, so
-- `completedOrders[].ticket` was silently discarded and every scalp trade row
-- kept its application correlation UUID in broker_ticket. Result: attribution
-- matched nothing, and 100% of open positions were skipped as
-- `no-scalp-trade-row` ("0 of N open position(s) attributable").
--
-- THE TWO IDENTITIES ARE INTENTIONALLY DIFFERENT AND BOTH ARE PRESERVED:
--
--   * APPLICATION correlation  = completedOrders[].id     -> trades.oanda_trade_id
--     (still the ONLY mechanism used to locate the asynchronous DB trade)
--   * NATIVE broker identity   = completedOrders[].ticket -> trades.broker_ticket
--     (the identity later exposed as /api/account openTrades[].id)
--
-- `oanda_trade_id` is NEVER overwritten with the MT5 ticket.
--
-- Behavioural change: EXACTLY ONE. On a successful completion, broker_ticket is
-- set to the native ticket, and only when it passes strict validation. A
-- missing/invalid ticket does NOT fail the otherwise-successful fill — it leaves
-- broker_ticket unchanged, so attribution stays UNAVAILABLE rather than becoming
-- AMBIGUOUS. No ticket is ever guessed or fabricated from symbol/time/lots, and
-- no historical row is backfilled (the native tickets of legacy rows were never
-- recorded, so there is no deterministic basis for reconstruction).
--
-- Body is otherwise IDENTICAL to 20260703_mt5_sync_pending_order_lock.sql (itself
-- identical to 20260616_mt5_rpc_mfe_mae, plus the config row lock). All
-- authentication, broker lookup, account updates, open-position handling,
-- pending-order locking, closed-position handling, reconciliation, failure
-- handling, response shape and concurrency behaviour are preserved verbatim.

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
  -- Phase 3.3.3 — native position ticket from completedOrders[].ticket
  v_ticket          text;
  v_ticket_valid    boolean;
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
  -- Phase 4.2B - broker deal-level accounting (payload v2)
  v_payload_version int := 0;
  v_cp_gross        numeric;
  v_cp_commission   numeric;
  v_cp_swap         numeric;
  v_cp_fee          numeric;
  v_cp_deals        int;
  v_cp_partial      boolean;
  v_cp_net          numeric;
  v_price_tol       numeric;
  v_closed_count    int := 0;
BEGIN
  -- ── Validate token ────────────────────────────────────────────────────────
  -- FOR UPDATE: hold the row lock for the whole call so append_pending_order
  -- serializes against our read-modify-write of config.pendingOrders.
  SELECT id, user_id, config
  INTO v_id, v_user_id, v_config
  FROM broker_configs
  WHERE (config->>'webhookToken') = p_token
    AND broker_type IN ('mt5direct', 'exness')
  LIMIT 1
  FOR UPDATE;

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

      -- ── Phase 3.3.3 — native position ticket (fail closed) ─────────────────
      -- NULLIF(btrim(...)) folds "missing", "" and " " (and any whitespace
      -- padding) to NULL, so none of them can reach the UPDATE.
      v_ticket := NULLIF(btrim(v_completed->>'ticket'), '');

      -- A ticket may replace broker_ticket ONLY when it is demonstrably a native
      -- MT5 position ticket:
      --   * numeric-only          digits only — no sign, decimal or exponent,
      --                           and (since a UUID is not all digits) no
      --                           application UUID can ever satisfy this
      --   * non-zero              a positive ticket; '0'/'00'/... are not
      --   * bounded length        a ulong ticket is at most 20 digits; anything
      --                           longer is not a real ticket
      --   * not the app id        never equal to completed.id — this is the
      --                           anti-fallback guard, so an APP UUID can never
      --                           be written into broker_ticket by accident
      v_ticket_valid :=
            v_ticket IS NOT NULL
        AND v_ticket ~ '^[0-9]+$'
        AND v_ticket !~ '^0+$'
        AND length(v_ticket) <= 20
        AND v_ticket <> v_order_id;

      IF v_success AND v_order_id IS NOT NULL AND v_user_id IS NOT NULL THEN
        -- Located by the APPLICATION correlation id (oanda_trade_id), which is
        -- never written here. broker_ticket falls back to its existing value
        -- whenever the ticket did not validate, so an invalid or absent ticket
        -- leaves attribution UNAVAILABLE rather than AMBIGUOUS, and an
        -- already-valid native ticket is never destroyed.
        UPDATE trades
           SET entry_price = COALESCE(v_filled_price, entry_price),
               opened_at   = COALESCE(opened_at, now()),
               result      = 'OPEN',
               broker_ticket = CASE
                                 WHEN v_ticket_valid THEN v_ticket
                                 ELSE broker_ticket
                               END
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

    -- Phase 4.2B - payload contract version. >= 2 means the EA transmits
    -- TRUE gross and every broker cost separately, so a NET figure is
    -- provable. Absent/1 is a v9.3.x EA that folded costs into `profit`.
    v_payload_version := COALESCE(NULLIF(p_payload->>'executionPayloadVersion', '')::int, 0);

    FOR v_closed_entry IN
        SELECT value FROM jsonb_array_elements(p_payload->'closedPositions')
    LOOP
      v_cp_sym         := regexp_replace(upper(v_closed_entry->>'symbol'), '[^A-Za-z]', '', 'g');
      v_cp_direction   := upper(COALESCE(v_closed_entry->>'type', 'BUY'));
      v_cp_open_price  := (v_closed_entry->>'openPrice')::numeric;
      v_cp_close_price := (v_closed_entry->>'closePrice')::numeric;
      -- Phase 4.2B - v2 payloads carry the gross and each broker cost
      -- separately. v1 payloads only have `profit`, which v9.3.x had already
      -- folded costs into; those rows stay gross-only, so the component
      -- columns are left NULL rather than given an invented zero.
      v_cp_gross       := COALESCE(NULLIF(v_closed_entry->>'grossProfit', '')::numeric,
                                   NULLIF(v_closed_entry->>'profit', '')::numeric);
      v_cp_profit      := v_cp_gross;
      v_cp_commission  := NULLIF(v_closed_entry->>'commission', '')::numeric;
      v_cp_swap        := NULLIF(v_closed_entry->>'swap', '')::numeric;
      v_cp_fee         := NULLIF(v_closed_entry->>'fee', '')::numeric;
      v_cp_deals       := NULLIF(v_closed_entry->>'dealCount', '')::int;
      v_cp_partial     := COALESCE(NULLIF(v_closed_entry->>'partial', '')::boolean, false);
      -- v9.3 fields (NULL when EA didn't track this ticket, e.g. restart)
      v_cp_mfe         := NULLIF(v_closed_entry->>'mfe', '')::numeric;
      v_cp_mae         := NULLIF(v_closed_entry->>'mae', '')::numeric;

      CONTINUE WHEN v_cp_sym IS NULL
                 OR v_cp_open_price IS NULL
                 OR v_cp_profit IS NULL;

      -- NET is computable ONLY when every cost term arrived. Otherwise the
      -- Phase 4.1 trigger leaves net_realised_pnl NULL and marks the row
      -- accounting-incomplete, which is the correct verdict - not a zero.
      v_cp_net := CASE
        WHEN v_payload_version >= 2
          AND v_cp_commission IS NOT NULL
          AND v_cp_swap IS NOT NULL
        THEN ROUND(v_cp_gross + v_cp_commission + v_cp_swap + COALESCE(v_cp_fee, 0), 2)
        ELSE NULL
      END;

      v_price_tol := CASE
        WHEN v_cp_sym LIKE 'XAU%' THEN 5.0
        WHEN v_cp_sym LIKE 'XAG%' THEN 0.5
        WHEN v_cp_sym LIKE '%JPY'  THEN 1.0
        ELSE 0.0015
      END;

      -- ── Phase 4.2.1 — CLOSE IDENTITY AND BROKER TIME ──────────────────────
      --
      -- Three defects are fixed here, and nothing else in this block changes
      -- meaning (RECENT_TRADES_ACCOUNTING_AUDIT.md R-1, R-2, R-3):
      --
      --   R-1  A close can never acquire a broker ticket, because broker_ticket
      --        is written only by the completedOrders branch. A genuine close
      --        whose fill never produced a validated completion therefore stays
      --        ticket-less, classifies as SIMULATION, and disappears from Recent
      --        Trades and from every headline figure. The payload's native
      --        position ticket is now persisted when it passes the SAME strict
      --        validation the completion branch already uses.
      --
      --   R-2  Matching was price-proximity only (|entry - open| < 5.0 for XAU)
      --        with ORDER BY opened_at DESC LIMIT 1. Two same-direction positions
      --        opened within that tolerance were indistinguishable, so P&L could
      --        be written onto the wrong row. When the payload carries a valid
      --        ticket we now match on IDENTITY first; the price predicate remains
      --        as the fallback for v1 and v9.4 payloads, which carry no ticket.
      --
      --   R-3  closed_at was COALESCE(closed_at, now()) — the SERVER's receive
      --        time. The EA's `closedAt` is now used, but ONLY when it is an
      --        ISO-8601 timestamp with an explicit UTC designator or offset.
      --        MT5's TimeToString emits broker-server local time with no zone
      --        ("2026.11.18 09:42:00"); converting that as if it were UTC would
      --        shift every close by the broker's offset, which is a fabrication.
      --        An unzoned value therefore falls through to now(), exactly as
      --        before, and the row keeps the arrival time it has always had.
      --
      -- NOTHING ELSE MOVES: the same WHERE `pl_usd IS NULL` idempotency guard
      -- (a re-delivered close still cannot overwrite an accounted row), the same
      -- money writes, the same realised_r rule, the same no-backfill policy.
      DECLARE
        v_cp_ticket      text;
        v_cp_closed_raw  text;
        v_cp_closed_at   timestamptz;
        v_cp_matched_id  uuid;
      BEGIN
        -- Native MT5 position ticket: digits only, non-zero, <= 20 chars, and
        -- never equal to any application correlation id. Identical rules to the
        -- completedOrders branch so one identity space exists.
        v_cp_ticket := NULLIF(btrim(v_closed_entry->>'ticket'), '');
        IF v_cp_ticket IS NOT NULL AND (
              v_cp_ticket !~ '^[0-9]+$'
           OR v_cp_ticket ~ '^0+$'
           OR length(v_cp_ticket) > 20
           OR v_cp_ticket = COALESCE(v_closed_entry->>'id', '')
        ) THEN
          v_cp_ticket := NULL;
        END IF;

        -- Broker close time: accept ONLY an explicitly-zoned ISO-8601 value.
        v_cp_closed_raw := NULLIF(btrim(v_closed_entry->>'closedAt'), '');
        IF v_cp_closed_raw IS NOT NULL
           AND (v_cp_closed_raw ~ 'Z$' OR v_cp_closed_raw ~ '[+-][0-9]{2}:?[0-9]{2}$') THEN
          BEGIN
            v_cp_closed_at := v_cp_closed_raw::timestamptz;
          EXCEPTION WHEN others THEN
            v_cp_closed_at := NULL;
          END;
        END IF;

        -- 1) Identity match (preferred). Requires the row to be un-accounted,
        --    preserving the existing duplicate-delivery protection.
        IF v_cp_ticket IS NOT NULL THEN
          SELECT id INTO v_cp_matched_id
            FROM trades
           WHERE user_id       = v_user_id
             AND broker_ticket = v_cp_ticket
             AND pl_usd        IS NULL
           ORDER BY opened_at DESC
           LIMIT 1;
        END IF;

        -- 2) Price fallback — unchanged behaviour, for payloads without a ticket.
        IF v_cp_matched_id IS NULL THEN
          SELECT id INTO v_cp_matched_id
            FROM trades
           WHERE user_id   = v_user_id
             AND replace(pair, '/', '') = v_cp_sym
             AND direction = v_cp_direction
             AND result   IN ('OPEN', 'CLOSED')
             AND pl_usd    IS NULL
             AND ABS(COALESCE(entry_price, 0) - v_cp_open_price) < v_price_tol
           ORDER BY opened_at DESC
           LIMIT 1;
        END IF;

        IF v_cp_matched_id IS NOT NULL THEN
          UPDATE trades
             SET result    = CASE WHEN COALESCE(v_cp_net, v_cp_profit) >= 0 THEN 'WIN' ELSE 'LOSS' END,
                 pl_usd    = v_cp_profit,
                 -- Broker costs, written through untouched (Exness reports
                 -- commission and swap signed: charges negative, credits
                 -- positive). NULL on a v1 payload, which keeps the row
                 -- gross-only instead of claiming a net the broker never sent.
                 commission = v_cp_commission,
                 swap       = v_cp_swap,
                 other_fees = v_cp_fee,
                 mfe_usd   = COALESCE(v_cp_mfe, mfe_usd),
                 mae_usd   = COALESCE(v_cp_mae, mae_usd),
                 -- R-3: validated broker close time, else the previous behaviour.
                 closed_at = COALESCE(closed_at, v_cp_closed_at, now()),
                 exit_price   = v_cp_close_price,
                 trade_status = 'CLOSED',
                 -- R-1: never overwrite an existing ticket, only fill a blank one.
                 broker_ticket = COALESCE(NULLIF(btrim(broker_ticket), ''), v_cp_ticket),
                 -- Realised R uses the confirmed NET when it exists, else gross,
                 -- so a gross-only row can never masquerade as net R.
                 realised_r   = COALESCE(v_cp_net, v_cp_profit) / NULLIF(planned_risk_amount, 0)
           WHERE id = v_cp_matched_id;

          v_closed_count := v_closed_count + 1;
        END IF;
      END;
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
