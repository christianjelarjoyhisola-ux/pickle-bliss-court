const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOGO_URL = "https://pickleblisscourt.com/pickle-bliss-logo.jpg";

type Payload = {
  bookingRef: string;
  email: string;
  fullName: string;
  courtName: string;
  oldDate: string;
  oldStartTime: string;
  oldEndTime: string;
  newDate: string;
  newStartTime: string;
  newEndTime: string;
  newDuration: number;
  note?: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-PH", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildHtml(p: Payload): string {
  const fullName = escapeHtml(p.fullName);
  const bookingRef = escapeHtml(p.bookingRef);
  const courtName = escapeHtml(p.courtName);
  const oldStartTime = escapeHtml(p.oldStartTime);
  const oldEndTime = escapeHtml(p.oldEndTime);
  const newStartTime = escapeHtml(p.newStartTime);
  const newEndTime = escapeHtml(p.newEndTime);
  const note = p.note?.trim()
    ? `<div style="background:#281c12;background-image:linear-gradient(#281c12,#281c12);border:1.5px solid #a85f1f;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <div style="font-size:.82rem;color:#f2d6b3;line-height:1.6;">
          <strong>Message from PICKLE BLISS COURT:</strong><br/>${escapeHtml(p.note)}
        </div>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>Booking Rescheduled - PICKLE BLISS COURT</title>
</head>
<body style="margin:0;padding:0;background:#15171b;background-image:linear-gradient(#15171b,#15171b);font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#15171b;background-image:linear-gradient(#15171b,#15171b);padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#202428;background-image:linear-gradient(#202428,#202428);border:1px solid #323840;border-radius:14px;overflow:hidden;box-shadow:0 12px 34px rgba(0,0,0,.42);max-width:560px;width:100%;">

      <tr><td style="background:#75330f;background-image:linear-gradient(#75330f,#75330f);padding:34px 36px 30px;text-align:center;border-top:6px solid #f59a38;border-bottom:1px solid #8f4518;">
        <img src="${LOGO_URL}" width="96" height="96" alt="Pickle Bliss Court logo" style="display:block;width:96px;height:96px;margin:0 auto 14px;border-radius:50%;background:#fff;padding:6px;border:4px solid #0f1720;"/>
        <div style="font-family:'Bebas Neue',Georgia,serif;font-size:1.6rem;letter-spacing:3px;color:#1b1f24;line-height:1.1;font-weight:900;">PICKLE BLISS COURT</div>
        <div style="font-size:.75rem;color:#2c221b;letter-spacing:2px;text-transform:uppercase;margin-top:4px;font-weight:700;">Bliss, Poblacion, Monkayo</div>
      </td></tr>

      <tr><td style="background:#c95a1c;background-image:linear-gradient(#c95a1c,#c95a1c);padding:14px 36px;text-align:center;">
        <div style="color:#1d2024;font-size:1rem;font-weight:900;letter-spacing:1px;">BOOKING RESCHEDULED</div>
      </td></tr>

      <tr><td style="padding:32px 36px;background:#202428;background-image:linear-gradient(#202428,#202428);">
        <p style="margin:0 0 20px;font-size:1rem;color:#f7fafc;">Hi <strong>${fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#d7dee8;line-height:1.6;">
          Your booking has been <strong style="color:#f49a4a;">rescheduled</strong> to a new date and time.
          All other details remain the same &mdash; your slot is secure.
        </p>

        ${note}

        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;margin-bottom:24px;">
          <tr><td style="background:#241313;background-image:linear-gradient(#241313,#241313);border:1.5px solid #7a3732;border-bottom:none;border-radius:10px 10px 0 0;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#f28b82;margin-bottom:6px;font-weight:700;">Old Schedule</div>
            <div style="font-size:.92rem;color:#f1b2ae;text-decoration:line-through;">${fmtDate(p.oldDate)}</div>
            <div style="font-size:.88rem;color:#f1b2ae;text-decoration:line-through;">${oldStartTime} &ndash; ${oldEndTime}</div>
          </td></tr>
          <tr><td style="background:#1d241e;background-image:linear-gradient(#1d241e,#1d241e);border:1.5px solid #8b4b20;border-top:none;border-radius:0 0 10px 10px;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#f49a4a;margin-bottom:6px;font-weight:700;">New Schedule</div>
            <div style="font-size:1rem;font-weight:800;color:#f7fafc;">${fmtDate(p.newDate)}</div>
            <div style="font-size:.92rem;font-weight:600;color:#d7dee8;">${newStartTime} &ndash; ${newEndTime} &middot; ${p.newDuration} hr${p.newDuration !== 1 ? "s" : ""}</div>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#1d241e;background-image:linear-gradient(#1d241e,#1d241e);border:1.5px solid #8b4b20;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 22px;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Court &middot; Booking Reference</div>
            <div style="font-size:.95rem;font-weight:700;color:#f7fafc;">${courtName} &nbsp;&middot;&nbsp; <span style="font-family:monospace;color:#f49a4a;">${bookingRef}</span></div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#aab6c5;line-height:1.6;">
          We apologize for the change and appreciate your understanding. See you on the new date!
        </p>
      </td></tr>

      <tr><td style="background:#1b2025;background-image:linear-gradient(#1b2025,#1b2025);padding:18px 36px;text-align:center;border-top:1px solid #30363d;">
        <div style="font-size:.75rem;color:#f49a4a;letter-spacing:1px;">PICKLE BLISS COURT</div>
        <div style="font-size:.72rem;color:#7f8ea3;margin-top:4px;">This is an automated notification email.</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    if (!resendKey) throw new Error("RESEND_API_KEY is not configured");

    const body = (await req.json()) as Payload;
    if (!body.email || !body.bookingRef) {
      return new Response(JSON.stringify({ error: "Missing email or bookingRef" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromAddress = Deno.env.get("EMAIL_FROM") || "PICKLE BLISS COURT <onboarding@resend.dev>";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [body.email],
        subject: `Booking Rescheduled - ${body.bookingRef} | PICKLE BLISS COURT`,
        html: buildHtml(body),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${JSON.stringify(json)}`);

    return new Response(JSON.stringify({ ok: true, id: json.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
