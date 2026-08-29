-- ============================================================
-- PICKLE BLISS COURT - COMPLETE SUPABASE DATABASE SETUP
-- Use this on a fresh Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- This file is a consolidated baseline of the migration history.
-- Do not run it as a replacement for migrations on an existing
-- production database unless you have reviewed the seed/upsert data.
--
-- REQUIRED FRESH-INSTALL FOLLOW-UP:
-- After this baseline succeeds, run these migrations in order:
--   1. 20260713213000_accumulated_booking_fee_remittances.sql
--   2. 20260713233000_remittance_late_cycle_due_fix.sql
--   3. 20260713234500_remittance_audit_metrics.sql
--   4. 20260730213000_owner_selectable_remittance_due_date.sql
--   5. 20260813173000_staged_booking_receipts.sql
-- They install the exact-cutoff ledger, private proof storage, security
-- policies, due-cycle correction, reconciled metrics, owner-selectable
-- audited due dates, and RPCs.
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. BASE TABLES
-- ============================================================

create table if not exists public.courts (
  id text primary key,
  name text not null,
  description text,
  rate numeric not null default 300,
  blocked boolean not null default false,
  feats text[] default '{}',
  photo text,
  rate_schedule jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  ref text primary key,
  booking_group_ref text,
  full_name text not null,
  contact_number text,
  email text,
  court_id text not null,
  court_name text,
  date date not null,
  slots text[] not null default '{}',
  start_time text,
  end_time text,
  duration numeric,
  rate numeric,
  total numeric,
  payment_method text,
  received_account text,
  payment_flow text,
  payment_status text not null default 'unpaid',
  payment_provider text,
  payment_session_id text,
  payment_checkout_url text,
  paid_at timestamptz,
  gcash_ref text,
  downpayment numeric,
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  hold_token_hash text,
  billed_at timestamptz,
  weekly_fee_id uuid,
  confirmation_email_id text,
  confirmation_email_sent_at timestamptz,
  confirmation_email_last_event text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint bookings_payment_status_check
    check (payment_status in (
      'unpaid',
      'pending',
      'for_verification',
      'downpayment_paid',
      'paid',
      'failed',
      'rejected'
    )),
  constraint bookings_status_check
    check (status in ('pending','verifying','confirmed','cancelled','completed')),
  constraint bookings_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint bookings_hold_token_hash_check
    check (hold_token_hash is null or hold_token_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table if not exists public.receipt_staged_uploads (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  booking_group_ref text,
  hold_token_hash text not null check (hold_token_hash ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  content_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),
  image_hash text not null check (image_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('gcash','bdopay','maya','bpi','gotyme','pnb')),
  status text not null default 'staged' check (status in ('staged','consumed','abandoned')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  storage_deleted_at timestamptz,
  constraint receipt_staged_uploads_expiry_check check (expires_at > created_at)
);

create index if not exists idx_receipt_staged_uploads_hold
  on public.receipt_staged_uploads (booking_ref, status, created_at desc);
create index if not exists idx_receipt_staged_uploads_cleanup
  on public.receipt_staged_uploads (expires_at) where status = 'staged';

create table if not exists public.accounts (
  id uuid primary key,
  username text unique not null,
  full_name text,
  email text unique,
  role text not null default 'staff',
  created_at timestamptz not null default now(),
  constraint accounts_role_check
    check (role in ('owner','court_owner','staff','host'))
);

create table if not exists public.blocked_dates (
  date date primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.open_play_registrations (
  id bigserial primary key,
  full_name text not null,
  court_id text,
  court_name text,
  date date not null,
  hour integer,
  time_label text,
  payment_type text,
  amount numeric,
  payment_method text default 'cash',
  gcash_ref text,
  payment_status text default 'pending',
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint open_play_payment_status_check
    check (payment_status in ('pending','paid','rejected')),
  constraint open_play_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected'))
);

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

create table if not exists public.used_gcash_refs (
  gcash_ref text primary key,
  booking_ref text not null,
  provider text,
  used_at timestamptz not null default now()
);

create table if not exists public.receipt_verifications (
  id bigserial primary key,
  booking_ref text not null,
  result text not null,
  flags text[] not null default '{}',
  extracted jsonb,
  confidence numeric,
  image_hash text,
  phash text,
  storage_path text,
  raw_ocr_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.agreements (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email text not null,
  full_name text not null,
  role text not null,
  version integer not null default 1,
  signature_data text not null,
  ip_address text,
  user_agent text,
  agreed_at timestamptz not null default now()
);

create table if not exists public.weekly_fees (
  id uuid primary key default gen_random_uuid(),
  court_owner_user_id text not null,
  court_owner_email text,
  week_start date not null,
  week_end date not null,
  bookings_count integer not null default 0,
  fee_per_booking numeric not null default 15,
  amount_due numeric not null default 0,
  status text not null default 'draft',
  billed_refs jsonb not null default '[]'::jsonb,
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
  constraint weekly_fees_status_check
    check (status in ('draft','sent','submitted','paid','overdue')),
  constraint weekly_fees_bookings_count_check check (bookings_count >= 0),
  constraint weekly_fees_amount_due_check check (amount_due >= 0),
  constraint weekly_fees_week_range_check check (week_end >= week_start)
);

create table if not exists public.open_play_game_sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time_label text,
  court_ids text[] not null default '{}',
  court_names text[] not null default '{}',
  mode text not null default 'smart_random_mixer',
  status text not null default 'draft',
  current_round integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_game_sessions_status_check
    check (status in ('draft','active','paused','completed','cancelled'))
);

create table if not exists public.open_play_game_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_game_sessions(id) on delete cascade,
  full_name text not null,
  source_registration_id bigint,
  status text not null default 'active',
  seed_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint open_play_game_players_status_check
    check (status in ('active','no_show','removed'))
);

create table if not exists public.open_play_game_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_game_sessions(id) on delete cascade,
  round_no integer not null,
  assignments jsonb not null default '[]'::jsonb,
  queue_snapshot jsonb not null default '[]'::jsonb,
  partner_history jsonb not null default '{}'::jsonb,
  opponent_history jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

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
    check (status in ('pending','approved','rejected'))
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
    check (status in ('draft','published','cancelled')),
  constraint open_play_host_sessions_time_check
    check (start_hour >= 0 and start_hour <= 23 and end_hour > start_hour and end_hour <= 24),
  constraint open_play_host_sessions_capacity_check check (max_players > 0),
  constraint open_play_host_sessions_fee_check check (fee_per_player >= 0)
);

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
    check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','pnb','cash')),
  constraint open_play_host_session_registrations_payment_status_check
    check (payment_status in ('pending','paid','rejected')),
  constraint open_play_host_session_registrations_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint open_play_host_session_registrations_amount_check check (amount >= 0)
);

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

-- Repair/upgrade tables when this script is rerun after an older partial setup.
alter table public.bookings
  add column if not exists booking_group_ref text,
  add column if not exists received_account text,
  add column if not exists receipt_image_url text,
  add column if not exists receipt_image_hash text,
  add column if not exists receipt_phash text,
  add column if not exists receipt_status text not null default 'none',
  add column if not exists receipt_flags text[] not null default '{}',
  add column if not exists receipt_extracted jsonb,
  add column if not exists receipt_confidence numeric,
  add column if not exists receipt_verified_at timestamptz,
  add column if not exists hold_token_hash text,
  add column if not exists billed_at timestamptz,
  add column if not exists weekly_fee_id uuid,
  add column if not exists confirmation_email_id text,
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_last_event text;

alter table public.bookings
  alter column payment_status set default 'unpaid',
  alter column status set default 'pending',
  alter column receipt_status set default 'none',
  alter column receipt_flags set default '{}';

update public.bookings
set receipt_status = coalesce(receipt_status, 'none'),
    receipt_flags = coalesce(receipt_flags, '{}')
where receipt_status is null
   or receipt_flags is null;

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in (
    'unpaid',
    'pending',
    'for_verification',
    'downpayment_paid',
    'paid',
    'failed',
    'rejected'
  ));

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending','verifying','confirmed','cancelled','completed'));

