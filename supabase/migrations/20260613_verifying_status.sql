-- Add 'verifying' to bookings.status to support slot reservation during OCR.
-- When a customer submits a booking with a GCash receipt, the slot is immediately
-- saved as 'verifying' (shown as yellow "Processing…" in the UI) so no other
-- player can book the same slot while OCR is running (~5-15 sec).
-- Stale 'verifying' bookings older than 10 min are auto-cancelled on page load.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','verifying','confirmed','cancelled','completed'));
