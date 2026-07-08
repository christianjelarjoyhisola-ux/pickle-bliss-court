-- Add Maya as a supported payment method.
insert into public.settings (key, value)
values ('payment_method_maya', '1')
on conflict (key) do nothing;

alter table if exists public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;

alter table if exists public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash', 'bdopay', 'maya', 'gotyme', 'pnb', 'cash'));
