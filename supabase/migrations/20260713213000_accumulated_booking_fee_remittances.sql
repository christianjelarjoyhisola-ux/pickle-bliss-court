-- ============================================================================
-- Accumulated booking-fee remittances
--
-- Business rule:
--   * The venue accumulates the full platform booking/service fee on every
--     eligible booking row. Customer/host downpayments are a separate amount.
--   * A court owner prepares one remittance on or after the 14th. The database
--     freezes all fees earned through the exact server timestamp of that call.
--   * Fees earned after that cutoff remain unclaimed for the next due cycle.
--   * A remittance reaches SETTLED only after a system owner accepts enough
--     payment proof to cover its frozen amount.
--
-- This migration intentionally leaves public.weekly_fees and its history
-- untouched. Any booking already claimed by weekly_fee_id, billed_at, or a
-- paid weekly_fees.billed_refs history is excluded from the new ledger; unpaid
-- legacy statements are superseded and their bookings return to accumulation.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 0. Pickle Bliss compatibility columns
--
-- The source ledger also supports host-originated reservations. Pickle Bliss
-- does not currently expose that public host flow, but the server-side
-- booking guard references these provenance fields. Adding safe customer
-- defaults keeps existing and future Pickle Bliss bookings compatible.
-- --------------------------------------------------------------------------

alter table public.bookings
  add column if not exists host_booking boolean not null default false,
  add column if not exists host_user_id uuid,
  add column if not exists host_name text,
  add column if not exists host_email text,
  add column if not exists created_via text not null default 'customer',
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_role text,
  add column if not exists created_by_name text,
  add column if not exists created_by_email text;

-- --------------------------------------------------------------------------
-- 1. Immutable, server-owned booking-fee snapshots
-- --------------------------------------------------------------------------

alter table public.bookings
  add column if not exists booking_fee_amount_snapshot numeric(12,2),
  add column if not exists booking_fee_rate_snapshot numeric(12,2),
  add column if not exists booking_fee_type_snapshot text,
  add column if not exists booking_fee_units_snapshot numeric(12,2),
  add column if not exists booking_fee_snapshot_source text,
  add column if not exists booking_fee_ledger_eligible_snapshot boolean,
  add column if not exists booking_fee_earned_at timestamptz;

-- Retire unpaid statements created by the old calendar-month workflow. Their
-- booking refs must return to the live accumulated balance so the first exact
-- cutoff includes every unpaid fee earned since operations began. Paid legacy
-- statements remain claimed and readable as permanent legacy history.
alter table public.weekly_fees
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

alter table public.weekly_fees
  drop constraint if exists weekly_fees_status_check;
alter table public.weekly_fees
  add constraint weekly_fees_status_check
  check (status in ('draft', 'sent', 'submitted', 'paid', 'overdue', 'superseded'));

update public.weekly_fees wf
   set status = 'superseded',
       superseded_at = coalesce(wf.superseded_at, clock_timestamp()),
       superseded_reason = coalesce(
         nullif(wf.superseded_reason, ''),
         'Replaced by accumulated exact-cutoff remittance ledger'
       )
 where wf.status <> 'paid';

update public.bookings b
   set weekly_fee_id = null,
       billed_at = null
 where exists (
   select 1
     from public.weekly_fees wf
    where wf.status = 'superseded'
      and (
        wf.id = b.weekly_fee_id
        or coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
      )
 );

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname = 'bookings_fee_snapshot_amount_check'
  ) then
    alter table public.bookings
      add constraint bookings_fee_snapshot_amount_check
      check (booking_fee_amount_snapshot is null or booking_fee_amount_snapshot >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname = 'bookings_fee_snapshot_rate_check'
  ) then
    alter table public.bookings
      add constraint bookings_fee_snapshot_rate_check
      check (booking_fee_rate_snapshot is null or booking_fee_rate_snapshot >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname = 'bookings_fee_snapshot_type_check'
  ) then
    alter table public.bookings
      add constraint bookings_fee_snapshot_type_check
      check (
        booking_fee_type_snapshot is null
        or booking_fee_type_snapshot in ('flat', 'per_hour')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname = 'bookings_fee_snapshot_units_check'
  ) then
    alter table public.bookings
      add constraint bookings_fee_snapshot_units_check
      check (booking_fee_units_snapshot is null or booking_fee_units_snapshot >= 0);
  end if;
end;
$$;

-- billed_refs is retained only for legacy compatibility. This index keeps the
-- one-time backfill and future exclusion check inexpensive.
create index if not exists idx_weekly_fees_billed_refs_gin
  on public.weekly_fees using gin (billed_refs);

-- Existing, unclaimed bookings did not store the fee that was charged. The
-- current configured fee is the safest available backfill. Its source label is
-- deliberately explicit so an owner can distinguish it from new snapshots.
with fee_config as (
  select
    case
      when trim(coalesce((
        select s.value
          from public.settings s
         where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
           and s.value is not null
         order by case s.key
           when 'maintenance_fee' then 1
           when 'service_fee_rate' then 2
           else 3
         end
         limit 1
      ), '')) ~ '^[0-9]+([.][0-9]+)?$'
      then trim((
        select s.value
          from public.settings s
         where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
           and s.value is not null
         order by case s.key
           when 'maintenance_fee' then 1
           when 'service_fee_rate' then 2
           else 3
         end
         limit 1
      ))::numeric
      else 0::numeric
    end as fee_rate,
    case
      when lower(trim(coalesce((
        select s.value from public.settings s where s.key = 'fee_type' limit 1
      ), ''))) in ('flat', 'booking', 'per_booking', 'per_transaction')
      then 'flat'
      else 'per_hour'
    end as fee_type
)
update public.bookings b
   set booking_fee_rate_snapshot = round(cfg.fee_rate, 2),
       booking_fee_type_snapshot = cfg.fee_type,
       booking_fee_units_snapshot = case
         when cfg.fee_type = 'flat' then 1
         else coalesce(cardinality(b.slots), 0)
       end,
       booking_fee_amount_snapshot = round(
         cfg.fee_rate * case
           when cfg.fee_type = 'flat' then 1
           else coalesce(cardinality(b.slots), 0)
         end,
         2
       ),
       booking_fee_snapshot_source = 'legacy_backfill_current_config',
       booking_fee_ledger_eligible_snapshot = true
  from fee_config cfg
 where b.booking_fee_amount_snapshot is null
   and b.weekly_fee_id is null
   and b.billed_at is null
   and lower(coalesce(b.created_via, 'customer')) <> 'import'
   and lower(coalesce(b.payment_method, '')) <> 'manual'
   and b.ref not ilike 'MANUAL-%'
   and not exists (
     select 1
       from public.weekly_fees wf
      where wf.status = 'paid'
        and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
   );

update public.bookings
   set booking_fee_ledger_eligible_snapshot = false
 where booking_fee_ledger_eligible_snapshot is null;

alter table public.bookings
  alter column booking_fee_ledger_eligible_snapshot set default false,
  alter column booking_fee_ledger_eligible_snapshot set not null;

-- A fee is earned once, at the first successful payment + booking transition.
-- It remains earned after a later cancellation; any correction must be an
-- auditable remittance action rather than silently changing history.
update public.bookings b
   set booking_fee_earned_at = coalesce(
     b.paid_at,
     b.receipt_verified_at,
     b.created_at,
     now()
   )
 where b.booking_fee_earned_at is null
   and b.booking_fee_amount_snapshot is not null
   and b.booking_fee_ledger_eligible_snapshot
   and b.status in ('confirmed', 'completed')
   and b.payment_status in ('paid', 'downpayment_paid');

create or replace function public.snapshot_booking_fee_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fee_text text;
  fee_type_text text;
  fee_rate numeric := 0;
  fee_type text := 'per_hour';
  fee_units numeric := 0;
