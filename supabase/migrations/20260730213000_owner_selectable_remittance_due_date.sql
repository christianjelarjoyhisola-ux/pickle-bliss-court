-- ============================================================
-- OWNER-SELECTABLE BOOKING-FEE REMITTANCE DUE DATE
-- Date: 2026-07-30
--
-- The System Owner chooses the venue's next exact remittance date.
-- Changes are validated and permanently audited. After a balance is
-- frozen, the next date rolls forward one calendar month and remains
-- editable by the System Owner.
-- ============================================================

begin;

-- Preserve the currently calculated cycle when this feature is installed.
insert into public.settings (key, value, updated_at)
values (
  'booking_fee_remittance_due_on',
  public.booking_fee_next_due_on(clock_timestamp())::text,
  clock_timestamp()
)
on conflict (key) do nothing;

create table if not exists public.booking_fee_remittance_due_date_events (
  id bigint generated always as identity primary key,
  previous_due_on date,
  new_due_on date not null,
  change_source text not null,
  actor_user_id uuid,
  actor_role text,
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint booking_fee_due_date_event_source_check
    check (change_source in ('owner_selected', 'cycle_advanced'))
);

create index if not exists booking_fee_due_date_events_changed_idx
  on public.booking_fee_remittance_due_date_events (changed_at desc, id desc);

alter table public.booking_fee_remittance_due_date_events enable row level security;

drop policy if exists booking_fee_due_date_events_select_owner
  on public.booking_fee_remittance_due_date_events;
create policy booking_fee_due_date_events_select_owner
  on public.booking_fee_remittance_due_date_events
  for select
  to authenticated
  using (public.current_account_role() = 'owner');

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
        'platform_gcash_qr',
        'booking_fee_remittance_due_on'
      )
    else false
  end
$$;

create or replace function public.booking_fee_monthly_due_after(p_due_on date)
returns date
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      (date_trunc('month', p_due_on::timestamp) + interval '1 month')::date
        as next_month_start,
      (date_trunc('month', p_due_on::timestamp) + interval '2 months - 1 day')::date
        as next_month_end,
      extract(day from p_due_on)::integer as desired_day
  )
  select least(
    next_month_start + (desired_day - 1),
    next_month_end
  )
  from bounds
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
  configured_due date;
  last_due date;
  last_cutoff_at timestamptz;
  cutoff_local_date date;
  next_due_from_cycle date;
  next_due_after_cutoff date;
  first_unclaimed_date date;
  anchor_date date;
begin
  select case
           when s.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then s.value::date
           else null
         end
    into configured_due
    from public.settings s
   where s.key = 'booking_fee_remittance_due_on'
   limit 1;

  if configured_due is not null then
    return configured_due;
  end if;

  -- Compatibility fallback for databases where the setting was removed.
  select r.cycle_due_on, r.cutoff_at
    into last_due, last_cutoff_at
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.status <> 'cancelled'
   order by r.cycle_due_on desc, r.cutoff_at desc, r.prepared_at desc
   limit 1;

  if last_due is not null then
    cutoff_local_date := timezone('Asia/Manila', last_cutoff_at)::date;
    next_due_from_cycle := public.booking_fee_monthly_due_after(last_due);
    next_due_after_cutoff := public.booking_fee_monthly_due_after(cutoff_local_date);
    return greatest(next_due_from_cycle, next_due_after_cutoff);
  end if;

  select timezone('Asia/Manila', min(u.fee_earned_at))::date
    into first_unclaimed_date
    from public.booking_fee_unclaimed_rows() u;

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

