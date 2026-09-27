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

-- ---------------------------------------------------------------------------
-- 5. FREE AI USAGE METER — actual provider tokens, enforced before each call.
-- The Worker uses the service-role key only as a Cloudflare secret. It must
-- never be added to the browser, Wrangler config, or repository.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_settings (
  id boolean primary key default true check (id = true),
  daily_global_token_limit bigint not null default 100000 check (daily_global_token_limit > 0),
  daily_user_token_limit bigint not null default 20000 check (daily_user_token_limit > 0),
  readiness_active_users integer not null default 50 check (readiness_active_users > 0),
  readiness_repeat_rate numeric(5,2) not null default 25 check (readiness_repeat_rate between 0 and 100),
  readiness_weekly_users integer not null default 20 check (readiness_weekly_users > 0),
  updated_at timestamptz not null default now()
);
insert into public.usage_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('groq', 'gemini')),
  model text not null,
  operation_mode text not null check (operation_mode in ('shorten', 'enhance')),
  reserved_tokens integer not null check (reserved_tokens > 0),
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  status text not null default 'pending' check (status in (
    'pending', 'completed', 'questionnaire', 'no_compression',
    'invalid_response', 'provider_error', 'failed_estimate', 'timeout'
  )),
  is_estimate boolean not null default false,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint ai_usage_tokens_nonnegative check (
    (input_tokens is null or input_tokens >= 0) and
    (output_tokens is null or output_tokens >= 0) and
    (total_tokens is null or total_tokens >= 0)
  )
);
create index if not exists ai_usage_events_created_at_idx on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_user_created_at_idx on public.ai_usage_events (user_id, created_at desc);
alter table public.usage_settings enable row level security;
alter table public.ai_usage_events enable row level security;
revoke all on table public.usage_settings, public.ai_usage_events from public, anon, authenticated;
grant select, update (daily_global_token_limit, daily_user_token_limit,
  readiness_active_users, readiness_repeat_rate, readiness_weekly_users, updated_at)
  on table public.usage_settings to authenticated;
grant select on table public.ai_usage_events to authenticated;
drop policy if exists "admins manage usage settings" on public.usage_settings;
create policy "admins manage usage settings"
  on public.usage_settings for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins read AI usage" on public.ai_usage_events;
create policy "admins read AI usage"
  on public.ai_usage_events for select
  using (public.is_admin());

