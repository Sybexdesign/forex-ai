-- Circuit-breaker arming trigger on trades.pl_usd transitions
--
-- Context: The MT5 EA posts directly to Supabase RPC mt5_webhook_sync, not to
-- the Next.js /api/mt5-sync route. The CB arming code in that route is dead
-- code on the actual close path, so SL-hit losses exceeding 1R were never
-- arming the breaker (Trade L 08-Jun unrealised=-0.87R realised=-1.006R, and
-- Trade today 10:45 unrealised never seen but realised=-58.34 = 1.216R both
-- slipped through).
--
-- Fix: trigger on trades AFTER UPDATE that fires whenever pl_usd transitions
-- from NULL to a value (the realised-PL write). If |pl_usd| >= 0.85 * 1R for
-- the user, write circuitBreakerUntil = max(existing, now()+15min) into
-- broker_configs.config. Source-agnostic — fires for closedPositions RPC,
-- oanda/trades DELETE, close-trade, manual UI close, all of them.
--
-- 1R formula: balance × (riskPct / 100), with conservative defaults if either
-- value is missing.

CREATE OR REPLACE FUNCTION public.arm_cb_on_realised_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       numeric;
  v_risk_pct      numeric;
  v_one_r         numeric;
  v_cb_trigger    numeric;
  v_now           timestamptz := now();
  v_until         timestamptz := v_now + interval '15 minutes';
  v_existing      timestamptz;
  v_existing_text text;
  v_until_iso     text;
  v_broker_id     uuid;
BEGIN
  -- Only act on transitions from NULL -> non-NULL pl_usd. Subsequent updates
  -- that change pl_usd from a value to another value (rare) are ignored.
  IF NEW.pl_usd IS NULL THEN RETURN NEW; END IF;
  IF OLD.pl_usd IS NOT NULL THEN RETURN NEW; END IF;
  -- Only losses arm the breaker.
  IF NEW.pl_usd >= 0 THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- Look up the user's strategy riskPct (defaults to 0.5%).
  SELECT COALESCE((settings->>'riskPct')::numeric, 0.5)
    INTO v_risk_pct
    FROM strategies
   WHERE user_id = NEW.user_id
   LIMIT 1;
  v_risk_pct := COALESCE(v_risk_pct, 0.5);

  -- Look up the active broker_config balance + existing CB state.
  SELECT id,
         COALESCE((config->>'balance')::numeric, 0),
         config->>'circuitBreakerUntil'
    INTO v_broker_id, v_balance, v_existing_text
    FROM broker_configs
   WHERE user_id = NEW.user_id
     AND is_active = true
   ORDER BY updated_at DESC
   LIMIT 1;

  -- Without a balance we cannot compute 1R reliably; skip.
  IF v_broker_id IS NULL OR v_balance <= 0 THEN
    RETURN NEW;
  END IF;

  v_one_r      := v_balance * (v_risk_pct / 100.0);
  v_cb_trigger := v_one_r * 0.85;

  -- Trigger threshold: realised loss must meet or exceed 0.85R.
  IF abs(NEW.pl_usd) < v_cb_trigger THEN
    RETURN NEW;
  END IF;

  -- If CB is already armed past our proposed until, leave the earlier (longer)
  -- pause untouched. Otherwise extend to v_until.
  v_existing := NULLIF(v_existing_text, '')::timestamptz;
  IF v_existing IS NOT NULL AND v_existing > v_until THEN
    v_until_iso := to_char(v_existing AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ELSE
    v_until_iso := to_char(v_until    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  END IF;

  UPDATE broker_configs
     SET config = config
                || jsonb_build_object(
                     'circuitBreakerUntil', v_until_iso,
                     'lastCbArmedAt',       to_char(v_now AT TIME ZONE 'UTC',
                                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'lastCbArmedPair',     NEW.pair,
                     'lastCbArmedPl',       to_char(NEW.pl_usd, 'FM999999990.99'),
                     'lastCbArmedOneR',     to_char(v_one_r,    'FM999999990.99')
                   ),
         updated_at = v_now
   WHERE id = v_broker_id;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never break the UPDATE if the trigger itself errors. CB arming is
    -- best-effort; a silent miss is preferable to a blocked trade close.
    RAISE WARNING 'arm_cb_on_realised_loss: % %', SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS arm_cb_on_realised_loss_trg ON public.trades;

CREATE TRIGGER arm_cb_on_realised_loss_trg
AFTER UPDATE OF pl_usd ON public.trades
FOR EACH ROW
WHEN (OLD.pl_usd IS NULL AND NEW.pl_usd IS NOT NULL AND NEW.pl_usd < 0)
EXECUTE FUNCTION public.arm_cb_on_realised_loss();
