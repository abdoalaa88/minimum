-- MiniMiz in-app notifications for support chat and subscription status.
-- Safe to run again; existing accounts, chats, prompts, and subscriptions stay intact.

create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in (
    'support_message', 'support_reply', 'subscription_request',
    'subscription_approved', 'subscription_rejected'
  )),
  target text not null check (target in ('messages', 'subscription')),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists app_notifications_user_created_idx
  on public.app_notifications(user_id, created_at desc);
create index if not exists app_notifications_unread_idx
  on public.app_notifications(user_id, created_at desc) where read_at is null;

alter table public.app_notifications enable row level security;
revoke all on table public.app_notifications from public, anon, authenticated;
grant select on table public.app_notifications to authenticated;
grant update (read_at) on table public.app_notifications to authenticated;

drop policy if exists "users read own app notifications" on public.app_notifications;
create policy "users read own app notifications"
  on public.app_notifications for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "users mark own app notifications read" on public.app_notifications;
create policy "users mark own app notifications read"
  on public.app_notifications for update to authenticated
  using (user_id = (select auth.uid()) and read_at is null)
  with check (user_id = (select auth.uid()) and read_at is not null);

create or replace function public.create_app_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_name = 'support_messages' then
    if exists (
      select 1 from public.profiles p
      where p.id = new.sender_id and p.is_admin = true
    ) then
      insert into public.app_notifications (user_id, type, target)
      values (new.user_id, 'support_reply', 'messages');
    else
      insert into public.app_notifications (user_id, type, target)
      select p.id, 'support_message', 'messages'
      from public.profiles p
      where p.is_admin = true and p.is_suspended = false;
    end if;
    return new;
  end if;

  if tg_table_name = 'subscription_requests' then
    if tg_op = 'INSERT' and new.status = 'pending' then
      insert into public.app_notifications (user_id, type, target)
      select p.id, 'subscription_request', 'subscription'
      from public.profiles p
      where p.is_admin = true and p.is_suspended = false;
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'rejected') then
      insert into public.app_notifications (user_id, type, target)
      values (
        new.user_id,
        case when new.status = 'approved' then 'subscription_approved' else 'subscription_rejected' end,
        'subscription'
      );
    end if;
    return new;
  end if;

  return new;
end;
$function$;

revoke all on function public.create_app_notification() from public, anon, authenticated;

drop trigger if exists notify_support_message on public.support_messages;
create trigger notify_support_message
  after insert on public.support_messages
  for each row execute function public.create_app_notification();

drop trigger if exists notify_subscription_request on public.subscription_requests;
create trigger notify_subscription_request
  after insert or update of status on public.subscription_requests
  for each row execute function public.create_app_notification();

-- Realtime makes the bell update immediately while open; the client also polls on return.
do $publication$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'app_notifications'
    ) then
    execute 'alter publication supabase_realtime add table public.app_notifications';
  end if;
end;
$publication$;

