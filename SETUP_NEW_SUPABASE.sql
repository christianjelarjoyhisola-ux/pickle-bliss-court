-- ============================================================
-- PICKLE BLISS COURT — COMPLETE DATABASE SETUP
-- Run this entire script in: Supabase Dashboard → SQL Editor
-- ============================================================


-- ── 1. COURTS TABLE ──────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.courts (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  rate        numeric NOT NULL DEFAULT 300,
  blocked     boolean NOT NULL DEFAULT false,
  feats       text[] DEFAULT '{}',
  photo       text,
  rate_schedule jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);


-- ── 2. BOOKINGS TABLE ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookings (
  ref                  text PRIMARY KEY,
  booking_group_ref    text,
  full_name            text NOT NULL,
  contact_number       text,
  email                text,
  court_id             text NOT NULL,
  court_name           text,
  date                 date NOT NULL,
  slots                text[] NOT NULL DEFAULT '{}',
  start_time           text,
  end_time             text,
  duration             numeric,
  rate                 numeric,
  total                numeric,
  payment_method       text,
  received_account     text,
  payment_flow         text,
  payment_status       text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','pending','for_verification','downpayment_paid','paid','failed','rejected')),
  payment_provider     text,
  payment_session_id   text,
  payment_checkout_url text,
  paid_at              timestamptz,
  gcash_ref            text,
  downpayment          numeric,
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verifying','confirmed','cancelled','completed')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_court_date ON public.bookings (court_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_status     ON public.bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_group_ref  ON public.bookings (booking_group_ref);


-- ── 3. SETTINGS TABLE ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- ── 4. ACCOUNTS TABLE ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounts (
  id         uuid PRIMARY KEY,
  username   text UNIQUE NOT NULL,
  full_name  text,
  email      text UNIQUE,
  role       text NOT NULL DEFAULT 'staff'
    CHECK (role IN ('owner','court_owner','staff')),
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ── 5. BLOCKED DATES TABLE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blocked_dates (
  date       date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ── 6. OPEN PLAY REGISTRATIONS TABLE ─────────────────────────
CREATE TABLE IF NOT EXISTS public.open_play_registrations (
  id           bigserial PRIMARY KEY,
  full_name    text NOT NULL,
  court_id     text,
  court_name   text,
  date         date NOT NULL,
  hour         integer,
  time_label   text,
  payment_type text,
  amount       numeric,
  created_at   timestamptz NOT NULL DEFAULT now()
);


-- ── 7. PAYMENT SESSIONS TABLE ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.open_play_game_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date NOT NULL,
  time_label    text,
  court_ids     text[] NOT NULL DEFAULT '{}',
  court_names   text[] NOT NULL DEFAULT '{}',
  mode          text NOT NULL DEFAULT 'smart_random_mixer',
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','paused','completed','cancelled')),
  current_round integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.open_play_game_players (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             uuid NOT NULL REFERENCES public.open_play_game_sessions(id) ON DELETE CASCADE,
  full_name              text NOT NULL,
  source_registration_id bigint,
  status                 text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','no_show','removed')),
  seed_order             integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.open_play_game_rounds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES public.open_play_game_sessions(id) ON DELETE CASCADE,
  round_no         integer NOT NULL,
  assignments      jsonb NOT NULL DEFAULT '[]'::jsonb,
  queue_snapshot   jsonb NOT NULL DEFAULT '[]'::jsonb,
  partner_history  jsonb NOT NULL DEFAULT '{}'::jsonb,
  opponent_history jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_op_game_sessions_date
  ON public.open_play_game_sessions(date);
CREATE INDEX IF NOT EXISTS idx_op_game_players_session
  ON public.open_play_game_players(session_id, seed_order);
CREATE INDEX IF NOT EXISTS idx_op_game_rounds_session
  ON public.open_play_game_rounds(session_id, round_no);

CREATE TABLE IF NOT EXISTS public.payment_sessions (
  id                 text PRIMARY KEY,
  booking_ref        text NOT NULL,
  provider           text NOT NULL,
  provider_reference text,
  amount_php         numeric NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  checkout_url       text,
  raw_request        jsonb,
  raw_webhook        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_booking_ref         ON public.payment_sessions (booking_ref);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_status              ON public.payment_sessions (status);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_provider_reference  ON public.payment_sessions (provider_reference);


-- ── 8. UPDATED_AT TRIGGER ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_sessions_touch_updated_at ON public.payment_sessions;
CREATE TRIGGER trg_payment_sessions_touch_updated_at
  BEFORE UPDATE ON public.payment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ── 9. DOUBLE-BOOKING PREVENTION TRIGGER ─────────────────────
DROP TRIGGER IF EXISTS trg_op_game_sessions_touch_updated_at ON public.open_play_game_sessions;
CREATE TRIGGER trg_op_game_sessions_touch_updated_at
  BEFORE UPDATE ON public.open_play_game_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.prevent_double_booking()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.court_id IS NOT DISTINCT FROM OLD.court_id
     AND NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.ref IS NOT DISTINCT FROM OLD.ref
     AND NEW.slots IS NOT DISTINCT FROM OLD.slots THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.court_id = NEW.court_id
      AND b.date     = NEW.date
      AND b.status  != 'cancelled'
      AND b.ref     != NEW.ref
      AND b.slots   && NEW.slots
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
$$;

DROP TRIGGER IF EXISTS check_booking_conflict ON public.bookings;
CREATE TRIGGER check_booking_conflict
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_double_booking();


-- ── 10. ROW LEVEL SECURITY ───────────────────────────────────

-- BOOKINGS
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookings_select_public  ON public.bookings;
DROP POLICY IF EXISTS bookings_insert_public  ON public.bookings;
DROP POLICY IF EXISTS bookings_update_admin   ON public.bookings;
DROP POLICY IF EXISTS bookings_delete_admin   ON public.bookings;
CREATE POLICY bookings_select_public  ON public.bookings FOR SELECT USING (true);
CREATE POLICY bookings_insert_public  ON public.bookings FOR INSERT WITH CHECK (true);
CREATE POLICY bookings_update_admin   ON public.bookings FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY bookings_delete_admin   ON public.bookings FOR DELETE USING (auth.uid() IS NOT NULL);

-- COURTS
ALTER TABLE public.courts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS courts_select_public ON public.courts;
DROP POLICY IF EXISTS courts_insert_admin  ON public.courts;
DROP POLICY IF EXISTS courts_update_admin  ON public.courts;
DROP POLICY IF EXISTS courts_delete_admin  ON public.courts;
CREATE POLICY courts_select_public ON public.courts FOR SELECT USING (true);
CREATE POLICY courts_insert_admin  ON public.courts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY courts_update_admin  ON public.courts FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY courts_delete_admin  ON public.courts FOR DELETE USING (auth.uid() IS NOT NULL);

-- SETTINGS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settings_select_public ON public.settings;
DROP POLICY IF EXISTS settings_insert_admin  ON public.settings;
DROP POLICY IF EXISTS settings_update_admin  ON public.settings;
DROP POLICY IF EXISTS settings_delete_admin  ON public.settings;
CREATE POLICY settings_select_public ON public.settings FOR SELECT USING (true);
CREATE POLICY settings_insert_admin  ON public.settings FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY settings_update_admin  ON public.settings FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY settings_delete_admin  ON public.settings FOR DELETE USING (auth.uid() IS NOT NULL);

-- ACCOUNTS
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_select_admin  ON public.accounts;
DROP POLICY IF EXISTS accounts_insert_admin  ON public.accounts;
DROP POLICY IF EXISTS accounts_update_admin  ON public.accounts;
DROP POLICY IF EXISTS accounts_delete_admin  ON public.accounts;
CREATE POLICY accounts_select_admin ON public.accounts FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY accounts_insert_admin ON public.accounts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY accounts_update_admin ON public.accounts FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY accounts_delete_admin ON public.accounts FOR DELETE USING (auth.uid() IS NOT NULL);

-- BLOCKED DATES
ALTER TABLE public.blocked_dates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blocked_dates_select_public ON public.blocked_dates;
DROP POLICY IF EXISTS blocked_dates_insert_admin  ON public.blocked_dates;
DROP POLICY IF EXISTS blocked_dates_delete_admin  ON public.blocked_dates;
CREATE POLICY blocked_dates_select_public ON public.blocked_dates FOR SELECT USING (true);
CREATE POLICY blocked_dates_insert_admin  ON public.blocked_dates FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY blocked_dates_delete_admin  ON public.blocked_dates FOR DELETE USING (auth.uid() IS NOT NULL);

-- OPEN PLAY REGISTRATIONS
ALTER TABLE public.open_play_registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS open_play_select_public ON public.open_play_registrations;
DROP POLICY IF EXISTS open_play_insert_public ON public.open_play_registrations;
DROP POLICY IF EXISTS open_play_delete_admin  ON public.open_play_registrations;
CREATE POLICY open_play_select_public ON public.open_play_registrations FOR SELECT USING (true);
CREATE POLICY open_play_insert_public ON public.open_play_registrations FOR INSERT WITH CHECK (true);
CREATE POLICY open_play_delete_admin  ON public.open_play_registrations FOR DELETE USING (auth.uid() IS NOT NULL);

-- OPEN PLAY GAME MANAGER
ALTER TABLE public.open_play_game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_play_game_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_play_game_rounds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS op_game_sessions_admin_all ON public.open_play_game_sessions;
DROP POLICY IF EXISTS op_game_players_admin_all ON public.open_play_game_players;
DROP POLICY IF EXISTS op_game_rounds_admin_all ON public.open_play_game_rounds;
CREATE POLICY op_game_sessions_admin_all ON public.open_play_game_sessions
  FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY op_game_players_admin_all ON public.open_play_game_players
  FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY op_game_rounds_admin_all ON public.open_play_game_rounds
  FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

-- PAYMENT SESSIONS (service-role only via Edge Functions)
ALTER TABLE public.payment_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_sessions_no_direct_access ON public.payment_sessions;
CREATE POLICY payment_sessions_no_direct_access ON public.payment_sessions FOR ALL TO authenticated USING (false);


-- ── 10b. RECEIPT VERIFICATION / FRAUD DETECTION ──────────────
-- Receipt-image columns on bookings, a reference-reuse ledger,
-- a perceptual-hash duplicate guard, and an immutable audit trail.
-- Expected merchant number/name are reused from settings keys
-- gcash_merchant_number / gcash_merchant_name.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS receipt_image_url  text,
  ADD COLUMN IF NOT EXISTS receipt_image_hash text,
  ADD COLUMN IF NOT EXISTS receipt_phash      text,
  ADD COLUMN IF NOT EXISTS receipt_status     text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS receipt_flags      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS receipt_extracted  jsonb,
  ADD COLUMN IF NOT EXISTS receipt_confidence numeric,
  ADD COLUMN IF NOT EXISTS receipt_verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_receipt_status_check') THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_receipt_status_check
      CHECK (receipt_status IN ('none','auto_approved','manual_review','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_receipt_phash
  ON public.bookings (receipt_phash)
  WHERE receipt_phash IS NOT NULL AND receipt_phash <> '';

CREATE TABLE IF NOT EXISTS public.used_gcash_refs (
  gcash_ref   text PRIMARY KEY,
  booking_ref text NOT NULL,
  provider    text,
  used_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_used_gcash_refs_booking_ref ON public.used_gcash_refs (booking_ref);

CREATE TABLE IF NOT EXISTS public.receipt_verifications (
  id           bigserial PRIMARY KEY,
  booking_ref  text NOT NULL,
  result       text NOT NULL,
  flags        text[] NOT NULL DEFAULT '{}',
  extracted    jsonb,
  confidence   numeric,
  image_hash   text,
  phash        text,
  raw_ocr_text text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_verifications_booking_ref ON public.receipt_verifications (booking_ref);
CREATE INDEX IF NOT EXISTS idx_receipt_verifications_created_at  ON public.receipt_verifications (created_at);

ALTER TABLE public.used_gcash_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS used_gcash_refs_no_select ON public.used_gcash_refs;
DROP POLICY IF EXISTS used_gcash_refs_no_write  ON public.used_gcash_refs;
CREATE POLICY used_gcash_refs_no_select ON public.used_gcash_refs FOR SELECT TO authenticated USING (false);
CREATE POLICY used_gcash_refs_no_write  ON public.used_gcash_refs FOR ALL TO authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.receipt_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipt_verifications_select_admin ON public.receipt_verifications;
DROP POLICY IF EXISTS receipt_verifications_no_write     ON public.receipt_verifications;
CREATE POLICY receipt_verifications_select_admin ON public.receipt_verifications FOR SELECT TO authenticated USING (true);
CREATE POLICY receipt_verifications_no_write     ON public.receipt_verifications FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Private storage bucket for receipt images (service-role access only).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipts','receipts',false,5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS receipts_no_select ON storage.objects;
DROP POLICY IF EXISTS receipts_no_insert ON storage.objects;
DROP POLICY IF EXISTS receipts_no_update ON storage.objects;
DROP POLICY IF EXISTS receipts_no_delete ON storage.objects;
CREATE POLICY receipts_no_select ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id <> 'receipts');
CREATE POLICY receipts_no_insert ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id <> 'receipts');
CREATE POLICY receipts_no_update ON storage.objects FOR UPDATE TO anon, authenticated USING (bucket_id <> 'receipts');
CREATE POLICY receipts_no_delete ON storage.objects FOR DELETE TO anon, authenticated USING (bucket_id <> 'receipts');


-- ── 11. SEED DEFAULT COURTS ──────────────────────────────────
INSERT INTO public.courts (id, name, description, rate, blocked, feats)
VALUES
  ('c1', 'Court Alpha', 'Outdoor · Open Air · Standard Flooring', 350, false, ARRAY['Outdoor','Open Air','Standard Floor']),
  ('c2', 'Court Beta',  'Outdoor · Open Air · Standard Flooring', 280, false, ARRAY['Outdoor','Open Air','Standard Floor'])
ON CONFLICT (id) DO NOTHING;


-- ── 12. SEED DEFAULT SETTINGS ────────────────────────────────
INSERT INTO public.settings (key, value)
VALUES
  ('venue_name',    'Pickle Bliss Court'),
  ('venue_address', 'Bliss, Poblacion, Monkayo'),
  ('open_time',     '6'),
  ('close_time',    '22'),
  ('booking_fee',   '5'),
  ('open_play_fee', '100')
ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- DONE! After running this:
-- 1. Go to Authentication → Providers → Email
--    → Disable "Confirm email" → Save
-- 2. Go to Project Settings → API
--    → Copy "Project URL" and "anon public" key
-- 3. Share those two values to update the app config
-- ============================================================
