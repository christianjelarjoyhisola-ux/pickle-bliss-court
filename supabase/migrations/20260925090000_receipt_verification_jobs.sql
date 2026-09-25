-- Durable receipt work. Browser, cron and admin requests use the same leases.
create table public.receipt_verification_jobs (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.receipt_staged_uploads(id),
  booking_ref text not null,
  requested_by uuid,
  request_key uuid unique,
  status text not null default 'queued' check (status in ('queued','processing','done','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  outcome jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index receipt_jobs_one_active_upload on public.receipt_verification_jobs(upload_id)
  where status in ('queued','processing');
create index receipt_jobs_due on public.receipt_verification_jobs(available_at) where status in ('queued','processing');
alter table public.receipt_verification_jobs enable row level security;
revoke all on public.receipt_verification_jobs from anon, authenticated;
grant all on public.receipt_verification_jobs to service_role;

-- Frozen email payloads allow retries without duplicate confirmations. Admin
-- re-reads and already-approved bookings never enqueue historical emails.
create table public.receipt_confirmation_outbox (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null unique references public.receipt_staged_uploads(id),
  payload jsonb not null,
  status text not null default 'queued' check(status in ('queued','processing','done','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  last_error text
);
alter table public.receipt_confirmation_outbox enable row level security;
revoke all on public.receipt_confirmation_outbox from anon,authenticated;
grant all on public.receipt_confirmation_outbox to service_role;

create function public.claim_receipt_confirmation(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare n public.receipt_confirmation_outbox;
begin
  select * into n from public.receipt_confirmation_outbox where id=p_id for update;
  if not found then raise exception 'Confirmation not found'; end if;
  if n.status in ('done','failed') then return jsonb_build_object('status',n.status); end if;
  if (n.status='processing' and n.lease_until>now()) or n.available_at>now() then
    return jsonb_build_object('status','busy');
  end if;
  -- Resend remembers idempotency keys for 24 hours. Never retry beyond that.
  if n.attempts>=3 or n.created_at<now()-interval '23 hours' then
    update public.receipt_confirmation_outbox set status='failed',last_error=coalesce(last_error,'Confirmation retry window expired') where id=n.id;
    return jsonb_build_object('status','failed');
  end if;
  update public.receipt_confirmation_outbox set status='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=n.id returning * into n;
  return to_jsonb(n);
end;
$$;
revoke all on function public.claim_receipt_confirmation(uuid) from public,anon,authenticated;
grant execute on function public.claim_receipt_confirmation(uuid) to service_role;

alter table public.receipt_verifications
  add column job_id uuid unique references public.receipt_verification_jobs(id),
  add column requested_by uuid,
  add column booking_state_before jsonb,
  add column booking_state_after jsonb;

create function public.queue_consumed_receipt() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'consumed' and old.status is distinct from new.status then
    insert into public.receipt_verification_jobs(upload_id, booking_ref)
      values (new.id, new.booking_ref) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.queue_consumed_receipt() from public, anon, authenticated;
create trigger receipt_consumed_queue after update of status on public.receipt_staged_uploads
for each row execute function public.queue_consumed_receipt();

-- Enqueue admin retries with request-level idempotency. Repeated clicks while
-- work is active share that work; a completed attempt needs a new request key.
create function public.enqueue_receipt_reread(p_upload_id uuid, p_actor uuid, p_request_key uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.receipt_staged_uploads; job_id uuid;
begin
  if p_actor is null or p_request_key is null then raise exception 'Admin and request key required'; end if;
  select * into u from public.receipt_staged_uploads where id=p_upload_id and status='consumed' for update;
  if not found then raise exception 'Stored receipt is unavailable'; end if;
  select id into job_id from public.receipt_verification_jobs where request_key=p_request_key;
  if job_id is not null then return job_id; end if;
  select id into job_id from public.receipt_verification_jobs
    where upload_id=u.id and status in ('queued','processing');
  if job_id is not null then return job_id; end if;
  insert into public.receipt_verification_jobs(upload_id,booking_ref,requested_by,request_key)
    values(u.id,u.booking_ref,p_actor,p_request_key) returning id into job_id;
  return job_id;
end;
$$;

create function public.claim_receipt_job(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.receipt_verification_jobs;
begin
  select * into j from public.receipt_verification_jobs where id=p_job_id for update;
  if not found then raise exception 'Receipt job not found'; end if;
  if j.status in ('done','failed') then return to_jsonb(j); end if;
  if (j.status='processing' and j.lease_until > now()) or j.available_at > now() then
    return jsonb_build_object('id',j.id,'status','busy');
  end if;
  if j.attempts >= 3 then
    update public.receipt_verification_jobs set status='failed', finished_at=now(),
      last_error=coalesce(last_error,'Verification worker did not finish after three attempts'),
      lease_token=null, lease_until=null where id=j.id returning * into j;
    return to_jsonb(j);
  end if;
  update public.receipt_verification_jobs set status='processing', attempts=attempts+1,
    lease_token=gen_random_uuid(), lease_until=now()+interval '5 minutes'
    where id=j.id returning * into j;
  return to_jsonb(j);
end;
$$;

create function public.fail_receipt_job(p_job_id uuid,p_lease uuid,p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.receipt_verification_jobs
  set status=case when attempts>=3 then 'failed' else 'queued' end,
      last_error=left(p_error,1000), lease_token=null, lease_until=null,
      available_at=now()+make_interval(mins=>attempts),
      finished_at=case when attempts>=3 then now() end
  where id=p_job_id and status='processing' and lease_token=p_lease;
$$;

-- Commit the booking and immutable audit together, while holding the group
-- locks. A late worker cannot undo an admin decision, reprocess replaced proof,
-- or commit after another worker has acquired its expired lease.
create function public.finish_receipt_job(p_job_id uuid,p_lease uuid,p_audit jsonb,p_metadata jsonb,p_outcome jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.receipt_verification_jobs; b public.bookings; u public.receipt_staged_uploads;
  before_state jsonb; after_state jsonb; group_key text; protected boolean;
begin
  select * into j from public.receipt_verification_jobs where id=p_job_id for update;
  if j.status is distinct from 'processing' or j.lease_token is distinct from p_lease or j.lease_until<=now() then
    raise exception 'Receipt job lease expired';
  end if;
  select * into u from public.receipt_staged_uploads where id=j.upload_id and status='consumed';
  if not found then raise exception 'Stored receipt is unavailable'; end if;
  select * into b from public.bookings where ref=j.booking_ref;
  if not found then raise exception 'Booking no longer exists'; end if;
  group_key := b.booking_group_ref;
  perform 1 from public.bookings where ref=b.ref or (group_key is not null and booking_group_ref=group_key)
    order by ref for update;
  if exists(select 1 from public.bookings where (ref=b.ref or (group_key is not null and booking_group_ref=group_key))
    and (receipt_image_url is distinct from u.storage_path or receipt_image_hash is distinct from u.image_hash)) then
    raise exception 'Booking receipt changed during verification';
  end if;
  select jsonb_agg(jsonb_build_object('ref',ref,'status',status,'payment_status',payment_status,'gcash_ref',gcash_ref) order by ref),
    bool_or(payment_status in ('paid','downpayment_paid') or status in ('confirmed','completed','cancelled'))
    into before_state,protected from public.bookings
    where ref=b.ref or (group_key is not null and booking_group_ref=group_key);
  -- Check the reference and original timestamp used by OCR are still current.
  if exists(select 1 from public.bookings where ref=b.ref and
    (gcash_ref is distinct from p_audit->>'typed_ref' or created_at is distinct from (p_audit->>'booking_created_at')::timestamptz)) then
    raise exception 'Booking changed during verification';
  end if;
  if p_outcome->>'status' not in ('auto_approved','manual_review') then raise exception 'Invalid receipt outcome'; end if;
  update public.bookings set
    receipt_status=p_metadata->>'receipt_status',
    receipt_flags=array(select jsonb_array_elements_text(p_metadata->'receipt_flags')),
    receipt_extracted=p_metadata->'receipt_extracted',
    receipt_confidence=(p_metadata->>'receipt_confidence')::numeric,
    receipt_verified_at=(p_metadata->>'receipt_verified_at')::timestamptz,
    receipt_phash=p_metadata->>'receipt_phash',
    status=case when protected then status when p_outcome->>'status'='auto_approved' then 'confirmed' else 'pending' end,
    payment_status=case when protected then payment_status
      when p_outcome->>'status'='auto_approved' then
        case when downpayment>=total-5 then 'paid' else 'downpayment_paid' end
      else 'for_verification' end
  where ref=b.ref or (group_key is not null and booking_group_ref=group_key);
  select jsonb_agg(jsonb_build_object('ref',ref,'status',status,'payment_status',payment_status,'gcash_ref',gcash_ref) order by ref)
    into after_state from public.bookings where ref=b.ref or (group_key is not null and booking_group_ref=group_key);
  insert into public.receipt_verifications(booking_ref,result,flags,extracted,confidence,image_hash,phash,storage_path,raw_ocr_text,
    job_id,requested_by,booking_state_before,booking_state_after)
  values(j.booking_ref,p_audit->>'result',array(select jsonb_array_elements_text(p_audit->'flags')),p_audit->'extracted',
    (p_audit->>'confidence')::numeric,u.image_hash,p_audit->>'phash',u.storage_path,p_audit->>'raw_ocr_text',
    j.id,j.requested_by,before_state,after_state);
  if not protected and j.requested_by is null and p_outcome->>'status'='auto_approved'
     and nullif(p_metadata->'confirmation'->>'email','') is not null then
    insert into public.receipt_confirmation_outbox(upload_id,payload)
      values(u.id,p_metadata->'confirmation') on conflict(upload_id) do nothing;
  end if;
  p_outcome := p_outcome || jsonb_build_object('preservedApproval',protected,'notificationsManaged',true);
  update public.receipt_verification_jobs set status='done',finished_at=now(),outcome=p_outcome,
    lease_token=null,lease_until=null,last_error=null where id=j.id;
  return p_outcome;
end;
$$;

revoke all on function public.enqueue_receipt_reread(uuid,uuid,uuid), public.claim_receipt_job(uuid),
  public.fail_receipt_job(uuid,uuid,text), public.finish_receipt_job(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_receipt_reread(uuid,uuid,uuid), public.claim_receipt_job(uuid),
  public.fail_receipt_job(uuid,uuid,text), public.finish_receipt_job(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

-- Recover only unresolved bookings with no saved result. Historical manual
-- approvals and flagged receipts need an explicit admin re-read instead.
insert into public.receipt_verification_jobs(upload_id,booking_ref)
select u.id,u.booking_ref from public.receipt_staged_uploads u join public.bookings b on b.ref=u.booking_ref
where u.status='consumed' and u.storage_deleted_at is null and b.status='pending'
  and b.payment_status='for_verification' and b.receipt_status='none'
  and b.receipt_image_url=u.storage_path
  and not exists(select 1 from public.receipt_verifications v where v.storage_path=u.storage_path)
on conflict do nothing;
notify pgrst,'reload schema';
