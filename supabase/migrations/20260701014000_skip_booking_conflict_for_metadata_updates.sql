-- The double-booking guard should only run when a booking's scheduling fields
-- change. Metadata updates such as weekly_fee_id, billed_at, receipt_status,
-- or payment review fields must not be blocked by existing slot conflicts.

CREATE OR REPLACE FUNCTION public.prevent_double_booking()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.court_id IS NOT DISTINCT FROM OLD.court_id
     AND NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.ref IS NOT DISTINCT FROM OLD.ref
     AND NEW.slots IS NOT DISTINCT FROM OLD.slots THEN
    RETURN NEW;
  END IF;

  -- Cancelled bookings don't occupy slots.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.court_id = NEW.court_id
      AND b.date = NEW.date
      AND b.status != 'cancelled'
      AND b.ref != NEW.ref
      AND b.slots && NEW.slots
      AND (
        b.status != 'verifying'
        OR b.created_at IS NULL
        OR b.created_at > (now() - interval '15 minutes')
      )
  ) THEN
    RAISE EXCEPTION 'One or more time slots are already booked for this court and date.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';