alter table public.bookings drop constraint if exists bookings_receipt_status_check;
alter table public.bookings
  add constraint bookings_receipt_status_check
  check (receipt_status in ('none','auto_approved','manual_review','rejected'));

alter table public.bookings drop constraint if exists bookings_hold_token_hash_check;
alter table public.bookings
  add constraint bookings_hold_token_hash_check
  check (hold_token_hash is null or hold_token_hash ~ '^[0-9a-f]{64}$');

create or replace function public.guard_booking_hold_token_hash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.hold_token_hash is distinct from old.hold_token_hash then
    raise exception 'Booking hold capability is immutable.' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts
  add constraint accounts_role_check
  check (role in ('owner','court_owner','staff','host'));

alter table public.open_play_registrations
  add column if not exists payment_method text default 'cash',
  add column if not exists gcash_ref text,
  add column if not exists payment_status text default 'pending',
  add column if not exists receipt_image_url text,
  add column if not exists receipt_image_hash text,
  add column if not exists receipt_phash text,
  add column if not exists receipt_status text not null default 'none',
  add column if not exists receipt_flags text[] not null default '{}',
  add column if not exists receipt_extracted jsonb,
  add column if not exists receipt_confidence numeric,
  add column if not exists receipt_verified_at timestamptz;

update public.open_play_registrations
set payment_status = coalesce(payment_status, 'pending'),
    receipt_status = coalesce(receipt_status, 'none'),
    receipt_flags = coalesce(receipt_flags, '{}')