begin
  select s.value
    into fee_text
    from public.settings s
   where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
     and s.value is not null
   order by case s.key
     when 'maintenance_fee' then 1
     when 'service_fee_rate' then 2
     else 3
   end
   limit 1;

  if trim(coalesce(fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    fee_rate := round(trim(fee_text)::numeric, 2);
  end if;

  select s.value into fee_type_text
    from public.settings s
   where s.key = 'fee_type'
   limit 1;

  if lower(trim(coalesce(fee_type_text, ''))) in
     ('flat', 'booking', 'per_booking', 'per_transaction') then
    fee_type := 'flat';
    fee_units := 1;
  else
    fee_units := coalesce(cardinality(new.slots), 0);
  end if;

  -- Ignore all client-supplied snapshot values.
  new.booking_fee_rate_snapshot := fee_rate;
  new.booking_fee_type_snapshot := fee_type;
  new.booking_fee_units_snapshot := fee_units;
  new.booking_fee_amount_snapshot := round(fee_rate * fee_units, 2);
  new.booking_fee_snapshot_source := 'server_insert';
  -- Public customer and authenticated host inserts are platform transactions.
  -- This immutable flag avoids relying on editable payment/display fields when
  -- the fee is later selected for remittance. Host role is checked explicitly
  -- because its canonicalization trigger runs in the same BEFORE INSERT phase.
  new.booking_fee_ledger_eligible_snapshot := (
    auth.role() = 'anon'
    or public.current_account_role() = 'host'
    or (
      lower(coalesce(new.created_via, '')) in ('customer', 'host', 'admin')
      and lower(coalesce(new.payment_method, '')) <> 'manual'
      and new.ref not ilike 'MANUAL-%'
    )
  );

  -- Restores and direct inserts may carry old client-controlled billing stamps.
  -- Preserve them only when this exact reference belongs to a paid legacy
  -- statement; otherwise clear them so they cannot suppress the new ledger.
  if not exists (
    select 1
      from public.weekly_fees wf
     where wf.status = 'paid'
       and (
         coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(new.ref)
         or (
           public.current_account_role() = 'owner'
           and wf.id = new.weekly_fee_id
         )
       )
  ) then
    new.weekly_fee_id := null;
    new.billed_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.guard_booking_fee_snapshot_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.booking_fee_amount_snapshot is distinct from old.booking_fee_amount_snapshot
     or new.booking_fee_rate_snapshot is distinct from old.booking_fee_rate_snapshot
     or new.booking_fee_type_snapshot is distinct from old.booking_fee_type_snapshot
     or new.booking_fee_units_snapshot is distinct from old.booking_fee_units_snapshot
     or new.booking_fee_snapshot_source is distinct from old.booking_fee_snapshot_source
     or new.booking_fee_ledger_eligible_snapshot is distinct from old.booking_fee_ledger_eligible_snapshot then
    raise exception 'Booking fee snapshots are immutable after booking creation.'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create or replace function public.mark_booking_fee_earned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.booking_fee_earned_at is not null then
    if new.booking_fee_earned_at is distinct from old.booking_fee_earned_at then
      raise exception 'A booking fee earned timestamp is immutable.'
        using errcode = '22000';
    end if;
    return new;
  end if;

  -- Ignore a client-supplied timestamp. Only a qualifying transition may set it.
  new.booking_fee_earned_at := null;
  if new.booking_fee_amount_snapshot is not null
     and new.booking_fee_ledger_eligible_snapshot
     and new.status in ('confirmed', 'completed')
     and new.payment_status in ('paid', 'downpayment_paid') then
    -- Shared eligibility locks serialize against the exclusive prepare lock.
    perform pg_advisory_xact_lock_shared(
      hashtextextended('pickle-bliss-booking-fee-remittance', 0)
    );
    new.booking_fee_earned_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create or replace function public.guard_legacy_booking_fee_stamps()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.weekly_fee_id is distinct from old.weekly_fee_id
     or new.billed_at is distinct from old.billed_at then
    raise exception 'Legacy billing stamps are read-only after the remittance-ledger cutover.'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

-- Public downpayments collect the full non-refundable platform fee plus 50%
-- of the court fee. This keeps the remittance obligation equal to money the
-- venue has actually collected. Hosts retain full fee + 25% court pricing.
create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  service_fee numeric := 0;
  public_due numeric := 0;
  host_due numeric := 0;
begin
  if request_role = 'anon'
     or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id
      or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date
      or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time
      or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration
      or new.rate is distinct from old.rate
      or new.total is distinct from old.total
      or new.created_at is distinct from old.created_at
      or new.host_booking is distinct from old.host_booking
      or new.host_user_id is distinct from old.host_user_id
      or new.host_name is distinct from old.host_name
      or new.host_email is distinct from old.host_email
      or new.created_via is distinct from old.created_via
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_role is distinct from old.created_by_role
      or new.created_by_name is distinct from old.created_by_name
      or new.created_by_email is distinct from old.created_by_email
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url
      or new.paid_at is distinct from old.paid_at
      or new.receipt_image_url is distinct from old.receipt_image_url
      or new.receipt_image_hash is distinct from old.receipt_image_hash
      or new.receipt_phash is distinct from old.receipt_phash
      or new.receipt_status is distinct from old.receipt_status
      or new.receipt_flags is distinct from old.receipt_flags
      or new.receipt_extracted is distinct from old.receipt_extracted
      or new.receipt_confidence is distinct from old.receipt_confidence
      or new.receipt_verified_at is distinct from old.receipt_verified_at
      or new.billed_at is distinct from old.billed_at
      or new.weekly_fee_id is distinct from old.weekly_fee_id
      or new.confirmation_email_id is distinct from old.confirmation_email_id
      or new.confirmation_email_sent_at is distinct from old.confirmation_email_sent_at
      or new.confirmation_email_last_event is distinct from old.confirmation_email_last_event then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;

    if new.payment_status not in ('unpaid', 'pending', 'for_verification', 'rejected') then
      raise exception 'Reservation payment status cannot be approved by the booking client.';
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false)
      or old.host_user_id is not null
      or old.created_via <> 'customer'
      or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Reservation payment amount is invalid.';
      end if;
      service_fee := least(
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      public_due := round(service_fee + ((old.total - service_fee) * 0.50), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - public_due) > 0.01
         -- Grandfather an in-flight/cached checkout opened before this deploy.
         and abs(new.downpayment - (old.total / 2)) > 0.01
         and abs(new.downpayment - round(old.total / 2)) > 0.01 then
        raise exception 'Reservation payment amount is invalid. Expected 50%% of the court fee plus the full service fee.';
      end if;
    end if;
  elsif request_role = 'authenticated' and account_role = 'host' then
    if old.status <> 'verifying'
      or old.created_at is null
      or old.created_at <= now() - interval '15 minutes'
      or not coalesce(old.host_booking, false)
      or old.host_user_id is distinct from auth.uid()
      or old.created_via <> 'host'
      or old.created_by_user_id is distinct from auth.uid()
      or old.created_by_role <> 'host' then
      raise exception 'Hosts may only finalize their own active booking holds.';
    end if;

    if new.status not in ('verifying', 'pending', 'cancelled') then
      raise exception 'Host booking hold status transition is invalid.';
    end if;

    if new.status = 'pending' and new.downpayment is null then
      raise exception 'A finalized host booking must store its payment amount.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Host booking total is invalid.';
      end if;
      service_fee := least(
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      host_due := round(service_fee + ((old.total - service_fee) * 0.25), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop policy if exists bookings_insert_public on public.bookings;
create policy bookings_insert_public
  on public.bookings
  for insert
  to anon
  with check (
    coalesce(host_booking, false) = false
    and host_user_id is null
    and host_name is null
    and host_email is null
    and created_via = 'customer'
    and created_by_user_id is null
    and created_by_role is null
    and created_by_name is null
    and created_by_email is null
    and status in ('verifying', 'pending')
    and payment_status in ('unpaid', 'pending', 'for_verification')
    and created_at > now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
    and total is not null
    and total >= 0
    and (
      downpayment is null
      or abs(downpayment - total) <= 0.01
      or abs(downpayment - (total / 2)) <= 0.01
      or abs(downpayment - round(total / 2)) <= 0.01
      or abs(
        downpayment - round(
          least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
          + ((total - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)) * 0.50),
          2
        )
      ) <= 0.01
    )
  );

drop trigger if exists trg_snapshot_booking_fee_on_insert on public.bookings;
create trigger trg_snapshot_booking_fee_on_insert
before insert on public.bookings
for each row execute function public.snapshot_booking_fee_on_insert();

drop trigger if exists trg_guard_booking_fee_snapshot_update on public.bookings;
create trigger trg_guard_booking_fee_snapshot_update
before update on public.bookings
for each row execute function public.guard_booking_fee_snapshot_update();

drop trigger if exists trg_mark_booking_fee_earned on public.bookings;
create trigger trg_mark_booking_fee_earned
before insert or update on public.bookings
for each row execute function public.mark_booking_fee_earned();

create index if not exists idx_bookings_booking_fee_earned_at
  on public.bookings (booking_fee_earned_at, created_at)
  where booking_fee_earned_at is not null;

comment on column public.bookings.booking_fee_amount_snapshot is
  'Full platform booking/service fee earned on this stored booking row. It is separate from the customer or host downpayment.';
comment on column public.bookings.booking_fee_earned_at is
  'Server timestamp when a confirmed/completed booking first had a paid/downpayment_paid payment state.';

-- --------------------------------------------------------------------------
-- 2. Permanent remittance ledger
-- --------------------------------------------------------------------------

create table if not exists public.booking_fee_remittances (
  id uuid primary key default gen_random_uuid(),
  remittance_ref text not null unique,
  scope_key text not null default 'venue',
  cycle_due_on date not null,
  coverage_start_at timestamptz,
  cutoff_at timestamptz not null,
  status text not null default 'prepared',
  currency text not null default 'PHP',
  bookings_count integer not null default 0,
  amount_due numeric(12,2) not null default 0,
  amount_settled numeric(12,2) not null default 0,
  prepared_at timestamptz not null,
  prepared_by_user_id uuid,
  prepared_by_email text,
  prepared_by_role text not null,
  prepare_idempotency_key text not null,
  owner_override boolean not null default false,
  owner_override_reason text,
  last_submitted_at timestamptz,
  settled_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancellation_reason text,
  cancel_idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_fee_remittances_scope_check
    check (scope_key = 'venue'),
  constraint booking_fee_remittances_status_check
    check (status in (
      'prepared',
      'submitted',
      'partially_settled',
      'payment_rejected',
      'settled',
      'cancelled'
    )),
  constraint booking_fee_remittances_currency_check check (currency = 'PHP'),
  constraint booking_fee_remittances_count_check check (bookings_count >= 0),
  constraint booking_fee_remittances_amount_check
    check (
      amount_due >= 0
      and amount_settled >= 0
      and amount_settled <= amount_due
    ),
  constraint booking_fee_remittances_prepare_key_check
    check (length(trim(prepare_idempotency_key)) between 8 and 128),
  constraint booking_fee_remittances_override_reason_check
    check (not owner_override or length(trim(coalesce(owner_override_reason, ''))) >= 3),
  constraint booking_fee_remittances_cancel_fields_check
    check (
      (status <> 'cancelled' and cancelled_at is null)
      or (status = 'cancelled' and cancelled_at is not null and cancellation_reason is not null)
    )
);

create unique index if not exists booking_fee_remittances_active_cycle_uq
  on public.booking_fee_remittances (scope_key, cycle_due_on)
  where status <> 'cancelled';
create unique index if not exists booking_fee_remittances_prepare_idempotency_uq
  on public.booking_fee_remittances (prepared_by_user_id, prepare_idempotency_key);
create unique index if not exists booking_fee_remittances_cancel_idempotency_uq
  on public.booking_fee_remittances (cancelled_by_user_id, cancel_idempotency_key)
  where cancel_idempotency_key is not null;
create index if not exists idx_booking_fee_remittances_status_due
  on public.booking_fee_remittances (status, cycle_due_on desc);
create index if not exists idx_booking_fee_remittances_cutoff
  on public.booking_fee_remittances (cutoff_at desc);

create table if not exists public.booking_fee_remittance_items (
  id uuid primary key default gen_random_uuid(),
  remittance_id uuid not null references public.booking_fee_remittances(id) on delete restrict,
  booking_ref text not null,
  booking_group_ref text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz not null,
  court_id text,
  court_name text,
  booking_date date,
  host_booking boolean not null default false,
  created_via text,
  fee_amount numeric(12,2) not null,
  fee_rate numeric(12,2) not null,
  fee_type text not null,
  fee_units numeric(12,2) not null,
  fee_snapshot_source text not null,
  released_at timestamptz,
  released_by_user_id uuid,
  release_reason text,
  created_at timestamptz not null default now(),
  constraint booking_fee_remittance_items_amount_check check (fee_amount >= 0),
  constraint booking_fee_remittance_items_rate_check check (fee_rate >= 0),
  constraint booking_fee_remittance_items_units_check check (fee_units >= 0),
  constraint booking_fee_remittance_items_type_check
    check (fee_type in ('flat', 'per_hour')),
  constraint booking_fee_remittance_items_release_check
    check (
      (released_at is null and released_by_user_id is null and release_reason is null)
      or (released_at is not null and release_reason is not null)
    )
);

create unique index if not exists booking_fee_remittance_items_active_booking_uq
  on public.booking_fee_remittance_items (booking_ref)
  where released_at is null;
create index if not exists idx_booking_fee_remittance_items_remittance
  on public.booking_fee_remittance_items (remittance_id, fee_earned_at, booking_ref);
create index if not exists idx_booking_fee_remittance_items_booking
  on public.booking_fee_remittance_items (booking_ref, created_at desc);

create table if not exists public.booking_fee_remittance_payments (
  id uuid primary key default gen_random_uuid(),
  remittance_id uuid not null references public.booking_fee_remittances(id) on delete restrict,
  amount_submitted numeric(12,2) not null,
  amount_accepted numeric(12,2) not null default 0,
  payment_method text not null,
  payment_reference text not null,
  normalized_reference text not null,
  proof_path text not null,
  note text,
  status text not null default 'pending',
  submitted_at timestamptz not null,
  submitted_by_user_id uuid not null,
  submitted_by_email text,
  submission_idempotency_key text not null,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  review_note text,
  review_idempotency_key text,
  created_at timestamptz not null default now(),
  constraint booking_fee_remittance_payments_amount_check
    check (
      amount_submitted > 0
      and amount_accepted >= 0
      and amount_accepted <= amount_submitted
    ),
  constraint booking_fee_remittance_payments_method_check
    check (payment_method in ('gcash', 'maya', 'bank_transfer', 'cash', 'other')),
  constraint booking_fee_remittance_payments_status_check
    check (status in ('pending', 'accepted', 'partially_accepted', 'rejected')),
  constraint booking_fee_remittance_payments_reference_check
    check (length(normalized_reference) >= 4),
  constraint booking_fee_remittance_payments_proof_check
    check (length(trim(proof_path)) between 3 and 2048 and proof_path !~* '^data:'),
  constraint booking_fee_remittance_payments_submission_key_check
    check (length(trim(submission_idempotency_key)) between 8 and 128),
  constraint booking_fee_remittance_payments_review_check
    check (
      (status = 'pending' and reviewed_at is null and reviewed_by_user_id is null)
      or (status <> 'pending' and reviewed_at is not null and reviewed_by_user_id is not null)
    )
);

create unique index if not exists booking_fee_remittance_payments_submission_uq
  on public.booking_fee_remittance_payments (
    submitted_by_user_id,
    submission_idempotency_key
  );
drop index if exists public.booking_fee_remittance_payments_reference_uq;
create unique index booking_fee_remittance_payments_reference_uq
  on public.booking_fee_remittance_payments (payment_method, normalized_reference)
  where status in ('pending', 'accepted', 'partially_accepted');
create unique index if not exists booking_fee_remittance_payments_proof_path_uq
  on public.booking_fee_remittance_payments (proof_path);
create unique index if not exists booking_fee_remittance_payments_review_uq
  on public.booking_fee_remittance_payments (reviewed_by_user_id, review_idempotency_key)
  where review_idempotency_key is not null;
create index if not exists idx_booking_fee_remittance_payments_remittance
  on public.booking_fee_remittance_payments (remittance_id, submitted_at desc);
create index if not exists idx_booking_fee_remittance_payments_pending
  on public.booking_fee_remittance_payments (status, submitted_at)
  where status = 'pending';

create table if not exists public.booking_fee_remittance_events (
  id bigserial primary key,
  remittance_id uuid not null references public.booking_fee_remittances(id) on delete restrict,
  payment_id uuid references public.booking_fee_remittance_payments(id) on delete restrict,
  event_type text not null,
  actor_user_id uuid,
  actor_role text,
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint booking_fee_remittance_events_type_check
    check (event_type in (
      'prepared',
      'zero_balance_settled',
      'payment_submitted',
      'payment_accepted',
      'payment_partially_accepted',
      'payment_rejected',
      'settled',
      'cancelled_and_released'
    )),
  constraint booking_fee_remittance_events_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists idx_booking_fee_remittance_events_remittance
  on public.booking_fee_remittance_events (remittance_id, event_at, id);

comment on table public.booking_fee_remittances is
  'Permanent header for one exact-cutoff booking-fee remittance cycle.';
comment on table public.booking_fee_remittance_items is
  'Immutable booking-row fee snapshots frozen into a remittance. Release fields are used only by the owner cancellation RPC.';
comment on table public.booking_fee_remittance_payments is
  'Permanent proof submissions. Rejected attempts remain in history; a new proof creates another row.';
comment on table public.booking_fee_remittance_events is
  'Append-only audit events for every remittance state transition.';

-- --------------------------------------------------------------------------
-- 3. Immutability and state guards
-- --------------------------------------------------------------------------

create or replace function public.guard_unsettled_booking_fee_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.booking_fee_earned_at is null
     or coalesce(old.booking_fee_amount_snapshot, 0) <= 0 then
    return old;
  end if;

  -- A settled immutable line item survives deletion of its source booking.
  if exists (
    select 1
      from public.booking_fee_remittance_items i
      join public.booking_fee_remittances r on r.id = i.remittance_id
     where i.booking_ref = old.ref
       and i.released_at is null
       and r.status = 'settled'
  ) or exists (
    select 1
      from public.weekly_fees wf
     where wf.status = 'paid'
       and (
         wf.id = old.weekly_fee_id
         or coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(old.ref)
       )
  ) then
    return old;
  end if;

  raise exception 'This paid booking has an unsettled platform fee and cannot be deleted. Keep/cancel it until the fee remittance is settled.'
    using errcode = '22000';
end;
$$;

drop trigger if exists trg_05_guard_unsettled_booking_fee_delete on public.bookings;
create trigger trg_05_guard_unsettled_booking_fee_delete
before delete on public.bookings
for each row execute function public.guard_unsettled_booking_fee_delete();

create or replace function public.touch_booking_fee_remittance_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_booking_fee_remittance_updated_at
  on public.booking_fee_remittances;
create trigger trg_touch_booking_fee_remittance_updated_at
before update on public.booking_fee_remittances
for each row execute function public.touch_booking_fee_remittance_updated_at();

create or replace function public.guard_booking_fee_remittance_item_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.remittance_id is distinct from old.remittance_id
     or new.booking_ref is distinct from old.booking_ref
     or new.booking_group_ref is distinct from old.booking_group_ref
     or new.booking_created_at is distinct from old.booking_created_at
     or new.fee_earned_at is distinct from old.fee_earned_at
     or new.court_id is distinct from old.court_id
     or new.court_name is distinct from old.court_name
     or new.booking_date is distinct from old.booking_date
     or new.host_booking is distinct from old.host_booking
     or new.created_via is distinct from old.created_via
     or new.fee_amount is distinct from old.fee_amount
     or new.fee_rate is distinct from old.fee_rate
     or new.fee_type is distinct from old.fee_type
     or new.fee_units is distinct from old.fee_units
     or new.fee_snapshot_source is distinct from old.fee_snapshot_source
     or new.created_at is distinct from old.created_at then
    raise exception 'Remittance item snapshots are immutable.' using errcode = '22000';
  end if;

  if old.released_at is not null and (
    new.released_at is distinct from old.released_at
    or new.released_by_user_id is distinct from old.released_by_user_id
    or new.release_reason is distinct from old.release_reason
  ) then
    raise exception 'Released remittance items cannot be changed.' using errcode = '22000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_booking_fee_remittance_item_update
  on public.booking_fee_remittance_items;
create trigger trg_guard_booking_fee_remittance_item_update
before update on public.booking_fee_remittance_items
for each row execute function public.guard_booking_fee_remittance_item_update();

create or replace function public.guard_booking_fee_remittance_payment_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.remittance_id is distinct from old.remittance_id
     or new.amount_submitted is distinct from old.amount_submitted
     or new.payment_method is distinct from old.payment_method
     or new.payment_reference is distinct from old.payment_reference
     or new.normalized_reference is distinct from old.normalized_reference
     or new.proof_path is distinct from old.proof_path
     or new.note is distinct from old.note
     or new.submitted_at is distinct from old.submitted_at
     or new.submitted_by_user_id is distinct from old.submitted_by_user_id
     or new.submitted_by_email is distinct from old.submitted_by_email
     or new.submission_idempotency_key is distinct from old.submission_idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Submitted remittance payment evidence is immutable.'
      using errcode = '22000';
  end if;

  if old.status <> 'pending' and row(new.status, new.amount_accepted, new.reviewed_at,
      new.reviewed_by_user_id, new.review_note, new.review_idempotency_key)
     is distinct from
     row(old.status, old.amount_accepted, old.reviewed_at,
      old.reviewed_by_user_id, old.review_note, old.review_idempotency_key) then
    raise exception 'A reviewed remittance payment cannot be changed.'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_booking_fee_remittance_payment_update
  on public.booking_fee_remittance_payments;
create trigger trg_guard_booking_fee_remittance_payment_update
before update on public.booking_fee_remittance_payments
for each row execute function public.guard_booking_fee_remittance_payment_update();

create or replace function public.prevent_booking_fee_remittance_ledger_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Remittance ledger records are permanent and cannot be deleted.'
    using errcode = '22000';
end;
$$;

drop trigger if exists trg_no_delete_booking_fee_remittances
  on public.booking_fee_remittances;
create trigger trg_no_delete_booking_fee_remittances
before delete on public.booking_fee_remittances
for each row execute function public.prevent_booking_fee_remittance_ledger_delete();

drop trigger if exists trg_no_delete_booking_fee_remittance_items
  on public.booking_fee_remittance_items;
create trigger trg_no_delete_booking_fee_remittance_items
before delete on public.booking_fee_remittance_items
for each row execute function public.prevent_booking_fee_remittance_ledger_delete();

drop trigger if exists trg_no_delete_booking_fee_remittance_payments
  on public.booking_fee_remittance_payments;
create trigger trg_no_delete_booking_fee_remittance_payments
before delete on public.booking_fee_remittance_payments
for each row execute function public.prevent_booking_fee_remittance_ledger_delete();

drop trigger if exists trg_no_update_booking_fee_remittance_events
  on public.booking_fee_remittance_events;
create trigger trg_no_update_booking_fee_remittance_events
before update or delete on public.booking_fee_remittance_events
for each row execute function public.prevent_booking_fee_remittance_ledger_delete();

-- Trigger names are ordered deliberately: snapshot first, earned-at second.
drop trigger if exists trg_snapshot_booking_fee_on_insert on public.bookings;
drop trigger if exists trg_mark_booking_fee_earned on public.bookings;
drop trigger if exists trg_10_snapshot_booking_fee_on_insert on public.bookings;
create trigger trg_10_snapshot_booking_fee_on_insert
before insert on public.bookings
for each row execute function public.snapshot_booking_fee_on_insert();
drop trigger if exists trg_20_mark_booking_fee_earned on public.bookings;
create trigger trg_20_mark_booking_fee_earned
before insert or update on public.bookings
for each row execute function public.mark_booking_fee_earned();
drop trigger if exists trg_30_guard_legacy_booking_fee_stamps on public.bookings;
create trigger trg_30_guard_legacy_booking_fee_stamps
before update on public.bookings
for each row execute function public.guard_legacy_booking_fee_stamps();

-- --------------------------------------------------------------------------
-- 4. Internal query helpers
-- --------------------------------------------------------------------------

create or replace function public.booking_fee_unclaimed_rows()
returns table (
  booking_ref text,
  booking_group_ref text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz,
  court_id text,
  court_name text,
  booking_date date,
  host_booking boolean,
  created_via text,
  fee_amount numeric,
  fee_rate numeric,
  fee_type text,
  fee_units numeric,
  fee_snapshot_source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.ref,
    b.booking_group_ref,
    b.created_at,
    b.booking_fee_earned_at,
    b.court_id,
    b.court_name,
    b.date,
    coalesce(b.host_booking, false),
    b.created_via,
    b.booking_fee_amount_snapshot,
    b.booking_fee_rate_snapshot,
    b.booking_fee_type_snapshot,
    b.booking_fee_units_snapshot,
    b.booking_fee_snapshot_source
  from public.bookings b
  where b.booking_fee_earned_at is not null
    and b.booking_fee_amount_snapshot is not null
    and b.booking_fee_amount_snapshot > 0
    and b.booking_fee_rate_snapshot is not null
    and b.booking_fee_type_snapshot in ('flat', 'per_hour')
    and b.booking_fee_units_snapshot is not null
    and b.booking_fee_snapshot_source is not null
    and b.booking_fee_ledger_eligible_snapshot
    -- Legacy statements retain ownership of every booking they claimed.
    and b.weekly_fee_id is null
    and b.billed_at is null
    and not exists (
      select 1
        from public.weekly_fees wf
       where wf.status = 'paid'
         and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
    )
    -- Eligibility is snapshotted on insert/backfill so later edits to booking
    -- display fields cannot remove an earned fee from the ledger.
    and not exists (
      select 1
        from public.booking_fee_remittance_items i
       where i.booking_ref = b.ref
         and i.released_at is null
    )
  order by b.booking_fee_earned_at, b.created_at, b.ref
$$;

create or replace function public.booking_fee_next_due_on(p_at timestamptz default now())
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  local_date date := timezone('Asia/Manila', p_at)::date;
  last_due date;
  last_cutoff_at timestamptz;
  cutoff_local_date date;
  next_due_from_cycle date;
  next_due_after_cutoff date;
  first_unclaimed_date date;
  anchor_date date;
begin
  select r.cycle_due_on, r.cutoff_at
    into last_due, last_cutoff_at
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.status <> 'cancelled'
   order by r.cycle_due_on desc, r.cutoff_at desc, r.prepared_at desc
   limit 1;

  if last_due is not null then
    -- A late catch-up remittance must not make the next cycle immediately
    -- overdue. Start with the scheduled following cycle, then advance it to
    -- the first 14th strictly after the cutoff whenever that is later.
    cutoff_local_date := timezone('Asia/Manila', last_cutoff_at)::date;
    next_due_from_cycle := (last_due + interval '1 month')::date;
    next_due_after_cutoff := (
      date_trunc('month', cutoff_local_date::timestamp)
      + interval '1 month'
      + interval '13 days'
    )::date;
    return greatest(next_due_from_cycle, next_due_after_cutoff);
  end if;

  select timezone('Asia/Manila', min(u.fee_earned_at))::date
    into first_unclaimed_date
    from public.booking_fee_unclaimed_rows() u;

  -- A fresh cycle is due on the first 14th on or after its first earned fee.
  -- With no fees yet, expose the next upcoming 14th without creating debt.
  anchor_date := coalesce(first_unclaimed_date, local_date);
  if extract(day from anchor_date)::integer <= 14 then
    return make_date(
      extract(year from anchor_date)::integer,
      extract(month from anchor_date)::integer,
      14
    );
  end if;
  return (
    date_trunc('month', anchor_date::timestamp)
    + interval '1 month'
    + interval '13 days'
  )::date;
end;
$$;

create or replace function public.booking_fee_remittance_summary_json(
  p_remittance_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with item_rows as materialized (
    select
      i.booking_ref,
      case
        when nullif(btrim(i.booking_group_ref), '') is not null
          then 'group:' || btrim(i.booking_group_ref)
        else 'booking:' || i.booking_ref
      end as reservation_key,
      i.fee_type,
      i.fee_rate,
      i.fee_units,
      i.fee_amount
    from public.booking_fee_remittance_items i
    where i.remittance_id = p_remittance_id
  ),
  audit_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count
    from item_rows i
  ),
  rate_breakdown as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      ),
      '[]'::jsonb
    ) as rows
    from (
      select
        i.fee_type,
        i.fee_rate,
        count(*)::integer as item_count,
        count(distinct i.reservation_key)::integer as reservation_count,
        round(sum(i.fee_units), 2) as fee_units,
        coalesce(
          round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
          0::numeric
        ) as billable_hours,
        (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
        round(sum(i.fee_amount), 2) as amount,
        case i.fee_type when 'per_hour' then 1 else 2 end as sort_order
      from item_rows i
      group by i.fee_type, i.fee_rate
    ) x
  )
  select jsonb_build_object(
    'id', r.id,
    'remittance_ref', r.remittance_ref,
    'cycle_due_on', r.cycle_due_on,
    'coverage_start_at', r.coverage_start_at,
    'cutoff_at', r.cutoff_at,
    'status', r.status,
    'currency', r.currency,
    'bookings_count', r.bookings_count,
    'booking_rows_count', m.booking_rows_count,
    'reservation_count', m.reservation_count,
    'billable_hours', m.billable_hours,
    'court_hours', m.billable_hours,
    'flat_fee_booking_count', m.flat_fee_booking_count,
    'fee_breakdown', rb.rows,
    'rate_type_breakdown', rb.rows,
    'amount_due', r.amount_due,
    'amount_settled', r.amount_settled,
    'remaining_balance', case
      when r.status = 'cancelled' then 0::numeric
      else greatest(round(r.amount_due - r.amount_settled, 2), 0)
    end,
    'prepared_at', r.prepared_at,
    'prepared_by_user_id', r.prepared_by_user_id,
    'prepared_by_email', r.prepared_by_email,
    'prepared_by_role', r.prepared_by_role,
    'owner_override', r.owner_override,
    'owner_override_reason', r.owner_override_reason,
    'last_submitted_at', r.last_submitted_at,
    'settled_at', r.settled_at,
    'cancelled_at', r.cancelled_at,
    'cancellation_reason', r.cancellation_reason,
    'latest_payment', (
      select jsonb_build_object(
        'id', p.id,
        'amount_submitted', p.amount_submitted,
        'amount_accepted', p.amount_accepted,
        'payment_method', p.payment_method,
        'payment_reference', p.payment_reference,
        'proof_path', p.proof_path,
        'note', p.note,
        'status', p.status,
        'submitted_at', p.submitted_at,
        'submitted_by_user_id', p.submitted_by_user_id,
        'submitted_by_email', p.submitted_by_email,
        'reviewed_at', p.reviewed_at,
        'reviewed_by_user_id', p.reviewed_by_user_id,
        'review_note', p.review_note
      )
      from public.booking_fee_remittance_payments p
      where p.remittance_id = r.id
      order by p.submitted_at desc, p.id desc
      limit 1
    ),
    'is_overdue', (
      r.status not in ('settled', 'cancelled')
      and timezone('Asia/Manila', now())::date > r.cycle_due_on
    ),
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
  from public.booking_fee_remittances r
  cross join audit_metrics m
  cross join rate_breakdown rb
  where r.id = p_remittance_id
$$;

revoke all on function public.booking_fee_unclaimed_rows() from public, anon, authenticated;
revoke all on function public.booking_fee_next_due_on(timestamptz) from public, anon, authenticated;
revoke all on function public.booking_fee_remittance_summary_json(uuid) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- 5. Read RPCs for the modern dashboard/history/detail views
-- --------------------------------------------------------------------------

create or replace function public.get_booking_fee_remittance_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  server_now timestamptz := clock_timestamp();
  local_date date;
  next_due date;
  accumulated_count integer := 0;
  accumulated_reservation_count integer := 0;
  accumulated_billable_hours numeric := 0;
  accumulated_flat_fee_booking_count integer := 0;
  accumulated_rate_type_breakdown jsonb := '[]'::jsonb;
  accumulated_amount numeric := 0;
  accumulated_start timestamptz;
  open_rows jsonb := '[]'::jsonb;
  open_remaining numeric := 0;
  settled_total numeric := 0;
  last_settled jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  local_date := timezone('Asia/Manila', server_now)::date;
  next_due := public.booking_fee_next_due_on(server_now);

  with unclaimed as materialized (
    select
      u.*,
      case
        when nullif(btrim(u.booking_group_ref), '') is not null
          then 'group:' || btrim(u.booking_group_ref)
        else 'booking:' || u.booking_ref
      end as reservation_key
    from public.booking_fee_unclaimed_rows() u
  )
  select
    count(*)::integer,
    count(distinct u.reservation_key)::integer,
    coalesce(
      round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
      0::numeric
    ),
    (count(*) filter (where u.fee_type = 'flat'))::integer,
    coalesce(round(sum(u.fee_amount), 2), 0::numeric),
    min(u.fee_earned_at),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      )
      from (
        select
          b.fee_type,
          b.fee_rate,
          count(*)::integer as item_count,
          count(distinct b.reservation_key)::integer as reservation_count,
          round(sum(b.fee_units), 2) as fee_units,
          coalesce(
            round(sum(b.fee_units) filter (where b.fee_type = 'per_hour'), 2),
            0::numeric
          ) as billable_hours,
          (count(*) filter (where b.fee_type = 'flat'))::integer as flat_fee_booking_count,
          round(sum(b.fee_amount), 2) as amount,
          case b.fee_type when 'per_hour' then 1 else 2 end as sort_order
        from unclaimed b
        group by b.fee_type, b.fee_rate
      ) x
    ), '[]'::jsonb)
    into
      accumulated_count,
      accumulated_reservation_count,
      accumulated_billable_hours,
      accumulated_flat_fee_booking_count,
      accumulated_amount,
      accumulated_start,
      accumulated_rate_type_breakdown
    from unclaimed u;

  select
    coalesce(
      jsonb_agg(
        public.booking_fee_remittance_summary_json(r.id)
        order by r.cycle_due_on, r.prepared_at
      ),
      '[]'::jsonb
    ),
    coalesce(sum(greatest(r.amount_due - r.amount_settled, 0)), 0)
    into open_rows, open_remaining
    from public.booking_fee_remittances r
   where r.status not in ('settled', 'cancelled');

  select public.booking_fee_remittance_summary_json(r.id)
    into last_settled
    from public.booking_fee_remittances r
   where r.status = 'settled'
    order by r.settled_at desc nulls last, r.prepared_at desc
    limit 1;

  select coalesce(round(sum(r.amount_settled), 2), 0)
    into settled_total
    from public.booking_fee_remittances r
   where r.status = 'settled';

  return jsonb_build_object(
    'server_now', server_now,
    'timezone', 'Asia/Manila',
    'role', account_role,
    'next_due_on', next_due,
    'can_prepare', local_date >= next_due and accumulated_amount > 0,
    'can_owner_override', account_role = 'owner',
    'accumulated', jsonb_build_object(
      'bookings_count', accumulated_count,
      'booking_rows_count', accumulated_count,
      'reservation_count', accumulated_reservation_count,
      'billable_hours', accumulated_billable_hours,
      'court_hours', accumulated_billable_hours,
      'flat_fee_booking_count', accumulated_flat_fee_booking_count,
      'fee_breakdown', accumulated_rate_type_breakdown,
      'rate_type_breakdown', accumulated_rate_type_breakdown,
      'amount', accumulated_amount,
      'coverage_start_at', accumulated_start
    ),
    'open_remaining_balance', round(open_remaining, 2),
    'total_outstanding_balance', round(open_remaining + accumulated_amount, 2),
    'settled_total', settled_total,
    'open_remittances', open_rows,
    'last_settled', last_settled
  );
end;
$$;

create or replace function public.get_booking_fee_remittance_history(
  p_limit integer default 50,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  result jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(x.summary order by x.prepared_at desc, x.id desc),
    '[]'::jsonb
  )
  into result
  from (
    select
      r.id,
      r.prepared_at,
      public.booking_fee_remittance_summary_json(r.id) as summary
    from public.booking_fee_remittances r
    where p_before is null or r.prepared_at < p_before
    order by r.prepared_at desc, r.id desc
    limit safe_limit
  ) x;

  return result;
end;
$$;

create or replace function public.get_booking_fee_remittance_detail(
  p_remittance_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  header jsonb;
  items jsonb;
  payments jsonb;
  events jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  header := public.booking_fee_remittance_summary_json(p_remittance_id);
  if header is null then
    raise exception 'Remittance not found.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'booking_ref', i.booking_ref,
    'booking_group_ref', i.booking_group_ref,
    'booking_created_at', i.booking_created_at,
    'fee_earned_at', i.fee_earned_at,
    'court_id', i.court_id,
    'court_name', i.court_name,
    'booking_date', i.booking_date,
    'host_booking', i.host_booking,
    'created_via', i.created_via,
    'fee_amount', i.fee_amount,
    'fee_rate', i.fee_rate,
    'fee_type', i.fee_type,
    'fee_units', i.fee_units,
    'fee_snapshot_source', i.fee_snapshot_source,
    'released_at', i.released_at,
    'release_reason', i.release_reason
  ) order by i.fee_earned_at, i.booking_ref), '[]'::jsonb)
  into items
  from public.booking_fee_remittance_items i
  where i.remittance_id = $1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'amount_submitted', p.amount_submitted,
    'amount_accepted', p.amount_accepted,
    'payment_method', p.payment_method,
    'payment_reference', p.payment_reference,
    'proof_path', p.proof_path,
    'note', p.note,
    'status', p.status,
    'submitted_at', p.submitted_at,
    'submitted_by_user_id', p.submitted_by_user_id,
    'submitted_by_email', p.submitted_by_email,
    'reviewed_at', p.reviewed_at,
    'reviewed_by_user_id', p.reviewed_by_user_id,
    'review_note', p.review_note
  ) order by p.submitted_at, p.id), '[]'::jsonb)
  into payments
  from public.booking_fee_remittance_payments p
  where p.remittance_id = $1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'payment_id', e.payment_id,
    'event_type', e.event_type,
    'actor_user_id', e.actor_user_id,
    'actor_role', e.actor_role,
    'event_at', e.event_at,
    'metadata', e.metadata
  ) order by e.event_at, e.id), '[]'::jsonb)
  into events
  from public.booking_fee_remittance_events e
  where e.remittance_id = $1;

  return jsonb_build_object(
    'remittance', header,
    'items', items,
    'payments', payments,
    'events', events
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 6. Transactional mutation RPCs
-- --------------------------------------------------------------------------

create or replace function public.prepare_booking_fee_remittance(
  p_idempotency_key text,
  p_owner_override boolean default false,
  p_override_due_on date default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  account_email text;
  existing_id uuid;
  new_id uuid := gen_random_uuid();
  cutoff_time timestamptz;
  local_date date;
  current_month_due date;
  due_on date;
  item_count integer := 0;
  total_due numeric := 0;
  coverage_start timestamptz;
  generated_ref text;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can prepare a remittance.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;
  if coalesce(p_owner_override, false) and account_role <> 'owner' then
    raise exception 'Only the system owner may override the due schedule.'
      using errcode = '42501';
  end if;
  if coalesce(p_owner_override, false)
     and length(trim(coalesce(p_override_reason, ''))) < 3 then
    raise exception 'An owner override reason is required.' using errcode = '22023';
  end if;

  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.prepared_by_user_id = auth.uid()
     and r.prepare_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  -- No fee can transition to earned while this transaction holds the exclusive
  -- lock. The cutoff assigned immediately afterward is therefore exact.
  perform pg_advisory_xact_lock(
    hashtextextended('pickle-bliss-booking-fee-remittance', 0)
  );

  -- Recheck after waiting for a concurrent request with the same key.
  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.prepared_by_user_id = auth.uid()
     and r.prepare_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  cutoff_time := clock_timestamp();
  local_date := timezone('Asia/Manila', cutoff_time)::date;
  current_month_due := make_date(
    extract(year from local_date)::integer,
    extract(month from local_date)::integer,
    14
  );

  -- The venue has shared court-owner access. If another court owner just
  -- prepared this month's batch, return that same permanent record instead of
  -- surfacing a duplicate-cycle error.
  if not coalesce(p_owner_override, false) and local_date >= current_month_due then
    select r.id into existing_id
      from public.booking_fee_remittances r
     where r.scope_key = 'venue'
       and r.cycle_due_on = current_month_due
       and r.status <> 'cancelled'
     limit 1;
    if existing_id is not null then
      return public.get_booking_fee_remittance_detail(existing_id);
    end if;
  end if;

  due_on := case
    when coalesce(p_owner_override, false)
      then coalesce(p_override_due_on, public.booking_fee_next_due_on(cutoff_time))
    else public.booking_fee_next_due_on(cutoff_time)
  end;

  if not coalesce(p_owner_override, false) and local_date < due_on then
    raise exception 'The next remittance may be prepared on or after % (Asia/Manila).', due_on
      using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.booking_fee_unclaimed_rows() u
     where u.fee_earned_at <= cutoff_time
       and u.fee_amount > 0
  ) then
    raise exception 'There are no accumulated booking fees ready to remit.'
      using errcode = '22023';
  end if;

  -- A different idempotency key must not create another active batch for the
  -- same due cycle.
  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.cycle_due_on = due_on
     and r.status <> 'cancelled'
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  select a.email into account_email
    from public.accounts a
   where a.id = auth.uid()
   limit 1;

  generated_ref := 'REM-' || to_char(due_on, 'YYYYMMDD') || '-' ||
    upper(substr(replace(new_id::text, '-', ''), 1, 8));

  insert into public.booking_fee_remittances (
    id,
    remittance_ref,
    cycle_due_on,
    cutoff_at,
    status,
    prepared_at,
    prepared_by_user_id,
    prepared_by_email,
    prepared_by_role,
    prepare_idempotency_key,
    owner_override,
    owner_override_reason
  ) values (
    new_id,
    generated_ref,
    due_on,
    cutoff_time,
    'prepared',
    cutoff_time,
    auth.uid(),
    account_email,
    account_role,
    trim(p_idempotency_key),
    coalesce(p_owner_override, false),
    case when coalesce(p_owner_override, false) then trim(p_override_reason) end
  );

  insert into public.booking_fee_remittance_items (
    remittance_id,
    booking_ref,
    booking_group_ref,
    booking_created_at,
    fee_earned_at,
    court_id,
    court_name,
    booking_date,
    host_booking,
    created_via,
    fee_amount,
    fee_rate,
    fee_type,
    fee_units,
    fee_snapshot_source
  )
  select
    new_id,
    u.booking_ref,
    u.booking_group_ref,
    u.booking_created_at,
    u.fee_earned_at,
    u.court_id,
    u.court_name,
    u.booking_date,
    u.host_booking,
    u.created_via,
    round(u.fee_amount, 2),
    round(u.fee_rate, 2),
    u.fee_type,
    u.fee_units,
    u.fee_snapshot_source
  from public.booking_fee_unclaimed_rows() u
  where u.fee_earned_at <= cutoff_time
  order by u.fee_earned_at, u.booking_created_at, u.booking_ref
  on conflict (booking_ref) where released_at is null do nothing;

  select count(*)::integer,
         coalesce(round(sum(i.fee_amount), 2), 0),
         min(i.fee_earned_at)
    into item_count, total_due, coverage_start
    from public.booking_fee_remittance_items i
   where i.remittance_id = new_id
     and i.released_at is null;

  update public.booking_fee_remittances r
     set bookings_count = item_count,
         amount_due = total_due,
         coverage_start_at = coverage_start,
         status = case when total_due = 0 then 'settled' else 'prepared' end,
         settled_at = case when total_due = 0 then cutoff_time else null end
   where r.id = new_id;

  insert into public.booking_fee_remittance_events (
    remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    new_id,
    'prepared',
    auth.uid(),
    account_role,
    cutoff_time,
    jsonb_build_object(
      'cycle_due_on', due_on,
      'cutoff_at', cutoff_time,
      'bookings_count', item_count,
      'amount_due', total_due,
      'owner_override', coalesce(p_owner_override, false)
    )
  );

  if total_due = 0 then
    insert into public.booking_fee_remittance_events (
      remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
    ) values (
      new_id,
      'zero_balance_settled',
      auth.uid(),
      account_role,
      cutoff_time,
      jsonb_build_object('amount_due', 0)
    );
  end if;

  return public.get_booking_fee_remittance_detail(new_id);
end;
$$;

create or replace function public.submit_booking_fee_remittance(
  p_remittance_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_reference text,
  p_proof_path text,
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  account_role text;
  account_email text;
  existing_payment public.booking_fee_remittance_payments%rowtype;
  remittance public.booking_fee_remittances%rowtype;
  payment_id uuid := gen_random_uuid();
  submitted_at_time timestamptz := clock_timestamp();
  submitted_amount numeric;
  remaining_amount numeric;
  method_value text;
  reference_value text;
  normalized_value text;
  proof_value text;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can submit remittance proof.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  select p.* into existing_payment
    from public.booking_fee_remittance_payments p
   where p.submitted_by_user_id = auth.uid()
     and p.submission_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if found then
    if existing_payment.remittance_id <> p_remittance_id then
      raise exception 'This idempotency key was already used for another remittance.'
        using errcode = '22023';
    end if;
    return public.get_booking_fee_remittance_detail(existing_payment.remittance_id);
  end if;

  select r.* into remittance
    from public.booking_fee_remittances r
   where r.id = p_remittance_id
   for update;
  if not found then
    raise exception 'Remittance not found.' using errcode = 'P0002';
  end if;

  -- A concurrent retry may have committed while this request waited for the
  -- header lock. Recheck so the same key always returns the original result.
  select p.* into existing_payment
    from public.booking_fee_remittance_payments p
   where p.submitted_by_user_id = auth.uid()
     and p.submission_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if found then
    if existing_payment.remittance_id <> p_remittance_id then
      raise exception 'This idempotency key was already used for another remittance.'
        using errcode = '22023';
    end if;
    return public.get_booking_fee_remittance_detail(existing_payment.remittance_id);
  end if;
  if remittance.status in ('settled', 'cancelled') then
    raise exception 'This remittance no longer accepts payment proof.'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.booking_fee_remittance_payments p
     where p.remittance_id = remittance.id
       and p.status = 'pending'
  ) then
    raise exception 'A payment proof is already awaiting review.' using errcode = '22023';
  end if;

  remaining_amount := round(remittance.amount_due - remittance.amount_settled, 2);
  submitted_amount := round(coalesce(p_amount, remaining_amount), 2);
  if submitted_amount <= 0 or submitted_amount > remaining_amount then
    raise exception 'Submitted amount must be greater than zero and no more than the remaining balance of %.', remaining_amount
      using errcode = '22023';
  end if;

  method_value := lower(trim(coalesce(p_payment_method, '')));
  if method_value not in ('gcash', 'maya', 'bank_transfer', 'cash', 'other') then
    raise exception 'Unsupported remittance payment method.' using errcode = '22023';
  end if;
  reference_value := trim(coalesce(p_payment_reference, ''));
  normalized_value := upper(regexp_replace(reference_value, '[^A-Za-z0-9]', '', 'g'));
  if length(normalized_value) < 4 then
    raise exception 'A valid payment reference is required.' using errcode = '22023';
  end if;

  proof_value := trim(coalesce(p_proof_path, ''));
  if proof_value !~ ('^' || remittance.id::text || '/' || auth.uid()::text || '/[^/]+$') then
    raise exception 'Proof path must belong to this remittance and submitting account.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'remittance-proofs'
       and o.name = proof_value
  ) then
    raise exception 'Uploaded remittance proof was not found.' using errcode = 'P0002';
  end if;

  select a.email into account_email
    from public.accounts a
   where a.id = auth.uid()
   limit 1;

  insert into public.booking_fee_remittance_payments (
    id,
    remittance_id,
    amount_submitted,
    payment_method,
    payment_reference,
    normalized_reference,
    proof_path,
    note,
    status,
    submitted_at,
    submitted_by_user_id,
    submitted_by_email,
    submission_idempotency_key
  ) values (
    payment_id,
    remittance.id,
    submitted_amount,
    method_value,
    reference_value,
    normalized_value,
    proof_value,
    nullif(trim(coalesce(p_note, '')), ''),
    'pending',
    submitted_at_time,
    auth.uid(),
    account_email,
    trim(p_idempotency_key)
  );

  update public.booking_fee_remittances r
     set status = 'submitted',
         last_submitted_at = submitted_at_time
   where r.id = remittance.id;

  insert into public.booking_fee_remittance_events (
    remittance_id, payment_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    remittance.id,
    payment_id,
    'payment_submitted',
    auth.uid(),
    account_role,
    submitted_at_time,
    jsonb_build_object(
      'amount_submitted', submitted_amount,
      'payment_method', method_value,
      'payment_reference', reference_value
    )
  );

  return public.get_booking_fee_remittance_detail(remittance.id);
