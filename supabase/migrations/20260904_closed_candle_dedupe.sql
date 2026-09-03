-- ============================================================
-- 20260904_closed_candle_dedupe.sql
-- Closed-candle evaluation fix (audit 2026-09-04)
--
-- Signals are now generated from the latest FULLY CLOSED 5m candle instead of
-- requiring the API request to land inside the 1-2s window right after a
-- candle closes. The worker may therefore sweep the same closed candle several
-- times while the next bar is still forming.
--
-- This migration makes per-candle deduplication DURABLE: for each
--   (user_id, pair, candle_close_time)
-- at most one signals row and one prediction_logs row may exist. Worker/browser
-- writers use ON CONFLICT DO NOTHING (supabase-js upsert with ignoreDuplicates)
-- so the first writer wins and every later attempt is a no-op — even across
-- worker restarts, serverless cold starts and concurrent API requests.
--
-- Plain (non-partial) unique indexes are used deliberately: PostgreSQL treats
-- NULLs as distinct, so legacy rows with NULL candle_close_time are untouched
-- while every non-NULL (user, pair, candle_close_time) triple is enforced
-- unique. No historical data is modified or deleted.
--
-- If a pre-existing duplicate set blocks index creation the migration emits a
-- NOTICE and leaves the constraint off (callers keep inserting with ON
-- CONFLICT DO NOTHING which is a no-op when the index is absent) — the admin
-- must then resolve duplicates before re-running.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.signals
    WHERE candle_close_time IS NOT NULL
    GROUP BY user_id, pair, candle_close_time
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'signals contains duplicate (user_id,pair,candle_close_time) rows — unique index signals_one_per_candle NOT created; resolve duplicates first';
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS signals_one_per_candle ON public.signals (user_id, pair, candle_close_time)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.prediction_logs
    WHERE candle_close_time IS NOT NULL
    GROUP BY user_id, pair, candle_close_time
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'prediction_logs contains duplicate (user_id,pair,candle_close_time) rows — unique index prediction_logs_one_per_candle NOT created; resolve duplicates first';
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS prediction_logs_one_per_candle ON public.prediction_logs (user_id, pair, candle_close_time)';
  END IF;
END $$;
