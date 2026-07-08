-- Archive deleted bookings and allow manual recovery notes without restoring
-- questionable rows into live availability.

create table if not exists public.deleted_booking_archive (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  source text not null default 'trigger',
  original_booking jsonb,
  recovered_booking jsonb,
  recovery_status text not null default 'archived',
  recovered_from text,
  notes text,
  deleted_at timestamptz not null default now(),
  archived_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_deleted_booking_archive_ref
  on public.deleted_booking_archive (booking_ref);

create index if not exists idx_deleted_booking_archive_deleted_at
  on public.deleted_booking_archive (deleted_at desc);

create index if not exists idx_deleted_booking_archive_status
  on public.deleted_booking_archive (recovery_status);

create unique index if not exists uniq_deleted_booking_archive_screenshot_ref
  on public.deleted_booking_archive (booking_ref, source)
  where source = 'screenshot_recovery';

create or replace function public.archive_deleted_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.deleted_booking_archive (
    booking_ref,
    source,
    original_booking,
    recovery_status,
    deleted_at,
    notes
  )
  values (
    old.ref,
    'trigger',
    to_jsonb(old),
    'deleted',
    now(),
    'Automatically archived before hard delete.'
  );

  return old;
end;
$$;

drop trigger if exists trg_archive_deleted_booking on public.bookings;
create trigger trg_archive_deleted_booking
before delete on public.bookings
for each row
execute function public.archive_deleted_booking();

alter table public.deleted_booking_archive enable row level security;

drop policy if exists deleted_booking_archive_select_dashboard_roles on public.deleted_booking_archive;
create policy deleted_booking_archive_select_dashboard_roles
  on public.deleted_booking_archive
  for select
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists deleted_booking_archive_insert_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_insert_owner
  on public.deleted_booking_archive
  for insert
  to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists deleted_booking_archive_update_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_update_owner
  on public.deleted_booking_archive
  for update
  to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

