-- ============================================================
-- 20260613_weekly_billing.sql
-- Weekly platform fee statements for court owner remittance
-- ============================================================

create table if not exists public.weekly_fees (
  id uuid primary key default gen_random_uuid(),
  court_owner_user_id text not null,
  court_owner_email text,
  week_start date not null,
  week_end date not null,
  bookings_count integer not null default 0,
  fee_per_booking numeric not null default 15,
  amount_due numeric not null default 0,
  status text not null default 'draft', -- draft | sent | submitted | paid | overdue
  generated_at timestamptz not null default now(),
  sent_at timestamptz,
  due_at timestamptz,
  submitted_at timestamptz,
  submitted_ref text,
  submitted_note text,
  submitted_proof_url text,
  paid_at timestamptz,
  paid_ref text,
  paid_note text,
  paid_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_fees_status_check check (status in ('draft','sent','submitted','paid','overdue')),
  constraint weekly_fees_bookings_count_check check (bookings_count >= 0),
  constraint weekly_fees_amount_due_check check (amount_due >= 0),
  constraint weekly_fees_week_range_check check (week_end >= week_start)
);

create unique index if not exists weekly_fees_owner_week_uq
  on public.weekly_fees (court_owner_user_id, week_start, week_end);

create index if not exists idx_weekly_fees_status on public.weekly_fees (status);
create index if not exists idx_weekly_fees_week_start on public.weekly_fees (week_start desc);

create or replace function public.touch_weekly_fees_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_weekly_fees_touch_updated_at on public.weekly_fees;
create trigger trg_weekly_fees_touch_updated_at
before update on public.weekly_fees
for each row execute function public.touch_weekly_fees_updated_at();

alter table if exists public.weekly_fees enable row level security;

-- Dashboard users can read and write; role-based checks are enforced in app logic.
drop policy if exists weekly_fees_select_auth on public.weekly_fees;
create policy weekly_fees_select_auth
  on public.weekly_fees
  for select
  to authenticated
  using (true);

drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
create policy weekly_fees_insert_auth
  on public.weekly_fees
  for insert
  to authenticated
  with check (true);

drop policy if exists weekly_fees_update_auth on public.weekly_fees;
create policy weekly_fees_update_auth
  on public.weekly_fees
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
create policy weekly_fees_delete_auth
  on public.weekly_fees
  for delete
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- Idempotent backfill: ensure court-owner payment-submission
-- columns exist even if the table was created by an earlier run.
-- ------------------------------------------------------------
alter table public.weekly_fees add column if not exists submitted_at timestamptz;
alter table public.weekly_fees add column if not exists submitted_ref text;
alter table public.weekly_fees add column if not exists submitted_note text;
alter table public.weekly_fees add column if not exists submitted_proof_url text;

notify pgrst, 'reload schema';

