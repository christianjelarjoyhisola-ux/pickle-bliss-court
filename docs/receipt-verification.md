# Receipt verification operations

Finalizing a staged booking receipt creates a durable job in the same database transaction. The browser can start that job immediately; the database scheduler also checks once per minute. Closing the checkout page does not discard verification work.

## Deployment configuration

Apply `20260925090000_receipt_verification_jobs.sql` once, deploy `verify-gcash-receipt` and `send-confirmation-email`, then apply `20260925091000_receipt_verification_cron.sql`.

Supabase Vault must contain:

- `receipt_project_url`: this project's Supabase URL.
- `receipt_service_role_key`: an existing backend API key for this project. Despite the configuration name, this accepts the modern `sb_secret_` key. Use the modern key for this project's current setup.

The dispatcher sends modern keys on the `apikey` header. Functions validate them against the platform's `SUPABASE_SECRET_KEYS` dictionary. Legacy service keys remain supported for older environments. Never place credentials in source code, SQL snippets, browser code, or cron command text. The cron command only calls `public.dispatch_receipt_jobs()`.

The two migrations were applied through this project's dashboard on September 25, 2026. Do not blindly rerun the initial table-creation migration.

## Retry and review behavior

- Verification has a five-minute lease and at most three attempts, with increasing retry delays. Provider errors remain available in the admin receipt dialog and job table.
- The worker sends the actual stored image to Google Vision. It avoids the costly local image transformations that previously exceeded the Edge Function CPU limit.
- Amount and timing checks use the original committed booking and booking-start timestamp. A reread does not create a new payment window.
- Reference parsing prefers the receipt's labeled reference, supports grouped digits, and never joins unrelated numeric lines. A customer phone number is not accepted as a payment reference.
- The transaction-history layout requires an outgoing debit and the transfer destination; credits and ambiguous amount blocks are not treated as payments.
- The receipt result, audit, and booking status are committed together. Expired leases and replaced receipts cannot commit. Existing paid, confirmed, completed, or cancelled states are preserved.
- An authorized admin can use **Re-read receipt** for a finalized stored upload. Legacy receipts without a finalized upload record need manual review.

New automatic approvals enqueue a frozen confirmation-email payload. Delivery is leased, uses a stable Resend idempotency key, and stops retrying before the provider's 24-hour idempotency window expires. Admin rereads and existing approvals do not resend confirmations. The customer browser suppresses its former email send when server delivery manages the result.

## Validation

Run `npm run test:receipts` with Node and Deno installed. Tests cover OCR references and history layouts, caller permissions, both API-key formats, replay behavior, database leases, retries, replaced proof, concurrent admin decisions, protected approvals, audit uniqueness, and the confirmation outbox.

For production diagnostics, inspect `receipt_verification_jobs`, `receipt_confirmation_outbox`, `cron.job_run_details`, and `net._http_response`. A completed job with `manual_review` is an intentional review result, not a failed worker. Receipt OCR does not independently check the receiving wallet.
