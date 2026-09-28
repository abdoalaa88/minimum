-- MiniMiz: user management, in-app support chat, and a rolling 3-hour quota.
-- Safe to rerun; existing profiles, prompts, usage events, and subscription requests stay intact.

alter table public.profiles
  add column if not exists is_suspended boolean not null default false,
  add column if not exists suspended_at timestamptz;

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists support_messages_user_created_idx
  on public.support_messages(user_id, created_at asc);
alter table public.support_messages enable row level security;
revoke all on table public.support_messages from public, anon, authenticated;
grant select, insert on table public.support_messages to authenticated;
drop policy if exists "users and admins read support messages" on public.support_messages;
create policy "users and admins read support messages"
  on public.support_messages for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));
drop policy if exists "users and admins send support messages" on public.support_messages;
create policy "users and admins send support messages"
  on public.support_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and (user_id = (select auth.uid()) or (select public.is_admin()))
  );

-- Suspended users keep access to support chat so the admin can resolve the suspension.
drop policy if exists "active accounts only" on public.support_messages;

drop function if exists public.admin_set_user_suspended(uuid, boolean);
create or replace function public.admin_set_user_suspended(p_user_id uuid, p_suspended boolean, p_actor_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $admin$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles where id = p_actor_user_id and is_admin = true and is_suspended = false
  ) then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_user_id is null or p_suspended is null then
    raise exception 'invalid account status request' using errcode = '22023';
  end if;
  update public.profiles
    set is_suspended = p_suspended,
        suspended_at = case when p_suspended then now() else null end
    where id = p_user_id and is_admin = false;
  if not found then
    raise exception 'user not found or is an admin' using errcode = 'P0002';
  end if;
  return true;
end;
$admin$;
revoke all on function public.admin_set_user_suspended(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_user_suspended(uuid, boolean, uuid) to service_role;

create or replace function public.is_active_user()
returns boolean
language sql
security definer
set search_path = pg_catalog, public, auth
stable
as $active$
  select coalesce((
    select is_admin or not is_suspended
    from public.profiles
    where id = auth.uid()
  ), false);
$active$;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

-- Restrictive policies add an account-status check without replacing the
-- existing per-user ownership policies.
drop policy if exists "active accounts only" on public.prompts_history;
create policy "active accounts only" on public.prompts_history
  as restrictive for all to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "active accounts only" on public.analytics_events;
create policy "active accounts only" on public.analytics_events
  as restrictive for all to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "active accounts only" on public.subscription_requests;
create policy "active accounts only" on public.subscription_requests
  as restrictive for all to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "active accounts only" on public.subscriptions;
create policy "active accounts only" on public.subscriptions
  as restrictive for all to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
-- Per-user limits use a rolling window: every usage event expires 3 hours after
-- its own creation. The shared app limit deliberately remains daily.
drop function if exists public.reserve_ai_usage(uuid,uuid,text,text,text,integer);
create or replace function public.reserve_ai_usage(
  p_request_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_operation_mode text,
  p_reserved_tokens integer,
  p_bypass_user_limit boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $usage$
declare
  v_settings public.usage_settings%rowtype;
  v_existing public.ai_usage_events%rowtype;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_window_start timestamptz := now() - interval '3 hours';
  v_global_used bigint;
  v_user_used bigint;
  v_user_reset_at timestamptz;
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
      'user_used', 0, 'user_limit', 0, 'reset_at', v_existing.created_at + interval '3 hours');
  end if;

  select * into v_settings from public.usage_settings where id = true for update;
  update public.ai_usage_events
    set status = 'timeout', total_tokens = reserved_tokens, is_estimate = true, settled_at = now()
    where status = 'pending' and created_at < now() - interval '15 minutes';

  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_global_used
    from public.ai_usage_events where created_at >= v_day_start;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_user_used
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;
  select min(created_at + interval '3 hours') into v_user_reset_at
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;

  if not p_bypass_user_limit and v_user_used + p_reserved_tokens > v_settings.daily_user_token_limit then
    v_reason := 'user_limit';
  elsif v_global_used + p_reserved_tokens > v_settings.daily_global_token_limit then
    v_reason := 'global_limit';
  end if;

  if v_reason is not null then
    return jsonb_build_object('allowed', false, 'reason', v_reason,
      'user_used', v_user_used, 'user_limit', v_settings.daily_user_token_limit,
      'reset_at', case when v_reason = 'global_limit' then v_day_start + interval '1 day' else v_user_reset_at end);
  end if;

  insert into public.ai_usage_events (request_id, user_id, provider, model, operation_mode, reserved_tokens)
  values (p_request_id, p_user_id, p_provider, left(p_model, 100), p_operation_mode, p_reserved_tokens);

  return jsonb_build_object('allowed', true, 'reason', null,
    'user_used', v_user_used + p_reserved_tokens, 'user_limit', v_settings.daily_user_token_limit,
    'reset_at', v_user_reset_at);
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
  v_window_start timestamptz := now() - interval '3 hours';
  v_used bigint;
  v_reset_at timestamptz;
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
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;
  select min(created_at + interval '3 hours') into v_reset_at
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;
  return jsonb_build_object('user_used', v_used, 'user_limit', v_settings.daily_user_token_limit,
    'reset_at', v_reset_at);
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
  v_window_start timestamptz := now() - interval '3 hours';
  v_used bigint;
  v_reset_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_settings from public.usage_settings where id = true;
  select coalesce(sum(coalesce(total_tokens, reserved_tokens)), 0) into v_used
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;
  select min(created_at + interval '3 hours') into v_reset_at
    from public.ai_usage_events where user_id = p_user_id and created_at >= v_window_start;
  return jsonb_build_object('used', v_used, 'limit', v_settings.daily_user_token_limit,
    'reset_at', v_reset_at);
end;
$usage$;

revoke all on function public.reserve_ai_usage(uuid,uuid,text,text,text,integer,boolean) from public, anon, authenticated;
grant execute on function public.reserve_ai_usage(uuid,uuid,text,text,text,integer,boolean) to service_role;
