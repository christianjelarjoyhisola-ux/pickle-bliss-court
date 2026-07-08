alter table if exists public.bookings
  add column if not exists received_account text;

update public.bookings
set received_account = case
  when lower(coalesce(payment_method, 'cash')) in ('gcash', 'bdopay', 'maya', 'gotyme', 'pnb') then 'gcash'
  when lower(coalesce(payment_method, 'cash')) = 'cash' then 'cash'
  else lower(coalesce(payment_method, 'cash'))
end
where received_account is null or btrim(received_account) = '';

create index if not exists idx_bookings_received_account
  on public.bookings (received_account);
