-- Trade Command V1 — Row Level Security
--
-- Policy model:
--  * Configuration tables: owner may select/insert/update/delete own rows.
--  * orders / fills / positions / execution_events: owner may SELECT only. Writes are
--    reserved for the service role used by a trusted execution backend.
--  * audit_events: owner may SELECT and INSERT; never UPDATE or DELETE (append-only).
--  * anon: no access to anything.

begin;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','server_directory_entries','instrument_specs','compatibility_profiles','compatibility_items',
    'trading_accounts','risk_settings','account_snapshots','account_groups','group_memberships',
    'master_signals','group_entry_plans','orders','fills','positions','execution_events','audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
end $$;

-- Owner CRUD on configuration tables.
do $$
declare
  t text;
begin
  foreach t in array array[
    'server_directory_entries','instrument_specs','compatibility_profiles','compatibility_items',
    'trading_accounts','risk_settings','account_snapshots','account_groups','group_memberships',
    'master_signals','group_entry_plans'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))$p$, t || '_select', t);
    execute format($p$create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))$p$, t || '_insert', t);
    execute format($p$create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))$p$, t || '_update', t);
    execute format($p$create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))$p$, t || '_delete', t);
  end loop;
end $$;

-- Profiles: keyed by id = auth.uid().
grant select, insert, update on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Read-only execution records.
do $$
declare
  t text;
begin
  foreach t in array array['orders','fills','positions','execution_events'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))$p$, t || '_select', t);
  end loop;
end $$;

-- Append-only audit trail.
grant select, insert on public.audit_events to authenticated;
create policy audit_events_select on public.audit_events for select to authenticated using (user_id = (select auth.uid()));
create policy audit_events_insert on public.audit_events for insert to authenticated with check (user_id = (select auth.uid()));

commit;
