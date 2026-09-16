-- 20261005_direction_confirmation_source.sql
-- Provenance for direction-confirmation permits: manual or automated.
--
-- 20260624 introduced direction_confirmations as an operator deadman switch: the
-- worker refuses to auto-execute unless an unexpired row exists for the pair.
-- This phase adds an automated validator so normal Auto Trade no longer needs a
-- human click every five minutes. Two things then need to be distinguishable:
--
--   1. AUDIT — "was this permit granted by a person or by the validator?"
--   2. POLICY — automated permits are bound to the M5 candle they were validated
--      against (a permit issued before that candle closed saw a PREVIOUS market
--      state and must not authorise execution against this one). Operator
--      permits keep their existing 5-minute semantics exactly.
--
-- A column is used rather than inferring provenance from timing or confidence,
-- because provenance is a fact and must not be guessed.
--
-- SAFE ON EXISTING DATA: NOT NULL with DEFAULT 'manual' — every pre-existing row
-- was operator-generated, so the default is not merely convenient, it is
-- correct. No row is rewritten, no constraint is dropped, no index is rebuilt
-- (20260624 already provides idx_direction_confirmations_user_pair_expires for
-- the worker's hot-path lookup).
--
-- REVERSIBILITY: ALTER TABLE public.direction_confirmations DROP COLUMN IF EXISTS source;

ALTER TABLE public.direction_confirmations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- Constrain to the two known provenances. Guarded so re-running is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'direction_confirmations_source_chk'
  ) THEN
    ALTER TABLE public.direction_confirmations
      ADD CONSTRAINT direction_confirmations_source_chk CHECK (source IN ('manual', 'automated'));
  END IF;
END $$;
