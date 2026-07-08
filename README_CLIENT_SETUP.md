# Pickleball Booking System Template

This is the clean master copy for onboarding a new pickleball court owner.

## New Client Setup

1. Copy this folder and rename it for the new court.
2. Create a brand-new Supabase project for that court owner.
3. Run `SETUP_NEW_SUPABASE.sql` in the new Supabase SQL editor.
4. Update `supabase-config.js` with the new Supabase project URL and anon key.
5. If using setup scripts, update `setup-db.js` and `create-accounts.js` with the new service role key, run them, then remove the service role key from local files when done.
6. Replace the placeholder brand text, logo, court photos, contact info, and payment QR settings.
7. Deploy the Supabase edge functions to the new Supabase project.
8. Deploy the frontend to a new Cloudflare Pages project or domain.

## Important

Do not reuse another court owner's Supabase project. Each court owner should have separate bookings, Open Play reservations, payment settings, and admin accounts.

Use `?localData=1` on the website URL when testing with browser-only demo data.