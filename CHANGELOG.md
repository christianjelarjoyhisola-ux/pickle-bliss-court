# Changelog — Korte DOS (Bayabas, Cagayan de Oro)

All notable changes to this project are documented here.
Format: `[YYYY-MM-DD] — Type: Description (files affected)`
Types: **Added**, **Changed**, **Fixed**, **Removed**, **Security**, **DB**

---

## [2026-07-01] - Deleted Booking Recovery Archive

### DB
- **Deleted booking archive** - added a Supabase archive table and delete trigger so future booking deletions are automatically captured before the live row is removed.
- **Screenshot recovery history** - recorded recovered cancelled/rejected screenshot references as history-only archive entries so they do not block court availability.

**Files affected:** `supabase/migrations/20260701033000_deleted_booking_archive.sql`

---

## [2026-07-01] - Shared Court Owner Remittance Statements

### Changed
- **Venue-level remittance visibility** - court-owner remittance statements are now treated as shared venue obligations so every court-owner account can see the same generated statement.
- **System owner remittance label** - generated statements now display as assigned to all court owners instead of implying they belong to only one court-owner login.

### DB
- **Shared weekly fee RLS policy** - added a Supabase migration so all `court_owner` accounts can read remittance statements and submit proof while owner-only fields remain protected by the existing trigger.

**Files affected:** `admin.html`, `supabase/migrations/20260626_role_based_security.sql`, `supabase/migrations/20260701020500_shared_court_owner_remittance_access.sql`

---

## [2026-06-30] - Guest Resume, Manual Booking & Admin Mobile Polish

### Added
- **Guest booking auto-resume** - public bookings now save the active guest reservation and form draft in the same browser so a player can return and continue before the hold expires.
- **Multi-court manual booking** - admin Book for Customer now supports selecting multiple courts and multiple time blocks in one modern time matrix, saved as grouped booking records.

### Changed
- **Booking hold countdown resume** - restored guest bookings continue from the original reservation time instead of restarting the 15-minute hold.
- **Admin mobile layouts** - modernized Reports, Payment Review, Bookings, booking date stickiness, and Find Available Time surfaces to use denser mobile-friendly cards, filters, and controls.
- **Payment review queue** - compacted payment review summary and queue cards for better mobile scanning.

### Fixed
- **Immediate booking expiration bug** - fixed Book Now opening with an expired countdown when starting a normal new booking.
- **Booking date sticky styling** - removed the unintended left-edge accent artifact while keeping the booking date area visible on scroll.
- **Find Available Time alignment** - corrected modal field alignment and tightened spacing.
- **Bookings filter alignment** - fixed mobile filter box positioning in the Bookings admin view.

**Files affected:** `index.html`, `admin.html`

---

## [2026-06-27] - Booking Search, Grouped Transactions & Admin Fixes

### Added
- **Public available-time search** - added a modal that searches all courts for consecutive available slots by date, start time, and duration.
- **Shared public booking date** - added one booking date control that updates Court 1, Court 2, and Court 3 availability together.
- **Manual booking spreadsheet importer** - added a Python import tool for historical/manual bookings and marked imported records so reporting can exclude them where needed.

### Changed
- **Grouped multi-court booking transactions** - admin booking, dashboard, and payment review views now group related court bookings under one transaction-style summary.
- **Selected booking summary flow** - moved the selected court/time summary into the sticky booking bar, compacted long time labels, and removed court feature chips from public court cards.
- **Booking email theme** - updated confirmation and reschedule email styling to use the Korte DOS logo and darker orange-accented court branding.
- **Manual import reporting rules** - excluded manual imports from analytics and platform-fee calculations so imported history does not inflate live booking metrics.
- **Staff payment access** - staff access now targets payment review permissions instead of broader payment settings.
- **Open Play maintenance blocking** - added support for Open Play maintenance block handling in public availability.
- **Host invite visibility** - disabled and hard-hidden the host invite popup after the splash/booking flow changes.

