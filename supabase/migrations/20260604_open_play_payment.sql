-- Add payment tracking columns to open_play_registrations
-- Enables per-registration payment verification in admin (separate from court booking verify flow)

ALTER TABLE public.open_play_registrations
  ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS gcash_ref       TEXT,
  ADD COLUMN IF NOT EXISTS payment_status  TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'rejected'));
