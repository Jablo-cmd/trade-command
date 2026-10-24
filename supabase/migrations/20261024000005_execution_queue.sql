-- Trade Command — execution queue for the MT5 connector.
--
-- Flow: the app (authenticated user) INSERTS a command; the connector on the Windows VPS
-- (service role) claims it, re-validates everything against MT5, acts, and records the
-- outcome. Clients can never mark a command done or write orders/fills/positions.

create table public.execution_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('submit', 'cancel', 'modify_tp', 'emergency_disable')),
  account_id uuid not null,
  signal_id uuid,
  client_order_id text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'rejected', 'failed')),
  result jsonb,
  claimed_by text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete cascade,
  check (kind <> 'submit' or (client_order_id is not null and signal_id is not null)),
  check (kind not in ('cancel', 'modify_tp') or client_order_id is not null)
);

-- Idempotency at the queue: one submit per logical order, however many times the app retries.
create unique index execution_commands_one_submit on public.execution_commands (user_id, client_order_id) where kind = 'submit';
create index execution_commands_pending on public.execution_commands (account_id, created_at) where status = 'pending';
create index execution_commands_user_idx on public.execution_commands (user_id, created_at desc);

-- Connector liveness and MT5 state per account, written only by the connector.
create table public.connector_heartbeats (
  account_id uuid primary key,
  user_id uuid not null,
  connector_id text not null,
  terminal_connected boolean not null,
  login_verified boolean not null,
  trade_mode text not null check (trade_mode in ('demo', 'contest', 'real', 'unknown')),
  trade_allowed boolean not null,
  balance numeric,
  equity numeric,
  currency text,
  server text,
  quotes jsonb not null default '{}'::jsonb,
  error text,
  last_seen timestamptz not null default now(),
  foreign key (account_id, user_id) references public.trading_accounts (id, user_id) on delete cascade
);

alter table public.execution_commands enable row level security;
alter table public.execution_commands force row level security;
alter table public.connector_heartbeats enable row level security;
alter table public.connector_heartbeats force row level security;
revoke all on public.execution_commands from anon, authenticated;
revoke all on public.connector_heartbeats from anon, authenticated;

grant select, insert on public.execution_commands to authenticated;
create policy execution_commands_select on public.execution_commands for select to authenticated
  using (user_id = (select auth.uid()));
-- Clients may only create fresh, unprocessed commands for their own accounts.
create policy execution_commands_insert on public.execution_commands for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending' and result is null and claimed_by is null
    and claimed_at is null and completed_at is null
  );

grant select on public.connector_heartbeats to authenticated;
create policy connector_heartbeats_select on public.connector_heartbeats for select to authenticated
  using (user_id = (select auth.uid()));

-- Reject unredacted secrets in command payloads and results (reuses the audit guard).
create or replace function public.reject_sensitive_command() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.payload::text || coalesce(new.result::text, '')) ~* '"[^"]*(password|passwd|secret|token|api_?key|credential|private_?key)[^"]*"\s*:\s*"(?!\[redacted\])' then
    raise exception 'Sensitive fields must not be sent in execution commands' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger execution_commands_no_secrets before insert or update on public.execution_commands
  for each row execute function public.reject_sensitive_command();
