-- LOCAL TEST SHIM ONLY. Never run against a Supabase project (which already has these).
-- Emulates the parts of Supabase that the migrations depend on: auth.users, auth.uid(),
-- and the anon / authenticated / service_role roles with Supabase's default grants.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase grants broad table privileges by default; the RLS migration must narrow them.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