exception
  when unique_violation then
    raise exception 'This payment reference, receipt proof, or submission key was already used.'
      using errcode = '23505';
end;
$$;

create or replace function public.review_booking_fee_remittance_payment(
  p_payment_id uuid,
  p_decision text,
  p_amount_accepted numeric default null,
  p_review_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  existing_review public.booking_fee_remittance_payments%rowtype;
  payment public.booking_fee_remittance_payments%rowtype;
  remittance public.booking_fee_remittances%rowtype;
  decision_value text;
  accepted_amount numeric;
  new_settled numeric;
  review_time timestamptz := clock_timestamp();
  payment_status text;
  remittance_status text;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role <> 'owner' then
    raise exception 'Only the active system owner may review remittance payments.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  select p.* into existing_review
    from public.booking_fee_remittance_payments p
   where p.reviewed_by_user_id = auth.uid()
     and p.review_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if found then
    if existing_review.id <> p_payment_id then
      raise exception 'This idempotency key was already used for another review.'
        using errcode = '22023';
    end if;
    return public.get_booking_fee_remittance_detail(existing_review.remittance_id);
  end if;

  select p.* into payment
    from public.booking_fee_remittance_payments p
   where p.id = p_payment_id
   for update;
  if not found then
    raise exception 'Remittance payment not found.' using errcode = 'P0002';
  end if;
  if payment.status <> 'pending' then
    if payment.review_idempotency_key = trim(p_idempotency_key) then
      return public.get_booking_fee_remittance_detail(payment.remittance_id);
    end if;
    raise exception 'This payment proof has already been reviewed.' using errcode = '22023';
  end if;

  select r.* into remittance
    from public.booking_fee_remittances r
   where r.id = payment.remittance_id
   for update;
  if not found then
    raise exception 'Remittance not found.' using errcode = 'P0002';
  end if;
  if remittance.status in ('settled', 'cancelled') then
    raise exception 'This remittance cannot be reviewed in its current state.'
      using errcode = '22023';
  end if;

  decision_value := lower(trim(coalesce(p_decision, '')));
  if decision_value not in ('accept', 'reject') then
    raise exception 'Decision must be accept or reject.' using errcode = '22023';
  end if;
  if decision_value = 'reject'
     and length(trim(coalesce(p_review_note, ''))) < 3 then
    raise exception 'A rejection reason is required.' using errcode = '22023';
  end if;

  if decision_value = 'reject' then
    update public.booking_fee_remittance_payments p
       set status = 'rejected',
           amount_accepted = 0,
           reviewed_at = review_time,
           reviewed_by_user_id = auth.uid(),
           review_note = nullif(trim(coalesce(p_review_note, '')), ''),
           review_idempotency_key = trim(p_idempotency_key)
     where p.id = payment.id;

    remittance_status := case
      when remittance.amount_settled > 0 then 'partially_settled'
      else 'payment_rejected'
    end;
    update public.booking_fee_remittances r
       set status = remittance_status
     where r.id = remittance.id;

    insert into public.booking_fee_remittance_events (
      remittance_id, payment_id, event_type, actor_user_id, actor_role, event_at, metadata
    ) values (
      remittance.id,
      payment.id,
      'payment_rejected',
      auth.uid(),
      account_role,
      review_time,
      jsonb_build_object(
        'amount_submitted', payment.amount_submitted,
        'review_note', nullif(trim(coalesce(p_review_note, '')), '')
      )
    );

    return public.get_booking_fee_remittance_detail(remittance.id);
  end if;

  accepted_amount := round(coalesce(p_amount_accepted, payment.amount_submitted), 2);
  if accepted_amount <= 0 or accepted_amount > payment.amount_submitted then
    raise exception 'Accepted amount must be greater than zero and no more than the submitted amount.'
      using errcode = '22023';
  end if;
  if accepted_amount > round(remittance.amount_due - remittance.amount_settled, 2) then
    raise exception 'Accepted amount exceeds the remittance remaining balance.'
      using errcode = '22023';
  end if;

  payment_status := case
    when accepted_amount = payment.amount_submitted then 'accepted'
    else 'partially_accepted'
  end;
  new_settled := round(remittance.amount_settled + accepted_amount, 2);
  if new_settled = remittance.amount_due then
    remittance_status := 'settled';
  else
    remittance_status := 'partially_settled';
  end if;

  update public.booking_fee_remittance_payments p
     set status = payment_status,
         amount_accepted = accepted_amount,
         reviewed_at = review_time,
         reviewed_by_user_id = auth.uid(),
         review_note = nullif(trim(coalesce(p_review_note, '')), ''),
         review_idempotency_key = trim(p_idempotency_key)
   where p.id = payment.id;

  update public.booking_fee_remittances r
     set amount_settled = new_settled,
         status = remittance_status,
         settled_at = case when remittance_status = 'settled' then review_time else null end
   where r.id = remittance.id;

  insert into public.booking_fee_remittance_events (
    remittance_id, payment_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    remittance.id,
    payment.id,
    case when payment_status = 'accepted'
      then 'payment_accepted'
      else 'payment_partially_accepted'
    end,
    auth.uid(),
    account_role,
    review_time,
    jsonb_build_object(
      'amount_submitted', payment.amount_submitted,
      'amount_accepted', accepted_amount,
      'amount_settled_total', new_settled,
      'remaining_balance', greatest(remittance.amount_due - new_settled, 0)
    )
  );

  if remittance_status = 'settled' then
    insert into public.booking_fee_remittance_events (
      remittance_id, payment_id, event_type, actor_user_id, actor_role, event_at, metadata
    ) values (
      remittance.id,
      payment.id,
      'settled',
      auth.uid(),
      account_role,
      review_time,
      jsonb_build_object(
        'amount_due', remittance.amount_due,
        'amount_settled', new_settled
      )
    );
  end if;

  return public.get_booking_fee_remittance_detail(remittance.id);
end;
$$;

create or replace function public.cancel_booking_fee_remittance(
  p_remittance_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  remittance public.booking_fee_remittances%rowtype;
  cancel_time timestamptz := clock_timestamp();
  released_count integer := 0;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only an active system owner or the preparing court owner may cancel a remittance.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A cancellation reason is required.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  -- Serialize release/replacement with preparation of a new exact-cutoff batch.
  perform pg_advisory_xact_lock(
    hashtextextended('pickle-bliss-booking-fee-remittance', 0)
  );

  select r.* into remittance
    from public.booking_fee_remittances r
   where r.id = p_remittance_id
   for update;
  if not found then
    raise exception 'Remittance not found.' using errcode = 'P0002';
  end if;
  if account_role = 'court_owner'
     and remittance.prepared_by_user_id is distinct from auth.uid() then
    raise exception 'A court owner may cancel only a remittance they prepared.'
      using errcode = '42501';
  end if;
  if remittance.status = 'cancelled' then
    if remittance.cancel_idempotency_key = trim(p_idempotency_key) then
      return public.get_booking_fee_remittance_detail(remittance.id);
    end if;
    raise exception 'This remittance is already cancelled.' using errcode = '22023';
  end if;
  if remittance.status not in ('prepared', 'payment_rejected')
     or remittance.amount_settled <> 0 then
    raise exception 'Only an unpaid prepared/rejected remittance may be cancelled.'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.booking_fee_remittance_payments p
     where p.remittance_id = remittance.id
       and p.status in ('pending', 'accepted', 'partially_accepted')
  ) then
    raise exception 'Pending or accepted payments prevent cancellation.'
      using errcode = '22023';
  end if;

  update public.booking_fee_remittance_items i
     set released_at = cancel_time,
         released_by_user_id = auth.uid(),
         release_reason = trim(p_reason)
   where i.remittance_id = remittance.id
     and i.released_at is null;
  get diagnostics released_count = row_count;

  update public.booking_fee_remittances r
     set status = 'cancelled',
         cancelled_at = cancel_time,
         cancelled_by_user_id = auth.uid(),
         cancellation_reason = trim(p_reason),
         cancel_idempotency_key = trim(p_idempotency_key)
   where r.id = remittance.id;

  insert into public.booking_fee_remittance_events (
    remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    remittance.id,
    'cancelled_and_released',
    auth.uid(),
    account_role,
    cancel_time,
    jsonb_build_object(
      'reason', trim(p_reason),
      'released_items', released_count,
      'released_amount', remittance.amount_due
    )
  );

  return public.get_booking_fee_remittance_detail(remittance.id);
end;
$$;

-- --------------------------------------------------------------------------
-- 7. Private proof storage
-- --------------------------------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'remittance-proofs',
  'remittance-proofs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The existing storage catch-all policies are permissive and PostgreSQL ORs
-- permissive policies together. Exclude this financial-evidence bucket before
-- adding its strict policies below, otherwise the catch-all would make proof
-- objects readable and mutable by unrelated anonymous/authenticated clients.
drop policy if exists receipts_no_select on storage.objects;
create policy receipts_no_select
  on storage.objects
  for select to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids', 'remittance-proofs'));

drop policy if exists receipts_no_insert on storage.objects;
create policy receipts_no_insert
  on storage.objects
  for insert to anon, authenticated
  with check (bucket_id not in ('receipts', 'host-ids', 'remittance-proofs'));

drop policy if exists receipts_no_update on storage.objects;
create policy receipts_no_update
  on storage.objects
  for update to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids', 'remittance-proofs'));

drop policy if exists receipts_no_delete on storage.objects;
create policy receipts_no_delete
  on storage.objects
  for delete to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids', 'remittance-proofs'));

drop policy if exists booking_fee_remittance_proofs_select
  on storage.objects;
create policy booking_fee_remittance_proofs_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'remittance-proofs'
    and public.has_account_role(array['owner', 'court_owner'])
  );