### Fixed
- **GCash receipt reference extraction** - improved receipt parsing so reference numbers are read more reliably during verification.
- **Grouped booking per-court actions** - guarded grouped booking actions so per-court status and payment updates do not affect the wrong booking item.
- **Grouped schedule labels** - cleaned dashboard and payment-review schedule labels for grouped bookings across one or more dates.
- **Cancelled booking dashboard counts** - cancelled bookings no longer inflate active booking and dashboard totals.
- **Rejected receipt display** - confirmed bookings with rejected payment review now show the rejected payment state clearly.
- **Temporary hold and booking refresh behavior** - preserved extension booking items during refresh and refreshed temporary holds after booking cancellation.
- **Splash and host invite cleanup** - fixed host invite scroll unlock after the welcome splash and refined the splash photo overlay/tap styling.
- **Public payment privacy** - masked the GCash receiver name on the public payment UI.

### Security
- **Public site headers and redirect support** - added Cloudflare security headers and worker redirect handling for the public site.

**Files affected:** `_headers`, `_worker.js`, `admin.html`, `auth.js`, `index.html`, `login.html`, `supabase-config.js`, `supabase/functions/send-confirmation-email/index.ts`, `supabase/functions/send-reschedule-email/index.ts`, `supabase/functions/verify-gcash-receipt/index.ts`, `tools/import_manual_bookings.py`

---

## [2026-06-26] - Public Booking Polish & Branding

### Changed
- **Moved Host application prompt** - removed the Open Play host invite from the booking wizard and made it a centered main-page popup that returns on refresh.
- **Improved Host prompt contrast** - changed the centered host popup to a dark navy panel with a lime border so it stands apart from the white booking page.
- **Host prompt modal behavior** - added a dim blurred backdrop, locked page scrolling while the host prompt is visible, and auto-closes it after 10 seconds.
- **Host session payment verification** - added player join/payment records for host-created Open Play sessions and reused receipt OCR checks for auto-approving valid host-session payments.
- **Uploaded circular Korte DOS logo** - replaced the generated SVG display with the court-provided circular PNG logo and updated public, login, admin, and favicon references.
- **Four-column booking slot grid** - public court-card time slots now stay in a cleaner 4-column layout across desktop and mobile breakpoints.
- **Compact booking fee breakdown** - per-hour booking fees now show the total first, followed by the short formula, for example `₱40.00 (₱10.00/hr × 4 hrs)`.
- **Plain slot status labels** - processing slots now show `Processing...` without an emoji, and booked slots show `Booked` instead of masked names or `TAKEN`.

### Fixed
- **Logo edge cleanup** - the new PNG has transparent corners so the logo appears as a true circle instead of a square image with rounded styling.
- **Restored full public page after label update** - repaired the public `index.html` deployment after a bad redirected verification output briefly replaced the local file.

**Files affected:** `index.html`, `admin.html`, `login.html`, `korte-dos-logo.png`, `korte-dos-logo.svg`

---

## [2026-06-25] - Public Booking Mobile UX & Slot Indicators

### Added
- **All Courts mobile tab** - mobile court tabs now start with `All Courts` so players see every court by default before filtering to Court 1, Court 2, or another specific court.
- **Court-card slot status legend** - each public court card now shows bottom color indicators for Available, Selected, Booked, Processing, Done, and Maintenance states.
- **Done slot indicator** - past/completed time slots now have their own muted silver indicator in the court-card legend.
- **Pickleball loading indicators** - public and admin loading placeholders now use an animated circling pickleball instead of plain text loaders.
- **Fast browser data cache** - Supabase reads now use short-lived in-flight caching for courts, bookings, settings, blocked dates, and Open Play counts to avoid duplicate requests.

### Changed
- **Selected time slot color** - selected public time cards now use the Korte DOS lime green from the logo instead of blue, making the active selection easier to identify.
- **Mobile time-slot grid** - public booking time cards use a 3-column mobile layout for easier reading.
- **Court-card selection behavior** - court cards stay visually neutral while the selected time slot carries the main booking emphasis.
- **Generic spinner styling** - the shared spinner class now renders as a mini pickleball loader for consistency.
- **Public booking data reads** - court-card and slot availability views now request only the needed court/date booking rows instead of repeatedly reading all bookings.
- **Realtime refresh speed** - live booking refreshes now clear cached reads and use a shorter debounce so updates appear faster without sending duplicate requests.

