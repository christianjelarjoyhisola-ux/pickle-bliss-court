-- ============================================================
-- MIGRATION 001: Prevent double-booking at the database level
-- Run this once in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Function: checks if any slot in the new booking overlaps
-- with an existing active booking for the same court + date
CREATE OR REPLACE FUNCTION prevent_double_booking()
RETURNS TRIGGER AS $$
BEGIN
  -- Cancelled bookings don't occupy slots
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
  ) THEN
    RAISE EXCEPTION 'One or more time slots are already booked for this court and date.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it already exists, then recreate
DROP TRIGGER IF EXISTS check_booking_conflict ON bookings;

CREATE TRIGGER check_booking_conflict
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION prevent_double_booking();
