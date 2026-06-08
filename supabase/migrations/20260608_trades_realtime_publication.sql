-- Enable Supabase Realtime broadcasting for the trades table so the browser
-- can subscribe to live INSERT/UPDATE events for the current user. The worker
-- (workers/scalper.mjs) is now the sole auto-trade executor; the AutoTrade
-- page uses this channel to fire toasts when a worker-placed trade lands and
-- when it later resolves to WIN/LOSS.
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
