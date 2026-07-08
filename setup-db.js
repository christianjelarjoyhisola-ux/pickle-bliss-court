// Run: node setup-db.js
// Sets up the full Pickle Bliss Court schema in the new Supabase project

const fs = require('fs');

function loadLocalEnv() {
  if (!fs.existsSync('.env.local')) return {};
  return Object.fromEntries(fs.readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => !line.trim().startsWith('#'))
    .map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
}

const env = loadLocalEnv();
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';
const SUPABASE_URL = env.SUPABASE_URL || 'https://ikqfszhqpyayzroccegi.supabase.co';

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function run() {
  console.log('Connecting to:', SUPABASE_URL);

  // ── 1. CREATE TABLES ──────────────────────────────────────────────────────
  const tables = [
    {
      name: 'courts',
      sql: `CREATE TABLE IF NOT EXISTS public.courts (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text,
        rate numeric NOT NULL DEFAULT 300,
        blocked boolean NOT NULL DEFAULT false,
        feats text[] DEFAULT '{}',
        photo text,
        rate_schedule jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'bookings',
      sql: `CREATE TABLE IF NOT EXISTS public.bookings (
        ref text PRIMARY KEY,
        full_name text NOT NULL,
        contact_number text,
        email text,
        court_id text NOT NULL,
        court_name text,
        date date NOT NULL,
        slots text[] NOT NULL DEFAULT '{}',
        start_time text,
        end_time text,
        duration numeric,
        rate numeric,
        total numeric,
        payment_method text,
        payment_flow text,
        payment_status text NOT NULL DEFAULT 'unpaid'
          CHECK (payment_status IN ('unpaid','pending','for_verification','downpayment_paid','paid','failed')),
        payment_provider text,
        payment_session_id text,
        payment_checkout_url text,
        paid_at timestamptz,
        gcash_ref text,
        downpayment numeric,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','cancelled','completed')),
        created_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'settings',
      sql: `CREATE TABLE IF NOT EXISTS public.settings (
        key text PRIMARY KEY,
        value text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'accounts',
      sql: `CREATE TABLE IF NOT EXISTS public.accounts (
        id uuid PRIMARY KEY,
        username text UNIQUE NOT NULL,
        full_name text,
        email text UNIQUE,
        role text NOT NULL DEFAULT 'manager'
          CHECK (role IN ('developer','admin','manager')),
        created_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'blocked_dates',
      sql: `CREATE TABLE IF NOT EXISTS public.blocked_dates (
        date date PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'open_play_registrations',
      sql: `CREATE TABLE IF NOT EXISTS public.open_play_registrations (
        id bigserial PRIMARY KEY,
        full_name text NOT NULL,
        court_id text,
        court_name text,
        date date NOT NULL,
        hour integer,
        time_label text,
        payment_type text,
        amount numeric,
        created_at timestamptz NOT NULL DEFAULT now()
      );`
    },
    {
      name: 'payment_sessions',
      sql: `CREATE TABLE IF NOT EXISTS public.payment_sessions (
        id text PRIMARY KEY,
        booking_ref text NOT NULL,
        provider text NOT NULL,
        provider_reference text,
        amount_php numeric NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        checkout_url text,
        raw_request jsonb,
        raw_webhook jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        paid_at timestamptz
      );`
    },
  ];

  for (const t of tables) {
    const { error } = await sb.rpc('exec_sql', { sql: t.sql }).catch(() => ({ error: 'rpc not available' }));
    // rpc exec_sql won't exist on fresh project — use REST SQL endpoint instead
    await runSQL(t.sql, t.name);
  }

  // ── 2. INDEXES ────────────────────────────────────────────────────────────
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_bookings_court_date ON public.bookings (court_id, date);',
    'CREATE INDEX IF NOT EXISTS idx_bookings_status ON public.bookings (status);',
    'CREATE INDEX IF NOT EXISTS idx_payment_sessions_booking_ref ON public.payment_sessions (booking_ref);',
    'CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON public.payment_sessions (status);',
    'CREATE INDEX IF NOT EXISTS idx_payment_sessions_provider_reference ON public.payment_sessions (provider_reference);',
  ];
  for (const sql of indexes) await runSQL(sql, 'index');

  // ── 3. TRIGGERS ───────────────────────────────────────────────────────────
  await runSQL(`
    CREATE OR REPLACE FUNCTION public.touch_updated_at()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
  `, 'trigger:touch_updated_at fn');

  await runSQL(`
    DROP TRIGGER IF EXISTS trg_payment_sessions_touch_updated_at ON public.payment_sessions;
    CREATE TRIGGER trg_payment_sessions_touch_updated_at
      BEFORE UPDATE ON public.payment_sessions
      FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  `, 'trigger:payment_sessions_updated_at');

  await runSQL(`
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
        WHERE b.court_id = NEW.court_id AND b.date = NEW.date
          AND b.status != 'cancelled' AND b.ref != NEW.ref
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
    END; $$;
  `, 'trigger:prevent_double_booking fn');

  await runSQL(`
    DROP TRIGGER IF EXISTS check_booking_conflict ON public.bookings;
    CREATE TRIGGER check_booking_conflict
      BEFORE INSERT OR UPDATE ON public.bookings
      FOR EACH ROW EXECUTE FUNCTION public.prevent_double_booking();
  `, 'trigger:check_booking_conflict');

  // ── 4. RLS ────────────────────────────────────────────────────────────────
  const rlsStatements = `
    ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.courts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.blocked_dates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.open_play_registrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.payment_sessions ENABLE ROW LEVEL SECURITY;
  `;
  for (const stmt of rlsStatements.trim().split(';').filter(s => s.trim())) {
    await runSQL(stmt + ';', 'RLS enable');
  }

  // ── 5. RLS POLICIES ───────────────────────────────────────────────────────
  const policies = [
    // bookings
    "DROP POLICY IF EXISTS bookings_select_public ON public.bookings; CREATE POLICY bookings_select_public ON public.bookings FOR SELECT USING (true);",
    "DROP POLICY IF EXISTS bookings_insert_public ON public.bookings; CREATE POLICY bookings_insert_public ON public.bookings FOR INSERT WITH CHECK (true);",
    "DROP POLICY IF EXISTS bookings_update_admin ON public.bookings; CREATE POLICY bookings_update_admin ON public.bookings FOR UPDATE USING (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS bookings_delete_admin ON public.bookings; CREATE POLICY bookings_delete_admin ON public.bookings FOR DELETE USING (auth.uid() IS NOT NULL);",
    // courts
    "DROP POLICY IF EXISTS courts_select_public ON public.courts; CREATE POLICY courts_select_public ON public.courts FOR SELECT USING (true);",
    "DROP POLICY IF EXISTS courts_insert_admin ON public.courts; CREATE POLICY courts_insert_admin ON public.courts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS courts_update_admin ON public.courts; CREATE POLICY courts_update_admin ON public.courts FOR UPDATE USING (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS courts_delete_admin ON public.courts; CREATE POLICY courts_delete_admin ON public.courts FOR DELETE USING (auth.uid() IS NOT NULL);",
    // settings
    "DROP POLICY IF EXISTS settings_select_public ON public.settings; CREATE POLICY settings_select_public ON public.settings FOR SELECT USING (true);",
    "DROP POLICY IF EXISTS settings_insert_admin ON public.settings; CREATE POLICY settings_insert_admin ON public.settings FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS settings_update_admin ON public.settings; CREATE POLICY settings_update_admin ON public.settings FOR UPDATE USING (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS settings_delete_admin ON public.settings; CREATE POLICY settings_delete_admin ON public.settings FOR DELETE USING (auth.uid() IS NOT NULL);",
    // accounts
    "DROP POLICY IF EXISTS accounts_select_admin ON public.accounts; CREATE POLICY accounts_select_admin ON public.accounts FOR SELECT USING (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS accounts_insert_admin ON public.accounts; CREATE POLICY accounts_insert_admin ON public.accounts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS accounts_update_admin ON public.accounts; CREATE POLICY accounts_update_admin ON public.accounts FOR UPDATE USING (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS accounts_delete_admin ON public.accounts; CREATE POLICY accounts_delete_admin ON public.accounts FOR DELETE USING (auth.uid() IS NOT NULL);",
    // blocked_dates
    "DROP POLICY IF EXISTS blocked_dates_select_public ON public.blocked_dates; CREATE POLICY blocked_dates_select_public ON public.blocked_dates FOR SELECT USING (true);",
    "DROP POLICY IF EXISTS blocked_dates_insert_admin ON public.blocked_dates; CREATE POLICY blocked_dates_insert_admin ON public.blocked_dates FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);",
    "DROP POLICY IF EXISTS blocked_dates_delete_admin ON public.blocked_dates; CREATE POLICY blocked_dates_delete_admin ON public.blocked_dates FOR DELETE USING (auth.uid() IS NOT NULL);",
    // open_play
    "DROP POLICY IF EXISTS open_play_select_public ON public.open_play_registrations; CREATE POLICY open_play_select_public ON public.open_play_registrations FOR SELECT USING (true);",
    "DROP POLICY IF EXISTS open_play_insert_public ON public.open_play_registrations; CREATE POLICY open_play_insert_public ON public.open_play_registrations FOR INSERT WITH CHECK (true);",
    "DROP POLICY IF EXISTS open_play_delete_admin ON public.open_play_registrations; CREATE POLICY open_play_delete_admin ON public.open_play_registrations FOR DELETE USING (auth.uid() IS NOT NULL);",
    // payment_sessions (service-role only)
    "DROP POLICY IF EXISTS payment_sessions_no_direct ON public.payment_sessions; CREATE POLICY payment_sessions_no_direct ON public.payment_sessions FOR ALL TO authenticated USING (false);",
  ];
  for (const p of policies) await runSQL(p, 'RLS policy');

  // ── 6. SEED DATA ──────────────────────────────────────────────────────────
  const { error: courtErr } = await sb.from('courts').upsert([
    { id: 'c1', name: 'Court Alpha', description: 'Outdoor · Open Air · Standard Flooring', rate: 350, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'] },
    { id: 'c2', name: 'Court Beta',  description: 'Outdoor · Open Air · Standard Flooring', rate: 280, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'] },
  ], { onConflict: 'id' });
  console.log(courtErr ? `  ✗ seed courts: ${courtErr.message}` : '  ✓ seed courts');

  const { error: settErr } = await sb.from('settings').upsert([
    { key: 'venue_name',    value: 'Pickle Bliss Court' },
    { key: 'venue_address', value: 'Bliss, Poblacion, Monkayo' },
    { key: 'open_time',     value: '6' },
    { key: 'close_time',    value: '22' },
    { key: 'booking_fee',   value: '5' },
    { key: 'open_play_fee', value: '100' },
  ], { onConflict: 'key' });
  console.log(settErr ? `  ✗ seed settings: ${settErr.message}` : '  ✓ seed settings');

  console.log('\nDone!');
}

async function runSQL(sql, label) {
  // Use Supabase's pg REST endpoint via RPC — only works with service_role
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    method: 'GET',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
    }
  });
  // Actually use the postgres endpoint directly via the Supabase management API
  // Since we can't call raw SQL via REST v1 on a new project, use the pg endpoint
  const r = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
    },
    body: JSON.stringify({ query: sql })
  });
  if (r.ok) {
    console.log(`  ✓ ${label}`);
  } else {
    const body = await r.text();
    console.log(`  ✗ ${label} (${r.status}): ${body.substring(0, 120)}`);
  }
}

run().catch(e => console.error('Fatal:', e.message));
