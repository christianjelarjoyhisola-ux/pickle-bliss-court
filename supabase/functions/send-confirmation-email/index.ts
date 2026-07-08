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
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  total: number;
  downpayment: number;
  contactNumber?: string;
  bookingItems?: Array<{
    courtName: string;
    date: string;
    startTime: string;
    endTime: string;
    duration: number;
    total: number;
    downpayment?: number;
  }>;
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

function fmtPHP(n: number): string {
  return "&#8369;" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}

function buildHtml(p: Payload): string {
  const fullName = escapeHtml(p.fullName);
  const bookingRef = escapeHtml(p.bookingRef);
  const bookingItems = Array.isArray(p.bookingItems) && p.bookingItems.length > 0
    ? p.bookingItems
    : [{
      courtName: p.courtName,
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      duration: p.duration,
      total: p.total,
      downpayment: p.downpayment,
    }];
  const courtName = escapeHtml([...new Set(bookingItems.map(item => item.courtName).filter(Boolean))].join(", ") || p.courtName);
  const dates = [...new Set(bookingItems.map(item => item.date).filter(Boolean))];
  const dateText = dates.length === 1 ? fmtDate(dates[0]) : dates.map(fmtDate).join("<br/>");
  const timeRows = bookingItems.map(item =>
    `${escapeHtml(item.courtName)}: ${escapeHtml(item.startTime)} &ndash; ${escapeHtml(item.endTime)}`
  ).join("<br/>");
  const duration = bookingItems.reduce((sum, item) => sum + Number(item.duration || 0), 0) || Number(p.duration || 0);
  const itemRows = bookingItems.length > 1 ? bookingItems.map(item => `
          <tr>
            <td style="padding:10px 12px;border-top:1px solid #384033;color:#f7fafc;font-weight:700;">${escapeHtml(item.courtName)}</td>
            <td style="padding:10px 12px;border-top:1px solid #384033;color:#d7dee8;">${fmtDate(item.date)}</td>
            <td style="padding:10px 12px;border-top:1px solid #384033;color:#d7dee8;">${escapeHtml(item.startTime)} &ndash; ${escapeHtml(item.endTime)}</td>
            <td style="padding:10px 12px;border-top:1px solid #384033;color:#f7fafc;font-weight:700;text-align:right;">${fmtPHP(Number(item.total || 0))}</td>
          </tr>`).join("") : "";
  const isFullPay = Number(p.downpayment || 0) >= Number(p.total || 0) - 1;
  const balance = Number(p.total || 0) - Number(p.downpayment || 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>Booking Confirmed - PICKLE BLISS COURT</title>
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
        <div style="color:#1d2024;font-size:1rem;font-weight:900;letter-spacing:1px;">&#10003; BOOKING CONFIRMED</div>
      </td></tr>

      <tr><td style="padding:32px 36px;background:#202428;background-image:linear-gradient(#202428,#202428);">
        <p style="margin:0 0 20px;font-size:1rem;color:#f7fafc;">Hi <strong>${fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#d7dee8;line-height:1.6;">
          Great news! PICKLE BLISS COURT booking has been <strong style="color:#f49a4a;">confirmed</strong>.
          ${isFullPay ? "Your full payment has been received and your slot is locked in." : "Your downpayment has been received and your slot is locked in."} See you on the court!
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#1d241e;background-image:linear-gradient(#1d241e,#1d241e);border:1.5px solid #8b4b20;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:18px 22px;border-bottom:1px solid #384033;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:4px;">Booking Reference</div>
            <div style="font-size:1.1rem;font-weight:800;color:#f49a4a;font-family:monospace;letter-spacing:1px;">${bookingRef}</div>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #384033;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Court</div>
                <div style="font-size:.92rem;font-weight:700;color:#f7fafc;">${courtName}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Date</div>
                <div style="font-size:.92rem;font-weight:700;color:#f7fafc;">${dateText}</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #384033;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Time</div>
                <div style="font-size:.92rem;font-weight:700;color:#f7fafc;">${timeRows}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Duration</div>
                <div style="font-size:.92rem;font-weight:700;color:#f7fafc;">${duration} hour${duration !== 1 ? "s" : ""}</div>
              </td>
            </tr></table>
          </td></tr>
          ${itemRows ? `<tr><td style="padding:0 10px 10px;border-bottom:1px solid #384033;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 12px;color:#aab6c5;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Court</td>
                <td style="padding:10px 12px;color:#aab6c5;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Date</td>
                <td style="padding:10px 12px;color:#aab6c5;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Time</td>
                <td style="padding:10px 12px;color:#aab6c5;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;text-align:right;">Amount</td>
              </tr>
              ${itemRows}
            </table>
          </td></tr>` : ""}
          <tr><td style="padding:14px 22px;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">Total Amount</div>
                <div style="font-size:1.05rem;font-weight:800;color:#f7fafc;">${fmtPHP(p.total)}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#aab6c5;margin-bottom:3px;">${isFullPay ? "Full Payment" : "Downpayment Paid"}</div>
                <div style="font-size:1.05rem;font-weight:800;color:#f49a4a;">&#10003; ${fmtPHP(p.downpayment)}</div>
              </td>
            </tr></table>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#281c12;background-image:linear-gradient(#281c12,#281c12);border:1.5px solid #a85f1f;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 18px;">
            <div style="font-size:.82rem;color:#f2d6b3;line-height:1.6;">
              <strong>&#128203; Reminders:</strong><br/>
              &bull; Please arrive <strong>10 minutes early</strong> to warm up.<br/>
              &bull; Bring your booking reference: <strong>${bookingRef}</strong><br/>
              ${isFullPay ? "&bull; No remaining balance &mdash; you're all paid up! <strong style=\"color:#f49a4a;\">&#10003;</strong>" : `&bull; Remaining balance of <strong>${fmtPHP(balance)}</strong> is due on the day of play.`}
            </div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#aab6c5;line-height:1.6;">
          Questions? Contact us directly. We're excited to see you on the court!
        </p>
      </td></tr>

      <tr><td style="background:#1b2025;background-image:linear-gradient(#1b2025,#1b2025);padding:18px 36px;text-align:center;border-top:1px solid #30363d;">
        <div style="font-size:.75rem;color:#f49a4a;letter-spacing:1px;">PICKLE BLISS COURT</div>
        <div style="font-size:.72rem;color:#7f8ea3;margin-top:4px;">This is an automated confirmation email.</div>
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
        subject: `Booking Confirmed - ${body.bookingRef} | PICKLE BLISS COURT`,
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
