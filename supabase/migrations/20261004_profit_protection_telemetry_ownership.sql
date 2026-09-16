-- 20261004_profit_protection_telemetry_ownership.sql
-- Explicit OWNERSHIP for every Profit Protection telemetry event.
--
-- WHY THIS IS REQUIRED
--
-- profit_protection_telemetry carried no user_id, so a telemetry row could only
-- be attributed by `broker_ticket`. That is insufficient: a native MT5 ticket is
-- unique WITHIN an account, not across every broker/account, so two accounts
-- sharing a ticket number were indistinguishable to the study.
--
-- Worse, the close-idempotency guarantee was built on that unqualified key
-- (migration 20261002):
--
--     UNIQUE (trade_source, broker_ticket) WHERE row_kind='close' AND ...
--
-- Under multi-account operation the second account's genuine close row would
-- collide with the first account's and be swallowed as a duplicate — the worker
-- treats a 409 as "already persisted", so the lifecycle would be silently
-- dropped rather than merely ambiguous. False idempotency, not just noise.
--
-- The invariant this migration restores:
--
--     ONE USER → ONE RESOLVED ACCOUNT → ITS TRADE → ITS TELEMETRY
--
-- SAFETY ON EXISTING DATA
--
-- Verified empty in production before writing this migration (0 rows), so the
-- unique index can be replaced cleanly with no backfill and no data loss. The
-- NOT NULL promotion is guarded: if ANY row ever lacks user_id the constraint is
-- simply not applied rather than failing the migration. No table recreation, no
-- destructive DDL, no history rewritten.
--
-- REVERSIBILITY
--
--   ALTER TABLE public.profit_protection_telemetry DROP COLUMN IF EXISTS user_id;
--   DROP INDEX IF EXISTS public.profit_protection_telemetry_scalp_close_uniq;
--   -- then re-apply 20261002 to restore the unqualified index.
--   ALTER TABLE public.profit_protection_telemetry DISABLE ROW LEVEL SECURITY;

-- ── 1. Ownership column ──────────────────────────────────────────────────────
-- Same identity model as every other user-owned table in this schema
-- (see 20260507_strategies_table.sql): UUID referencing auth.users.
ALTER TABLE public.profit_protection_telemetry
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── 2. User-scoped read indexes ──────────────────────────────────────────────
-- Supersedes the ticket-only index for every scoped query. The old index is left
-- in place (it is still usable for unscoped admin scans and dropping it is not
-- required for correctness).
CREATE INDEX IF NOT EXISTS ppt_user_created_idx
  ON public.profit_protection_telemetry (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ppt_user_ticket_idx
  ON public.profit_protection_telemetry (user_id, broker_ticket, created_at);

-- ── 3. Re-scope the close-idempotency key ────────────────────────────────────
-- Dropped and recreated rather than altered: Postgres cannot add a column to a
-- partial unique index in place. The predicate is otherwise unchanged, so the
-- semantics are identical for a single account — only cross-account collisions
-- stop being falsely deduplicated.
DROP INDEX IF EXISTS public.profit_protection_telemetry_scalp_close_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS profit_protection_telemetry_scalp_close_uniq
  ON public.profit_protection_telemetry (user_id, trade_source, broker_ticket)
  WHERE row_kind = 'close'
    AND trade_source = 'scalp'
    AND broker_ticket IS NOT NULL;

-- ── 4. Ownership is mandatory, once it is safe to say so ─────────────────────
-- Guarded so a non-empty legacy table cannot fail the migration. When it applies,
-- unattributed telemetry becomes structurally impossible: a writer that forgets
-- the owner gets a NOT NULL violation (fail closed) instead of writing a row the
-- study cannot attribute.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profit_protection_telemetry WHERE user_id IS NULL LIMIT 1) THEN
    ALTER TABLE public.profit_protection_telemetry ALTER COLUMN user_id SET NOT NULL;
  END IF;
END $$;

-- ── 5. RLS ───────────────────────────────────────────────────────────────────
-- The table previously had none. Every reader in this codebase (the admin
-- telemetry route, scripts/pp-observation-report.mjs) uses the service role,
-- which bypasses RLS, so enabling it cannot break the reporting path. Writes are
-- service-role only by design — no INSERT policy is granted, so a mis-scoped
-- client key cannot fabricate telemetry.
ALTER TABLE public.profit_protection_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ppt_select_own ON public.profit_protection_telemetry;
CREATE POLICY ppt_select_own
  ON public.profit_protection_telemetry
  FOR SELECT
  USING (auth.uid() = user_id);