drop policy if exists booking_fee_remittance_proofs_insert
  on storage.objects;
create policy booking_fee_remittance_proofs_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'remittance-proofs'
    and public.has_account_role(array['owner', 'court_owner'])
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1
        from public.booking_fee_remittances r
       where r.id::text = (storage.foldername(name))[1]
         and r.status not in ('settled', 'cancelled')
    )
  );

drop policy if exists booking_fee_remittance_proofs_delete_unattached
  on storage.objects;

-- Proof objects have no UPDATE/DELETE path. A failed submission can leave a
-- small private orphan, which is safer than permitting a race that could
-- remove evidence immediately before its immutable ledger row is committed.

-- --------------------------------------------------------------------------
-- 8. Strict RLS and grants
-- --------------------------------------------------------------------------

alter table public.booking_fee_remittances enable row level security;
alter table public.booking_fee_remittance_items enable row level security;
alter table public.booking_fee_remittance_payments enable row level security;
alter table public.booking_fee_remittance_events enable row level security;

-- The old monthly statement table is retained for paid-history lookup only.
-- All financial mutations now go through the exact-cutoff ledger RPCs.
alter table public.weekly_fees enable row level security;
drop policy if exists weekly_fees_select_auth on public.weekly_fees;
drop policy if exists weekly_fees_select_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
drop policy if exists weekly_fees_insert_owner on public.weekly_fees;
drop policy if exists weekly_fees_update_auth on public.weekly_fees;
drop policy if exists weekly_fees_update_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
drop policy if exists weekly_fees_delete_owner on public.weekly_fees;
drop policy if exists weekly_fees_select_legacy_remittance_roles on public.weekly_fees;
create policy weekly_fees_select_legacy_remittance_roles
  on public.weekly_fees
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on table public.weekly_fees from public, anon, authenticated;
grant select on table public.weekly_fees to authenticated;

