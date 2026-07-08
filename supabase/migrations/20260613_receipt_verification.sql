-- ============================================================
-- 20260613_receipt_verification.sql
-- GCash / GoTyme / PNB receipt verification + fraud detection.
--
-- Adds receipt-image columns to bookings, a duplicate-reference
-- ledger, a perceptual-hash duplicate guard, and an immutable
-- audit trail for every verification attempt (for disputes and
-- rule tuning). The "expected" merchant number/name are reused
-- from the existing public.settings keys:
--   gcash_merchant_number / gcash_merchant_name
-- (no new accounts columns are required — single-venue model).
-- ============================================================

-- ── 1. BOOKINGS: receipt verification fields ─────────────────
alter table if exists public.bookings
  add column if not exists receipt_image_url  text,        -- storage path in 'receipts' bucket
  add column if not exists receipt_image_hash text,        -- sha256 of the uploaded bytes (exact-dupe guard)
  add column if not exists receipt_phash       text,       -- perceptual hash (near-dupe / re-crop guard)
  add column if not exists receipt_status      text not null default 'none',
  add column if not exists receipt_flags       text[] not null default '{}',
  add column if not exists receipt_extracted   jsonb,      -- {ref, amount, date, time, number, name}
  add column if not exists receipt_confidence  numeric,    -- 0..1 OCR/decision confidence
  add column if not exists receipt_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_receipt_status_check'
  ) then
    alter table public.bookings
      add constraint bookings_receipt_status_check
      check (receipt_status in ('none','auto_approved','manual_review','rejected'));
  end if;
exception
  when undefined_table then null;
end $$;

-- Receipt phash lookup for near-duplicate checks. The Edge Function decides
-- duplicates; this index must not be unique or duplicate evidence cannot be
-- attached to the flagged booking.
create index if not exists idx_bookings_receipt_phash
  on public.bookings (receipt_phash)
  where receipt_phash is not null and receipt_phash <> '';


-- ── 2. USED GCASH REFERENCES (reuse / replay guard) ──────────
create table if not exists public.used_gcash_refs (
  gcash_ref   text primary key,
  booking_ref text not null,
  provider    text,                       -- gcash | gotyme | pnb
  used_at     timestamptz not null default now()
);

create index if not exists idx_used_gcash_refs_booking_ref
  on public.used_gcash_refs (booking_ref);


-- ── 3. RECEIPT VERIFICATION AUDIT TRAIL ──────────────────────
-- One immutable row per verification attempt. Never updated.
create table if not exists public.receipt_verifications (
  id            bigserial primary key,
  booking_ref   text not null,
  result        text not null,            -- auto_approved | manual_review | rejected
  flags         text[] not null default '{}',
  extracted     jsonb,                    -- parsed fields from OCR
  confidence    numeric,
  image_hash    text,
  phash         text,
  raw_ocr_text  text,                     -- full OCR text (PII — RLS locked)
  created_at    timestamptz not null default now()
);

create index if not exists idx_receipt_verifications_booking_ref
  on public.receipt_verifications (booking_ref);
create index if not exists idx_receipt_verifications_created_at
  on public.receipt_verifications (created_at);


-- ── 4. ROW LEVEL SECURITY ────────────────────────────────────
-- These tables hold financial PII and anti-fraud state. All writes
-- happen through the service-role Edge Function. Authenticated admins
-- may READ the audit trail; nobody writes directly via the anon/auth key.

alter table if exists public.used_gcash_refs enable row level security;
drop policy if exists used_gcash_refs_no_select on public.used_gcash_refs;
drop policy if exists used_gcash_refs_no_write  on public.used_gcash_refs;
create policy used_gcash_refs_no_select on public.used_gcash_refs
  for select to authenticated using (false);
create policy used_gcash_refs_no_write on public.used_gcash_refs
  for all to authenticated using (false) with check (false);

alter table if exists public.receipt_verifications enable row level security;
drop policy if exists receipt_verifications_select_admin on public.receipt_verifications;
drop policy if exists receipt_verifications_no_write     on public.receipt_verifications;
-- Admins (any signed-in dashboard user) can read the audit trail for disputes.
create policy receipt_verifications_select_admin on public.receipt_verifications
  for select to authenticated using (true);
-- Direct writes are forbidden — only the service role (which bypasses RLS) writes.
create policy receipt_verifications_no_write on public.receipt_verifications
  for all to authenticated using (false) with check (false);


-- ── 5. PRIVATE STORAGE BUCKET FOR RECEIPT IMAGES ─────────────
-- Receipts contain financial PII → private bucket, no public reads.
-- Uploads/reads happen through the service-role Edge Function and
-- signed URLs generated for admins. 5 MB per file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts', 'receipts', false, 5242880,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Lock down object access: deny all anon/auth direct access. The Edge
-- Function uses the service-role key (bypasses these policies) to upload
-- and to mint short-lived signed URLs for admin viewing.
drop policy if exists receipts_no_select on storage.objects;
drop policy if exists receipts_no_insert on storage.objects;
drop policy if exists receipts_no_update on storage.objects;
drop policy if exists receipts_no_delete on storage.objects;
create policy receipts_no_select on storage.objects
  for select to anon, authenticated using (bucket_id <> 'receipts');
create policy receipts_no_insert on storage.objects
  for insert to anon, authenticated with check (bucket_id <> 'receipts');
create policy receipts_no_update on storage.objects
  for update to anon, authenticated using (bucket_id <> 'receipts');
create policy receipts_no_delete on storage.objects
  for delete to anon, authenticated using (bucket_id <> 'receipts');
