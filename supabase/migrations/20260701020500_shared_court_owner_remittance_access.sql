-- Remittance statements are venue-level obligations. Every court_owner account
-- for the venue should see the same statements and be able to submit proof.
-- The guard_weekly_fee_court_owner_update trigger still restricts court owners
-- to proof-submission fields only.

alter table if exists public.weekly_fees enable row level security;

drop policy if exists weekly_fees_select_auth on public.weekly_fees;
drop policy if exists weekly_fees_select_role_scoped on public.weekly_fees;
create policy weekly_fees_select_role_scoped
  on public.weekly_fees
  for select
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner'])
  );

drop policy if exists weekly_fees_update_auth on public.weekly_fees;
drop policy if exists weekly_fees_update_role_scoped on public.weekly_fees;
create policy weekly_fees_update_role_scoped
  on public.weekly_fees
  for update
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner'])
  )
  with check (
    public.has_account_role(array['owner'])
    or (
      public.has_account_role(array['court_owner'])
      and status = 'submitted'
    )
  );

notify pgrst, 'reload schema';
