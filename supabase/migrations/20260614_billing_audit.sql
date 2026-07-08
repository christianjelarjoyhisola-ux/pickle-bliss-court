-- ============================================================
-- 20260614_billing_audit.sql
-- Billing audit trail + double-billing protection
--   * bookings.billed_at / bookings.weekly_fee_id  -> a booking is
--     billed exactly once, and we know on which statement.
--   * weekly_fees.billed_refs (jsonb)              -> immutable snapshot
--     of the exact booking refs included on each statement (itemised invoice).
-- The platform fee is a FIXED ₱15.00 per confirmed booking and never changes,
-- so it is a constant in the app rather than an editable setting.
-- ============================================================

-- --- bookings: per-booking billing stamps -------------------
alter table public.bookings add column if not exists billed_at      timestamptz;
alter table public.bookings add column if not exists weekly_fee_id  uuid;

-- Fast lookup of un-billed bookings when generating a statement.
create index if not exists idx_bookings_billed_at
  on public.bookings (billed_at);
create index if not exists idx_bookings_weekly_fee_id
  on public.bookings (weekly_fee_id);

-- --- weekly_fees: itemised snapshot of billed bookings -------
alter table public.weekly_fees add column if not exists billed_refs jsonb not null default '[]'::jsonb;

-- Reload PostgREST schema cache so supabase-js .from() sees the new columns.
notify pgrst, 'reload schema';
