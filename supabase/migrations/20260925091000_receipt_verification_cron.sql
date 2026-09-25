-- Supabase Vault must contain receipt_project_url and receipt_service_role_key.
-- Reuse the existing backend key; never put it in source or cron command text.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_receipt_jobs() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare project_url text; service_key text; j record; dispatched integer := 0;
begin
  if not exists(select 1 from public.receipt_verification_jobs where
    (status='queued' and available_at<=now()) or (status='processing' and lease_until<=now()))
    and not exists(select 1 from public.receipt_confirmation_outbox where
    (status='queued' and available_at<=now()) or (status='processing' and lease_until<=now())) then return 0; end if;
  select decrypted_secret into project_url from vault.decrypted_secrets where name='receipt_project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name='receipt_service_role_key';
  if project_url is null or service_key is null then raise exception 'Receipt worker Vault configuration missing'; end if;
  for j in select id from public.receipt_verification_jobs where
    (status='queued' and available_at<=now()) or (status='processing' and lease_until<=now())
    order by created_at limit 2
  loop
    perform net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/verify-gcash-receipt',
      headers:=jsonb_build_object('Content-Type','application/json','apikey',service_key) || case when service_key like 'eyJ%' then jsonb_build_object('Authorization','Bearer '||service_key) else '{}'::jsonb end,
      body:=jsonb_build_object('action','process_job','jobId',j.id), timeout_milliseconds:=120000);
    dispatched := dispatched+1;
  end loop;
  for j in select id from public.receipt_confirmation_outbox where
    (status='queued' and available_at<=now()) or (status='processing' and lease_until<=now())
    order by created_at limit 2
  loop
    perform net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/verify-gcash-receipt',
      headers:=jsonb_build_object('Content-Type','application/json','apikey',service_key) || case when service_key like 'eyJ%' then jsonb_build_object('Authorization','Bearer '||service_key) else '{}'::jsonb end,
      body:=jsonb_build_object('action','process_notification','notificationId',j.id), timeout_milliseconds:=30000);
    dispatched := dispatched+1;
  end loop;
  return dispatched;
end;
$$;
revoke all on function public.dispatch_receipt_jobs() from public,anon,authenticated;
grant execute on function public.dispatch_receipt_jobs() to service_role;
select cron.schedule('receipt-verification-retries','* * * * *','select public.dispatch_receipt_jobs()');