where payment_status is null
   or receipt_status is null
   or receipt_flags is null;

alter table public.open_play_registrations drop constraint if exists open_play_payment_status_check;
alter table public.open_play_registrations
  add constraint open_play_payment_status_check
  check (payment_status in ('pending','paid','rejected'));

alter table public.open_play_registrations drop constraint if exists open_play_receipt_status_check;
alter table public.open_play_registrations
  add constraint open_play_receipt_status_check
  check (receipt_status in ('none','auto_approved','manual_review','rejected'));

alter table public.weekly_fees
  add column if not exists billed_refs jsonb not null default '[]'::jsonb,
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_ref text,
  add column if not exists submitted_note text,
  add column if not exists submitted_proof_url text;

alter table public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','pnb','cash'));

-- ============================================================
-- 2. INDEXES
-- ============================================================

create index if not exists idx_bookings_court_date on public.bookings (court_id, date);
create index if not exists idx_bookings_status on public.bookings (status);
create index if not exists idx_bookings_booking_group_ref on public.bookings (booking_group_ref);
create index if not exists idx_bookings_billed_at on public.bookings (billed_at);
create index if not exists idx_bookings_weekly_fee_id on public.bookings (weekly_fee_id);
create index if not exists idx_bookings_received_account on public.bookings (received_account);
create index if not exists idx_bookings_receipt_phash
  on public.bookings (receipt_phash)
  where receipt_phash is not null and receipt_phash <> '';
create index if not exists idx_bookings_confirmation_email_id
  on public.bookings (confirmation_email_id)
  where confirmation_email_id is not null;

create index if not exists idx_payment_sessions_booking_ref on public.payment_sessions (booking_ref);
create index if not exists idx_payment_sessions_status on public.payment_sessions (status);
create index if not exists idx_payment_sessions_provider_reference on public.payment_sessions (provider_reference);

create index if not exists idx_used_gcash_refs_booking_ref on public.used_gcash_refs (booking_ref);
create index if not exists idx_receipt_verifications_booking_ref on public.receipt_verifications (booking_ref);
create index if not exists idx_receipt_verifications_created_at on public.receipt_verifications (created_at);
create index if not exists idx_receipt_verifications_storage_path
  on public.receipt_verifications (storage_path, created_at desc)
  where storage_path is not null and storage_path <> '';
create unique index if not exists agreements_user_version_uq on public.agreements (user_id, version);

create unique index if not exists weekly_fees_owner_week_uq
  on public.weekly_fees (court_owner_user_id, week_start, week_end);
create index if not exists idx_weekly_fees_status on public.weekly_fees (status);
create index if not exists idx_weekly_fees_week_start on public.weekly_fees (week_start desc);

