-- Telegram alert when MT5 rejects an order (trades → CANCELLED transition)
--
-- 2026-07-03 — EA-side order rejections (e.g. retcode 10026 "autotrading
-- disabled by server") are recorded by mt5_webhook_sync as result=CANCELLED
-- with a "MT5 rejected: retcode N" note, but no alert fires: the order API
-- already returned success when the order was queued, so alertOrderFailed
-- never runs and the trade just silently fails to appear. Fire the alert from
-- a trigger so it works regardless of which component records the rejection.
--
-- Credentials: Telegram bot token + chat id are read from Supabase Vault
-- (secrets `telegram_bot_token` / `telegram_chat_id` — created out-of-band,
-- NOT in this migration). If either secret is missing the trigger no-ops.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.alert_mt5_rejection()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token   text;
  v_chat    text;
  v_retcode text;
  v_meaning text;
  v_text    text;
BEGIN
  -- Only on transition INTO CANCELLED with an MT5 rejection note.
  IF NEW.result IS DISTINCT FROM 'CANCELLED' THEN RETURN NEW; END IF;
  IF OLD.result IS NOT DISTINCT FROM 'CANCELLED' THEN RETURN NEW; END IF;
  IF NEW.notes IS NULL OR NEW.notes NOT ILIKE '%MT5 rejected%' THEN RETURN NEW; END IF;

  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token';
  SELECT decrypted_secret INTO v_chat  FROM vault.decrypted_secrets WHERE name = 'telegram_chat_id';
  IF v_token IS NULL OR v_chat IS NULL THEN
    RAISE WARNING 'alert_mt5_rejection: telegram secrets missing from vault — alert not sent';
    RETURN NEW;
  END IF;

  v_retcode := substring(NEW.notes from 'retcode (\d+)');
  v_meaning := CASE v_retcode
    WHEN '10004' THEN 'requote'
    WHEN '10006' THEN 'request rejected by broker'
    WHEN '10013' THEN 'invalid request — often symbol unknown to terminal (price=0); check Market Watch / SymbolSuffix'
    WHEN '10014' THEN 'invalid volume'
    WHEN '10015' THEN 'invalid price'
    WHEN '10016' THEN 'invalid stops (SL/TP too close or wrong side)'
    WHEN '10017' THEN 'trading disabled'
    WHEN '10018' THEN 'market closed'
    WHEN '10019' THEN 'insufficient funds'
    WHEN '10021' THEN 'no quotes to process request'
    WHEN '10026' THEN 'autotrading disabled by broker SERVER — check account permissions / contact broker'
    WHEN '10027' THEN 'autotrading disabled in terminal — enable the AutoTrading button'
    WHEN '10030' THEN 'unsupported order fill mode'
    WHEN '10031' THEN 'no connection to trade server'
    ELSE NULL
  END;

  v_text := '❌ <b>MT5 REJECTED ORDER — ' || COALESCE(NEW.pair, '?') || '</b>'
         || E'\n\n'
         || 'Direction: ' || COALESCE(NEW.direction, '?') || E'\n'
         || 'Lots: '      || COALESCE(NEW.lots::text, '?') || E'\n'
         || 'Source: '    || COALESCE(NEW.source, 'unknown') || E'\n'
         || 'Error: '     || replace(replace(NEW.notes, '<', '&lt;'), '>', '&gt;')
         || CASE WHEN v_meaning IS NOT NULL THEN E'\n' || '→ ' || v_meaning ELSE '' END;

  PERFORM net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object('chat_id', v_chat, 'text', v_text, 'parse_mode', 'HTML'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_alert_mt5_rejection ON public.trades;
CREATE TRIGGER trg_alert_mt5_rejection
  AFTER UPDATE OF result ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION public.alert_mt5_rejection();
