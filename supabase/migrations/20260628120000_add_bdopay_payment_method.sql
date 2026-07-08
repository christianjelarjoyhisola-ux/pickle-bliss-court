-- Add BDO Pay / InstaPay-to-GCash as an accepted digital payment method.

alter table if exists public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;

alter table if exists public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash', 'bdopay', 'gotyme', 'pnb', 'cash'));
