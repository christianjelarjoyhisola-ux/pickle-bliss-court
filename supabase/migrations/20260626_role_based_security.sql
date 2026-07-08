-- Enforce server-side roles for dashboard writes.
-- Browser visibility checks are convenience only; these policies are the source of truth.

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

grant execute on function public.current_account_role() to anon, authenticated;
grant execute on function public.has_account_role(text[]) to anon, authenticated;
grant execute on function public.can_write_setting(text) to authenticated;

-- BOOKINGS
alter table if exists public.bookings enable row level security;

drop policy if exists bookings_select_public on public.bookings;
drop policy if exists "bookings_select_public" on public.bookings;
create policy bookings_select_public
  on public.bookings
  for select
  using (true);

drop policy if exists bookings_insert_public on public.bookings;
drop policy if exists "bookings_insert_public" on public.bookings;
create policy bookings_insert_public
  on public.bookings
  for insert
  with check (true);

drop policy if exists bookings_update_admin on public.bookings;
drop policy if exists "bookings_update_admin" on public.bookings;
drop policy if exists bookings_update_dashboard_roles on public.bookings;
create policy bookings_update_dashboard_roles
  on public.bookings
  for update
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists bookings_update_public_hold on public.bookings;
create policy bookings_update_public_hold
  on public.bookings
  for update
  to anon
  using (
    status = 'verifying'
    and created_at > now() - interval '15 minutes'
  )
  with check (
    status in ('verifying','pending','cancelled')
    and created_at > now() - interval '15 minutes'
  );

drop policy if exists bookings_delete_admin on public.bookings;
drop policy if exists "bookings_delete_admin" on public.bookings;
drop policy if exists bookings_delete_owner on public.bookings;
create policy bookings_delete_owner
  on public.bookings
  for delete
  to authenticated
  using (public.has_account_role(array['owner']));

create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'anon' then
    if new.ref is distinct from old.ref
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

drop trigger if exists trg_guard_public_booking_hold_update on public.bookings;
create trigger trg_guard_public_booking_hold_update
before update on public.bookings
for each row execute function public.guard_public_booking_hold_update();

-- COURTS
alter table if exists public.courts enable row level security;

drop policy if exists courts_select_public on public.courts;
drop policy if exists "courts_select_public" on public.courts;
create policy courts_select_public
  on public.courts
  for select
  using (true);

drop policy if exists courts_insert_admin on public.courts;
drop policy if exists "courts_insert_admin" on public.courts;
drop policy if exists courts_insert_operators on public.courts;
create policy courts_insert_operators
  on public.courts
  for insert
  to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_update_admin on public.courts;
drop policy if exists "courts_update_admin" on public.courts;
drop policy if exists courts_update_operators on public.courts;
create policy courts_update_operators
  on public.courts
  for update
  to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_delete_admin on public.courts;
drop policy if exists "courts_delete_admin" on public.courts;
drop policy if exists courts_delete_operators on public.courts;
create policy courts_delete_operators
  on public.courts
  for delete
  to authenticated
  using (public.has_account_role(array['owner','court_owner']));

-- SETTINGS
alter table if exists public.settings enable row level security;

drop policy if exists settings_select_public on public.settings;
drop policy if exists "settings_select_public" on public.settings;
create policy settings_select_public
  on public.settings
  for select
  using (true);

drop policy if exists settings_insert_admin on public.settings;
drop policy if exists "settings_insert_admin" on public.settings;
drop policy if exists settings_insert_operators on public.settings;
create policy settings_insert_operators
  on public.settings
  for insert
  to authenticated
  with check (public.can_write_setting(key));

drop policy if exists settings_update_admin on public.settings;
drop policy if exists "settings_update_admin" on public.settings;
drop policy if exists settings_update_operators on public.settings;
create policy settings_update_operators
  on public.settings
  for update
  to authenticated
  using (public.can_write_setting(key))
  with check (public.can_write_setting(key));

drop policy if exists settings_delete_admin on public.settings;
drop policy if exists "settings_delete_admin" on public.settings;
drop policy if exists settings_delete_operators on public.settings;
create policy settings_delete_operators
  on public.settings
  for delete
  to authenticated
  using (public.can_write_setting(key));

-- ACCOUNTS
alter table if exists public.accounts enable row level security;

drop policy if exists accounts_select_admin on public.accounts;
drop policy if exists "accounts_select_admin" on public.accounts;
drop policy if exists accounts_select_self_or_owner on public.accounts;
create policy accounts_select_self_or_owner
  on public.accounts
  for select
  to authenticated
  using (id = auth.uid() or public.has_account_role(array['owner']));

drop policy if exists accounts_insert_admin on public.accounts;
drop policy if exists "accounts_insert_admin" on public.accounts;
drop policy if exists accounts_insert_owner on public.accounts;
create policy accounts_insert_owner
  on public.accounts
  for insert
  to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_update_admin on public.accounts;
drop policy if exists "accounts_update_admin" on public.accounts;
drop policy if exists accounts_update_owner on public.accounts;
create policy accounts_update_owner
  on public.accounts
  for update
  to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_delete_admin on public.accounts;
