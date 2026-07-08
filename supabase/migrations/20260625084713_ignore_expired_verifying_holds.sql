-- Keep database conflict checks aligned with the browser's 15-minute
-- temporary booking hold. Abandoned "verifying" rows older than this should
-- not block customers from reserving the same slot again.

CREATE OR REPLACE FUNCTION prevent_double_booking()
RETURNS TRIGGER AS $$
BEGIN
  -- Cancelled bookings don't occupy slots.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bookings b
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