**Files affected:** `index.html`, `admin.html`, `style.css`, `supabase-config.js`

---

## [2026-06-17] - Open Play Game Manager & Mobile Polish

### Added
- **Open Play Game Manager** - admin can create Open Play game sessions, import paid players, add walk-ins, generate balanced rounds, track live games, and export the manager list to CSV.
- **Winner selection** - completed games can record winners and use results to keep the next court rotation moving.
- **Saved game manager data** - added persistent sessions, player snapshots, and round history for Open Play rotation management.

### Changed
- **Live game cards upgraded** - active court cards now show clearer team/player state and a more compact mobile layout.
- **Mobile Game Manager layout refined** - teams stay side by side on small screens and live game cards use tighter spacing.
- **Queue-style manager flow** - Game Manager layout was adjusted closer to a queue app for faster in-session use.
- **Open Play payment/card spacing tightened** - mobile Open Play payment and card spacing were reduced for a cleaner flow.

### Fixed
- **Walk-in player names preserved** - manually added Game Manager players stay named correctly across manager updates.
- **Automatic court rotation** - selecting a winner now advances the rotation without manual court juggling.
- **Stale mobile booking selection cleared** - mobile booking state no longer carries an outdated slot selection.

### DB
- `20260617_open_play_game_manager.sql` - added `open_play_game_sessions`, `open_play_game_players`, and `open_play_game_rounds` with indexes, update trigger, and authenticated admin RLS policies.

**Files affected:** `admin.html`, `supabase-config.js`, `SETUP_NEW_SUPABASE.sql`, `supabase/migrations/20260617_open_play_game_manager.sql`

---

## [2026-06-16] - Cloudflare Pages Deployment

### Added
- **Cloudflare Pages project** - created `korte-dos` under the Cloudflare account and deployed the static public site.
- **Clean deploy bundle** - staged only public browser assets for Cloudflare Pages, excluding local secrets, dependencies, Supabase functions, and setup scripts.

### Changed
- Added Cloudflare deploy artifacts to `.gitignore` so temporary deploy folders and login output files stay out of source control.

**Live URL:** `https://YOUR-CLOUDFLARE-PAGES-URL.pages.dev`

**Files affected:** `.gitignore`, `CHANGELOG.md`, `package.json`, `package-lock.json`

---

## [2026-06-15] - Receipt Verification, Mobile Admin & Open Play Payment UX

### Added
- **Receipt verification details modal** - admin can now inspect OCR/payment details such as receipt time, amount, reference, receiver, confidence, and rejection reason.
- **Clear receipt rejection reasons** - rejected payments now show specific labels such as receipt before booking or reference already used instead of only "flagged".
- **Customer payment window text** - booking payment step now shows the exact Philippine time payment window before receipt upload.
- **QR zoom support** - payment QR images can be tapped/clicked to open a larger QR preview.
- **Open Play payment guide** - added a compact 4-step guide beside the QR: copy/tap QR, pay due amount, save receipt/reference, then attach receipt.

### Changed
- **Receipt duplicate-image hard rejection removed** - receipt checking now focuses on readable receipt content such as reference number, date/time, amount, receiver, and payment validity.
- **Mobile admin booking cards cleaned up** - mobile admin now uses compact booking cards with expandable payment details instead of crowded table-style rows.
- **Booking payment step simplified** - removed repeated duration/hourly-rate/court-fee/total block from the payment step because the summary is already shown elsewhere.
- **Open Play payment layout polished** - amount due, 50/100 payment controls, receiver details, QR, guide, reference, and receipt upload now use a cleaner mobile-friendly layout.
- **Open Play schedule subtitle shortened** - modal header now uses compact text like `Court Alpha - Jun 20 - 5PM-12AM`.

### Fixed
- **Full-payment-only Open Play layout** - when payment settings require full payment only, the GCash receiver strip now centers correctly with no empty column or off-center divider.
- **Open Play QR/guide balance** - QR and guide now use a 40/60 ratio on mobile so longer guide text fits without crowding.

**Files affected:** `index.html`, `admin.html`, `supabase-config.js`, `supabase/functions/verify-gcash-receipt/index.ts`

---