drop policy if exists "accounts_delete_admin" on public.accounts;
drop policy if exists accounts_delete_owner on public.accounts;
create policy accounts_delete_owner
  on public.accounts
  for delete
  to authenticated
  using (public.has_account_role(array['owner']));

-- BLOCKED DATES / MAINTENANCE
alter table if exists public.blocked_dates enable row level security;

drop policy if exists blocked_dates_select_public on public.blocked_dates;
drop policy if exists "blocked_dates_select_public" on public.blocked_dates;
create policy blocked_dates_select_public
  on public.blocked_dates
  for select
  using (true);

drop policy if exists blocked_dates_insert_admin on public.blocked_dates;
drop policy if exists "blocked_dates_insert_admin" on public.blocked_dates;
drop policy if exists blocked_dates_insert_operators on public.blocked_dates;
create policy blocked_dates_insert_operators
  on public.blocked_dates
  for insert
  to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists blocked_dates_delete_admin on public.blocked_dates;
drop policy if exists "blocked_dates_delete_admin" on public.blocked_dates;
drop policy if exists blocked_dates_delete_operators on public.blocked_dates;
create policy blocked_dates_delete_operators
  on public.blocked_dates
  for delete
  to authenticated
  using (public.has_account_role(array['owner','court_owner']));

-- OPEN PLAY REGISTRATIONS
alter table if exists public.open_play_registrations enable row level security;

drop policy if exists open_play_select_public on public.open_play_registrations;
create policy open_play_select_public
  on public.open_play_registrations
  for select
  using (true);

drop policy if exists open_play_insert_public on public.open_play_registrations;
create policy open_play_insert_public
  on public.open_play_registrations
  for insert
  with check (true);

drop policy if exists open_play_update_dashboard_roles on public.open_play_registrations;
create policy open_play_update_dashboard_roles
  on public.open_play_registrations
  for update
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists open_play_delete_admin on public.open_play_registrations;
drop policy if exists open_play_delete_dashboard_roles on public.open_play_registrations;
create policy open_play_delete_dashboard_roles
  on public.open_play_registrations
  for delete
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

-- OPEN PLAY GAME MANAGER
alter table if exists public.open_play_game_sessions enable row level security;
alter table if exists public.open_play_game_players enable row level security;
alter table if exists public.open_play_game_rounds enable row level security;

drop policy if exists op_game_sessions_admin_all on public.open_play_game_sessions;
drop policy if exists op_game_sessions_dashboard_all on public.open_play_game_sessions;
create policy op_game_sessions_dashboard_all
  on public.open_play_game_sessions
  for all
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_players_dashboard_all on public.open_play_game_players;
create policy op_game_players_dashboard_all
  on public.open_play_game_players
  for all
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;
drop policy if exists op_game_rounds_dashboard_all on public.open_play_game_rounds;
create policy op_game_rounds_dashboard_all
  on public.open_play_game_rounds
  for all
  to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

-- WEEKLY FEES
alter table if exists public.weekly_fees enable row level security;

drop policy if exists weekly_fees_select_auth on public.weekly_fees;
drop policy if exists weekly_fees_select_role_scoped on public.weekly_fees;
create policy weekly_fees_select_role_scoped
  on public.weekly_fees
  for select
  to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
  );

drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
drop policy if exists weekly_fees_insert_owner on public.weekly_fees;
create policy weekly_fees_insert_owner
  on public.weekly_fees
  for insert
  to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists weekly_fees_update_auth on public.weekly_fees;
drop policy if exists weekly_fees_update_role_scoped on public.weekly_fees;
create policy weekly_fees_update_role_scoped
  on public.weekly_fees
  for update
  to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
  )
  with check (
    public.has_account_role(array['owner'])
    or (
      public.has_account_role(array['court_owner'])
      and status = 'submitted'
    )
  );

drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
drop policy if exists weekly_fees_delete_owner on public.weekly_fees;
create policy weekly_fees_delete_owner
  on public.weekly_fees
  for delete
  to authenticated
  using (public.has_account_role(array['owner']));

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

drop trigger if exists trg_guard_weekly_fee_court_owner_update on public.weekly_fees;
create trigger trg_guard_weekly_fee_court_owner_update
before update on public.weekly_fees
for each row execute function public.guard_weekly_fee_court_owner_update();

-- AGREEMENTS
alter table if exists public.agreements enable row level security;

drop policy if exists "users_read_own_agreement" on public.agreements;
drop policy if exists agreements_select_self_or_owner on public.agreements;
create policy agreements_select_self_or_owner
  on public.agreements
  for select
  to authenticated
  using (user_id = auth.uid()::text or public.has_account_role(array['owner']));

drop policy if exists agreements_insert_self on public.agreements;
create policy agreements_insert_self
  on public.agreements
  for insert
  to authenticated
  with check (user_id = auth.uid()::text);

drop policy if exists agreements_update_self on public.agreements;
create policy agreements_update_self
  on public.agreements
  for update
  to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);