-- These functions run only from the Worker, which keeps the service-role key
-- out of browser requests. Reservations serialize against the settings row so
-- parallel requests cannot race past the daily free-use ceilings.
create or replace function public.reserve_ai_usage(
  p_request_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_operation_mode text,
  p_reserved_tokens integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $usage$
declare
  v_settings public.usage_settings%rowtype;
  v_existing public.ai_usage_events%rowtype;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_global_used bigint;
  v_user_used bigint;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_request_id is null or p_reserved_tokens is null or p_reserved_tokens < 1
     or p_provider not in ('groq','gemini') or p_operation_mode not in ('shorten','enhance') then
    raise exception 'invalid usage reservation' using errcode = '22023';
  end if;

  select * into v_existing from public.ai_usage_events where request_id = p_request_id;
  if found then
    if v_existing.user_id <> p_user_id then raise exception 'request id conflict' using errcode = '23505'; end if;
    return jsonb_build_object('allowed', v_existing.status = 'pending', 'reason', 'duplicate',
      'user_used', 0, 'user_limit', 0, 'reset_at', v_day_start + interval '1 day');
  end if;

  select * into v_settings from public.usage_settings where id = true for update;
  update public.ai_usage_events
    set status = 'timeout', total_tokens = reserved_tokens, is_estimate = true, settled_at = now()
    where status = 'pending' and created_at < now() - interval '15 minutes';

  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_global_used
    from public.ai_usage_events where created_at >= v_day_start;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_user_used
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_day_start;

  if v_user_used + p_reserved_tokens > v_settings.daily_user_token_limit then
    v_reason := 'user_limit';
  elsif v_global_used + p_reserved_tokens > v_settings.daily_global_token_limit then
    v_reason := 'global_limit';
  end if;

  if v_reason is not null then
    return jsonb_build_object('allowed', false, 'reason', v_reason,
      'user_used', v_user_used, 'user_limit', v_settings.daily_user_token_limit,
      'reset_at', v_day_start + interval '1 day');
  end if;

  insert into public.ai_usage_events (request_id, user_id, provider, model, operation_mode, reserved_tokens)
  values (p_request_id, p_user_id, p_provider, left(p_model, 100), p_operation_mode, p_reserved_tokens);

  return jsonb_build_object('allowed', true, 'reason', null,
    'user_used', v_user_used, 'user_limit', v_settings.daily_user_token_limit,
    'reset_at', v_day_start + interval '1 day');
end;
$usage$;

create or replace function public.settle_ai_usage(
  p_request_id uuid,
  p_user_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_status text,
  p_is_estimate boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $usage$
declare
  v_settings public.usage_settings%rowtype;
  v_event public.ai_usage_events%rowtype;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_used bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('completed','questionnaire','no_compression','invalid_response','provider_error','failed_estimate')
     or coalesce(p_input_tokens, 0) < 0 or coalesce(p_output_tokens, 0) < 0 or coalesce(p_total_tokens, 0) < 0 then
    raise exception 'invalid usage settlement' using errcode = '22023';
  end if;
  select * into v_event from public.ai_usage_events where request_id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'usage reservation not found' using errcode = 'P0002'; end if;

  if v_event.status = 'pending' then
    update public.ai_usage_events set
      input_tokens = p_input_tokens, output_tokens = p_output_tokens,
      total_tokens = greatest(p_total_tokens, p_input_tokens + p_output_tokens),
      status = p_status, is_estimate = p_is_estimate, settled_at = now()
    where request_id = p_request_id and user_id = p_user_id;
  end if;

  select * into v_settings from public.usage_settings where id = true;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_used
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_day_start;
  return jsonb_build_object('user_used', v_used, 'user_limit', v_settings.daily_user_token_limit,
    'reset_at', v_day_start + interval '1 day');
end;
$usage$;

create or replace function public.get_my_ai_usage(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
stable
as $usage$
declare
  v_settings public.usage_settings%rowtype;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_used bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_settings from public.usage_settings where id = true;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_used
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_day_start;
  return jsonb_build_object('used', v_used, 'limit', v_settings.daily_user_token_limit,
    'reset_at', v_day_start + interval '1 day');
end;
$usage$;

create or replace function public.get_admin_usage_overview()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
stable
as $usage$
declare
  v_settings public.usage_settings%rowtype;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_daily_used bigint;
  v_weekly bigint;
  v_monthly bigint;
  v_active7 bigint;
  v_active30 bigint;
  v_repeat30 bigint;
  v_calls30 bigint;
  v_failed30 bigint;
  v_estimated30 bigint;
  v_daily_trend jsonb;
  v_modes jsonb;
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  select * into v_settings from public.usage_settings where id = true;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_daily_used
    from public.ai_usage_events where created_at >= v_day_start;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_weekly
    from public.ai_usage_events where created_at >= now() - interval '7 days';
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_monthly
    from public.ai_usage_events where created_at >= now() - interval '30 days';
  select count(distinct user_id) into v_active7 from public.ai_usage_events
    where created_at >= now() - interval '7 days' and status not in ('pending','provider_error','failed_estimate','timeout');
  select count(distinct user_id) into v_active30 from public.ai_usage_events
    where created_at >= now() - interval '30 days' and status not in ('pending','provider_error','failed_estimate','timeout');
  select count(*) into v_repeat30 from (
    select user_id from public.ai_usage_events where created_at >= now() - interval '30 days'
      and status not in ('pending','provider_error','failed_estimate','timeout')
    group by user_id having count(*) >= 2
  ) repeat_users;
  select count(*) into v_calls30 from public.ai_usage_events where created_at >= now() - interval '30 days';
  select count(*) into v_failed30 from public.ai_usage_events where created_at >= now() - interval '30 days'
    and status in ('provider_error','failed_estimate','timeout','invalid_response');
  select count(*) into v_estimated30 from public.ai_usage_events where created_at >= now() - interval '30 days' and is_estimate;
  select coalesce(jsonb_object_agg(day_key, token_count order by day_key), '{}'::jsonb) into v_daily_trend from (
    select to_char(days.day_start at time zone 'UTC', 'YYYY-MM-DD') as day_key,
      coalesce(sum(coalesce(events.total_tokens, events.reserved_tokens)), 0)::bigint as token_count
    from generate_series(v_day_start - interval '13 days', v_day_start, interval '1 day') as days(day_start)
    left join public.ai_usage_events events on events.created_at >= days.day_start and events.created_at < days.day_start + interval '1 day'
    group by days.day_start
  ) daily_usage;
  select coalesce(jsonb_object_agg(operation_mode, totals), '{}'::jsonb) into v_modes from (
    select operation_mode, jsonb_build_object('calls', count(*), 'tokens', sum(coalesce(total_tokens, reserved_tokens))) as totals
    from public.ai_usage_events where created_at >= now() - interval '30 days'
    group by operation_mode
  ) usage_by_mode;
  return jsonb_build_object(
    'daily_used', v_daily_used,
    'weekly_used', v_weekly, 'monthly_used', v_monthly,
    'global_limit', v_settings.daily_global_token_limit, 'user_limit', v_settings.daily_user_token_limit,
    'readiness_active_users', v_settings.readiness_active_users,
    'readiness_repeat_rate', v_settings.readiness_repeat_rate,
    'readiness_weekly_users', v_settings.readiness_weekly_users,
    'active_7d', v_active7, 'active_30d', v_active30,
    'repeat_30d', v_repeat30, 'calls_30d', v_calls30, 'failed_30d', v_failed30, 'estimated_30d', v_estimated30,
    'daily_trend', v_daily_trend, 'mode_totals', v_modes,
    'reset_at', v_day_start + interval '1 day'
  );
end;
$usage$;

revoke all on function public.reserve_ai_usage(uuid,uuid,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.settle_ai_usage(uuid,uuid,integer,integer,integer,text,boolean) from public, anon, authenticated;
revoke all on function public.get_my_ai_usage(uuid) from public, anon, authenticated;
grant execute on function public.reserve_ai_usage(uuid,uuid,text,text,text,integer) to service_role;
grant execute on function public.settle_ai_usage(uuid,uuid,integer,integer,integer,text,boolean) to service_role;
grant execute on function public.get_my_ai_usage(uuid) to service_role;
revoke all on function public.get_admin_usage_overview() from public, anon;
grant execute on function public.get_admin_usage_overview() to authenticated;
