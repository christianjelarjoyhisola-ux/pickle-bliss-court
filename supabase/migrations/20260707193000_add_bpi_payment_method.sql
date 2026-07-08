-- Add BPI / InstaPay-to-GCash as a supported payment method.

insert into public.settings (key, value)
values ('payment_method_bpi', '1')
on conflict (key) do nothing;

alter table if exists public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;

alter table if exists public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb', 'cash'));

update public.bookings
set received_account = 'gcash'
where lower(coalesce(payment_method, '')) = 'bpi'
  and (received_account is null or btrim(received_account) = '');
