-- Trade Command V1 — initial schema
--
-- Every user-owned row carries user_id and is protected by Row Level Security.
-- Composite foreign keys (id, user_id) prevent linking rows across users.
-- Orders, fills, positions and execution events are READ-ONLY for clients: they are
-- written only by a trusted backend (service role) that talks to an execution provider.
-- No credential columns exist anywhere in this schema.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  emergency_disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Server directory and instrument specifications
-- ---------------------------------------------------------------------------

create table public.server_directory_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  firm text not null check (length(trim(firm)) > 0),
  server_name text not null check (length(trim(server_name)) > 0),
  platform text not null check (platform in ('MT5','MT4','cTrader','DXtrade','MatchTrader','other')),
  origin text not null check (origin in ('directory','custom')),
  verification_status text not null default 'user_supplied' check (verification_status in ('verified','user_supplied','unknown')),
  source text,
  verified_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, firm, server_name),
  -- "verified" requires evidence.
  check (verification_status <> 'verified' or (source is not null and verified_on is not null))
);

create table public.instrument_specs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  server_id uuid not null,
  symbol text not null check (symbol = upper(symbol) and length(symbol) between 1 and 32),
  tick_size numeric not null check (tick_size > 0),
  tick_value numeric not null check (tick_value > 0),
  contract_size numeric not null check (contract_size > 0),
  profit_currency text not null check (length(profit_currency) = 3),
  volume_min numeric not null check (volume_min > 0),
  volume_max numeric not null,
  volume_step numeric not null check (volume_step > 0),
  min_stop_distance numeric not null default 0 check (min_stop_distance >= 0),
  commission_per_lot numeric check (commission_per_lot >= 0),
  verification_status text not null default 'user_supplied' check (verification_status in ('verified','user_supplied','unknown')),
  source text,
  verified_on date,
  updated_at timestamptz not null default now(),
  check (volume_max >= volume_min),
  check (verification_status <> 'verified' or (source is not null and verified_on is not null)),
  unique (user_id, server_id, symbol),
  foreign key (server_id, user_id) references public.server_directory_entries (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Prop-firm compatibility
-- ---------------------------------------------------------------------------

create table public.compatibility_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  firm text not null,
  program text not null,
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, firm, program)
);

create table public.compatibility_items (
  profile_id uuid not null,
  user_id uuid not null default auth.uid(),
  item_key text not null check (item_key in (
    'automatedExecution','eaOrApi','vpsVpn','personalAccountCopying','pendingOrders',
    'hedgingNetting','instrumentRestrictions','newsSessionRestrictions','programLimitations')),
  status text not null default 'unknown' check (status in ('unknown','permitted','conditional','prohibited')),
  notes text,
  source text,
  verified_on date,
  primary key (profile_id, item_key),
  foreign key (profile_id, user_id) references public.compatibility_profiles (id, user_id) on delete cascade,
  -- A rule can only be marked permitted/conditional with evidence.
  check (status in ('unknown','prohibited') or (source is not null and verified_on is not null))
);

-- ---------------------------------------------------------------------------
-- Trading accounts
-- ---------------------------------------------------------------------------

create table public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null check (length(trim(display_name)) > 0),
  firm text not null,
  program text not null default '',
  platform text not null check (platform in ('MT5','MT4','cTrader','DXtrade','MatchTrader','other')),
  server_id uuid,
  account_size numeric not null check (account_size > 0),
  currency text not null check (length(currency) = 3),
  trading_enabled boolean not null default false,
  execution_mode text not null default 'disabled' check (execution_mode in ('disabled','manual_only','simulation','live_automated')),
  instrument_permissions text[] not null default '{}',
  connection_status text not null default 'not_configured' check (connection_status in (
    'not_configured','unsupported','disconnected','unauthorized','unverified','connected','simulated')),
  compatibility_profile_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (server_id, user_id) references public.server_directory_entries (id, user_id) on delete set null (server_id),
  foreign key (compatibility_profile_id, user_id) references public.compatibility_profiles (id, user_id) on delete set null (compatibility_profile_id)
);

-- V1 limit: 40 accounts per user. Serialised per user with an advisory lock.
create or replace function public.enforce_account_limit() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('trading_accounts:' || new.user_id::text));
  if (select count(*) from public.trading_accounts where user_id = new.user_id) >= 40 then
    raise exception 'Account limit reached: a maximum of 40 trading accounts is supported in V1'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trading_accounts_limit before insert on public.trading_accounts
  for each row execute function public.enforce_account_limit();

