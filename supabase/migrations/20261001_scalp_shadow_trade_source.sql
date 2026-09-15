-- 20261001_scalp_shadow_trade_source.sql
-- Additive provenance discriminator for public.profit_protection_telemetry.
--
-- WHY EXPLICIT PROVENANCE
--
-- Two independent producers now write this table: the MT5 position manager and
-- the scalp shadow evaluator. Inferring which one wrote a row later — from ticket
-- shape, pair, or the row's decision vocabulary — is guesswork, and a
-- misattributed row silently pollutes the shadow study's sample. So each
-- producer stamps its own source at write time.
--
--   trade_source = 'scalp'  → scalp shadow evaluator (read-only observation)
--   trade_source = 'mt5'    → MT5 position manager
--
-- The column is nullable and defaults to nothing, so the existing MT5 code path
-- is unaffected and no writer breaks if it does not yet set the field.

ALTER TABLE public.profit_protection_telemetry
  ADD COLUMN IF NOT EXISTS trade_source TEXT;

-- Backfill pre-existing rows to 'mt5'. This is an inference, but a sound one:
-- before this migration the MT5 manager was the only writer that existed.
-- At the time of writing the table is at ZERO rows, so this is a no-op there and
-- exists purely to keep the column meaningful on any environment that does have
-- history.
UPDATE public.profit_protection_telemetry
  SET trade_source = 'mt5'
  WHERE trade_source IS NULL;

-- The analysis tool filters by source first, so lead the index with it.
CREATE INDEX IF NOT EXISTS profit_protection_telemetry_source_idx
  ON public.profit_protection_telemetry (trade_source, created_at DESC);