## [2026-06-15] - Open Play Multi-Court, Local Test Data & Promo Ads

### Added
- **Court-aware Open Play schedule** - admin can now apply Open Play to all courts or selected courts only. The Open Play court picker uses a compact 3-column grid so it stays clean for venues with many courts.
- **Per-court Open Play capacity** - player limits now count separately per court/day instead of sharing one global count across all courts.
- **Open Play reservation court filter** - admin Open Play Reservations list can be filtered by court.
- **Local data mode for testing** - localhost can run against browser-local seeded data with `?localData=1`, including 10 demo courts, without writing to the live Supabase project. `?remoteData=1` switches local browser testing back to live Supabase.
- **Local promo ad assets** - created promotional ad source and rendered PNG using actual Korte DOS booking UI screenshots for marketing to pickleball court owners.

### Changed
- **Public booking availability** now respects the selected Open Play courts, so non-Open-Play courts remain normally bookable.
- **Admin manual booking modal** now respects the same court-specific Open Play rules.
- **Open Play capacity label** changed to "Max Players per Court / Day" to clarify how multi-court sessions are counted.
- **Local data mode isolation** disables realtime subscriptions and external notification calls while testing locally.

### Fixed
- Saved Open Play court selections gracefully fall back to "All courts" when old/stale court IDs no longer exist.
- Open Play time checks in admin now support overnight ranges consistently with the public booking page.

**Files affected:** `admin.html`, `index.html`, `supabase-config.js`, `output/ads/*`

---

## [2026-06-14] — Google AdSense, Full-App Realtime & Weekly Billing Audit

### Added
- **Google AdSense** — site `kortedos.local` connected, verified, and approved ("Ready"). AdSense code snippet added to the `<head>` of `index.html`, `login.html`, and `admin.html` (publisher `ca-pub-YOUR_ADSENSE_ID`)
- **Full-app realtime** — live updates with no manual refresh across the public site and admin dashboard:
  - Public (`index.html`): realtime channel `public-rt` now subscribes to `bookings`, `courts`, `settings`, `blocked_dates`, and `open_play_registrations` — maintenance, blocked dates, open play, and rate changes all appear live (debounced via `refreshLiveViews()`)
  - Admin (`admin.html`): new `startAdminRealtime()` channel `admin-rt` subscribes to all 7 tables and re-renders the **current** section on change. `goto()` now tracks `_curSection`; guards skip re-render while a form field is focused or a modal is open
- **Billing audit trail** — each weekly statement now records the exact booking refs it billed (`weekly_fees.billed_refs`), and each booking is stamped with `billed_at` + `weekly_fee_id` so a booking is billed **exactly once**
- **Weekly remittance terms** in the court-owner agreement (now **Version 2**, forces re-sign): Section 3 renamed "Platform Booking Fee & Weekly Remittance" — defines the billable event (confirmed booking), customer-collected fee, weekly Mon–Sun statement, 5-day GCash due date with proof, and non-payment → suspension

### Changed
- **Platform fee is now a fixed constant** `PLATFORM_FEE_PER_BOOKING = 15` in `admin.html` — permanent ₱15.00 per confirmed booking that never changes. `generateWeeklyStatement()` no longer reads `settings.maintenance_fee` (that setting belongs to the separate monthly Maintenance report)
- **Weekly statement generation is now idempotent** — regenerating a week updates the existing statement (one per owner/week) instead of creating a duplicate, refuses to regenerate a paid statement, and stamps the billed bookings

### Security
- Admin realtime re-render is suppressed while the user is editing a form field or has a modal open — prevents clobbering in-progress input

### DB
- `20260614_billing_audit.sql` — added `bookings.billed_at` (timestamptz), `bookings.weekly_fee_id` (uuid), `weekly_fees.billed_refs` (jsonb); indexes `idx_bookings_billed_at`, `idx_bookings_weekly_fee_id`. Applied to live database
- All 7 tables added to the `supabase_realtime` publication with `replica identity full`: `accounts`, `blocked_dates`, `bookings`, `courts`, `open_play_registrations`, `settings`, `weekly_fees`

**Files affected:** `index.html`, `admin.html`, `login.html`, `supabase-config.js`, `supabase/migrations/20260614_billing_audit.sql`