create index if not exists idx_open_play_receipt_status on public.open_play_registrations (receipt_status);
create index if not exists idx_open_play_receipt_verified_at on public.open_play_registrations (receipt_verified_at);

create index if not exists idx_op_game_sessions_date on public.open_play_game_sessions (date);
create index if not exists idx_op_game_players_session
  on public.open_play_game_players (session_id, seed_order);
create unique index if not exists idx_op_game_players_source
  on public.open_play_game_players (session_id, source_registration_id)
  where source_registration_id is not null;
create index if not exists idx_op_game_rounds_session
  on public.open_play_game_rounds (session_id, round_no);

create index if not exists idx_open_play_host_applications_status
  on public.open_play_host_applications (status, created_at desc);
create index if not exists idx_open_play_host_sessions_date
  on public.open_play_host_sessions (date, start_hour);
create index if not exists idx_open_play_host_session_registrations_session
  on public.open_play_host_session_registrations (session_id, created_at desc);
create index if not exists idx_open_play_host_session_registrations_payment
  on public.open_play_host_session_registrations (payment_status, receipt_status);

create index if not exists idx_deleted_booking_archive_ref on public.deleted_booking_archive (booking_ref);
create index if not exists idx_deleted_booking_archive_deleted_at on public.deleted_booking_archive (deleted_at desc);
create index if not exists idx_deleted_booking_archive_status on public.deleted_booking_archive (recovery_status);
create unique index if not exists uniq_deleted_booking_archive_screenshot_ref
  on public.deleted_booking_archive (booking_ref, source)
  where source = 'screenshot_recovery';

-- ============================================================
-- 3. FUNCTIONS AND TRIGGERS
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.current_account_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.role
  from public.accounts a
  where a.id = auth.uid()
  limit 1
$$;

create or replace function public.has_account_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_account_role() = any(allowed_roles), false)
$$;

