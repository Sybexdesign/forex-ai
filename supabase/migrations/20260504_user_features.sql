-- ─── Broker configs per user ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.broker_configs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  broker_type TEXT NOT NULL DEFAULT 'simulation',
  label       TEXT NOT NULL DEFAULT 'My Broker',
  config      JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.broker_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own broker configs"
  ON public.broker_configs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Prop-firm settings per user ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prop_firm_settings (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  enabled                 BOOLEAN DEFAULT false,
  firm_type               TEXT DEFAULT 'ftmo',
  phase                   TEXT DEFAULT 'evaluation',
  account_size            NUMERIC DEFAULT 10000,
  initial_balance         NUMERIC DEFAULT 10000,
  max_daily_loss_pct      NUMERIC DEFAULT 5,
  max_total_drawdown_pct  NUMERIC DEFAULT 10,
  profit_target_pct       NUMERIC DEFAULT 10,
  min_trading_days        INTEGER DEFAULT 4,
  no_overnight            BOOLEAN DEFAULT false,
  no_weekend              BOOLEAN DEFAULT true,
  news_restriction        BOOLEAN DEFAULT true,
  consistency_rule_pct    NUMERIC DEFAULT 50,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.prop_firm_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own prop firm settings"
  ON public.prop_firm_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Ensure existing tables have user policies (safe to re-run) ───────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'trades' AND policyname = 'Users manage own trades'
  ) THEN
    CREATE POLICY "Users manage own trades"
      ON public.trades FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'signals' AND policyname = 'Users manage own signals'
  ) THEN
    CREATE POLICY "Users manage own signals"
      ON public.signals FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'strategies' AND policyname = 'Users manage own strategies'
  ) THEN
    CREATE POLICY "Users manage own strategies"
      ON public.strategies FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ─── Profiles table (create if not exists) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email      TEXT,
  full_name  TEXT,
  role       TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id OR auth.jwt()->>'email' = 'sybexdesigns@gmail.com');

CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Auto-create profile on sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
