-- Covering indexes for composite (id, user_id) foreign keys (Supabase performance advisor 0001).
create index if not exists account_snapshots_account_user_idx on public.account_snapshots (account_id, user_id);
create index if not exists compatibility_items_profile_user_idx on public.compatibility_items (profile_id, user_id);
create index if not exists fills_order_user_idx on public.fills (order_id, user_id);
create index if not exists group_entry_plans_group_user_idx on public.group_entry_plans (group_id, user_id);
create index if not exists group_entry_plans_signal_user_idx on public.group_entry_plans (signal_id, user_id);
create index if not exists group_memberships_account_user_idx on public.group_memberships (account_id, user_id);
create index if not exists group_memberships_group_user_idx on public.group_memberships (group_id, user_id);
create index if not exists instrument_specs_server_user_idx on public.instrument_specs (server_id, user_id);
create index if not exists master_signals_user_idx on public.master_signals (user_id);
create index if not exists orders_account_user_idx on public.orders (account_id, user_id);
create index if not exists orders_signal_user_idx on public.orders (signal_id, user_id);
create index if not exists positions_order_user_idx on public.positions (order_id, user_id);
create index if not exists risk_settings_account_user_idx on public.risk_settings (account_id, user_id);
create index if not exists trading_accounts_profile_user_idx on public.trading_accounts (compatibility_profile_id, user_id);
create index if not exists trading_accounts_server_user_idx on public.trading_accounts (server_id, user_id);
