-- ============================================================
-- 20260615_three_tier_roles.sql
-- Migrate accounts.role from the old 2-role model
-- (developer / admin / manager) to the new 3-tier model:
--   owner       → System Owner  (full access)
--   court_owner → Court Owner   (operations + settings, no account mgmt)
--   staff       → Court Staff   (front-desk: bookings, payments, open play)
-- ============================================================

-- 1. Drop the old CHECK constraint so we can remap existing rows.
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_role_check;

-- 2. Remap any existing data to the new role names.
UPDATE public.accounts SET role = 'owner'       WHERE role = 'developer';
UPDATE public.accounts SET role = 'court_owner' WHERE role = 'admin';
UPDATE public.accounts SET role = 'staff'       WHERE role = 'manager';
-- Safety net: anything unrecognized becomes least-privilege staff.
UPDATE public.accounts SET role = 'staff'
  WHERE role NOT IN ('owner', 'court_owner', 'staff');

-- 3. Update the default for new rows.
ALTER TABLE public.accounts
  ALTER COLUMN role SET DEFAULT 'staff';

-- 4. Re-add the CHECK constraint with the new allowed values.
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('owner', 'court_owner', 'staff'));
