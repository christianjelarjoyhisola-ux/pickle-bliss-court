-- Store Open Play receipt OCR evidence on each registration, same as bookings.

alter table public.open_play_registrations
  add column if not exists receipt_image_url  text,
  add column if not exists receipt_image_hash text,
  add column if not exists receipt_phash      text,
  add column if not exists receipt_status     text not null default 'none',
  add column if not exists receipt_flags      text[] not null default '{}',
  add column if not exists receipt_extracted  jsonb,
  add column if not exists receipt_confidence numeric,
  add column if not exists receipt_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'open_play_receipt_status_check'
  ) then
    alter table public.open_play_registrations
      add constraint open_play_receipt_status_check
      check (receipt_status in ('none','auto_approved','manual_review','rejected'));
  end if;
end $$;

create index if not exists idx_open_play_receipt_status
  on public.open_play_registrations (receipt_status);

create index if not exists idx_open_play_receipt_verified_at
  on public.open_play_registrations (receipt_verified_at);
