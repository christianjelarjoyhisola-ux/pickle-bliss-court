-- Persist customer receipt evidence before a booking is finalized.
-- The raw hold capability is never stored; callers prove possession and the
-- Edge Function passes only its SHA-256 hash to the transaction below.

alter table if exists public.bookings
  add column if not exists hold_token_hash text;

alter table if exists public.bookings
  drop constraint if exists bookings_hold_token_hash_check;
alter table if exists public.bookings
  add constraint bookings_hold_token_hash_check
  check (hold_token_hash is null or hold_token_hash ~ '^[0-9a-f]{64}$');

create or replace function public.guard_booking_hold_token_hash()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.hold_token_hash is distinct from old.hold_token_hash then
    raise exception 'Booking hold capability is immutable.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_booking_hold_token_hash on public.bookings;
create trigger trg_guard_booking_hold_token_hash
before update on public.bookings
for each row execute function public.guard_booking_hold_token_hash();

-- Existing deployments have a permissive public insert policy. A restrictive
-- policy composes with it and prevents anonymous clients from minting permanent
-- pending rows or holds with no unguessable capability.
drop policy if exists bookings_insert_requires_capability on public.bookings;
create policy bookings_insert_requires_capability
  on public.bookings as restrictive
  for insert to anon
  with check (
    status = 'verifying'
    and hold_token_hash ~ '^[0-9a-f]{64}$'
    and created_at > now() - interval '1 minute'
    and created_at <= now() + interval '5 minutes'
  );

