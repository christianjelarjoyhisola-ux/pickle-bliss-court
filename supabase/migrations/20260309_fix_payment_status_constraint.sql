-- Fix payment_status CHECK constraint to include 'downpayment_paid'
-- The original constraint only allowed: unpaid, pending, for_verification, paid, failed
-- Admin dropdown needs 'downpayment_paid' as a valid status

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'pending', 'for_verification', 'downpayment_paid', 'paid', 'failed'));
