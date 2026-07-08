-- Payment security and auto-sync schema updates

-- 1) Extend bookings with payment lifecycle fields
alter table if exists public.bookings
  add column if not exists payment_flow text,
  add column if not exists payment_status text default 'unpaid',
  add column if not exists payment_provider text,
  add column if not exists payment_session_id text,
  add column if not exists payment_checkout_url text,
  add column if not exists paid_at timestamptz,
  add column if not exists gcash_ref text,
  add column if not exists downpayment numeric;

-- Optional constraints
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bookings_payment_status_check'
  ) then
    alter table public.bookings
      add constraint bookings_payment_status_check
      check (payment_status in ('unpaid','pending','for_verification','paid','failed'));
  end if;
exception
  when undefined_table then null;
end $$;

-- 2) Payment sessions for provider/webhook tracking
create table if not exists public.payment_sessions (
  id text primary key,
  booking_ref text not null,
  provider text not null,
  provider_reference text,
  amount_php numeric not null,
  status text not null default 'pending',
  checkout_url text,
  raw_request jsonb,
  raw_webhook jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists idx_payment_sessions_booking_ref on public.payment_sessions (booking_ref);
create index if not exists idx_payment_sessions_status on public.payment_sessions (status);
create index if not exists idx_payment_sessions_provider_reference on public.payment_sessions (provider_reference);

-- 3) updated_at trigger helper
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_payment_sessions_touch_updated_at on public.payment_sessions;
create trigger trg_payment_sessions_touch_updated_at
before update on public.payment_sessions
for each row execute function public.touch_updated_at();

-- 4) Enable RLS and lock down direct access
alter table if exists public.payment_sessions enable row level security;

-- Users should not directly read/write payment session internals.
-- All writes should happen through service-role Edge Functions.
drop policy if exists payment_sessions_select_none on public.payment_sessions;
create policy payment_sessions_select_none
on public.payment_sessions
for select
to authenticated
using (false);

drop policy if exists payment_sessions_insert_none on public.payment_sessions;
create policy payment_sessions_insert_none
on public.payment_sessions
for insert
to authenticated
with check (false);

drop policy if exists payment_sessions_update_none on public.payment_sessions;
create policy payment_sessions_update_none
on public.payment_sessions
for update
to authenticated
using (false)
with check (false);
