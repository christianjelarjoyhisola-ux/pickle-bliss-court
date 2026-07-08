-- Open Play host applications and host-created sessions.

alter table public.accounts
  drop constraint if exists accounts_role_check;

alter table public.accounts
  add constraint accounts_role_check
  check (role in ('owner', 'court_owner', 'staff', 'host'));

create table if not exists public.open_play_host_applications (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  contact_number text not null,
  email text not null,
  preferred_schedule text,
  notes text,
  status text not null default 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_applications_status_check
    check (status in ('pending', 'approved', 'rejected'))
);

create table if not exists public.open_play_host_sessions (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid,
  host_name text not null,
  host_email text,
  title text not null,
  date date not null,
  start_hour int not null,
  end_hour int not null,
  court_ids text[] not null default '{}',
  court_names text[] not null default '{}',
  max_players int not null default 16,
  fee_per_player numeric(10,2) not null default 0,
  status text not null default 'published',
  notes text,
  payment_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_sessions_status_check
    check (status in ('draft', 'published', 'cancelled')),
  constraint open_play_host_sessions_time_check
    check (start_hour >= 0 and start_hour <= 23 and end_hour > start_hour and end_hour <= 24),
  constraint open_play_host_sessions_capacity_check
    check (max_players > 0),
  constraint open_play_host_sessions_fee_check
    check (fee_per_player >= 0)
);

create index if not exists idx_open_play_host_applications_status
  on public.open_play_host_applications(status, created_at desc);

create index if not exists idx_open_play_host_sessions_date
  on public.open_play_host_sessions(date, start_hour);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_open_play_host_applications_touch_updated_at on public.open_play_host_applications;
create trigger trg_open_play_host_applications_touch_updated_at
before update on public.open_play_host_applications
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_sessions_touch_updated_at on public.open_play_host_sessions;
create trigger trg_open_play_host_sessions_touch_updated_at
before update on public.open_play_host_sessions
for each row execute function public.touch_updated_at();

alter table public.open_play_host_applications enable row level security;
alter table public.open_play_host_sessions enable row level security;

drop policy if exists open_play_host_applications_insert_public on public.open_play_host_applications;
create policy open_play_host_applications_insert_public
  on public.open_play_host_applications
  for insert
  with check (status = 'pending');

drop policy if exists open_play_host_applications_owner_all on public.open_play_host_applications;
create policy open_play_host_applications_owner_all
  on public.open_play_host_applications
  for all
  to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

drop policy if exists open_play_host_sessions_select_public on public.open_play_host_sessions;
create policy open_play_host_sessions_select_public
  on public.open_play_host_sessions
  for select
  using (status = 'published' or public.has_account_role(array['owner','court_owner','host']));

drop policy if exists open_play_host_sessions_insert_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_insert_host_roles
  on public.open_play_host_sessions
  for insert
  to authenticated
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (
      public.has_account_role(array['host'])
      and host_user_id = auth.uid()
    )
  );

drop policy if exists open_play_host_sessions_update_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_update_host_roles
  on public.open_play_host_sessions
  for update
  to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or (
      public.has_account_role(array['host'])
      and host_user_id = auth.uid()
    )
  )
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (
      public.has_account_role(array['host'])
      and host_user_id = auth.uid()
    )
  );