create table if not exists public.receipt_staged_uploads (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  booking_group_ref text,
  hold_token_hash text not null check (hold_token_hash ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  content_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),
  image_hash text not null check (image_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('gcash','bdopay','maya','bpi','gotyme','pnb')),
  status text not null default 'staged' check (status in ('staged','consumed','abandoned')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  storage_deleted_at timestamptz,
  constraint receipt_staged_uploads_expiry_check check (expires_at > created_at)
);

create index if not exists idx_receipt_staged_uploads_hold
  on public.receipt_staged_uploads (booking_ref, status, created_at desc);
create index if not exists idx_receipt_staged_uploads_cleanup
  on public.receipt_staged_uploads (expires_at)
  where status = 'staged';

alter table public.receipt_staged_uploads enable row level security;
revoke all on table public.receipt_staged_uploads from anon, authenticated;

-- Service-role-only transaction used by verify-gcash-receipt. It serializes
-- each court/date, rechecks the complete hold group and consumes exactly one
-- staged object in the same transaction that changes the rows to pending.
create or replace function public.finalize_staged_booking(
  p_booking_ref text,
  p_hold_token_hash text,
  p_upload_id uuid,
  p_full_name text,
  p_contact_number text,
  p_email text,
  p_payment_method text,
  p_payment_reference text,
  p_payment_flow text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  primary_row public.bookings%rowtype;
  upload_row public.receipt_staged_uploads%rowtype;
  group_key text;
  group_count integer;
  item_count integer;
  item_ref_count integer;
  now_at timestamptz := clock_timestamp();
  normalized_method text := lower(trim(coalesce(p_payment_method, '')));
  normalized_reference text := trim(coalesce(p_payment_reference, ''));
  result_refs text[];
  row_item record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'This operation is available only through the receipt service.' using errcode = '42501';
  end if;
  if p_hold_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid hold capability.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_full_name, ''))) not between 3 and 120 then
    raise exception 'Full name must be between 3 and 120 characters.' using errcode = '22023';
  end if;
  if regexp_replace(coalesce(p_contact_number, ''), '[[:space:]-]', '', 'g') !~ '^(09|\+639)[0-9]{9}$' then
    raise exception 'A valid Philippine contact number is required.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_email, ''))) > 254
     or trim(coalesce(p_email, '')) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if normalized_method not in ('gcash','bdopay','maya','bpi','gotyme','pnb') then
    raise exception 'Unsupported staged-receipt payment method.' using errcode = '22023';
  end if;
  if nullif(lower(trim(coalesce(p_payment_flow, ''))), '') is not null
     and lower(trim(p_payment_flow)) <> normalized_method then
    raise exception 'Payment flow does not match the selected payment method.' using errcode = '22023';
  end if;
  if normalized_reference = '' or length(normalized_reference) > 100 then
    raise exception 'A payment reference is required.' using errcode = '22023';
  end if;
  if normalized_method = 'gcash' and normalized_reference !~ '^[0-9]{13}$' then
    raise exception 'GCash reference must contain exactly 13 digits.' using errcode = '22023';
  elsif normalized_method = 'bdopay' and upper(normalized_reference) !~ '^BN-[0-9]{8}-[0-9]{8}$' then
    raise exception 'BDO Pay reference format is invalid.' using errcode = '22023';
  elsif normalized_method = 'maya'
        and regexp_replace(upper(normalized_reference), '[^A-Z0-9]', '', 'g') !~ '^[A-Z0-9]{12}$' then
    raise exception 'Maya reference format is invalid.' using errcode = '22023';
  elsif normalized_method in ('bpi','gotyme','pnb')
        and length(regexp_replace(normalized_reference, '[^A-Za-z0-9]', '', 'g')) < 4 then
    raise exception 'Payment reference format is invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Booking items are required.' using errcode = '22023';
  end if;

  select * into primary_row
    from public.bookings
   where ref = p_booking_ref
   for update;
  if not found then
    raise exception 'Booking hold was not found.' using errcode = 'P0002';
  end if;
  if primary_row.status <> 'verifying'
     or primary_row.created_at is null
     or primary_row.created_at <= now_at - interval '15 minutes' then
    raise exception 'Booking hold has expired or is no longer awaiting completion.' using errcode = '22023';
  end if;
  if primary_row.hold_token_hash is distinct from p_hold_token_hash then
    raise exception 'Invalid hold capability.' using errcode = '42501';
  end if;

  group_key := nullif(primary_row.booking_group_ref, '');

  -- Advisory locks prevent two simultaneous transactions for the same
  -- court/date from both passing the conflict query.
  for row_item in
    select distinct b.court_id, b.date
      from public.bookings b
     where (group_key is not null and b.booking_group_ref = group_key)
        or (group_key is null and b.ref = primary_row.ref)
     order by b.court_id, b.date
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'pickle-bliss-slot:' || row_item.court_id || ':' || row_item.date::text, 0
    ));
  end loop;

  -- Lock the whole group after advisory locks and validate that it is exact,
  -- fresh and protected by the same capability.
  perform 1
    from public.bookings b
   where (group_key is not null and b.booking_group_ref = group_key)
      or (group_key is null and b.ref = primary_row.ref)
   for update;

  select count(*) into group_count
    from public.bookings b
   where (group_key is not null and b.booking_group_ref = group_key)
      or (group_key is null and b.ref = primary_row.ref);

  if exists (
    select 1 from public.bookings b
     where ((group_key is not null and b.booking_group_ref = group_key)
         or (group_key is null and b.ref = primary_row.ref))
       and (b.status <> 'verifying'
         or b.created_at is null
         or b.created_at <= now_at - interval '15 minutes'
         or b.hold_token_hash is distinct from p_hold_token_hash)
  ) then
    raise exception 'One or more booking holds expired or no longer belong to this checkout.' using errcode = '22023';
  end if;

  select count(*), count(distinct value->>'ref')
    into item_count, item_ref_count
    from jsonb_array_elements(p_items);
  if item_count <> group_count or item_ref_count <> group_count then
    raise exception 'Booking item list does not match the held group.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
     where not exists (
       select 1 from public.bookings b
        where b.ref = i.value->>'ref'
          and ((group_key is not null and b.booking_group_ref = group_key)
            or (group_key is null and b.ref = primary_row.ref))
     )
       or (i.value->>'downpayment') is null
       or (i.value->>'downpayment') !~ '^[0-9]+([.][0-9]{1,2})?$'
  ) then
    raise exception 'Booking item details are invalid.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.bookings b
      join jsonb_array_elements(p_items) i on i.value->>'ref' = b.ref
     where not (
       abs((i.value->>'downpayment')::numeric - b.total) <= 0.01
       or abs(
         (i.value->>'downpayment')::numeric
         - round(
           least(greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0), b.total)
           + ((b.total - least(greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0), b.total)) * 0.50),
           2
         )
       ) <= 0.01
     )
  ) then
    raise exception 'Booking payment amount does not match the server-calculated amount due.' using errcode = '22023';
  end if;

  select * into upload_row
    from public.receipt_staged_uploads
   where id = p_upload_id
   for update;
  if not found
     or upload_row.status <> 'staged'
     or upload_row.expires_at <= now_at
     or upload_row.booking_ref <> primary_row.ref
     or upload_row.booking_group_ref is distinct from group_key
     or upload_row.hold_token_hash <> p_hold_token_hash
     or upload_row.provider <> normalized_method then
    raise exception 'Uploaded receipt is missing, expired, or belongs to another checkout.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'receipts' and o.name = upload_row.storage_path
  ) then
    raise exception 'Uploaded receipt object was not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.bookings held
      join public.bookings other
        on other.court_id = held.court_id
       and other.date = held.date
       and other.ref <> held.ref
       and other.slots && held.slots
     where ((group_key is not null and held.booking_group_ref = group_key)
         or (group_key is null and held.ref = primary_row.ref))
       and not ((group_key is not null and other.booking_group_ref = group_key)
         or (group_key is null and other.ref = primary_row.ref))
       and other.status <> 'cancelled'
       and (other.status <> 'verifying'
         or other.created_at is null
         or other.created_at > now_at - interval '15 minutes')
  ) then
    raise exception 'One or more time slots are no longer available.' using errcode = '23P01';
  end if;

  update public.bookings b
     set full_name = trim(p_full_name),
         contact_number = trim(p_contact_number),
         email = lower(trim(p_email)),
         payment_method = normalized_method,
         payment_flow = normalized_method,
         gcash_ref = normalized_reference,
         downpayment = (i.value->>'downpayment')::numeric,
         payment_status = 'for_verification',
         status = 'pending',
         receipt_image_url = upload_row.storage_path,
         receipt_image_hash = upload_row.image_hash,
         receipt_status = 'none',
         receipt_flags = '{}',
         receipt_extracted = null,
         receipt_confidence = null,
         receipt_verified_at = null
    from jsonb_array_elements(p_items) i
   where b.ref = i.value->>'ref'
     and ((group_key is not null and b.booking_group_ref = group_key)
       or (group_key is null and b.ref = primary_row.ref));

  update public.receipt_staged_uploads
     set status = 'consumed', consumed_at = now_at
   where id = upload_row.id and status = 'staged';
  if not found then
    raise exception 'Uploaded receipt was already consumed.' using errcode = '22023';
  end if;

  select array_agg(b.ref order by b.ref) into result_refs
    from public.bookings b
   where (group_key is not null and b.booking_group_ref = group_key)
      or (group_key is null and b.ref = primary_row.ref);

  return jsonb_build_object(
    'ok', true,
    'status', 'pending',
    'paymentStatus', 'for_verification',
    'bookingRefs', to_jsonb(result_refs),
    'uploadId', upload_row.id,
    'receiptImageUrl', upload_row.storage_path
  );
end;
$$;

revoke all on function public.finalize_staged_booking(
  text,text,uuid,text,text,text,text,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_staged_booking(
  text,text,uuid,text,text,text,text,text,text,jsonb
) to service_role;

notify pgrst, 'reload schema';
