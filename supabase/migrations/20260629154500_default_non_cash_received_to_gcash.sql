alter table if exists public.bookings
  add column if not exists received_account text;

update public.bookings
set received_account = case
  when lower(coalesce(payment_method, 'cash')) = 'cash' then 'cash'
  else 'gcash'
end
where received_account is null
  or btrim(received_account) = ''
  or lower(received_account) not in ('cash', 'gcash');

create index if not exists idx_bookings_received_account
  on public.bookings (received_account);
