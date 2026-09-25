export type ReceiptJob = { id: string; upload_id: string; booking_ref: string; lease_token: string; requested_by: string | null };

export async function processReceiptConfirmation(req: Request, db: any, body: Record<string, unknown>, respond: (body: unknown, status?: number) => Response): Promise<Response> {
  const secrets = [...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("SERVICE_ROLE_KEY")].filter((key): key is string => typeof key === "string" && key.length > 0);
  if (!secrets.some(key => req.headers.get("apikey") === key || req.headers.get("authorization") === `Bearer ${key}`)) return respond({ error: "Unauthorized" }, 401);
  const { data: item, error } = await db.rpc("claim_receipt_confirmation", { p_id: body.notificationId });
  if (error) return respond({ error: "Confirmation claim failed" }, 503);
  if (item.status !== "processing") return respond({ ok: true, status: item.status });
  let failure: string | null = null;
  try {
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const response = await fetch(`${projectUrl}/functions/v1/send-confirmation-email`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: secrets[0], ...(secrets[0].startsWith("eyJ") ? {Authorization: `Bearer ${secrets[0]}`} : {}) },
      body: JSON.stringify({ ...item.payload, idempotencyKey: `receipt-confirmation/${item.upload_id}` }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Confirmation service HTTP ${response.status}`);
  } catch (e) { failure = e instanceof Error ? e.message : String(e); }
  const { error: saveError } = await db.from("receipt_confirmation_outbox").update({
    status: failure ? (item.attempts >= 3 ? "failed" : "queued") : "done",
    available_at: new Date(Date.now() + item.attempts * 60000).toISOString(),
    lease_token: null, lease_until: null, last_error: failure,
  }).eq("id", item.id).eq("lease_token", item.lease_token).eq("status", "processing");
  return respond({ ok: !failure && !saveError, status: failure || saveError ? "retry_pending" : "done" }, failure || saveError ? 503 : 200);
}

// These capabilities are created only after server authentication and an atomic
// DB claim. A request body's fields can never impersonate a claimed job.
export async function runReceiptJobRequest(
  req: Request, db: any, body: Record<string, unknown>,
  hashToken: (token: unknown) => Promise<string>,
  run: (request: Request, job: ReceiptJob) => Promise<Response>,
  respond: (body: unknown, status?: number) => Response,
): Promise<Response> {
  let claimed: ReceiptJob | null = null;
  try {
    let jobId = "";
    if (body.action === "process_job") {
      const secrets = [...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("SERVICE_ROLE_KEY")].filter((key): key is string => typeof key === "string" && key.length > 0);
      if (!secrets.some(key => req.headers.get("apikey") === key || req.headers.get("authorization") === `Bearer ${key}`)) return respond({ error: "Unauthorized" }, 401);
      jobId = String(body.jobId || "");
    } else if (body.action === "reread") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: user, error: authError } = await db.auth.getUser(token);
      if (authError || !user?.user) return respond({ error: "Unauthorized" }, 401);
      const { data: account } = await db.from("accounts").select("role").eq("id", user.user.id).maybeSingle();
      if (!account || !["owner", "court_owner", "staff", "developer"].includes(account.role)) return respond({ error: "Forbidden" }, 403);
      if (!/^[0-9a-f-]{36}$/i.test(String(body.requestKey || ""))) return respond({ error: "Request key required" }, 400);
      const { data: booking, error: bookingError } = await db.from("bookings").select("receipt_image_url")
        .eq("ref", String(body.bookingRef || "")).single();
      if (bookingError || !booking?.receipt_image_url) return respond({ error: "Stored receipt not found" }, 404);
      const { data: upload, error: uploadError } = await db.from("receipt_staged_uploads").select("id")
        .eq("storage_path", booking.receipt_image_url).eq("status", "consumed").is("storage_deleted_at", null).single();
      if (uploadError || !upload) return respond({ error: "This receipt has no finalized upload record; review it manually." }, 409);
      const { data: id, error } = await db.rpc("enqueue_receipt_reread", {
        p_upload_id: upload.id, p_actor: user.user.id, p_request_key: body.requestKey,
      });
      if (error) throw error;
      jobId = id;
    } else {
      // The existing customer fast path can process only its own finalized
      // receipt. It cannot create new jobs or retry completed reviews.
      const hash = await hashToken(body.holdToken);
      const { data: upload, error } = await db.from("receipt_staged_uploads").select("id,booking_ref")
        .eq("id", String(body.uploadId || "")).eq("booking_ref", String(body.bookingRef || ""))
        .eq("hold_token_hash", hash).eq("status", "consumed").single();
      if (error || !upload) return respond({ error: "Invalid hold capability" }, 403);
      const { data: job, error: jobError } = await db.from("receipt_verification_jobs").select("id")
        .eq("upload_id", upload.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (jobError) throw jobError;
      if (!job) return respond({ error: "Receipt queue is not ready. Receipt remains stored for review." }, 503);
      jobId = job.id;
    }
    const { data: job, error } = await db.rpc("claim_receipt_job", { p_job_id: jobId });
    if (error) throw error;
    if (job.status === "done") return respond({ ...job.outcome, replayed: true });
    if (job.status === "failed") return respond({ error: "Verification retries exhausted. Use admin Re-read receipt to try again.", jobId }, 503);
    if (job.status === "busy") return respond({ ok: true, status: "processing", jobId, message: "Receipt verification is queued or in progress." }, 202);
    claimed = job;
    const response = await run(new Request(req.url, {
      method: "POST", headers: req.headers,
      body: JSON.stringify({ action: "verify_staged", bookingRef: job.booking_ref, uploadId: job.upload_id }),
    }), job);
    if (!response.ok) {
      const result = await response.clone().json().catch(() => ({}));
      const { error: failError } = await db.rpc("fail_receipt_job", {
        p_job_id: job.id, p_lease: job.lease_token, p_error: String(result.error || `HTTP ${response.status}`),
      });
      if (failError) console.error("Receipt retry persistence failed", failError.message);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String((error as any)?.message || error);
    if (claimed) await db.rpc("fail_receipt_job", { p_job_id: claimed.id, p_lease: claimed.lease_token, p_error: message });
    console.error("Receipt job failed", message);
    return respond({ error: "Receipt verification could not finish. The stored receipt will remain available for review." }, 503);
  }
}
