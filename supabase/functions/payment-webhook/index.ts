import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-payment-signature",
};

type WebhookBody = {
  session_id?: string;
  booking_ref?: string;
  provider_reference?: string;
  status?: string;
  paid_at?: string;
  raw?: unknown;
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      type?: string;
      data?: {
        id?: string;
        type?: string;
        attributes?: {
          status?: string;
          paid_at?: string;
          reference_number?: string;
          metadata?: Record<string, unknown>;
        };
      };
    };
  };
};

function normalizeStatus(input?: string) {
  const v = (input || "").toLowerCase();
  if (["paid", "succeeded", "success", "completed"].includes(v)) return "paid";
  if (["failed", "canceled", "cancelled", "expired"].includes(v)) return "failed";
  return "pending";
}

async function verifySignature(req: Request, bodyText: string) {
  const secret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  if (!secret) return true;
  const given = req.headers.get("x-payment-signature") || "";
  if (!given) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === given;
}

function parseWebhook(body: WebhookBody) {
  // Generic payload support
  let sessionId = body.session_id || null;
  let bookingRef = body.booking_ref || null;
  let providerRef = body.provider_reference || null;
  let normalized = normalizeStatus(body.status);
  let paidAtIso = body.paid_at || new Date().toISOString();

  // PayMongo event payload support
  const evType = body?.data?.attributes?.type || "";
  const evData = body?.data?.attributes?.data;
  if (evData) {
    providerRef = evData.id || providerRef;
    const evStatus = evData.attributes?.status || "";
    const evRef = evData.attributes?.reference_number || "";
    const evMeta = evData.attributes?.metadata || {};
    const metaRef = typeof evMeta.booking_ref === "string" ? evMeta.booking_ref : "";
    if (!bookingRef) bookingRef = evRef || metaRef || null;
    if (evStatus) normalized = normalizeStatus(evStatus);
    if (evData.attributes?.paid_at) paidAtIso = evData.attributes.paid_at;
    if (evType.toLowerCase().includes("paid")) normalized = "paid";
    if (evType.toLowerCase().includes("failed") || evType.toLowerCase().includes("expired")) normalized = "failed";
    if (!sessionId) sessionId = evData.id || null;
  }

  return { sessionId, bookingRef, providerRef, normalized, paidAtIso };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const rawText = await req.text();
    const valid = await verifySignature(req, rawText);
    if (!valid) return new Response("Invalid signature", { status: 401, headers: corsHeaders });

    const body = JSON.parse(rawText) as WebhookBody;
    const { sessionId, bookingRef, providerRef, normalized, paidAtIso } = parseWebhook(body);

    if (!sessionId && !bookingRef) {
      return new Response(JSON.stringify({ error: "Missing session_id or booking_ref" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const db = createClient(supabaseUrl, serviceRoleKey);

    const paymentUpdate: Record<string, unknown> = {
      status: normalized,
      provider_reference: providerRef,
      raw_webhook: body.raw ?? body,
      updated_at: new Date().toISOString(),
    };
    if (normalized === "paid") paymentUpdate.paid_at = paidAtIso;

    let bookingRefToUpdate = bookingRef;
    let localSessionId: string | null = null;

    if (sessionId) {
      // 1) Try local session id
      const { data: localRow } = await db.from("payment_sessions").select("id,booking_ref").eq("id", sessionId).single();
      if (localRow?.id) {
        localSessionId = localRow.id;
        if (!bookingRefToUpdate) bookingRefToUpdate = localRow.booking_ref || null;
      }
      // 2) Try provider reference
      if (!localSessionId) {
        const { data: providerRow } = await db.from("payment_sessions").select("id,booking_ref").eq("provider_reference", sessionId).single();
        if (providerRow?.id) {
          localSessionId = providerRow.id;
          if (!bookingRefToUpdate) bookingRefToUpdate = providerRow.booking_ref || null;
        }
      }
    }

    if (!localSessionId && providerRef) {
      const { data: providerRow2 } = await db.from("payment_sessions").select("id,booking_ref").eq("provider_reference", providerRef).single();
      if (providerRow2?.id) {
        localSessionId = providerRow2.id;
        if (!bookingRefToUpdate) bookingRefToUpdate = providerRow2.booking_ref || null;
      }
    }

    if (localSessionId) {
      await db.from("payment_sessions").update(paymentUpdate).eq("id", localSessionId);
    } else if (bookingRefToUpdate) {
      await db.from("payment_sessions").update(paymentUpdate).eq("booking_ref", bookingRefToUpdate);
    }

    if (bookingRefToUpdate) {
      const bookingUpdate: Record<string, unknown> = {
        payment_status: normalized,
      };
      if (normalized === "paid") {
        bookingUpdate.paid_at = paidAtIso;
      }
      if (normalized === "failed") bookingUpdate.status = "cancelled";
      const { data: bookingRow } = await db
        .from("bookings")
        .select("ref,booking_group_ref")
        .eq("ref", bookingRefToUpdate)
        .single();
      if (bookingRow?.booking_group_ref) {
        await db.from("bookings").update(bookingUpdate).eq("booking_group_ref", bookingRow.booking_group_ref);
      } else {
        await db.from("bookings").update(bookingUpdate).eq("ref", bookingRefToUpdate);
      }
    }

    return new Response(JSON.stringify({ ok: true, status: normalized }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