---

## [2026-06-12] — Date Picker Label & Alignment

### Added
- **"SELECT DATE" label** above the date input in the court card times header — small uppercase muted text so players notice the date is changeable

### Fixed
- `display: none` leftover from an earlier experiment was hiding the date picker — removed to restore it
- `align-items: flex-start` on `.cc-times-head` caused uneven vertical spacing when the label was added — changed to `align-items: center` so the left block (title + subtitle) and right block (SELECT DATE + input) are symmetrically centered

**Files affected:** `index.html`

---

## [2026-06-12] — Mobile UX, Slot Colors & Past-Date Booking Fix

### Fixed
- **Past date booking** — Selecting a past date (e.g. Jun 11 when today is Jun 12) now marks all slots as "Past" and blocks booking. `toggleCardSlot()` also guards against past-date calls with a toast error
- `isPastDate_` flag added to `renderCourtsGrid()` slot renderer; availability badge now uses `curHour_badge = 999` for past dates (shows 0 available)

### Changed
- **Slot color redesign** — New dark navy + blue palette matching the logo/brand theme:
  - Available: `#0d1b2e` bg + blue-tint border (`rgba(37,99,235,.4)`), price in `#60a5fa`
  - Selected: Solid `#1d4ed8` blue fill + white text + blue glow ring — fully solid, no ambiguity
  - Booked/Taken: `#1c0a0a` dark red bg + red strikethrough time + masked name in red
  - Past: 38% opacity ghost — clearly unclickable
  - Hover transitions now use `@media (hover: hover)` — no stuck hover states on touch devices
  - Removed `scale()` and `translateY()` transforms on selected/hover — eliminates layout jank on mobile

**Files affected:** `index.html`

---

## [2026-06-12] — Mobile-Friendly Admin Dashboard

### Added
- **Sidebar backdrop overlay** — `#sidebarOverlay` div with dark semi-transparent background; tapping it closes the sidebar on mobile
- `toggleSidebar()` JS function — replaces inline `onclick` on burger button; syncs sidebar and overlay open/close state
- `.sidebar-overlay` CSS class with `backdrop-filter: blur(2px)`

### Changed
- **Responsive CSS overhaul** — replaced scattered media queries with consolidated breakpoints:
  - `≤900px`: sidebar fixed overlay, burger visible, `topbar` padding reduced to `14px 16px 0`
  - `≤700px`: `.toolbar` stacks vertically; nav badge hidden; Sign Out becomes ⏻ icon; reports period filter stacks; sidebar gets `box-shadow`
  - `≤480px`: modal becomes **bottom sheet** (slides up, `border-radius: 20px 20px 0 0`); modal footer buttons stack vertically
- Sidebar `open` state now includes `box-shadow: 4px 0 24px rgba(0,0,0,0.3)`
- `.role-bdg` gets `white-space: nowrap; flex-shrink: 0` — prevents "SYSTEM OWNER" from wrapping to two lines
- Sign Out button: text wrapped in `.sign-out-text` (hidden ≤700px) + `.sign-out-icon` ⏻ (shown ≤700px)
- Nav actions gap reduced to `6px` on mobile; `.btn-d` reduced to `8px 10px` padding on mobile
- `goto()` now also removes `.show` from `#sidebarOverlay` when navigating

**Files affected:** `admin.html`

---

## [2026-06-12] — Splash Screen Bottom Label Fix

### Fixed
- `.sp-bottom` location label was positioned at bottom-left instead of bottom-center
- Added `left: 50%; transform: translateX(-50%); white-space: nowrap` to center it horizontally

**Files affected:** `index.html`

---

## [2026-06-12] — Staff Login Link in Footer + Platform Fee Panel

### Added
- **Staff Login link** added to footer Support section in `index.html` — styled with muted color + separator line above it for subtle admin access
- **Platform Fee panel** in admin Payments section (`data-perm="owner_only"`) — System Owner configures per-hour or flat booking fee; labeled "SYSTEM OWNER" badge

### Changed
- Platform fee / developer rate moved from Courts section → Payments section; only visible to `owner` role

**Files affected:** `index.html`, `admin.html`

