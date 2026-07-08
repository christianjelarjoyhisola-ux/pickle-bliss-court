-- ============================================================
-- MIGRATION 002: Enable Row Level Security on all tables
-- Run this once in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── BOOKINGS ─────────────────────────────────────────────────
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Anyone (customers) can read bookings to check slot availability
CREATE POLICY "bookings_select_public"
  ON bookings FOR SELECT
  USING (true);

-- Anyone (customers) can create a booking
CREATE POLICY "bookings_insert_public"
  ON bookings FOR INSERT
  WITH CHECK (true);

-- Only logged-in admins can update bookings (confirm, reschedule, etc.)
CREATE POLICY "bookings_update_admin"
  ON bookings FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- Only logged-in admins can delete bookings
CREATE POLICY "bookings_delete_admin"
  ON bookings FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- ── COURTS ───────────────────────────────────────────────────
ALTER TABLE courts ENABLE ROW LEVEL SECURITY;

-- Anyone can read courts (shown on booking page)
CREATE POLICY "courts_select_public"
  ON courts FOR SELECT
  USING (true);

-- Only admins can add / edit / delete courts
CREATE POLICY "courts_insert_admin"
  ON courts FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "courts_update_admin"
  ON courts FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "courts_delete_admin"
  ON courts FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- ── SETTINGS ─────────────────────────────────────────────────
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Anyone can read settings (needed for QR images, merchant info, hours)
CREATE POLICY "settings_select_public"
  ON settings FOR SELECT
  USING (true);

-- Only admins can change settings
CREATE POLICY "settings_insert_admin"
  ON settings FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "settings_update_admin"
  ON settings FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "settings_delete_admin"
  ON settings FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- ── BLOCKED DATES ────────────────────────────────────────────
ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blocked_dates_select_public"
  ON blocked_dates FOR SELECT
  USING (true);

CREATE POLICY "blocked_dates_insert_admin"
  ON blocked_dates FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "blocked_dates_delete_admin"
  ON blocked_dates FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- ── PAYMENT SESSIONS ─────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'payment_sessions') THEN
    ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "payment_sessions_insert_public"
      ON payment_sessions FOR INSERT WITH CHECK (true);

    CREATE POLICY "payment_sessions_select_admin"
      ON payment_sessions FOR SELECT USING (auth.uid() IS NOT NULL);

    CREATE POLICY "payment_sessions_update_admin"
      ON payment_sessions FOR UPDATE USING (auth.uid() IS NOT NULL);
  END IF;
END $$;
