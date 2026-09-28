-- MiniMiz manual subscription requests and entitlements.
-- Safe to run after schema.sql; preserves all existing account and prompt data.

create table if not exists public.subscription_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);

create unique index if not exists subscription_requests_one_pending_per_user
  on public.subscription_requests(user_id) where status = 'pending';
create index if not exists subscription_requests_created_at_idx
  on public.subscription_requests(created_at desc);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  granted_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.subscription_requests enable row level security;
alter table public.subscriptions enable row level security;

revoke all on table public.subscription_requests, public.subscriptions from public, anon, authenticated;
grant select on table public.subscription_requests, public.subscriptions to authenticated;
grant insert (user_id, note) on table public.subscription_requests to authenticated;

drop policy if exists "users read own subscription requests; admins read all" on public.subscription_requests;
create policy "users read own subscription requests; admins read all"
  on public.subscription_requests for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "users submit own pending subscription request" on public.subscription_requests;
create policy "users submit own pending subscription request"
  on public.subscription_requests for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'pending'
    and decided_at is null
    and decided_by is null
    and (note is null or char_length(note) <= 500)
  );

drop policy if exists "users read own subscription; admins read all" on public.subscriptions;
create policy "users read own subscription; admins read all"
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));

create or replace function public.has_active_subscription(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $function$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id and s.expires_at > now()
  );
$function$;
revoke all on function public.has_active_subscription(uuid) from public, anon, authenticated;
grant execute on function public.has_active_subscription(uuid) to service_role;

create or replace function public.admin_activate_subscription_request(p_request_id uuid, p_duration_days integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.subscription_requests%rowtype;
  v_expires_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_duration_days not in (30, 90, 365) then
    raise exception 'invalid subscription duration' using errcode = '22023';
  end if;

  select * into v_request
  from public.subscription_requests
  where id = p_request_id and status = 'pending'
  for update;
  if not found then
    raise exception 'pending subscription request not found' using errcode = 'P0002';
  end if;

  insert into public.subscriptions (user_id, expires_at, granted_by, updated_at)
  values (v_request.user_id, now() + make_interval(days => p_duration_days), auth.uid(), now())
  on conflict (user_id) do update set
    expires_at = greatest(public.subscriptions.expires_at, now()) + make_interval(days => p_duration_days),
    granted_by = auth.uid(),
    updated_at = now()
  returning expires_at into v_expires_at;

  update public.subscription_requests
  set status = 'approved', decided_at = now(), decided_by = auth.uid()
  where id = p_request_id;
  return v_expires_at;
end;
$function$;

create or replace function public.admin_reject_subscription_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  update public.subscription_requests
  set status = 'rejected', decided_at = now(), decided_by = auth.uid()
  where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'pending subscription request not found' using errcode = 'P0002';
  end if;
  return true;
end;
$function$;

revoke all on function public.admin_activate_subscription_request(uuid, integer) from public, anon;
revoke all on function public.admin_reject_subscription_request(uuid) from public, anon;
grant execute on function public.admin_activate_subscription_request(uuid, integer) to authenticated;
grant execute on function public.admin_reject_subscription_request(uuid) to authenticated;
