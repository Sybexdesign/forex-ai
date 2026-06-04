-- Expand trades_result_check to include CLOSED and CANCELLED.
-- The original constraint only had WIN/LOSS/BREAKEVEN/OPEN, but several
-- code paths (RPC reconciliation, close-trade API, mt5-sync API) set
-- result = 'CLOSED' or result = 'CANCELLED', causing check violations.

ALTER TABLE public.trades
DROP CONSTRAINT trades_result_check;

ALTER TABLE public.trades
ADD CONSTRAINT trades_result_check
CHECK (result = ANY (ARRAY['WIN','LOSS','BREAKEVEN','OPEN','CLOSED','CANCELLED']));
