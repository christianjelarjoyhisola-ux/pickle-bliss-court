-- ============================================================
-- MIGRATION: Electronic usage agreements
-- Records court owner consent to ₱15/booking system fee
-- ============================================================

CREATE TABLE IF NOT EXISTS agreements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,          -- auth user id
  email           text NOT NULL,
  full_name       text NOT NULL,          -- typed legal name
  role            text NOT NULL,
  version         integer NOT NULL DEFAULT 1, -- bump to force re-acceptance
  signature_data  text NOT NULL,          -- base64 PNG of drawn signature
  ip_address      text,
  user_agent      text,
  agreed_at       timestamptz NOT NULL DEFAULT now()
);

-- One active agreement per user per version
CREATE UNIQUE INDEX IF NOT EXISTS agreements_user_version_uq ON agreements (user_id, version);

-- RLS: service role writes; users can only read their own row
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_agreement"
  ON agreements FOR SELECT
  USING (auth.uid()::text = user_id);

-- Service role writes via edge function / admin API (anon cannot insert)
