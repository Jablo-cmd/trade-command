-- Per-account currency conversion rates used by the risk engine when an instrument's
-- profit currency differs from the account currency: {"USD": {"rate": 0.9, "asOf": "..."}}
alter table public.trading_accounts add column fx_rates jsonb not null default '{}'::jsonb
  check (jsonb_typeof(fx_rates) = 'object');
