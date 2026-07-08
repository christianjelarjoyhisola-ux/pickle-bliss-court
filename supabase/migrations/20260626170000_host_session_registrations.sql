-- Player registrations and OCR payment review for host-created Open Play sessions.

create table if not exists public.open_play_host_session_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_host_sessions(id) on delete cascade,
  full_name text not null,
  contact_number text,
  payment_method text not null default 'gcash',
  gcash_ref text,
  payment_status text not null default 'pending',
  amount numeric(10,2) not null default 0,
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_session_registrations_payment_method_check
    check (payment_method in ('gcash', 'gotyme', 'pnb', 'cash')),
  constraint open_play_host_session_registrations_payment_status_check
    check (payment_status in ('pending', 'paid', 'rejected')),
  constraint open_play_host_session_registrations_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint open_play_host_session_registrations_amount_check
    check (amount >= 0)
);

create index if not exists idx_open_play_host_session_registrations_session
  on public.open_play_host_session_registrations(session_id, created_at desc);

create index if not exists idx_open_play_host_session_registrations_payment
  on public.open_play_host_session_registrations(payment_status, receipt_status);

drop trigger if exists trg_open_play_host_session_registrations_touch_updated_at
  on public.open_play_host_session_registrations;
create trigger trg_open_play_host_session_registrations_touch_updated_at
before update on public.open_play_host_session_registrations
for each row execute function public.touch_updated_at();

alter table public.open_play_host_session_registrations enable row level security;

drop policy if exists open_play_host_session_registrations_insert_public
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_insert_public
  on public.open_play_host_session_registrations
  for insert
  with check (
    exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and s.status = 'published'
    )
  );

drop policy if exists open_play_host_session_registrations_select_host_roles
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_select_host_roles
  on public.open_play_host_session_registrations
  for select
  to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

drop policy if exists open_play_host_session_registrations_update_host_roles
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_update_host_roles
  on public.open_play_host_session_registrations
  for update
  to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  )
  with check (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

create or replace function public.count_open_play_host_session_registrations(p_session_id uuid)
returns int
language sql
security definer
set search_path = public
as $$
  select count(*)::int
  from public.open_play_host_session_registrations r
  where r.session_id = p_session_id
    and coalesce(r.payment_status, 'pending') <> 'rejected';
$$;

grant execute on function public.count_open_play_host_session_registrations(uuid) to anon, authenticated;