---

## [2026-06-13] — Slot Locking, Receipt Validation & Ghost Booking Fixes

### Added
- **Slot reservation on "Book Now"** — clicking Book Now immediately INSERTs a slim `verifying` booking (`status='verifying'`) before the form opens, so no other player can claim the same slot during the 15-minute fill-in window. If the slot is already taken, a toast blocks entry instead of letting two users race to the same DB insert.
- **15-minute countdown timer** (`#slotCountdown` banner) inside the booking modal — turns red in the last 60 seconds. On expiry the reservation is auto-cancelled server-side and the modal closes.
- **Yellow "⏳ Processing…" slot state** — `verifying` bookings render as animated yellow slots so other users immediately see a slot is being held. Slots held longer than 15 minutes automatically render as available (render-time expiry, no write needed).
- **`isHeldVerifying()` / `bookingHoldsSlot()` helpers** — centralise the reservation-window check so both the card grid and date-picker grid always agree on which slots are held vs free.
- **`expireStaleVerifyingBookings()`** called on DOMContentLoaded — cancels any `verifying` bookings older than 15 minutes in the DB on page load.
- **Receipt upload made mandatory** for GCash / GoTyme / PNB payments — the upload zone flashes red and scrolls into view if the user tries to submit without a file.
- **Cloudflare Pages deployment** — project connected to `your-github-account/your-court-booking-site` GitHub repo; auto-deploys to `your-site.pages.dev` on every push to `main`.

### Fixed
- **Ghost bookings / stuck "Processing…" slots** — root cause was a DB constraint: `bookings_payment_status_check` did not allow `'rejected'`, so every rejection UPDATE rolled back and the booking stayed `status='verifying'` forever. Fixed by adding `'rejected'` to the allowed values.
- **Edge function UPDATE silently failing for DUPLICATE_IMAGE/DUPLICATE_REF rejections** — the single large UPDATE wrote 10 fields atomically; any transient failure on one receipt_* metadata column rolled back the entire UPDATE including the critical `status='cancelled'`. Refactored to **two-pass UPDATE**: Pass 1 writes only `status` + `payment_status` (slot-gating fields) with `.select()` RETURNING to verify it landed; Pass 2 writes receipt_* metadata. A last-resort fallback issues a minimal `SET status='cancelled'` if Pass 1 fails, so the slot is freed no matter what.
- **`renderCourts()` not refreshing the active date-picker grid after rejection** — `renderCourts()` only refreshes the "today" card grid. After OCR rejection the code now also calls `onCardDate(courtId, date)` to free the slot in whichever date was selected at submit time.
- **`prevent_double_booking()` DB trigger blocking new reservations on expired holds** — trigger was updated to ignore `verifying` rows older than 15 minutes (`AND NOT (b.status='verifying' AND b.created_at < now() - interval '15 minutes')`), so an abandoned hold can no longer block a new booking at the DB level even if cleanup writes never ran.
- **30-second submit cooldown resetting after validation failures** — validation errors no longer consume the cooldown timer; only actual submission attempts count.
- **`updateBooking()` missing field mappings** — added `contactNumber`, `email`, `total`, `paymentMethod` to the mapper so slot-reservation-to-booking upgrades carry all customer fields correctly.

### Changed
- **`submitBooking()` UPDATE flow** — instead of a fresh INSERT, re-uses the reservation ref from `proceedToBook()` and UPDATEs the existing `verifying` row with full customer details, avoiding a second slot-conflict check and ensuring the reservation holds atomically through checkout.
- **Rejection message copy** — changed from "your booking is on hold" to "your booking has been cancelled — please make a new booking and upload a valid GCash receipt."
- **`expireStaleVerifyingBookings()` cutoff** aligned to `RESERVATION_MINUTES` (15 min) instead of the previous hardcoded 10 min.
- **Edge function response** now includes `warning` / `metadataWarning` fields when DB updates fail, making errors observable client-side instead of silently swallowed.

### DB
- `bookings_payment_status_check` constraint updated to include `'rejected'`
- `prevent_double_booking()` trigger updated to be time-aware (ignores expired `verifying` rows)
- Migration: `supabase/migrations/20260613_verifying_status.sql` — adds `'verifying'` to `bookings_status_check`