create or replace function public.can_write_setting(setting_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_account_role() = 'owner' then true
    when public.current_account_role() = 'court_owner' then
      coalesce(setting_key, '') not in (
        'booking_fee',
        'service_fee_rate',
        'maintenance_fee',
        'fee_type',
        'platform_gcash_number',
        'platform_gcash_name',
        'platform_gcash_qr'
      )
    else false
  end
$$;

create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and new.court_id is not distinct from old.court_id
     and new.date is not distinct from old.date
     and new.status is not distinct from old.status
     and new.ref is not distinct from old.ref
     and new.slots is not distinct from old.slots then
    return new;
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  if exists (
    select 1
    from public.bookings b
    where b.court_id = new.court_id
      and b.date = new.date
      and b.status != 'cancelled'
      and b.ref != new.ref
      and b.slots && new.slots
      and (
        b.status != 'verifying'
        or b.created_at is null
        or b.created_at > (now() - interval '15 minutes')
      )
  ) then
    raise exception 'One or more time slots are already booked for this court and date.';
  end if;

  return new;
end;
$$;

create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'anon' then
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
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url
      or new.paid_at is distinct from old.paid_at
      or new.billed_at is distinct from old.billed_at
      or new.weekly_fee_id is distinct from old.weekly_fee_id then
      raise exception 'Reservation details cannot be changed after a hold is created.';
    end if;

    if new.downpayment is not null then
      if old.total is null
        or (
          abs(new.downpayment - old.total) > 0.01
          and abs(new.downpayment - (old.total / 2)) > 0.01
        ) then
        raise exception 'Reservation payment amount is invalid.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_weekly_fee_court_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_account_role() = 'court_owner' then
    if new.court_owner_user_id is distinct from old.court_owner_user_id
      or new.court_owner_email is distinct from old.court_owner_email
      or new.week_start is distinct from old.week_start
      or new.week_end is distinct from old.week_end
      or new.bookings_count is distinct from old.bookings_count
      or new.fee_per_booking is distinct from old.fee_per_booking
      or new.amount_due is distinct from old.amount_due
      or new.generated_at is distinct from old.generated_at
      or new.sent_at is distinct from old.sent_at
      or new.due_at is distinct from old.due_at
      or new.paid_at is distinct from old.paid_at
      or new.paid_ref is distinct from old.paid_ref
      or new.paid_note is distinct from old.paid_note
      or new.paid_by_user_id is distinct from old.paid_by_user_id then
      raise exception 'Court owners may only submit payment proof fields.';
    end if;
  end if;
  return new;
end;
$$;

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

create or replace function public.restore_deleted_booking_archive(p_archive_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  archive_rec public.deleted_booking_archive%rowtype;
  restored public.bookings%rowtype;
  target_ref text;
begin
  if not public.has_account_role(array['owner']) then
    raise exception 'Only the system owner can restore deleted bookings.'
      using errcode = '42501';
  end if;

  select *
    into archive_rec
    from public.deleted_booking_archive
   where id = p_archive_id
   for update;

  if not found then
    raise exception 'Deleted booking archive row not found.';
  end if;

  if archive_rec.original_booking is null then
    raise exception 'Archive row has no original booking payload.';
  end if;

  target_ref := coalesce(archive_rec.original_booking->>'ref', archive_rec.booking_ref);
  if exists (select 1 from public.bookings where ref = target_ref) then
    raise exception 'Booking % already exists in active bookings.', target_ref;
  end if;

  restored := jsonb_populate_record(null::public.bookings, archive_rec.original_booking);

  insert into public.bookings
  select (restored).*
  returning * into restored;

  update public.deleted_booking_archive
     set recovery_status = 'restored',
         recovered_booking = to_jsonb(restored),
         recovered_from = coalesce(recovered_from, 'archive_restore'),
         restored_at = now(),
         restored_by = auth.uid(),
         notes = concat_ws(E'\n', notes, 'Restored from deleted booking archive.')
   where id = p_archive_id;

  return restored;
end;
$$;

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

grant execute on function public.current_account_role() to anon, authenticated;
grant execute on function public.has_account_role(text[]) to anon, authenticated;
grant execute on function public.can_write_setting(text) to authenticated;
grant execute on function public.restore_deleted_booking_archive(uuid) to authenticated;
grant execute on function public.count_open_play_host_session_registrations(uuid) to anon, authenticated;

drop trigger if exists trg_payment_sessions_touch_updated_at on public.payment_sessions;
create trigger trg_payment_sessions_touch_updated_at
before update on public.payment_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists check_booking_conflict on public.bookings;
create trigger check_booking_conflict
before insert or update on public.bookings
for each row execute function public.prevent_double_booking();

drop trigger if exists trg_guard_public_booking_hold_update on public.bookings;
create trigger trg_guard_public_booking_hold_update
before update on public.bookings
for each row execute function public.guard_public_booking_hold_update();

drop trigger if exists trg_guard_booking_hold_token_hash on public.bookings;
create trigger trg_guard_booking_hold_token_hash
before update on public.bookings
for each row execute function public.guard_booking_hold_token_hash();

drop trigger if exists trg_archive_deleted_booking on public.bookings;
create trigger trg_archive_deleted_booking
before delete on public.bookings
for each row execute function public.archive_deleted_booking();

drop trigger if exists trg_weekly_fees_touch_updated_at on public.weekly_fees;
create trigger trg_weekly_fees_touch_updated_at
before update on public.weekly_fees
for each row execute function public.touch_updated_at();

drop trigger if exists trg_guard_weekly_fee_court_owner_update on public.weekly_fees;
create trigger trg_guard_weekly_fee_court_owner_update
before update on public.weekly_fees
for each row execute function public.guard_weekly_fee_court_owner_update();

drop trigger if exists trg_op_game_sessions_touch_updated_at on public.open_play_game_sessions;
create trigger trg_op_game_sessions_touch_updated_at
before update on public.open_play_game_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_applications_touch_updated_at on public.open_play_host_applications;
create trigger trg_open_play_host_applications_touch_updated_at
before update on public.open_play_host_applications
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_sessions_touch_updated_at on public.open_play_host_sessions;
create trigger trg_open_play_host_sessions_touch_updated_at
before update on public.open_play_host_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_session_registrations_touch_updated_at
  on public.open_play_host_session_registrations;
create trigger trg_open_play_host_session_registrations_touch_updated_at
before update on public.open_play_host_session_registrations
for each row execute function public.touch_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY AND POLICIES
-- ============================================================

alter table public.bookings enable row level security;
alter table public.courts enable row level security;
alter table public.settings enable row level security;
alter table public.accounts enable row level security;
alter table public.blocked_dates enable row level security;
alter table public.open_play_registrations enable row level security;
alter table public.payment_sessions enable row level security;
alter table public.used_gcash_refs enable row level security;
alter table public.receipt_verifications enable row level security;
alter table public.receipt_staged_uploads enable row level security;
alter table public.agreements enable row level security;
alter table public.weekly_fees enable row level security;
alter table public.open_play_game_sessions enable row level security;
alter table public.open_play_game_players enable row level security;
alter table public.open_play_game_rounds enable row level security;
alter table public.open_play_host_applications enable row level security;
alter table public.open_play_host_sessions enable row level security;
alter table public.open_play_host_session_registrations enable row level security;
alter table public.deleted_booking_archive enable row level security;

drop policy if exists bookings_select_public on public.bookings;
create policy bookings_select_public on public.bookings
  for select using (true);

drop policy if exists bookings_insert_public on public.bookings;
create policy bookings_insert_public on public.bookings
  for insert with check (true);

drop policy if exists bookings_insert_requires_capability on public.bookings;
create policy bookings_insert_requires_capability
  on public.bookings as restrictive
  for insert to anon
  with check (
    status = 'verifying'
    and hold_token_hash ~ '^[0-9a-f]{64}$'
    and created_at > now() - interval '1 minute'
    and created_at <= now() + interval '5 minutes'
  );

drop policy if exists bookings_update_admin on public.bookings;
drop policy if exists bookings_update_dashboard_roles on public.bookings;
create policy bookings_update_dashboard_roles on public.bookings
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists bookings_update_public_hold on public.bookings;
create policy bookings_update_public_hold on public.bookings
  for update to anon
  using (status = 'verifying' and created_at > now() - interval '15 minutes')
  with check (status in ('verifying','pending','cancelled') and created_at > now() - interval '15 minutes');

drop policy if exists bookings_delete_admin on public.bookings;
drop policy if exists bookings_delete_owner on public.bookings;
create policy bookings_delete_owner on public.bookings
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists courts_select_public on public.courts;
create policy courts_select_public on public.courts
  for select using (true);

drop policy if exists courts_insert_admin on public.courts;
drop policy if exists courts_insert_operators on public.courts;
create policy courts_insert_operators on public.courts
  for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_update_admin on public.courts;
drop policy if exists courts_update_operators on public.courts;
create policy courts_update_operators on public.courts
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_delete_admin on public.courts;
drop policy if exists courts_delete_operators on public.courts;
create policy courts_delete_operators on public.courts
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists settings_select_public on public.settings;
create policy settings_select_public on public.settings
  for select using (true);

drop policy if exists settings_insert_admin on public.settings;
drop policy if exists settings_insert_operators on public.settings;
create policy settings_insert_operators on public.settings
  for insert to authenticated
  with check (public.can_write_setting(key));

drop policy if exists settings_update_admin on public.settings;
drop policy if exists settings_update_operators on public.settings;
create policy settings_update_operators on public.settings
  for update to authenticated
  using (public.can_write_setting(key))
  with check (public.can_write_setting(key));

drop policy if exists settings_delete_admin on public.settings;
drop policy if exists settings_delete_operators on public.settings;
create policy settings_delete_operators on public.settings
  for delete to authenticated
  using (public.can_write_setting(key));

drop policy if exists accounts_select_admin on public.accounts;
drop policy if exists accounts_select_self_or_owner on public.accounts;
create policy accounts_select_self_or_owner on public.accounts
  for select to authenticated
  using (id = auth.uid() or public.has_account_role(array['owner']));

drop policy if exists accounts_insert_admin on public.accounts;
drop policy if exists accounts_insert_owner on public.accounts;
create policy accounts_insert_owner on public.accounts
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_update_admin on public.accounts;
drop policy if exists accounts_update_owner on public.accounts;
create policy accounts_update_owner on public.accounts
  for update to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_delete_admin on public.accounts;
drop policy if exists accounts_delete_owner on public.accounts;
create policy accounts_delete_owner on public.accounts
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists blocked_dates_select_public on public.blocked_dates;
create policy blocked_dates_select_public on public.blocked_dates
  for select using (true);

drop policy if exists blocked_dates_insert_admin on public.blocked_dates;
drop policy if exists blocked_dates_insert_operators on public.blocked_dates;
create policy blocked_dates_insert_operators on public.blocked_dates
  for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists blocked_dates_delete_admin on public.blocked_dates;
drop policy if exists blocked_dates_delete_operators on public.blocked_dates;
create policy blocked_dates_delete_operators on public.blocked_dates
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists open_play_select_public on public.open_play_registrations;
create policy open_play_select_public on public.open_play_registrations
  for select using (true);

drop policy if exists open_play_insert_public on public.open_play_registrations;
create policy open_play_insert_public on public.open_play_registrations
  for insert with check (true);

drop policy if exists open_play_update_dashboard_roles on public.open_play_registrations;
create policy open_play_update_dashboard_roles on public.open_play_registrations
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists open_play_delete_admin on public.open_play_registrations;
drop policy if exists open_play_delete_dashboard_roles on public.open_play_registrations;
create policy open_play_delete_dashboard_roles on public.open_play_registrations
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists payment_sessions_no_direct on public.payment_sessions;
drop policy if exists payment_sessions_no_direct_access on public.payment_sessions;
drop policy if exists payment_sessions_select_none on public.payment_sessions;
create policy payment_sessions_select_none on public.payment_sessions
  for select to authenticated using (false);

drop policy if exists payment_sessions_insert_none on public.payment_sessions;
create policy payment_sessions_insert_none on public.payment_sessions
  for insert to authenticated with check (false);

drop policy if exists payment_sessions_update_none on public.payment_sessions;
create policy payment_sessions_update_none on public.payment_sessions
  for update to authenticated using (false) with check (false);

drop policy if exists used_gcash_refs_no_select on public.used_gcash_refs;
create policy used_gcash_refs_no_select on public.used_gcash_refs
  for select to authenticated using (false);

drop policy if exists used_gcash_refs_no_write on public.used_gcash_refs;
create policy used_gcash_refs_no_write on public.used_gcash_refs
  for all to authenticated using (false) with check (false);

drop policy if exists receipt_verifications_select_admin on public.receipt_verifications;
create policy receipt_verifications_select_admin on public.receipt_verifications
  for select to authenticated using (true);

drop policy if exists receipt_verifications_no_write on public.receipt_verifications;
create policy receipt_verifications_no_write on public.receipt_verifications
  for all to authenticated using (false) with check (false);

revoke all on table public.receipt_staged_uploads from anon, authenticated;

drop policy if exists agreements_select_self_or_owner on public.agreements;
drop policy if exists users_read_own_agreement on public.agreements;
create policy agreements_select_self_or_owner on public.agreements
  for select to authenticated
  using (user_id = auth.uid()::text or public.has_account_role(array['owner']));

drop policy if exists agreements_insert_self on public.agreements;
create policy agreements_insert_self on public.agreements
  for insert to authenticated
  with check (user_id = auth.uid()::text);

drop policy if exists agreements_update_self on public.agreements;
create policy agreements_update_self on public.agreements
  for update to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists weekly_fees_select_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_select_auth on public.weekly_fees;
create policy weekly_fees_select_role_scoped on public.weekly_fees
  for select to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists weekly_fees_insert_owner on public.weekly_fees;
drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
create policy weekly_fees_insert_owner on public.weekly_fees
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists weekly_fees_update_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_update_auth on public.weekly_fees;
create policy weekly_fees_update_role_scoped on public.weekly_fees
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (
    public.has_account_role(array['owner'])
    or (
      public.has_account_role(array['court_owner'])
      and status = 'submitted'
    )
  );

drop policy if exists weekly_fees_delete_owner on public.weekly_fees;
drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
create policy weekly_fees_delete_owner on public.weekly_fees
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists op_game_sessions_admin_all on public.open_play_game_sessions;
drop policy if exists op_game_sessions_dashboard_all on public.open_play_game_sessions;
create policy op_game_sessions_dashboard_all on public.open_play_game_sessions
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_players_dashboard_all on public.open_play_game_players;
create policy op_game_players_dashboard_all on public.open_play_game_players
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;
drop policy if exists op_game_rounds_dashboard_all on public.open_play_game_rounds;
create policy op_game_rounds_dashboard_all on public.open_play_game_rounds
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists open_play_host_applications_insert_public on public.open_play_host_applications;
create policy open_play_host_applications_insert_public on public.open_play_host_applications
  for insert with check (status = 'pending');

drop policy if exists open_play_host_applications_owner_all on public.open_play_host_applications;
create policy open_play_host_applications_owner_all on public.open_play_host_applications
  for all to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

drop policy if exists open_play_host_sessions_select_public on public.open_play_host_sessions;
create policy open_play_host_sessions_select_public on public.open_play_host_sessions
  for select
  using (status = 'published' or public.has_account_role(array['owner','court_owner','host']));

drop policy if exists open_play_host_sessions_insert_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_insert_host_roles on public.open_play_host_sessions
  for insert to authenticated
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  );

drop policy if exists open_play_host_sessions_update_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_update_host_roles on public.open_play_host_sessions
  for update to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  )
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  );

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
  for select to authenticated
  using (
    public.has_account_role(array['owner','court_owner','staff'])
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
  for update to authenticated
  using (
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  )
  with check (
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

drop policy if exists deleted_booking_archive_select_dashboard_roles on public.deleted_booking_archive;
create policy deleted_booking_archive_select_dashboard_roles on public.deleted_booking_archive
  for select to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists deleted_booking_archive_insert_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_insert_owner on public.deleted_booking_archive
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists deleted_booking_archive_update_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_update_owner on public.deleted_booking_archive
  for update to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

-- ============================================================
-- 5. STORAGE FOR PRIVATE RECEIPTS
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_no_select on storage.objects;
create policy receipts_no_select on storage.objects
  for select to anon, authenticated using (bucket_id <> 'receipts');

drop policy if exists receipts_no_insert on storage.objects;
create policy receipts_no_insert on storage.objects
  for insert to anon, authenticated with check (bucket_id <> 'receipts');

drop policy if exists receipts_no_update on storage.objects;
create policy receipts_no_update on storage.objects
  for update to anon, authenticated using (bucket_id <> 'receipts');

drop policy if exists receipts_no_delete on storage.objects;
create policy receipts_no_delete on storage.objects
  for delete to anon, authenticated using (bucket_id <> 'receipts');

-- ============================================================
-- 6. SEED DATA
-- ============================================================

insert into public.courts (id, name, description, rate, blocked, feats)
values
  ('c1', 'Main Court', 'Indoor - Standard Flooring', 150, false, array['Indoor','Standard Floor'])
on conflict (id) do update
  set name = excluded.name,
      description = excluded.description,
      rate = excluded.rate,
      blocked = excluded.blocked,
      feats = excluded.feats;

insert into public.settings (key, value)
values
  ('venue_name', 'Pickle Bliss Court'),
  ('venue_address', 'Bliss, Poblacion, Monkayo'),
  ('open_time', '6'),
  ('close_time', '22'),
  ('booking_fee', '5'),
  ('open_play_fee', '100'),
  ('payment_method_maya', '1'),
  ('maya_merchant_number', ''),
  ('maya_merchant_name', 'Pickle Bliss Court'),
  ('maya_qr_image', ''),
  ('payment_method_bpi', '1')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- ============================================================
-- DONE
--
-- Next steps:
-- 1. Run the follow-up migrations listed at the top in order, including the
--    staged-booking-receipt migration before deploying the updated Edge Function.
-- 2. Authentication -> Providers -> Email -> disable Confirm email.
-- 3. Project Settings -> API -> copy Project URL and anon public key.
-- 4. Update .env.local / supabase-config.js for the cloned app.
-- 5. Run create-accounts.js with a service-role key to create dashboard users.
-- 6. Deploy edge functions and configure their required secrets.
-- ============================================================