-- Clients may not claim a broker connection; only the backend (service role) can.
create or replace function public.protect_connection_status() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and new.connection_status in ('connected','unverified','unauthorized','disconnected')
     and (tg_op = 'INSERT' or new.connection_status is distinct from old.connection_status) then
    raise exception 'connection_status % can only be set by the execution backend', new.connection_status
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger trading_accounts_connection before insert or update on public.trading_accounts
  for each row execute function public.protect_connection_status();

create table public.risk_settings (
  account_id uuid primary key,
  user_id uuid not null default auth.uid(),
  max_risk_per_trade numeric check (max_risk_per_trade > 0),
  daily_loss_limit numeric check (daily_loss_limit > 0),
  max_total_drawdown numeric check (max_total_drawdown > 0),
  max_volume numeric check (max_volume > 0),
  max_aggregate_risk numeric check (max_aggregate_risk > 0),
  max_snapshot_age_minutes integer not null default 60 check (max_snapshot_age_minutes between 1 and 1440),
  updated_at timestamptz not null default now(),
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete cascade
);

create table public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  user_id uuid not null default auth.uid(),
  balance numeric not null,
  equity numeric not null,
  daily_loss_used numeric not null default 0 check (daily_loss_used >= 0),
  drawdown_reference numeric not null check (drawdown_reference > 0),
  source text not null check (source in ('manual_entry','provider','simulation')),
  as_of timestamptz not null,
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------

create table public.account_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  enabled boolean not null default true,
  staging_mode text not null default 'manual' check (staging_mode in ('manual','automatic')),
  entry_offset numeric not null default 0 check (entry_offset >= 0),
  require_approval boolean not null default true,
  max_group_risk numeric check (max_group_risk > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

create table public.group_memberships (
  group_id uuid not null,
  account_id uuid not null,
  user_id uuid not null default auth.uid(),
  primary key (group_id, account_id),
  foreign key (group_id, user_id) references public.account_groups (id, user_id) on delete cascade,
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Signals and staged entry plans
-- ---------------------------------------------------------------------------

create table public.master_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol text not null check (symbol = upper(symbol)),
  direction text not null check (direction in ('BUY','SELL')),
  reference_entry numeric not null check (reference_entry > 0),
  strategy_pip_size numeric not null check (strategy_pip_size > 0),
  default_tp_pips numeric not null check (default_tp_pips > 0),
  stop_loss_distance numeric not null check (stop_loss_distance > 0),
  tp_mode text not null default 'default_per_entry' check (tp_mode in ('default_per_entry','extended_absolute')),
  extended_tp_price numeric,
  extended_tp_activated_at timestamptz,
  status text not null default 'draft' check (status in ('draft','previewed','authorized','active','closed','cancelled')),
  revision integer not null default 1 check (revision >= 1),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check ((tp_mode = 'extended_absolute') = (extended_tp_price is not null)),
  check (
    extended_tp_price is null
    or (direction = 'BUY' and extended_tp_price > reference_entry)
    or (direction = 'SELL' and extended_tp_price < reference_entry)
  )
);

create table public.group_entry_plans (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null,
  group_id uuid,
  user_id uuid not null default auth.uid(),
  group_name text not null,
  entry_offset numeric not null check (entry_offset >= 0),
  entry_price numeric not null check (entry_price > 0),
  order_kind text not null check (order_kind in ('limit','market')),
  staging_mode text not null check (staging_mode in ('manual','automatic')),
  require_approval boolean not null,
  approved boolean not null default false,
  unique (signal_id, group_id),
  foreign key (signal_id, user_id) references public.master_signals (id, user_id) on delete cascade,
  foreign key (group_id, user_id) references public.account_groups (id, user_id) on delete set null (group_id),
  check (order_kind = 'limit' or entry_offset = 0)
);

-- ---------------------------------------------------------------------------
-- Orders, fills, positions (backend-written)
-- ---------------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_order_id text not null,
  signal_id uuid not null,
  group_id uuid,
  account_id uuid not null,
  symbol text not null,
  direction text not null check (direction in ('BUY','SELL')),
  order_type text not null check (order_type in ('BUY_LIMIT','SELL_LIMIT','BUY_MARKET','SELL_MARKET')),
  volume numeric not null check (volume > 0),
  filled_volume numeric not null default 0 check (filled_volume >= 0),
  limit_price numeric not null check (limit_price > 0),
  stop_loss numeric not null,
  take_profit numeric not null,
  state text not null check (state in ('planned','pending_submission','submitted','acknowledged','partially_filled',
    'filled','rejected','cancel_requested','cancelled','expired','unknown')),
  provider_name text not null,
  provider_order_id text,
  simulated boolean not null,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- Idempotency: one order per logical (signal, group, account) key.
  unique (user_id, client_order_id),
  check (filled_volume <= volume),
  check (order_type like direction || '_%'),
  check (
    (direction = 'BUY' and stop_loss < limit_price and take_profit > limit_price)
    or (direction = 'SELL' and stop_loss > limit_price and take_profit < limit_price)
  ),
  foreign key (signal_id, user_id) references public.master_signals (id, user_id) on delete restrict,
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete restrict
);

