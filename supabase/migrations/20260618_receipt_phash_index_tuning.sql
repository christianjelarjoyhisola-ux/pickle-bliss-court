-- Let duplicate receipt attempts keep their evidence on the flagged booking.
-- Duplicate detection is handled in verify-gcash-receipt using exact hash plus
-- near-match hamming distance; a unique phash index can reject metadata writes.

drop index if exists public.uniq_bookings_receipt_phash;

create index if not exists idx_bookings_receipt_phash
  on public.bookings (receipt_phash)
  where receipt_phash is not null and receipt_phash <> '';
