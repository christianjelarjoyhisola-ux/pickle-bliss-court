const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type ServiceStatus = {
  id: string;
  label: string;
  configured: boolean;
  required: string[];
  recommended?: string[];
  missing: string[];
  note?: string;
};

function hasEnv(name: string): boolean {
  return Boolean((Deno.env.get(name) || "").trim());
}

function missingEnv(names: string[]): string[] {
  return names.filter((name) => !hasEnv(name));
}

function service(
  id: string,
  label: string,
  required: string[],
  recommended: string[] = [],
  note = "",
): ServiceStatus {
  const missing = missingEnv(required);
  return {
    id,
    label,
    required,
    recommended,
    missing,
    configured: missing.length === 0,
    note,
  };
}

function receiptOcrService(): ServiceStatus {
  const configured = hasEnv("GOOGLE_VISION_API_KEY");
  return {
    id: "ocr",
    label: "Receipt OCR",
    configured,
    required: ["GOOGLE_VISION_API_KEY"],
    recommended: [],
    missing: configured ? [] : ["GOOGLE_VISION_API_KEY"],
    note: configured
      ? "Receipt verification uses Google Vision."
      : "Add Google Vision for receipt OCR.",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(req.method)) {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const serviceRoleConfigured = hasEnv("SERVICE_ROLE_KEY") || hasEnv("SUPABASE_SERVICE_ROLE_KEY");
  const services: ServiceStatus[] = [
    service("email", "Email confirmations", ["RESEND_API_KEY"], ["EMAIL_FROM"]),
    service("telegram", "Telegram admin alerts", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], ["APP_ADMIN_URL"]),
    service("payments", "PayMongo checkout", ["PAYMONGO_SECRET_KEY", "PAYMENT_SUCCESS_URL", "PAYMENT_CANCEL_URL"], ["PAYMENT_WEBHOOK_SECRET"]),
    receiptOcrService(),
    {
      id: "service_role",
      label: "Server database access",
      configured: serviceRoleConfigured,
      required: ["SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY"],
      recommended: [],
      missing: serviceRoleConfigured ? [] : ["SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY"],
      note: "Needed by payment sessions, webhooks, and receipt storage.",
    },
  ];

  return new Response(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    readyCount: services.filter((s) => s.configured).length,
    totalCount: services.length,
    services,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
