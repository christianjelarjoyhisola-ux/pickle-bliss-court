import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type CreatePayload = {
  bookingRef: string;
  amountPhp?: number;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  metadata?: Record<string, string>;
};

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string | null;
  email: string | null;
  contact_number: string | null;
  court_id: string;
  slots: Array<string | number> | null;
  total: number | null;
  downpayment: number | null;
  status: string | null;
  payment_status: string | null;
};

type CourtRow = {
  rate: number | null;
  rate_schedule: Array<{ from: number; to: number; rate: number }> | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function extractErrMsg(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function closeMoney(a: number, b: number) {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01;
}

function settingMap(rows: Array<{ key: string; value: string }> | null) {
  const out: Record<string, string> = {};
  (rows || []).forEach((row) => { out[row.key] = row.value; });
  return out;
}

function parseTiers(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rateForHour(hour: number, tiers: Array<{ from: number; to: number; rate: number }>, fallbackRate: number) {
  for (const tier of tiers || []) {
    const from = toNumber(tier.from);
    const to = toNumber(tier.to);
    const rate = toNumber(tier.rate, fallbackRate);
    const inRange = from < to ? hour >= from && hour < to : hour >= from || hour < to;
    if (inRange) return rate;
  }
  return tiers && tiers.length > 0
    ? Math.min(...tiers.map((tier) => toNumber(tier.rate, fallbackRate)))
    : fallbackRate;
}

function expectedBookingAmounts(booking: BookingRow, court: CourtRow, settings: Record<string, string>) {
  const slots = (booking.slots || []).map(Number).filter(Number.isFinite);
  if (slots.length === 0) throw new Error("Booking has no billable slots");

  const courtRate = toNumber(court.rate);
  const tiers = Array.isArray(court.rate_schedule) && court.rate_schedule.length
    ? court.rate_schedule
    : parseTiers(settings.pricing_tiers);
  const usableTiers = tiers.length ? tiers : [{ from: 0, to: 24, rate: courtRate }];
  const courtTotal = slots.reduce((sum, hour) => sum + rateForHour(hour, usableTiers, courtRate), 0);

  const feeRate = toNumber(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee);
  const feeType = settings.fee_type === "flat" ? "flat" : "per_hour";
  const serviceFee = feeType === "flat" ? feeRate : feeRate * slots.length;
  const total = roundMoney(courtTotal + serviceFee);
  const half = roundMoney(total / 2);
  const storedDownpayment = toNumber(booking.downpayment, -1);
  const mode = settings.payment_acceptance_mode || "both";

  let due = half;
  if (mode === "full_payment_only") due = total;
  else if (mode === "downpayment_only") due = half;
  else if (closeMoney(storedDownpayment, total)) due = total;
  else if (closeMoney(storedDownpayment, half)) due = half;
  else throw new Error("Booking amount does not match current pricing");

  return { total, due };
}

async function loadBookingGroup(
  db: ReturnType<typeof createClient>,
  booking: BookingRow,
): Promise<BookingRow[]> {
  if (!booking.booking_group_ref) return [booking];
  const { data, error } = await db
    .from("bookings")
    .select("ref,booking_group_ref,full_name,email,contact_number,court_id,slots,total,downpayment,status,payment_status")
    .eq("booking_group_ref", booking.booking_group_ref)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data || []) as BookingRow[];
}

async function expectedBookingGroupAmounts(
  db: ReturnType<typeof createClient>,
  bookings: BookingRow[],
  settings: Record<string, string>,
) {
  let total = 0;
  let due = 0;
  for (const row of bookings) {
    const { data: court, error: courtErr } = await db
      .from("courts")
      .select("rate,rate_schedule")
      .eq("id", row.court_id)
      .single();
    if (courtErr || !court) throw courtErr || new Error("Court not found");
    const amounts = expectedBookingAmounts(row, court as CourtRow, settings);
    total += amounts.total;
    due += amounts.due;
  }
  return { total: roundMoney(total), due: roundMoney(due) };
}

async function createPayMongoCheckoutSession(input: {
  secretKey: string;
  amountPhp: number;
  bookingRef: string;
  customer: { name: string; email: string; phone: string };
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}) {
  const amountCents = Math.round(input.amountPhp * 100);
  const auth = btoa(`${input.secretKey}:`);

  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        payment_method_types: ["qrph", "paymaya"],
        line_items: [
          {
            currency: "PHP",
            amount: amountCents,
            name: `Booking ${input.bookingRef}`,
            quantity: 1,
            description: `Downpayment for booking ${input.bookingRef}`,
          },
        ],
        reference_number: input.bookingRef,
        description: `Downpayment for ${input.bookingRef}`,
        metadata: input.metadata,
        billing: {
          name: input.customer.name,
          email: input.customer.email,
          phone: input.customer.phone,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    },
  };

  const res = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayMongo error ${res.status}: ${extractErrMsg(json)}`);

  const sessionId = json?.data?.id || null;
  const checkoutUrl = json?.data?.attributes?.checkout_url || null;
  if (!sessionId || !checkoutUrl) throw new Error("PayMongo response missing session id or checkout_url");

  return { sessionId, checkoutUrl };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const provider = (Deno.env.get("PAYMENT_PROVIDER") || "paymongo").toLowerCase();
    const db = createClient(supabaseUrl, serviceRoleKey);

    const body = (await req.json()) as CreatePayload;
    const bookingRef = String(body.bookingRef || "").trim();
    if (!bookingRef) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: booking, error: bookingErr } = await db
      .from("bookings")
      .select("ref,booking_group_ref,full_name,email,contact_number,court_id,slots,total,downpayment,status,payment_status")
      .eq("ref", bookingRef)
      .single();
    if (bookingErr || !booking) {
      return new Response(JSON.stringify({ error: "Booking not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (booking.status === "cancelled" || booking.payment_status === "paid" || booking.payment_status === "downpayment_paid") {
      return new Response(JSON.stringify({ error: "Booking is not payable" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settingRows, error: settingsErr } = await db.from("settings").select("key,value");
    if (settingsErr) throw settingsErr;
    const settings = settingMap(settingRows as Array<{ key: string; value: string }>);
    const bookingGroup = await loadBookingGroup(db, booking as BookingRow);
    const amounts = await expectedBookingGroupAmounts(db, bookingGroup, settings);

    const requestedAmount = Number(body.amountPhp);
    if (Number.isFinite(requestedAmount) && !closeMoney(requestedAmount, amounts.due)) {
      return new Response(JSON.stringify({ error: "Payment amount does not match booking price" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sessionId = crypto.randomUUID();
    const amountPhp = amounts.due;
    const customer = {
      name: body.customer?.name || booking.full_name || "Customer",
      email: body.customer?.email || booking.email || "",
      phone: body.customer?.phone || booking.contact_number || "",
    };
    const metadata = {
      ...(body.metadata || {}),
      booking_ref: bookingRef,
      ...(booking.booking_group_ref ? { booking_group_ref: booking.booking_group_ref } : {}),
    };

    let checkoutUrl = "";
    let providerSessionId = sessionId;
    let providerName = provider;

    if (provider !== "paymongo") throw new Error("Only PAYMENT_PROVIDER=paymongo is supported");

    const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
    const successUrl = Deno.env.get("PAYMENT_SUCCESS_URL") || "";
    const cancelUrl = Deno.env.get("PAYMENT_CANCEL_URL") || "";
    if (!secretKey) throw new Error("PAYMONGO_SECRET_KEY is missing");
    if (!successUrl || !cancelUrl) throw new Error("PAYMENT_SUCCESS_URL or PAYMENT_CANCEL_URL is missing");

    const out = await createPayMongoCheckoutSession({
      secretKey,
      amountPhp,
      bookingRef,
      customer,
      successUrl,
      cancelUrl,
      metadata,
    });
    providerSessionId = out.sessionId;
    checkoutUrl = out.checkoutUrl;
    providerName = "paymongo";

    const nowIso = new Date().toISOString();
    const paymentRow = {
      id: sessionId,
      booking_ref: bookingRef,
      provider: providerName,
      provider_reference: providerSessionId,
      amount_php: amountPhp,
      status: "pending",
      checkout_url: checkoutUrl,
      raw_request: body,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { error: sessErr } = await db.from("payment_sessions").insert(paymentRow);
    if (sessErr) throw sessErr;

    const bookingUpdate = {
      payment_status: "pending",
      payment_provider: providerName,
      payment_session_id: sessionId,
      payment_checkout_url: checkoutUrl,
    };
    const { error: bErr } = booking.booking_group_ref
      ? await db.from("bookings").update(bookingUpdate).eq("booking_group_ref", booking.booking_group_ref).neq("status", "cancelled")
      : await db.from("bookings").update(bookingUpdate).eq("ref", bookingRef);
    if (bErr) throw bErr;

    return new Response(JSON.stringify({
      ok: true,
      provider: providerName,
      sessionId: sessionId,
      providerSessionId,
      checkoutUrl,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: extractErrMsg(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
