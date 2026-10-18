-- RLS and invariant tests. Run via scripts/test-rls.sh against a disposable local database.
\set ON_ERROR_STOP on
\set QUIET on

-- Assertion helper
create or replace function pg_temp.expect_error(sql text, label text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: % — statement unexpectedly succeeded', label;
exception
  when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise notice 'PASS: % (%)', label, sqlerrm;
end $$;
create or replace function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.test');

-- ------------------------------------------------------------------ user A
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into public.profiles (id, display_name) values (auth.uid(), 'A');
insert into public.server_directory_entries (id, firm, server_name, platform, origin)
  values ('10000000-0000-0000-0000-000000000001', 'Example Firm', 'Example-Server', 'MT5', 'custom');
insert into public.trading_accounts (id, display_name, firm, platform, server_id, account_size, currency, connection_status)
  values ('20000000-0000-0000-0000-000000000001', 'A-1', 'Example Firm', 'MT5', '10000000-0000-0000-0000-000000000001', 100000, 'USD', 'simulated');
insert into public.risk_settings (account_id, max_risk_per_trade) values ('20000000-0000-0000-0000-000000000001', 500);
insert into public.account_groups (id, name, entry_offset) values ('30000000-0000-0000-0000-000000000001', 'A', 0);
insert into public.group_memberships (group_id, account_id) values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
insert into public.master_signals (id, symbol, direction, reference_entry, strategy_pip_size, default_tp_pips, stop_loss_distance)
  values ('40000000-0000-0000-0000-000000000001', 'XAUUSD', 'BUY', 4080, 0.1, 30, 15);
insert into public.audit_events (category, action, message) values ('account', 'create', 'A created account');

select pg_temp.expect((select count(*) from public.trading_accounts) = 1, 'A sees own account');

-- Invariants
select pg_temp.expect_error($$insert into public.trading_accounts (display_name, firm, platform, account_size, currency, connection_status)
  values ('x','f','MT5',1000,'USD','connected')$$, 'client cannot claim connected status');
select pg_temp.expect_error($$update public.trading_accounts set connection_status = 'connected'$$, 'client cannot update to connected');
select pg_temp.expect_error($$insert into public.server_directory_entries (firm, server_name, platform, origin, verification_status)
  values ('f','s2','MT5','custom','verified')$$, 'verified server entry requires source and date');
select pg_temp.expect_error($$insert into public.master_signals (symbol, direction, reference_entry, strategy_pip_size, default_tp_pips, stop_loss_distance, tp_mode, extended_tp_price)
  values ('XAUUSD','BUY',4080,0.1,30,15,'extended_absolute',4070)$$, 'BUY extended TP must be above reference');
select pg_temp.expect_error($$insert into public.account_groups (name, entry_offset) values ('neg', -1)$$, 'negative offset rejected');
select pg_temp.expect_error($$insert into public.group_entry_plans (signal_id, group_name, entry_offset, entry_price, order_kind, staging_mode, require_approval)
  values ('40000000-0000-0000-0000-000000000001','B',3,4077,'market','manual',true)$$, 'market entry only for zero offset');
select pg_temp.expect_error($$insert into public.compatibility_profiles (id, firm, program) values ('50000000-0000-0000-0000-000000000001','F','P');
  insert into public.compatibility_items (profile_id, item_key, status) values ('50000000-0000-0000-0000-000000000001','eaOrApi','permitted')$$,
  'compatibility item cannot be permitted without evidence');
select pg_temp.expect_error($$insert into public.audit_events (category, action, message, details) values ('account','x','m','{"password":"hunter2"}')$$,
  'audit rejects unredacted secrets');
insert into public.audit_events (category, action, message, details) values ('account','x','m','{"password":"[redacted]"}');

-- Execution records are backend-only
select pg_temp.expect_error($$insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values (auth.uid(),'k','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,4077,4062,4080,'planned','sim',true)$$,
  'client cannot insert orders');
select pg_temp.expect_error($$update public.audit_events set message = 'tampered'$$, 'audit events cannot be updated');
select pg_temp.expect_error($$delete from public.audit_events$$, 'audit events cannot be deleted');

-- 40 account limit (1 exists; add 39 more then the 41st fails)
insert into public.trading_accounts (display_name, firm, platform, account_size, currency)
  select 'bulk-' || g, 'Example Firm', 'MT5', 10000, 'USD' from generate_series(1, 39) g;
select pg_temp.expect((select count(*) from public.trading_accounts) = 40, 'A has 40 accounts');
select pg_temp.expect_error($$insert into public.trading_accounts (display_name, firm, platform, account_size, currency) values ('41st','f','MT5',1,'USD')$$,
  '41st account rejected');

-- ------------------------------------------------------------------ user B
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';

select pg_temp.expect((select count(*) from public.trading_accounts) = 0, 'B cannot read A accounts');
select pg_temp.expect((select count(*) from public.server_directory_entries) = 0, 'B cannot read A servers');
select pg_temp.expect((select count(*) from public.master_signals) = 0, 'B cannot read A signals');
select pg_temp.expect((select count(*) from public.audit_events) = 0, 'B cannot read A audit events');
select pg_temp.expect((select count(*) from public.profiles) = 0, 'B cannot read A profile');
select pg_temp.expect((select count(*) from public.risk_settings) = 0, 'B cannot read A risk settings');

with u as (update public.trading_accounts set display_name = 'hijacked' returning 1)
  select pg_temp.expect((select count(*) from u) = 0, 'B update of A accounts affects 0 rows');
with d as (delete from public.account_groups returning 1)
  select pg_temp.expect((select count(*) from d) = 0, 'B delete of A groups affects 0 rows');

select pg_temp.expect_error($$insert into public.trading_accounts (user_id, display_name, firm, platform, account_size, currency)
  values ('aaaaaaaa-0000-0000-0000-000000000001','evil','f','MT5',1,'USD')$$, 'B cannot insert rows owned by A');

insert into public.account_groups (id, name) values ('30000000-0000-0000-0000-000000000002', 'B-group');
select pg_temp.expect_error($$insert into public.group_memberships (group_id, account_id)
  values ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001')$$, 'B cannot add A account to B group');
select pg_temp.expect_error($$update public.account_groups set user_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'B cannot transfer ownership to A');

-- ------------------------------------------------------------------ anon
set role anon;
reset request.jwt.claim.sub;
select pg_temp.expect_error($$select count(*) from public.trading_accounts$$, 'anon has no table access');

-- ------------------------------------------------------------------ backend (service role)
set role service_role;
insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values ('aaaaaaaa-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001:g:a','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,4077,4062,4080,'acknowledged','sim',true);
select pg_temp.expect_error($$insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values ('aaaaaaaa-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001:g:a','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,4077,4062,4080,'acknowledged','sim',true)$$,
  'duplicate client_order_id rejected (idempotency)');
select pg_temp.expect_error($$insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values ('aaaaaaaa-0000-0000-0000-000000000001','k2','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,4077,4080,4062,'acknowledged','sim',true)$$,
  'inverted BUY SL/TP rejected');
select pg_temp.expect_error($$insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, filled_volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values ('aaaaaaaa-0000-0000-0000-000000000001','k3','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,0.2,4077,4062,4080,'filled','sim',true)$$,
  'overfill rejected');
select pg_temp.expect_error($$insert into public.orders (user_id, client_order_id, signal_id, account_id, symbol, direction, order_type, volume, limit_price, stop_loss, take_profit, state, provider_name, simulated)
  values ('bbbbbbbb-0000-0000-0000-000000000002','k4','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','XAUUSD','BUY','BUY_LIMIT',0.1,4077,4062,4080,'acknowledged','sim',true)$$,
  'order cannot reference another user''s signal/account');

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.expect((select count(*) from public.orders) = 1, 'A can read own backend-written order');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.expect((select count(*) from public.orders) = 0, 'B cannot read A orders');

reset role;
\echo 'ALL RLS TESTS PASSED'