create table public.fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  user_id uuid not null,
  provider_fill_id text not null,
  price numeric not null check (price > 0),
  volume numeric not null check (volume > 0),
  filled_at timestamptz not null,
  simulated boolean not null,
  unique (user_id, provider_fill_id),
  foreign key (order_id, user_id) references public.orders (id, user_id) on delete restrict
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  user_id uuid not null,
  signal_id uuid not null,
  account_id uuid not null,
  symbol text not null,
  direction text not null check (direction in ('BUY','SELL')),
  volume numeric not null check (volume > 0),
  entry_price numeric not null check (entry_price > 0),
  stop_loss numeric not null,
  take_profit numeric not null,
  tp_modification_state text not null default 'none' check (tp_modification_state in ('none','requested','confirmed','failed')),
  tp_modification_requested numeric,
  tp_modification_reason text,
  status text not null check (status in ('open','closed')),
  simulated boolean not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  close_price numeric,
  unique (order_id),
  foreign key (order_id, user_id) references public.orders (id, user_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

-- Raw provider events (backend-written, append-only).
create table public.execution_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid,
  provider_name text not null,
  event_type text not null,
  payload jsonb not null default '{}',
  simulated boolean not null,
  occurred_at timestamptz not null default now()
);

-- User-visible audit trail (append-only for clients).
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  category text not null check (category in ('account','server','group','signal','order','risk','compatibility','execution','settings','safety')),
  action text not null,
  entity_id text,
  message text not null,
  details jsonb,
  simulated boolean
);

-- Reject obviously sensitive keys in audit/execution payloads (defence in depth; clients also redact).
create or replace function public.reject_sensitive_payload() returns trigger
language plpgsql as $$
declare
  doc jsonb := to_jsonb(new) -> (case when tg_table_name = 'audit_events' then 'details' else 'payload' end);
begin
  if doc is not null and jsonb_typeof(doc) <> 'null' and doc::text ~* '"[^"]*(password|passwd|secret|token|api_?key|credential|private_?key)[^"]*"\s*:\s*"(?!\[redacted\])' then
    raise exception 'Sensitive fields must be redacted before logging' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger audit_events_no_secrets before insert on public.audit_events
  for each row execute function public.reject_sensitive_payload();
create trigger execution_events_no_secrets before insert on public.execution_events
  for each row execute function public.reject_sensitive_payload();

-- updated_at triggers
create trigger t_profiles_upd before update on public.profiles for each row execute function public.set_updated_at();
create trigger t_servers_upd before update on public.server_directory_entries for each row execute function public.set_updated_at();
create trigger t_specs_upd before update on public.instrument_specs for each row execute function public.set_updated_at();
create trigger t_compat_upd before update on public.compatibility_profiles for each row execute function public.set_updated_at();
create trigger t_accounts_upd before update on public.trading_accounts for each row execute function public.set_updated_at();
create trigger t_risk_upd before update on public.risk_settings for each row execute function public.set_updated_at();
create trigger t_groups_upd before update on public.account_groups for each row execute function public.set_updated_at();
create trigger t_signals_upd before update on public.master_signals for each row execute function public.set_updated_at();
create trigger t_orders_upd before update on public.orders for each row execute function public.set_updated_at();

-- Indexes on common filters
create index on public.trading_accounts (user_id);
create index on public.group_memberships (account_id);
create index on public.orders (user_id, signal_id);
create index on public.orders (account_id, state);
create index on public.fills (order_id);
create index on public.positions (user_id, status);
create index on public.audit_events (user_id, at desc);
create index on public.execution_events (user_id, occurred_at desc);

commit;
