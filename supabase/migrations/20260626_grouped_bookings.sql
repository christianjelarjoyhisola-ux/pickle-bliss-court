-- Grouped public bookings let one customer reserve multiple courts in one
-- checkout/receipt flow while preserving one row per court for availability.

alter table if exists public.bookings
  add column if not exists booking_group_ref text;

create index if not exists idx_bookings_booking_group_ref
  on public.bookings (booking_group_ref);

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