create or replace function public.set_booking_fee_remittance_due_on(
  p_due_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  local_date date := timezone('Asia/Manila', clock_timestamp())::date;
  previous_due date;
  latest_cycle_due date;
  changed_time timestamptz := clock_timestamp();
begin
  account_role := public.current_account_role();
  if account_role <> 'owner' then
    raise exception 'Only the System Owner can choose the remittance due date.'
      using errcode = '42501';
  end if;
  if p_due_on is null then
    raise exception 'Choose a valid remittance due date.'
      using errcode = '22023';
  end if;
  if p_due_on < local_date then
    raise exception 'The remittance due date cannot be earlier than % (Asia/Manila).', local_date
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pickle-bliss-booking-fee-remittance', 0)
  );

  select max(r.cycle_due_on)
    into latest_cycle_due
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.status <> 'cancelled';

  if latest_cycle_due is not null and p_due_on <= latest_cycle_due then
    raise exception 'Choose a due date after the latest remittance cycle (%).', latest_cycle_due
      using errcode = '22023';
  end if;

  select case
           when s.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then s.value::date
           else null
         end
    into previous_due
    from public.settings s
   where s.key = 'booking_fee_remittance_due_on'
   limit 1;

  insert into public.settings (key, value, updated_at)
  values ('booking_fee_remittance_due_on', p_due_on::text, changed_time)
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  if previous_due is distinct from p_due_on then
    insert into public.booking_fee_remittance_due_date_events (
      previous_due_on,
      new_due_on,
      change_source,
      actor_user_id,
      actor_role,
      changed_at,
      metadata
    ) values (
      previous_due,
      p_due_on,
      'owner_selected',
      auth.uid(),
      account_role,
      changed_time,
      jsonb_build_object('timezone', 'Asia/Manila')
    );
  end if;

  return jsonb_build_object(
    'previous_due_on', previous_due,
    'next_due_on', p_due_on,
    'server_now', changed_time,
    'timezone', 'Asia/Manila'
  );
end;
$$;

create or replace function public.advance_booking_fee_remittance_due_on()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  configured_due date;
  advanced_due date;
begin
  select case
           when s.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then s.value::date
           else null
         end
    into configured_due
    from public.settings s
   where s.key = 'booking_fee_remittance_due_on'
   limit 1;

  if configured_due is null or configured_due > new.cycle_due_on then
    return new;
  end if;

  advanced_due := public.booking_fee_monthly_due_after(new.cycle_due_on);

  insert into public.settings (key, value, updated_at)
  values ('booking_fee_remittance_due_on', advanced_due::text, new.prepared_at)
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  insert into public.booking_fee_remittance_due_date_events (
    previous_due_on,
    new_due_on,
    change_source,
    actor_user_id,
    actor_role,
    changed_at,
    metadata
  ) values (
    configured_due,
    advanced_due,
    'cycle_advanced',
    new.prepared_by_user_id,
    new.prepared_by_role,
    new.prepared_at,
    jsonb_build_object(
      'remittance_id', new.id,
      'remittance_ref', new.remittance_ref,
      'cycle_due_on', new.cycle_due_on
    )
  );

  return new;
end;
$$;

drop trigger if exists booking_fee_remittance_advance_due_date
  on public.booking_fee_remittances;
create trigger booking_fee_remittance_advance_due_date
after insert on public.booking_fee_remittances
for each row
execute function public.advance_booking_fee_remittance_due_on();

revoke all on function public.set_booking_fee_remittance_due_on(date)
  from public, anon, authenticated;
grant execute on function public.set_booking_fee_remittance_due_on(date)
  to authenticated;

revoke all on function public.booking_fee_next_due_on(timestamptz)
  from public, anon, authenticated;
revoke all on function public.booking_fee_monthly_due_after(date)
  from public, anon, authenticated;
revoke all on function public.advance_booking_fee_remittance_due_on()
  from public, anon, authenticated;

comment on table public.booking_fee_remittance_due_date_events is
  'Append-only audit of owner-selected and automatically advanced remittance due dates.';
comment on function public.set_booking_fee_remittance_due_on(date) is
  'System-owner-only selection of the venue next remittance due date, validated in Asia/Manila and permanently audited.';
comment on function public.booking_fee_next_due_on(timestamptz) is
  'Returns the System Owner-selected venue remittance due date, with a compatibility fallback when no setting exists.';

notify pgrst, 'reload schema';

commit;
