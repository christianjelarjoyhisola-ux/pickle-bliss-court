// Creates admin accounts directly via Supabase Auth Admin API (no email confirmation needed)
// Run: node create-accounts.js

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
const SUPABASE_URL = env.SUPABASE_URL || 'https://zcuufcpkgidmaanxjufo.supabase.co';
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const ACCOUNTS = [
  { email: env.OWNER_EMAIL || 'owner@picklebliss.local', password: env.OWNER_PASSWORD || 'CHANGE_THIS_PASSWORD!', username: 'sysowner', full_name: 'System Owner', role: 'owner' },
  { email: env.COURT_OWNER_EMAIL || 'courtowner@picklebliss.local', password: env.COURT_OWNER_PASSWORD || 'CHANGE_THIS_PASSWORD!', username: 'courtowner', full_name: 'Court Owner', role: 'court_owner' },
  { email: env.STAFF_EMAIL || 'staff@picklebliss.local', password: env.STAFF_PASSWORD || 'CHANGE_THIS_PASSWORD!', username: 'courtstaff', full_name: 'Court Staff', role: 'staff' },
];

async function run() {
  console.log('Creating admin accounts in Supabase project:', SUPABASE_URL, '\n');

  for (const acc of ACCOUNTS) {
    // 1. Create auth user (auto-confirmed via admin API)
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email: acc.email,
      password: acc.password,
      email_confirm: true,   // bypass email confirmation
      user_metadata: { full_name: acc.full_name, role: acc.role }
    });

    if (authErr) {
      console.log(`  ✗ Auth create [${acc.email}]: ${authErr.message}`);
      
      // If user already exists, try to find them
      if (authErr.message.includes('already') || authErr.status === 422) {
        const { data: users } = await sb.auth.admin.listUsers();
        const existing = users?.users?.find(u => u.email === acc.email);
        if (existing) {
          console.log(`    → Found existing user: ${existing.id}`);
          await upsertAccountRow(existing.id, acc);
        }
      }
      continue;
    }

    const uid = authData.user.id;
    console.log(`  ✓ Auth user created: ${acc.email} (id: ${uid})`);

    // 2. Insert row in public.accounts
    await upsertAccountRow(uid, acc);
  }

  console.log('\nDone! Login credentials:');
  console.log('  URL:      <your-deployed-url>/login.html');
  const roleLabel = { owner: 'System Owner', court_owner: 'Court Owner ', staff: 'Court Staff ' };
  for (const acc of ACCOUNTS) {
    console.log(`  ${roleLabel[acc.role] || acc.role}: ${acc.email} / ${acc.password}`);
  }
}

async function upsertAccountRow(uid, acc) {
  const { error } = await sb.from('accounts').upsert({
    id: uid,
    username: acc.username,
    full_name: acc.full_name,
    email: acc.email,
    role: acc.role,
  }, { onConflict: 'id' });

  if (error) console.log(`  ✗ accounts table insert [${acc.email}]: ${error.message}`);
  else console.log(`  ✓ accounts row inserted: ${acc.username} (${acc.role})`);
}

run().catch(e => console.error('Fatal:', e.message));
