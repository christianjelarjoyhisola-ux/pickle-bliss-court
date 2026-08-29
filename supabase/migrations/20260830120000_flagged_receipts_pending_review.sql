-- Receipt OCR/fraud checks are advisory. A duplicate reference or a receipt
-- timestamp outside the booking window must remain pending for admin review;
-- it must never be auto-cancelled or pre-confirmed.

-- Bind each immutable audit record to the exact private receipt object so an
-- admin never sees flags from a different upload that reused the same booking
-- reference. Existing rows continue to use the stored image hash as fallback.
alter table public.receipt_verifications
  add column if not exists storage_path text;

create index if not exists idx_receipt_verifications_storage_path
  on public.receipt_verifications (storage_path, created_at desc)
  where storage_path is not null and storage_path <> '';

-- Maya used to be confirmed during staged finalization, before OCR and replay
-- checks ran. Disable that early approval so the Edge verifier can either
-- confirm a normal GCash-to-Maya/Maya receipt or leave a flagged one pending.
-- Keep the trigger and function in place so this change is reversible and does
-- not remove schema objects from an existing installation.
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'trg_15_auto_approve_maya_staged_receipt'
      and tgrelid = 'public.bookings'::regclass
      and not tgisinternal
  ) then
    alter table public.bookings
      disable trigger trg_15_auto_approve_maya_staged_receipt;
  end if;
end
$$;

-- Earlier Maya verification namespaced every reference as `maya:<ref>`. A
-- 13-digit value is actually a GCash transaction reference, so add its bare
-- canonical alias. This lets GCash and GCash-to-Maya submissions share the
-- same replay guard without altering or deleting the historical ledger row.
insert into public.used_gcash_refs (gcash_ref, booking_ref, provider, used_at)
select substring(gcash_ref from 6), booking_ref, 'maya', used_at
from public.used_gcash_refs
where gcash_ref ~ '^maya:[0-9]{13}$'
on conflict (gcash_ref) do nothing;

-- Court Staff already have the Payment Review permission. Let that role see
-- and update hosted-session payment rows just as it can review normal court
-- and Open Play payments; hosts remain limited to their own sessions.
alter policy open_play_host_session_registrations_select_host_roles
  on public.open_play_host_session_registrations
  using (
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

alter policy open_play_host_session_registrations_update_host_roles
  on public.open_play_host_session_registrations
  using (
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  )
  with check (
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