drop policy if exists booking_fee_remittances_select_roles
  on public.booking_fee_remittances;
create policy booking_fee_remittances_select_roles
  on public.booking_fee_remittances
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists booking_fee_remittance_items_select_roles
  on public.booking_fee_remittance_items;
create policy booking_fee_remittance_items_select_roles
  on public.booking_fee_remittance_items
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists booking_fee_remittance_payments_select_roles
  on public.booking_fee_remittance_payments;
create policy booking_fee_remittance_payments_select_roles
  on public.booking_fee_remittance_payments
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists booking_fee_remittance_events_select_roles
  on public.booking_fee_remittance_events;
create policy booking_fee_remittance_events_select_roles
  on public.booking_fee_remittance_events
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

-- There are intentionally no INSERT/UPDATE/DELETE policies. All mutations go
-- through the SECURITY DEFINER RPCs above, which derive actors from auth.uid().
revoke all on table public.booking_fee_remittances from public, anon, authenticated;
revoke all on table public.booking_fee_remittance_items from public, anon, authenticated;
revoke all on table public.booking_fee_remittance_payments from public, anon, authenticated;
revoke all on table public.booking_fee_remittance_events from public, anon, authenticated;

grant select on table public.booking_fee_remittances to authenticated;
grant select on table public.booking_fee_remittance_items to authenticated;
grant select on table public.booking_fee_remittance_payments to authenticated;
grant select on table public.booking_fee_remittance_events to authenticated;

