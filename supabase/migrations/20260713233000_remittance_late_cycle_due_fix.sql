-- ============================================================
-- REMITTANCE LATE-CYCLE DUE-DATE HARDENING
-- Date: 2026-07-13
--
-- If a court owner catches up after missing an entire 14th cycle, the next
-- booking fee must wait for the next upcoming 14th after the actual cutoff.
-- It must not become immediately overdue under an already-past cycle date.
-- ============================================================

begin;

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
    -- Preserve the scheduled monthly cycle for an on-time remittance. For a
    -- late catch-up, advance to the first 14th strictly after the real cutoff.
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

revoke all on function public.booking_fee_next_due_on(timestamptz)
  from public, anon, authenticated;

comment on function public.booking_fee_next_due_on(timestamptz) is
  'Returns the next venue remittance due date. A late catch-up advances to the first 14th strictly after its exact cutoff.';

notify pgrst, 'reload schema';

commit;
