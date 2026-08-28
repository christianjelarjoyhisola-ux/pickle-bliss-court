-- Maya checkout policy:
--   * Customers may send to the configured Maya account from either Maya or
--     GCash, so both reference formats are valid.
--   * Once the staged receipt and booking hold pass the server-side checks,
--     approve the booking in the same transaction. OCR still runs afterward
--     for audit data, but it cannot leave a successful Maya checkout pending.

-- Keep the existing hardened finalization function intact and narrowly relax
-- its Maya reference check. CREATE OR REPLACE preserves the function identity,
-- owner, grants, SECURITY DEFINER setting, and atomic hold/slot validations.
do $migration$
declare
  function_ddl text;
  old_check text := $old$!~ '^[A-Z0-9]{12}$'$old$;
  new_check text := $new$!~ '^([A-Z0-9]{12}|[0-9]{13})$'$new$;
begin
  if to_regprocedure(
    'public.finalize_staged_booking(text,text,uuid,text,text,text,text,text,text,jsonb)'
  ) is null then
    raise exception 'public.finalize_staged_booking was not found';
  end if;

  select pg_get_functiondef(to_regprocedure(
    'public.finalize_staged_booking(text,text,uuid,text,text,text,text,text,text,jsonb)'
  )) into function_ddl;

  if position(new_check in function_ddl) > 0 then
    return;
  end if;
  if position(old_check in function_ddl) = 0 then
    raise exception 'Expected Maya reference validation was not found in finalize_staged_booking';
  end if;

  execute replace(function_ddl, old_check, new_check);
end;
$migration$;

create or replace function public.auto_approve_maya_staged_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- This is deliberately limited to the service-owned staged-finalization
  -- transition. Missing uploads, expired holds, invalid prices, and slot
  -- conflicts fail before this trigger can approve anything.
  if old.status = 'verifying'
     and new.status = 'pending'
     and new.payment_status = 'for_verification'
     and lower(trim(coalesce(new.payment_method, ''))) = 'maya'
     and nullif(trim(coalesce(new.receipt_image_url, '')), '') is not null
     and new.receipt_image_hash ~ '^[0-9a-f]{64}$' then
    new.status := 'confirmed';
    new.payment_status := case
      when coalesce(new.downpayment, 0) >= coalesce(new.total, 0) - 0.01 then 'paid'
      else 'downpayment_paid'
    end;
    new.receipt_status := 'auto_approved';
    new.receipt_flags := coalesce(new.receipt_flags, '{}'::text[]);
    if not ('MAYA_POLICY_AUTO_APPROVED' = any(new.receipt_flags)) then
      new.receipt_flags := array_append(new.receipt_flags, 'MAYA_POLICY_AUTO_APPROVED');
    end if;
    new.receipt_extracted := coalesce(new.receipt_extracted, '{}'::jsonb)
      || jsonb_build_object('approvalPolicy', 'maya_auto_approve');
    new.receipt_verified_at := clock_timestamp();
  end if;

  return new;
end;
$$;

-- Trigger order is intentional: policy approval runs before the existing
-- trg_20_mark_booking_fee_earned trigger so the earned-fee snapshot sees the
-- final confirmed/paid state.
drop trigger if exists trg_15_auto_approve_maya_staged_receipt on public.bookings;
create trigger trg_15_auto_approve_maya_staged_receipt
before update on public.bookings
for each row execute function public.auto_approve_maya_staged_receipt();

revoke all on function public.auto_approve_maya_staged_receipt() from public, anon, authenticated;

notify pgrst, 'reload schema';