revoke all on function public.snapshot_booking_fee_on_insert()
  from public, anon, authenticated;
revoke all on function public.guard_booking_fee_snapshot_update()
  from public, anon, authenticated;
revoke all on function public.mark_booking_fee_earned()
  from public, anon, authenticated;
revoke all on function public.guard_legacy_booking_fee_stamps()
  from public, anon, authenticated;
revoke all on function public.guard_unsettled_booking_fee_delete()
  from public, anon, authenticated;
revoke all on function public.touch_booking_fee_remittance_updated_at()
  from public, anon, authenticated;
revoke all on function public.guard_booking_fee_remittance_item_update()
  from public, anon, authenticated;
revoke all on function public.guard_booking_fee_remittance_payment_update()
  from public, anon, authenticated;
revoke all on function public.prevent_booking_fee_remittance_ledger_delete()
  from public, anon, authenticated;

revoke all on function public.get_booking_fee_remittance_dashboard()
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_dashboard()
  to authenticated;

revoke all on function public.get_booking_fee_remittance_history(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_history(integer, timestamptz)
  to authenticated;

revoke all on function public.get_booking_fee_remittance_detail(uuid)
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_detail(uuid)
  to authenticated;

revoke all on function public.prepare_booking_fee_remittance(text, boolean, date, text)
  from public, anon, authenticated;
grant execute on function public.prepare_booking_fee_remittance(text, boolean, date, text)
  to authenticated;

revoke all on function public.submit_booking_fee_remittance(uuid, numeric, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_booking_fee_remittance(uuid, numeric, text, text, text, text, text)
  to authenticated;

revoke all on function public.review_booking_fee_remittance_payment(uuid, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.review_booking_fee_remittance_payment(uuid, text, numeric, text, text)
  to authenticated;

revoke all on function public.cancel_booking_fee_remittance(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.cancel_booking_fee_remittance(uuid, text, text)
  to authenticated;

comment on function public.prepare_booking_fee_remittance(text, boolean, date, text) is
  'Atomically freezes every unclaimed fee earned through an exact server cutoff. Court owners may call only when the next 14th cycle is due; owners may record a reasoned override.';
comment on function public.submit_booking_fee_remittance(uuid, numeric, text, text, text, text, text) is
  'Creates immutable payment proof for all or part of a remittance. Proof must already exist in the private remittance-proofs bucket.';
comment on function public.review_booking_fee_remittance_payment(uuid, text, numeric, text, text) is
  'System-owner-only review. Accepted value reduces the frozen balance; rejected proof remains permanently auditable.';
comment on function public.cancel_booking_fee_remittance(uuid, text, text) is
  'Recovery for an unpaid prepared/rejected batch. System owners may cancel any eligible batch; a court owner may cancel only the batch they prepared. Items are released without deleting history.';

notify pgrst, 'reload schema';

commit;