### Security
- Receipt upload required server-side (edge function always runs OCR) — client cannot skip verification by omitting the file
- Duplicate image / reference detection fires before OCR cost is incurred (hash check short-circuits)
- All rejection paths free the slot server-side regardless of client state (two-pass UPDATE + fallback)

**Files affected:** `index.html`, `supabase-config.js`, `supabase/functions/verify-gcash-receipt/index.ts`, `supabase/migrations/20260613_verifying_status.sql`

---



### Added
- **`verify-gcash-receipt` Edge Function** — server-side receipt image verification before a booking is confirmed
- **OCR.space integration** (`https://api.ocr.space/parse/image`, `OCREngine=2`) as primary OCR provider; Google Vision API was attempted but rejected (billing disabled on GCP project `consummate-mark-499309-c7`, returns `403 BILLING_DISABLED`)
- `runOCR(visionKey, ocrSpaceKey, base64, contentType)` helper — tries Vision API first, falls back to OCR.space automatically
- `OCRSPACE_API_KEY` secret set in Supabase (value kept out of repository)
- **Hard flag `IMAGE_UNREADABLE`** — no OCR text extracted (blank image, random photo, non-receipt) → automatically rejected; prevents submitting arbitrary images to bypass payment gate
- **Soft flag `OCR_UNAVAILABLE`** — OCR service itself unreachable → routes to manual review instead of hard reject
- **Decision routing**:
  - Any hard flag → `rejected`
  - Any soft flag → `manual_review`
  - Clean (ref match, amount match, correct merchant) → `auto_approved`: sets `bookings.status = 'confirmed'` and `payment_status = 'paid'` or `'downpayment_paid'`
- Migration: `supabase/migrations/20260613_receipt_verification.sql`

### Security
- Reference number cross-checked against booking record server-side — client cannot influence the comparison
- Receipt reuse prevented: each reference number is validated as unique per booking
- All verification decisions (approved / manual_review / rejected) stored with flag list for audit trail

### Verified
- End-to-end tested against live Edge Function:
  - Real receipt → `auto_approved` + `status=confirmed` ✓
  - Random image → `rejected (IMAGE_UNREADABLE)` ✓
  - Wrong-ref receipt → `rejected (REF_MISMATCH)` ✓

**Files affected:** `supabase/functions/verify-gcash-receipt/index.ts`, `supabase/migrations/20260613_receipt_verification.sql`

---

## [2026-06-15] — 3-Tier Role-Based Access Control

### Added
- New 3-tier role system replacing old 2-role model (`developer/manager`):
  - **System Owner** (`owner`) — full access: all sections + account management
  - **Court Owner** (`court_owner`) — operations & settings, no account management
  - **Court Staff** (`staff`) — front-desk only: bookings, payments, open play
- Permission matrix defined in `supabase-config.js → window.Auth.ROLE_PERMISSIONS`
- `Auth.can(action, role)` and `Auth.permissionsFor(role)` helpers for checking permissions
- Role selector dropdown in the Add/Edit Account modal
- `applyRoleVisibility(role)` function in `admin.html` — hides sidebar nav items and buttons via `data-perm` attributes
- Navigation guard in `goto()` — prevents accessing sections without permission
- 3 default accounts created in Supabase: `sysowner`, `courtowner`, `courtstaff`
- Migration file: `supabase/migrations/20260615_three_tier_roles.sql`

### Changed
- `admin.html`: sidebar nav items now carry `data-perm` attributes; role badge updated for 3 roles; booking delete guard uses `Auth.can('booking_delete')` instead of `isDev` check; fallback session role changed from `admin` → `staff` (least-privilege)
- `supabase-config.js`: `window.Auth` extended with role model, `ROLES`, `ROLE_LABELS`, `ROLE_PERMISSIONS`, `can()`, `permissionsFor()`, `hasRole()`; account `add()` default role changed from `manager` → `staff`; login fallback role changed from `admin` → `staff`
- `auth.js`: updated DEFAULT_ACCOUNTS to use `owner` role; `hasRole()` now checks `owner` for full access; `addManager()` accepts role parameter
- `create-accounts.js`: updated to 3 accounts (`owner`, `court_owner`, `staff`) with new emails
- `SETUP_NEW_SUPABASE.sql`: accounts table default role `manager` → `staff`, CHECK constraint updated

