-- ============================================================================
-- Remittance audit metrics
--
-- Adds read-only, snapshot-derived reconciliation metrics to the existing
-- remittance JSON contracts. No ledger row, booking row, or proof is changed.
-- Existing fields and RPC signatures remain unchanged.
-- ============================================================================

begin;

create or replace function public.booking_fee_remittance_summary_json(
  p_remittance_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with item_rows as materialized (
    select
      i.booking_ref,
      case
        when nullif(btrim(i.booking_group_ref), '') is not null
          then 'group:' || btrim(i.booking_group_ref)
        else 'booking:' || i.booking_ref
      end as reservation_key,
      i.fee_type,
      i.fee_rate,
      i.fee_units,
      i.fee_amount
    from public.booking_fee_remittance_items i
    where i.remittance_id = p_remittance_id
  ),
  audit_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count
    from item_rows i
  ),
  rate_breakdown as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      ),
      '[]'::jsonb
    ) as rows
    from (
      select
        i.fee_type,
        i.fee_rate,
        count(*)::integer as item_count,
        count(distinct i.reservation_key)::integer as reservation_count,
        round(sum(i.fee_units), 2) as fee_units,
        coalesce(
          round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
          0::numeric
        ) as billable_hours,
        (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
        round(sum(i.fee_amount), 2) as amount,
        case i.fee_type when 'per_hour' then 1 else 2 end as sort_order
      from item_rows i
      group by i.fee_type, i.fee_rate
    ) x
  )
  select jsonb_build_object(
    'id', r.id,
    'remittance_ref', r.remittance_ref,
    'cycle_due_on', r.cycle_due_on,
    'coverage_start_at', r.coverage_start_at,
    'cutoff_at', r.cutoff_at,
    'status', r.status,
    'currency', r.currency,
    'bookings_count', r.bookings_count,
    'booking_rows_count', m.booking_rows_count,
    'reservation_count', m.reservation_count,
    'billable_hours', m.billable_hours,
    'court_hours', m.billable_hours,
    'flat_fee_booking_count', m.flat_fee_booking_count,
    'fee_breakdown', rb.rows,
    'rate_type_breakdown', rb.rows,
    'amount_due', r.amount_due,
    'amount_settled', r.amount_settled,
    'remaining_balance', case
      when r.status = 'cancelled' then 0::numeric
      else greatest(round(r.amount_due - r.amount_settled, 2), 0)
    end,
    'prepared_at', r.prepared_at,
    'prepared_by_user_id', r.prepared_by_user_id,
    'prepared_by_email', r.prepared_by_email,
    'prepared_by_role', r.prepared_by_role,
    'owner_override', r.owner_override,
    'owner_override_reason', r.owner_override_reason,
    'last_submitted_at', r.last_submitted_at,
    'settled_at', r.settled_at,
    'cancelled_at', r.cancelled_at,
    'cancellation_reason', r.cancellation_reason,
    'latest_payment', (
      select jsonb_build_object(
        'id', p.id,
        'amount_submitted', p.amount_submitted,
        'amount_accepted', p.amount_accepted,
        'payment_method', p.payment_method,
        'payment_reference', p.payment_reference,
        'proof_path', p.proof_path,
        'note', p.note,
        'status', p.status,
        'submitted_at', p.submitted_at,
        'submitted_by_user_id', p.submitted_by_user_id,
        'submitted_by_email', p.submitted_by_email,
        'reviewed_at', p.reviewed_at,
        'reviewed_by_user_id', p.reviewed_by_user_id,
        'review_note', p.review_note
      )
      from public.booking_fee_remittance_payments p
      where p.remittance_id = r.id
      order by p.submitted_at desc, p.id desc
      limit 1
    ),
    'is_overdue', (
      r.status not in ('settled', 'cancelled')
      and timezone('Asia/Manila', now())::date > r.cycle_due_on
    ),
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
  from public.booking_fee_remittances r
  cross join audit_metrics m
  cross join rate_breakdown rb
  where r.id = p_remittance_id
$$;

create or replace function public.get_booking_fee_remittance_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  server_now timestamptz := clock_timestamp();
  local_date date;
  next_due date;
  accumulated_count integer := 0;
  accumulated_reservation_count integer := 0;
  accumulated_billable_hours numeric := 0;
  accumulated_flat_fee_booking_count integer := 0;
  accumulated_rate_type_breakdown jsonb := '[]'::jsonb;
  accumulated_amount numeric := 0;
  accumulated_start timestamptz;
  open_rows jsonb := '[]'::jsonb;
  open_remaining numeric := 0;
  settled_total numeric := 0;
  last_settled jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  local_date := timezone('Asia/Manila', server_now)::date;
  next_due := public.booking_fee_next_due_on(server_now);

  with unclaimed as materialized (
    select
      u.*,
      case
        when nullif(btrim(u.booking_group_ref), '') is not null
          then 'group:' || btrim(u.booking_group_ref)
        else 'booking:' || u.booking_ref
      end as reservation_key
    from public.booking_fee_unclaimed_rows() u
  )
  select
    count(*)::integer,
    count(distinct u.reservation_key)::integer,
    coalesce(
      round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
      0::numeric
    ),
    (count(*) filter (where u.fee_type = 'flat'))::integer,
    coalesce(round(sum(u.fee_amount), 2), 0::numeric),
    min(u.fee_earned_at),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      )
      from (
        select
          b.fee_type,
          b.fee_rate,
          count(*)::integer as item_count,
          count(distinct b.reservation_key)::integer as reservation_count,
          round(sum(b.fee_units), 2) as fee_units,
          coalesce(
            round(sum(b.fee_units) filter (where b.fee_type = 'per_hour'), 2),
            0::numeric
          ) as billable_hours,
          (count(*) filter (where b.fee_type = 'flat'))::integer as flat_fee_booking_count,
          round(sum(b.fee_amount), 2) as amount,
          case b.fee_type when 'per_hour' then 1 else 2 end as sort_order
        from unclaimed b
        group by b.fee_type, b.fee_rate
      ) x
    ), '[]'::jsonb)
    into
      accumulated_count,
      accumulated_reservation_count,
      accumulated_billable_hours,
      accumulated_flat_fee_booking_count,
      accumulated_amount,
      accumulated_start,
      accumulated_rate_type_breakdown
    from unclaimed u;

  select
    coalesce(
      jsonb_agg(
        public.booking_fee_remittance_summary_json(r.id)
        order by r.cycle_due_on, r.prepared_at
      ),
      '[]'::jsonb
    ),
    coalesce(sum(greatest(r.amount_due - r.amount_settled, 0)), 0)
    into open_rows, open_remaining
    from public.booking_fee_remittances r
   where r.status not in ('settled', 'cancelled');

  select public.booking_fee_remittance_summary_json(r.id)
    into last_settled
    from public.booking_fee_remittances r
   where r.status = 'settled'
    order by r.settled_at desc nulls last, r.prepared_at desc
    limit 1;

  select coalesce(round(sum(r.amount_settled), 2), 0)
    into settled_total
    from public.booking_fee_remittances r
   where r.status = 'settled';

  return jsonb_build_object(
    'server_now', server_now,
    'timezone', 'Asia/Manila',
    'role', account_role,
    'next_due_on', next_due,
    'can_prepare', local_date >= next_due and accumulated_amount > 0,
    'can_owner_override', account_role = 'owner',
    'accumulated', jsonb_build_object(
      'bookings_count', accumulated_count,
      'booking_rows_count', accumulated_count,
      'reservation_count', accumulated_reservation_count,
      'billable_hours', accumulated_billable_hours,
      'court_hours', accumulated_billable_hours,
      'flat_fee_booking_count', accumulated_flat_fee_booking_count,
      'fee_breakdown', accumulated_rate_type_breakdown,
      'rate_type_breakdown', accumulated_rate_type_breakdown,
      'amount', accumulated_amount,
      'coverage_start_at', accumulated_start
    ),
    'open_remaining_balance', round(open_remaining, 2),
    'total_outstanding_balance', round(open_remaining + accumulated_amount, 2),
    'settled_total', settled_total,
    'open_remittances', open_rows,
    'last_settled', last_settled
  );
end;
$$;

-- Keep the internal summary helper private and preserve the dashboard's
-- authenticated RPC contract after CREATE OR REPLACE.
revoke all on function public.booking_fee_remittance_summary_json(uuid)
  from public, anon, authenticated;
revoke all on function public.get_booking_fee_remittance_dashboard()
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_dashboard()
  to authenticated;

comment on function public.booking_fee_remittance_summary_json(uuid) is
  'Builds a permanent remittance summary with exact snapshot-derived reservation, hour, flat-fee, and rate/type reconciliation metrics.';
comment on function public.get_booking_fee_remittance_dashboard() is
  'Returns live accumulated fees and permanent remittance summaries with snapshot-derived audit metrics.';

notify pgrst, 'reload schema';

commit;
