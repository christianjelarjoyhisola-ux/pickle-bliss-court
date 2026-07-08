-- Allow rejected as an explicit booking payment state.
-- Receipt OCR already cancels invalid bookings; this keeps the payment log clear.

alter table public.bookings drop constraint if exists bookings_payment_status_check;

alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in (
    'unpaid',
    'pending',
    'for_verification',
    'downpayment_paid',
    'paid',
    'failed',
    'rejected'
  ));