### DB
- Dropped old `accounts_role_check` constraint (`developer/admin/manager`)
- Remapped existing rows: `developer→owner`, `admin→court_owner`, `manager→staff`
- Added new `accounts_role_check` constraint: `('owner','court_owner','staff')`

**Files affected:** `admin.html`, `supabase-config.js`, `auth.js`, `create-accounts.js`, `SETUP_NEW_SUPABASE.sql`, `supabase/migrations/20260615_three_tier_roles.sql`, `CHANGELOG.md`

---

## [2026-06-12] — Rebrand + Color Theme Update

### Changed
- Renamed all instances of the legacy venue branding to "Korte DOS" across all pages
- Updated color theme to match Korte DOS logo: dark navy background + vivid blue accent
  - Primary: `#2563eb`, Dark: `#1848c8`, Glow: `rgba(37,99,235,.25)`
  - Background: `#0c1220`, Card: `#111b2d`, Border: `#1e3252`, Input: `#0e1828`
  - Admin light mode green → blue: `#2563eb / #1848c8`, bg `#dbeafe`
  - Admin dark mode green → blue: `#3b82f6 / #2563eb`, bg `#0d1f4a`
  - Login page hardcoded rgba green values updated to blue equivalents
- Navbar background changed from greenish `rgba(13,26,13,.95)` to navy `rgba(12,18,32,.95)`

**Files affected:** `index.html`, `admin.html`, `login.html`, `CHANGELOG.md`

---

## [2026-06-12] — Session: Initial Changelog Created

### Project State Snapshot (as of this date)
This is the baseline snapshot of the project when the changelog was introduced.

#### Pages
- `index.html` — Main public booking page (Korte DOS branding, dark/light mode, court booking form)
- `admin.html` — Admin dashboard with analytics charts (`chart.min.js`), booking management, dark/light theme
- `login.html` — Admin login page with Supabase auth

#### Scripts
- `script.js` — Main booking logic (form submission, slot availability, payment flow)
- `admin.js` — Admin dashboard logic (booking list, status updates, filters, charts)
- `auth.js` — Authentication helpers (session check, redirect guards)
- `supabase-config.js` — Supabase client initialization + global `window._supabase` + JSON/error helpers
- `create-accounts.js` — Utility for creating admin accounts
- `setup-db.js` — One-time DB setup utility

#### Styling
- `style.css` — Shared global styles

#### Supabase Edge Functions
- `create-payment-session` — Creates a secure GCash/PayMongo payment session server-side
- `payment-webhook` — Receives payment provider callbacks and updates booking payment status
- `send-confirmation-email` — Sends booking confirmation email to customer
- `send-reschedule-email` — Sends reschedule notification email
- `send-telegram-notification` — Sends Telegram alert to admin on new booking

#### Database Migrations (applied)
- `001_prevent_double_booking.sql` — Prevents overlapping bookings on the same court/time slot
- `002_enable_rls.sql` — Enables Row Level Security on all tables
- `20260227_payment_security.sql` — Adds `payment_sessions` table + payment columns on `bookings`
- `20260309_fix_payment_status_constraint.sql` — Fixes payment status check constraint
- `20260604_open_play_payment.sql` — Adds open play payment support

#### Docs
- `PAYMENT_SETUP.md` — Step-by-step guide for GCash/PayMongo payment integration
- `SETUP_NEW_SUPABASE.sql` — Full SQL script to bootstrap a fresh Supabase project

#### Stack
- Frontend: Vanilla HTML/CSS/JS (no build step)
- Backend: Supabase (Postgres + Auth + Edge Functions)
- Payment: PayMongo (GCash)
- Notifications: Telegram Bot + Email
- Local dev: `npx serve . -l 3000`

---

<!-- TEMPLATE — copy this block when making changes:

## [YYYY-MM-DD] — Brief title

### Added
- 

### Changed
- 

### Fixed
- 

### Removed
- 

**Files affected:** `file1.js`, `file2.html`

-->
