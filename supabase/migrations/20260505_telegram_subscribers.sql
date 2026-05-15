-- Telegram bot subscriber list
-- People who send /start to the bot are stored here and receive broadcast alerts.

CREATE TABLE IF NOT EXISTS public.telegram_subscribers (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id       text NOT NULL UNIQUE,
  username      text,
  first_name    text,
  last_name     text,
  active        boolean DEFAULT true,
  subscribed_at timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- No RLS needed — this table is only ever read/written by the service role key
-- (the webhook runs server-side with SUPABASE_SERVICE_ROLE_KEY).

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_active
  ON public.telegram_subscribers (active)
  WHERE active = true;
