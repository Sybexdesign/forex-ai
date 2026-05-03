-- ============================================================
-- FOREX AI TRADING ASSISTANT — SUPABASE SCHEMA
-- Run this in Supabase SQL editor to set up all tables
-- ============================================================

-- Enable Row Level Security on all tables
-- Users table (managed by Supabase Auth — this extends it)
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  display_name text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Trigger to auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- STRATEGIES TABLE
-- ============================================================
create table if not exists public.strategies (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  settings jsonb not null default '{
    "style": "Day Trader",
    "riskPct": 1,
    "maxLoss": 3,
    "maxPositions": 2,
    "minStrength": 65,
    "tpPips": 50,
    "slPips": 25,
    "watchlist": ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "XAU/USD"],
    "sessionStart": 7,
    "sessionEnd": 20,
    "hardDailyStop": true,
    "hardNews": true,
    "demoLock": true
  }'::jsonb,
  updated_at timestamptz default now()
);

alter table public.strategies enable row level security;
create policy "Users can manage own strategies" on public.strategies
  for all using (auth.uid() = user_id);

-- Upsert function for strategy settings
create or replace function public.upsert_strategy(p_user_id uuid, p_settings jsonb)
returns void as $$
begin
  insert into public.strategies (user_id, settings, updated_at)
  values (p_user_id, p_settings, now())
  on conflict (user_id) do update
    set settings = p_settings, updated_at = now();
end;
$$ language plpgsql security definer;

-- Unique constraint for one strategy per user
create unique index if not exists strategies_user_id_idx on public.strategies(user_id);

-- ============================================================
-- TRADES TABLE
-- ============================================================
create table if not exists public.trades (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  oanda_trade_id text,
  pair text not null,
  direction text not null check (direction in ('BUY', 'SELL')),
  entry_price numeric(12, 6) not null,
  exit_price numeric(12, 6),
  tp_price numeric(12, 6),
  sl_price numeric(12, 6),
  lots numeric(8, 4) not null default 0.01,
  pips numeric(10, 2),
  pl_usd numeric(12, 2),
  result text check (result in ('WIN', 'LOSS', 'BREAKEVEN', 'OPEN')),
  rules_followed boolean default true,
  checklist_score integer,
  ai_confidence integer,
  notes text,
  opened_at timestamptz default now(),
  closed_at timestamptz,
  created_at timestamptz default now()
);

alter table public.trades enable row level security;
create policy "Users can manage own trades" on public.trades
  for all using (auth.uid() = user_id);

create index if not exists trades_user_id_idx on public.trades(user_id);
create index if not exists trades_opened_at_idx on public.trades(opened_at desc);

-- ============================================================
-- SIGNALS TABLE
-- ============================================================
create table if not exists public.signals (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  pair text not null,
  timeframe text not null,
  direction text not null check (direction in ('BUY', 'SELL', 'WAIT')),
  confidence integer not null,
  checklist_score integer not null,
  entry_zone_low numeric(12, 6),
  entry_zone_high numeric(12, 6),
  reasons jsonb,
  risk_note text,
  acted_on boolean default false,
  outcome text check (outcome in ('WIN', 'LOSS', 'PENDING', 'SKIPPED')),
  trade_id uuid references public.trades(id),
  indicator_snapshot jsonb,
  created_at timestamptz default now()
);

alter table public.signals enable row level security;
create policy "Users can manage own signals" on public.signals
  for all using (auth.uid() = user_id);

create index if not exists signals_user_id_idx on public.signals(user_id);
create index if not exists signals_created_at_idx on public.signals(created_at desc);

-- ============================================================
-- DAILY STATS VIEW (computed)
-- ============================================================
create or replace view public.daily_stats as
select
  user_id,
  date_trunc('day', opened_at) as trade_date,
  count(*) as total_trades,
  count(*) filter (where result = 'WIN') as wins,
  count(*) filter (where result = 'LOSS') as losses,
  sum(pl_usd) as total_pl,
  avg(pips) filter (where result = 'WIN') as avg_win_pips,
  avg(abs(pips)) filter (where result = 'LOSS') as avg_loss_pips,
  sum(pl_usd) filter (where result = 'WIN') as gross_profit,
  abs(sum(pl_usd) filter (where result = 'LOSS')) as gross_loss
from public.trades
where result in ('WIN', 'LOSS', 'BREAKEVEN')
group by user_id, date_trunc('day', opened_at);
