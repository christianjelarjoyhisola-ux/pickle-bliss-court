# Secure GCash Payment Setup (Dynamic Amount + Auto Sync)

This project now supports:
- Dynamic downpayment amount from booking form
- Server-created payment session (no raw gateway URL logic in browser)
- Webhook-based auto update of booking payment status

## 1) Run DB Migration

Apply:

`supabase/migrations/20260227_payment_security.sql`

It adds:
- New payment columns on `bookings`
- `payment_sessions` table for checkout tracking

## 2) Deploy Supabase Edge Functions

Deploy:
- `supabase/functions/create-payment-session`
- `supabase/functions/payment-webhook`

Example:

```bash
supabase functions deploy create-payment-session
supabase functions deploy payment-webhook
```

## 3) Set Function Environment Variables

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAYMENT_PROVIDER`

Recommended (dynamic amount with PayMongo):
- `PAYMENT_PROVIDER=paymongo`
- `PAYMONGO_SECRET_KEY=sk_live_...` (or `sk_test_...`)
- `PAYMENT_SUCCESS_URL=https://your-domain/success`
- `PAYMENT_CANCEL_URL=https://your-domain/cancel`

Template fallback mode (legacy/static-link style):
- `PAYMENT_PROVIDER=template`
- `PAYMENT_CHECKOUT_URL_TEMPLATE=https://your-gateway-link?...`

Optional security:
- `PAYMENT_WEBHOOK_SECRET` (used by `payment-webhook` via `x-payment-signature` HMAC SHA-256)

## 4) Configure Gateway Webhook

Point your gateway webhook to:

`https://<project-ref>.functions.supabase.co/payment-webhook`

Send payload fields:
- `session_id` (preferred) or `booking_ref`
- `status` (`paid`, `failed`, etc.)
- `provider_reference` (optional)
- `paid_at` (optional)

## 5) Configure App Admin Settings

In Admin panel:
- Go to `Courts` -> `GCash Payment Settings`
- Enable checkout mode
- Set merchant name and number
- Save

The booking page will:
- Save booking
- Create secure payment session
- Open checkout URL returned by function
- Auto-sync payment status and confirm booking when webhook marks paid

## PayMongo-specific notes

- The function now creates a **new PayMongo Checkout Session per booking**, so amount is dynamic.
- Webhook handler supports PayMongo event payload parsing and maps provider session IDs back to your booking.

## 6) Security Notes

- Keep provider secrets only in Edge Function env vars.
- Do not expose service-role keys in frontend.
- Keep `payment_sessions` RLS locked (already included in migration).
- Use webhook signature validation (`PAYMENT_WEBHOOK_SECRET`) in production.
