-- minimum — Supabase schema (v2: accounts + Google login + admin dashboard)
-- Run this whole file in the Supabase SQL editor (or `supabase db push`).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE everywhere.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. PROFILES — one row per auth user. Created automatically on signup.
--    The account whose email matches ADMIN_EMAIL below is auto-promoted.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- IMPORTANT: change this to your real admin email if it's ever different.
-- This is the ONLY place that grants admin rights.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, is_admin)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    (lower(new.email) = lower('abdelrahmanalaaegy@gmail.com'))
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Remove policies that used the old arbitrary-user helper before replacing it.
drop policy if exists "users read own profile" on public.profiles;
drop policy if exists "users read own history" on public.prompts_history;
drop policy if exists "admin read events" on public.analytics_events;
drop function if exists public.is_admin(uuid);

-- This helper can only inspect the currently signed-in user's own admin flag.
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $func$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$func$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin());

drop policy if exists "users update own profile" on public.profiles;
-- Profile updates are intentionally disabled so users cannot modify is_admin.

-- ---------------------------------------------------------------------------
-- 2. PROMPTS HISTORY — each optimization run, tied to its owner.
-- ---------------------------------------------------------------------------
create table if not exists public.prompts_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_prompt text not null,
  optimized_prompt text not null,
  tokens_saved text,
  original_tokens integer,
  optimized_tokens integer,
  savings_pct numeric(5,2),
  archetype text,
  mode text,
  operation_mode text,
  created_at timestamptz not null default now()
);

-- Track whether each saved result came from shortening or improving.
-- Backfill older rows; the former Prompt Optimizer archetype meant improvement.
alter table public.prompts_history
  add column if not exists operation_mode text;

-- Recover improvements that were saved before the mode was recorded.
-- Shortening never expands a prompt; Improve can. It also translates Arabic
-- input to English, while Shorten preserves the input language.
update public.prompts_history
set operation_mode = 'enhance'
where lower(coalesce(archetype, '')) in ('prompt optimizer', 'improvement', 'enhance')
   or coalesce(savings_pct, 0) < 0
   or (original_prompt ~ '[ء-ي]' and optimized_prompt !~ '[ء-ي]');

-- Remaining legacy rows have no reliable improvement signal. The old default
-- operation was Shorten, so keep them in that category without changing prompts.
update public.prompts_history
set operation_mode = 'shorten'
where operation_mode is null;

alter table public.prompts_history
  alter column operation_mode set default 'shorten';
alter table public.prompts_history
  alter column operation_mode set not null;

create index if not exists prompts_history_created_at_idx on public.prompts_history (created_at desc);
create index if not exists prompts_history_user_id_idx on public.prompts_history (user_id);

alter table public.prompts_history enable row level security;

drop policy if exists "public read access" on public.prompts_history;
drop policy if exists "public insert access" on public.prompts_history;

drop policy if exists "users read own history" on public.prompts_history;
create policy "users read own history"
  on public.prompts_history for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "users insert own history" on public.prompts_history;
create policy "users insert own history"
  on public.prompts_history for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. ANALYTICS EVENTS — visits & behavior, for the admin dashboard.
-- ---------------------------------------------------------------------------
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,       -- e.g. 'page_view', 'optimize_run', 'save', 'sign_in'
  view_name text,                 -- optimize / inspect / metrics / library / admin
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_created_at_idx on public.analytics_events (created_at desc);
create index if not exists analytics_events_type_idx on public.analytics_events (event_type);
create index if not exists analytics_events_user_idx on public.analytics_events (user_id);

alter table public.analytics_events enable row level security;

-- Any signed-in user can log their own events; nobody can read except the admin.
drop policy if exists "authenticated insert events" on public.analytics_events;
create policy "authenticated insert events"
  on public.analytics_events for insert
  with check (auth.uid() = user_id);

drop policy if exists "admin read events" on public.analytics_events;
create policy "admin read events"
  on public.analytics_events for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- One-time backfill: if you already had users before this migration,
-- make sure a profile row exists for each and admin status is correct.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, is_admin)
select u.id, u.email, (lower(u.email) = lower('abdelrahmanalaaegy@gmail.com'))
from auth.users u
on conflict (id) do update set is_admin = excluded.is_admin;

-- ---------------------------------------------------------------------------
-- 4. LEAST-PRIVILEGE GRANTS AND APPEND-ONLY SECURITY AUDIT LOG
-- ---------------------------------------------------------------------------
-- Keep browser access limited to the operations required by the app. Row-level
-- security policies above still decide which rows an authenticated user can see.
revoke all on table public.profiles, public.prompts_history, public.analytics_events
  from public, anon, authenticated;
grant select on table public.profiles, public.prompts_history, public.analytics_events
  to authenticated;
grant insert on table public.prompts_history, public.analytics_events to authenticated;

-- Trigger functions do not need to be callable through the Data API.
revoke all on function public.handle_new_user() from public, anon, authenticated;

create table if not exists public.security_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  table_name text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  record_id text,
  created_at timestamptz not null default now()
);
create index if not exists security_audit_logs_created_at_idx
  on public.security_audit_logs (created_at desc);
create index if not exists security_audit_logs_actor_user_id_idx
  on public.security_audit_logs (actor_user_id);

alter table public.security_audit_logs enable row level security;
revoke all on table public.security_audit_logs from public, anon, authenticated;
grant select on table public.security_audit_logs to authenticated;
drop policy if exists "admins read security audit logs" on public.security_audit_logs;
create policy "admins read security audit logs"
  on public.security_audit_logs for select
  using (public.is_admin());

create or replace function public.write_security_audit_log()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $audit$
declare
  v_record_id text;
begin
  if tg_op = 'DELETE' then
    v_record_id := old.id::text;
  else
    v_record_id := new.id::text;
  end if;

  insert into public.security_audit_logs (actor_user_id, table_name, action, record_id)
  values (auth.uid(), tg_table_name, tg_op, v_record_id);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$audit$;
revoke all on function public.write_security_audit_log() from public, anon, authenticated;

drop trigger if exists audit_profiles_changes on public.profiles;
create trigger audit_profiles_changes
  after insert or update or delete on public.profiles
  for each row execute function public.write_security_audit_log();
drop trigger if exists audit_prompts_history_changes on public.prompts_history;
create trigger audit_prompts_history_changes
  after insert or update or delete on public.prompts_history
  for each row execute function public.write_security_audit_log();
drop trigger if exists audit_analytics_events_changes on public.analytics_events;
create trigger audit_analytics_events_changes
  after insert or update or delete on public.analytics_events
  for each row execute function public.write_security_audit_log();
