-- 20261002_scalp_shadow_close_idempotency.sql
-- At most ONE logical close row per scalp broker ticket.
--
-- WHY THIS IS A DATABASE CONSTRAINT AND NOT AN IN-MEMORY FLAG
--
-- The observer needs to retry a close row whose insert failed, and it needs to
-- survive a worker restart mid-retry. An in-memory "already closed" set cannot
-- do either: a restart forgets it, and a retry that races a previously
-- successful-but-unacknowledged insert would duplicate the record. Since a
-- duplicated close silently double-counts a trade in the shadow study, the
-- guarantee has to live where the data lives.
--
-- A PARTIAL index is required, not a plain one: snapshots and decisions repeat
-- legitimately many times per ticket, so only the terminal row is unique.
--
-- The worker treats a duplicate-key response for an already-persisted close as
-- SUCCESS rather than an error, which is what makes the retry path idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS profit_protection_telemetry_scalp_close_uniq
  ON public.profit_protection_telemetry (trade_source, broker_ticket)
  WHERE row_kind = 'close'
    AND trade_source = 'scalp'
    AND broker_ticket IS NOT NULL;
