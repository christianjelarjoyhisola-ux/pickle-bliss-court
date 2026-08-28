// verify-gcash-receipt
// ----------------------------------------------------------------------------
// Server-side GCash / BDO Pay / GoTyme / PNB receipt verification + fraud detection.
//
// Actions (POST JSON):
//   { action: "stage_upload", bookingRef, holdToken, provider, imageBase64, contentType }
//   { action: "finalize_booking", bookingRef, holdToken, uploadId, customer, payment, items }
//   { action: "verify_staged", bookingRef, holdToken, uploadId }
//   { action: "abandon_upload", bookingRef, holdToken, uploadId }
//   { action: "verify", bookingRef, provider, imageBase64, contentType }
//     -> OCR (Google Vision) + fraud checks + confidence routing.
//        Stores the image (private bucket), writes an audit row, advances
//        payment_status on auto-approve, and alerts admin on review/reject.
//   { action: "sign", bookingRef }    (admin-only, requires a user JWT)
//     -> returns a short-lived signed URL to view the stored receipt image.
//
// Decision lanes:
//   auto_approved : zero hard flags, zero soft flags, OCR confident
//   manual_review : soft flag(s) or unreadable fields or low confidence
//   rejected      : any hard flag (duplicate / wrong number / underpay / stale)
//
// Rejections never auto-cancel the booking (OCR is heuristic — avoid harming
// honest customers). They flag the booking red and alert the admin.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Payment must happen within this many minutes after the booking/session join
// is started.
const PAYMENT_WINDOW_MINUTES = 15;
// OCR usually reads only minute-level timestamps. A receipt paid during the
// same minute as the hold can look a few seconds "before" the booking.
const PAYMENT_EARLY_TOLERANCE_MINUTES = 2;

const MAX_BYTES = 5 * 1024 * 1024;
const HOLD_WINDOW_MINUTES = 15;
const STAGED_UPLOAD_LIMIT_PER_HOLD = 5;
const STAGED_CLEANUP_BATCH = 25;
const PESO_TOLERANCE = 5; // allow ±₱5 rounding; underpay beyond this is a hard flag

// Hard flags force a rejection; soft flags force manual review.
const HARD_FLAGS = new Set([
  "REF_FORMAT_INVALID",
  "SUSPECTED_FAKE",     // OCR ran and image has zero receipt-like content
  "DUPLICATE_REF",
  "DUPLICATE_INVOICE",
  "DUPLICATE_INSTAPAY_REF",
  "DUPLICATE_BPI_TRANSACTION_REF",
  "METHOD_MISMATCH",
  "REF_MISMATCH",
  "DATE_NOT_TODAY",
  "TIME_EXPIRED",
  "TIME_FUTURE",
  "WRONG_GCASH_NUMBER",
  "WRONG_RECEIVER_NUMBER",
  "AMOUNT_MISMATCH",    // Only hard if significantly underpaid (>₱5)
]);

type PaymentProvider = "gcash" | "bdopay" | "maya" | "bpi" | "gotyme" | "pnb";
type OcrProvider = "google_vision" | "none";

type OcrResult = {
  text: string;
  confidence: number;
  provider: OcrProvider;
  primaryProvider?: OcrProvider;
  fallbackProvider?: OcrProvider;
  fallbackReason?: string;
  imageVariant?: string;
};

function publicReceiptMessage(
  result: "auto_approved" | "manual_review" | "rejected",
  flags: string[],
): string {
  if (result === "auto_approved") return "Payment verified.";
  if (result === "manual_review") return "Received - the owner will verify your payment shortly.";

  const flagSet = new Set(flags);
  if (flagSet.has("AMOUNT_MISMATCH")) {
    return "Payment amount is lower than required. Please upload the correct payment receipt.";
  }
  if (flagSet.has("TIME_EXPIRED") || flagSet.has("TIME_FUTURE") || flagSet.has("DATE_NOT_TODAY")) {
    return "Payment was sent outside the allowed 10-minute window. Please create a new booking.";
  }
  if (flagSet.has("IMAGE_UNREADABLE") || flagSet.has("OCR_UNAVAILABLE")) {
    return "Receipt image is unreadable. Please upload a clearer screenshot.";
  }
  if (
    flagSet.has("SUSPECTED_FAKE")
    || flagSet.has("GCASH_RECEIPT_UNREADABLE")
    || flagSet.has("BDO_PAY_UNREADABLE")
    || flagSet.has("MAYA_UNREADABLE")
    || flagSet.has("BPI_UNREADABLE")
  ) {
    return "Payment could not be verified. Please upload a valid receipt or contact admin.";
  }
  return "Payment details do not match this booking. Please check your receipt and try again, or contact admin.";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = err as Record<string, unknown>;
    if (typeof m.message === "string") return m.message;
    if (typeof m.error === "string") return m.error;
  }
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  // Accept raw base64 or a data: URL.
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function safeReceiptMime(bytes: Uint8Array, requested: string): { contentType: string; ext: string } | null {
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  if (isJpeg) return { contentType: "image/jpeg", ext: "jpg" };
  if (isPng) return { contentType: "image/png", ext: "png" };
  if (isWebp) return { contentType: "image/webp", ext: "webp" };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.subarray(8, 12)).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { contentType: requested.toLowerCase().includes("heif") ? "image/heif" : "image/heic", ext: "heic" };
    }
  }
  return null;
}

async function holdTokenHash(raw: unknown): Promise<string> {
  const token = String(raw || "");
  if (token.length < 40 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Invalid hold capability");
  }
  return sha256Hex(new TextEncoder().encode(token));
}

function freshVerifyingHold(row: Record<string, unknown>): boolean {
  if (String(row.status || "") !== "verifying") return false;
  const createdMs = new Date(String(row.created_at || "")).getTime();
  return Number.isFinite(createdMs)
    && createdMs > Date.now() - HOLD_WINDOW_MINUTES * 60 * 1000
    && createdMs <= Date.now() + 5 * 60 * 1000;
}

async function cleanupExpiredStagedUploads(db: any, limit = STAGED_CLEANUP_BATCH): Promise<number> {
  const bounded = Math.max(1, Math.min(Number(limit) || STAGED_CLEANUP_BATCH, 100));
  const { data: candidates, error } = await db
    .from("receipt_staged_uploads")
    .select("id, storage_path")
    .eq("status", "staged")
    .lte("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(bounded);
  if (error) return 0;

  const claimed: Array<{ id: string; storage_path: string }> = [];
  for (const candidate of candidates) {
    const { data } = await db
      .from("receipt_staged_uploads")
      .update({ status: "abandoned" })
      .eq("id", candidate.id)
      .eq("status", "staged")
      .lte("expires_at", new Date().toISOString())
      .select("id, storage_path")
      .maybeSingle();
    if (data) claimed.push(data);
  }
  const remaining = Math.max(0, bounded - claimed.length);
  if (remaining) {
    const { data: retryRows } = await db
      .from("receipt_staged_uploads")
      .select("id, storage_path")
      .eq("status", "abandoned")
      .is("storage_deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(remaining);
    for (const row of retryRows || []) {
      if (!claimed.some((item) => item.id === row.id)) claimed.push(row);
    }
  }
  let deleted = 0;
  for (const row of claimed) {
    const { error: removeError } = await db.storage.from("receipts").remove([row.storage_path]);
    if (removeError) {
      console.error("staged receipt cleanup storage failure:", errMsg(removeError));
      continue;
    }
    await db.from("receipt_staged_uploads")
      .update({ storage_deleted_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "abandoned");
    deleted++;
  }
  return deleted;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(out);
}

function pixelBrightness(pixel: number): number {
  const r = (pixel >>> 24) & 0xff;
  const g = (pixel >>> 16) & 0xff;
  const b = (pixel >>> 8) & 0xff;
  return (r + g + b) / 3;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Difference-hash (dHash): 64-bit perceptual hash robust to recompression and
// light cropping/scaling. Returns 16-hex-char string, or null if undecodable.
async function dHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const img = await Image.decode(bytes);
    const small = img.resize(9, 8); // 9x8 -> 8 horizontal comparisons per row
    let bits = "";
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 8; x++) {
        const lPix = small.getPixelAt(x, y);
        const rPix = small.getPixelAt(x + 1, y);
        const lGray = ((lPix >>> 24) & 0xff) + ((lPix >>> 16) & 0xff) + ((lPix >>> 8) & 0xff);
        const rGray = ((rPix >>> 24) & 0xff) + ((rPix >>> 16) & 0xff) + ((rPix >>> 8) & 0xff);
        bits += lGray < rGray ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  } catch {
    return null; // HEIC/unknown formats — skip perceptual dedupe, not fatal
  }
}

async function imageToJpegBase64(img: Image, quality = 92): Promise<string> {
  const encoded = await img.encodeJPEG(quality);
  return bytesToBase64(encoded);
}

function resizeForOcr(img: Image): Image {
  const maxSide = Math.max(img.width, img.height);
  const minSide = Math.min(img.width, img.height);
  let scale = 1;
  if (maxSide > 2200) scale = 2200 / maxSide;
  else if (minSide < 900) scale = Math.min(2.5, 1200 / Math.max(1, minSide));
  if (Math.abs(scale - 1) < 0.05) return img.clone();
  return img.resize(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
}

function cropBrightReceiptRegion(img: Image): Image | null {
  const w = img.width;
  const h = img.height;
  if (w < 200 || h < 200) return null;

  const step = Math.max(4, Math.floor(Math.min(w, h) / 260));
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;

  for (let y = 1; y <= h; y += step) {
    for (let x = 1; x <= w; x += step) {
      const brightness = pixelBrightness(img.getPixelAt(x, y));
      if (brightness >= 168) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hits++;
      }
    }
  }

  if (hits < 40 || maxX <= minX || maxY <= minY) return null;
  const cropW = maxX - minX + step;
  const cropH = maxY - minY + step;
  const areaRatio = (cropW * cropH) / (w * h);
  if (areaRatio < 0.12 || areaRatio > 0.92) return null;

  const pad = Math.round(Math.min(w, h) * 0.025);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const width = Math.min(w - x, cropW + pad * 2);
  const height = Math.min(h - y, cropH + pad * 2);
  if (width < 180 || height < 180) return null;
  return img.crop(x, y, width, height);
}

function cropPhoneScreenRegion(img: Image): Image | null {
  const w = img.width;
  const h = img.height;
  if (h < w * 1.15 || w < 260 || h < 360) return null;

  // Phone-photo receipts often include hands/table around a tall lit screen.
  // A conservative centered crop removes most background while preserving the
  // full GCash receipt, even when the phone is slightly tilted.
  const x = Math.round(w * 0.12);
  const y = Math.round(h * 0.03);
  const width = Math.round(w * 0.76);
  const height = Math.round(h * 0.94);
  if (width < 220 || height < 320) return null;
  return img.crop(x, y, Math.min(width, w - x), Math.min(height, h - y));
}

function cropReceiptDetailRegion(img: Image): Image | null {
  const w = img.width;
  const h = img.height;
  if (w < 180 || h < 260) return null;

  // Keep the top details card and reference/date row, drop ad/eco footer noise.
  const x = Math.round(w * 0.02);
  const y = Math.round(h * 0.02);
  const width = Math.round(w * 0.96);
  const height = Math.round(h * 0.68);
  if (width < 160 || height < 220) return null;
  return img.crop(x, y, Math.min(width, w - x), Math.min(height, h - y));
}

async function buildOcrImageVariants(bytes: Uint8Array): Promise<Array<{ label: string; base64: string }>> {
  try {
    const img = await Image.decode(bytes);
    const variants: Array<{ label: string; base64: string }> = [];

    const normalized = resizeForOcr(img);
    variants.push({ label: "normalized_jpeg", base64: await imageToJpegBase64(normalized) });

    const phone = cropPhoneScreenRegion(img);
    if (phone) {
      const phoneNorm = resizeForOcr(phone);
      variants.push({ label: "phone_screen_jpeg", base64: await imageToJpegBase64(phoneNorm) });

      const phoneReceipt = cropBrightReceiptRegion(phone);
      if (phoneReceipt) {
        const phoneReceiptNorm = resizeForOcr(phoneReceipt);
        variants.push({ label: "phone_receipt_jpeg", base64: await imageToJpegBase64(phoneReceiptNorm) });

        const phoneDetails = cropReceiptDetailRegion(phoneReceiptNorm);
        if (phoneDetails) {
          variants.push({ label: "phone_receipt_details_jpeg", base64: await imageToJpegBase64(resizeForOcr(phoneDetails)) });
        }
      }
    }

    const crop = cropBrightReceiptRegion(img);
    if (crop) {
      const cropNorm = resizeForOcr(crop);
      variants.push({ label: "cropped_receipt_jpeg", base64: await imageToJpegBase64(cropNorm) });

      const details = cropReceiptDetailRegion(cropNorm);
      if (details) {
        variants.push({ label: "cropped_receipt_details_jpeg", base64: await imageToJpegBase64(resizeForOcr(details)) });
      }
    }

    return variants;
  } catch (e) {
    console.error("receipt OCR preprocessing failed:", errMsg(e));
    return [];
  }
}

function phManilaNow(): Date {
  // Current instant shifted to UTC+8 wall clock.
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function phTodayStr(): string {
  return phManilaNow().toISOString().slice(0, 10); // YYYY-MM-DD in PH
}

function toPhWallClockDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

function formatPhDateTime12(d: Date | null): string | null {
  if (!d) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  let hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${year}-${month}-${day} ${hour}:${minute} ${ampm} PH`;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse a GCash-style timestamp e.g. "Jun 13, 2026 10:30 AM" into a Date
// interpreted as PH wall-clock (returned as a UTC+8-shifted Date for comparison
// against phManilaNow()). If OCR only finds the date, return the date but no
// shifted time so it routes to manual review instead of assuming midnight.
function parseReceiptDateTime(text: string): { date: string | null; shifted: Date | null } {
  const normalized = normalizeOcrText(text)
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const datePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(\d{4})\b/i;
  const dateOnly = normalized.match(datePattern);
  if (!dateOnly) return { date: null, shifted: null };

  const mon = MONTHS[dateOnly[1].toLowerCase().slice(0, 3)];
  const day = parseInt(dateOnly[2], 10);
  const year = parseInt(dateOnly[3], 10);
  const dateStr = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const afterDate = normalized.slice((dateOnly.index || 0) + dateOnly[0].length, (dateOnly.index || 0) + dateOnly[0].length + 80);
  const beforeDate = normalized.slice(Math.max(0, (dateOnly.index || 0) - 40), dateOnly.index || 0);
  const timePattern = /\b(\d{1,2})\s*(?:[:;.]|\s)\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const time = afterDate.match(timePattern) || beforeDate.match(timePattern);
  if (time) {
    let hour = parseInt(time[1], 10);
    const min = parseInt(time[2], 10);
    const ap = time[3].toLowerCase().replace(/[^apm]/g, "");
    if (ap.startsWith("p") && hour !== 12) hour += 12;
    if (ap.startsWith("a") && hour === 12) hour = 0;
    const shifted = new Date(Date.UTC(year, mon, day, hour, min, 0));
    return { date: dateStr, shifted };
  }

  return { date: dateStr, shifted: null };
}

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function ocrDigitsOnly(s: string): string {
  return (s || "")
    .replace(/[oO]/g, "0")
    .replace(/[iIl|]/g, "1")
    .replace(/[sS]/g, "5")
    .replace(/[bB]/g, "8")
    .replace(/\D/g, "");
}

function normalizeOcrText(text: string): string {
  return String(text || "")
    .replace(/\u20b1/g, "P")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\bN[0O]\b/gi, "No")
    .replace(/\bR[e3]f\b/gi, "Ref")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReferenceForProvider(value: string, provider: PaymentProvider): string {
  const raw = value || "";
  if (provider === "gcash") return digitsOnly(raw);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isBdoPayReference(value: string): boolean {
  return /^BN\d{16}$/.test(normalizeReferenceForProvider(value, "bdopay"));
}

function isMayaReference(value: string): boolean {
  const normalized = normalizeReferenceForProvider(value, "maya");
  return /^[A-Z0-9]{12}$/.test(normalized) || /^\d{13}$/.test(normalized);
}

function isBpiConfirmationNo(value: string): boolean {
  return /^\d{10,20}$/.test(digitsOnly(value));
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[^0-9]*"));
}

function maskedDigitPattern(digits: string): RegExp {
  const mask = "[\\s\\-.*xX#\\u2022\\u2023\\u25E6\\u2043\\u2219]*";
  return new RegExp(digits.split("").join(mask));
}

// Extract candidate 13-digit GCash reference numbers from OCR text.
function extractGcashRef(text: string, typedRef = ""): string | null {
  text = normalizeOcrText(text);
  const normalizedTyped = digitsOnly(typedRef);

  // If the customer-entered ref is visible in the OCR text, trust it. This
  // avoids false mismatches when OCR sees the receiver mobile number before the
  // "Ref No." line and a broad numeric scan accidentally joins nearby digits.
  if (normalizedTyped.length === 13 && flexibleDigitPattern(normalizedTyped).test(text)) {
    return normalizedTyped;
  }

  // Prefer numbers immediately following receipt reference labels.
  const labelPattern = /\b(?:ref(?:erence)?(?:\s*(?:no|number|#))?\.?)\s*[:#]?\s*([0-9oOiIl|sSbB][0-9oOiIl|sSbB\s-]{11,30}[0-9oOiIl|sSbB])/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const d = ocrDigitsOnly(labelMatch[1]);
    if (d.length === 13) return d;
    if (normalizedTyped.length === 13 && d.includes(normalizedTyped)) return normalizedTyped;
  }

  // Fallback: any standalone 13-digit run.
  const standalone = text.match(/\b[0-9oOiIl|sSbB]{13}\b/);
  if (standalone) {
    const d = ocrDigitsOnly(standalone[0]);
    if (d.length === 13) return d;
  }

  // Last resort: tolerate OCR spaces inside a single long numeric group.
  // Keep this after label/typed matching because phone numbers and amounts can
  // otherwise be accidentally joined into a fake 13-digit reference.
  const cleaned = text.replace(/[^0-9oOiIl|sSbB\s-]/g, " ");
  const groups = cleaned.match(/(?:[0-9oOiIl|sSbB][0-9oOiIl|sSbB\s-]{11,30}[0-9oOiIl|sSbB])/g) || [];
  for (const g of groups) {
    const d = ocrDigitsOnly(g);
    if (d.length === 13) return d;
  }
  return null;
}

function extractBpiConfirmationNo(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);
  if (isBpiConfirmationNo(normalizedTyped) && flexibleDigitPattern(normalizedTyped).test(text)) {
    return normalizedTyped;
  }

  const patterns = [
    /\bconfirmation\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
    /\bconfirm(?:ation)?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (isBpiConfirmationNo(ref)) return ref;
  }
  return null;
}

function extractReference(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string | null {
  if (provider === "gcash") return extractGcashRef(text, typedRef);
  if (provider === "bpi") return extractBpiConfirmationNo(text, typedRef);

  // BDO Pay/GoTyme/PNB references are not guaranteed to be 13-digit GCash-style refs.
  // For those providers, trust the customer-entered reference only if OCR sees
  // the same alphanumeric token in the receipt text.
  const normalizedTyped = normalizeReferenceForProvider(typedRef, provider);
  if (normalizedTyped.length >= 6) {
    const normalizedText = normalizeReferenceForProvider(text, provider);
    if (normalizedText.includes(normalizedTyped)) return normalizedTyped;
  }
  return null;
}

function hasBdoPayIndicator(text: string): boolean {
  return isBdoPayReceipt(text);
}

function hasMayaIndicator(text: string): boolean {
  return isMayaReceipt(text);
}

function hasBpiIndicator(text: string): boolean {
  return isBpiReceipt(text);
}

function hasInstapayQrphIndicator(text: string): boolean {
  return /\binsta\s*pay\b|\bqrph\b|\bqr\s*ph\b/i.test(text);
}

function hasBdoBnReference(text: string): boolean {
  return /\bbn[\s-]*\d{8}[\s-]*\d{8}\b/i.test(text);
}

function isBdoPayReceipt(text: string): boolean {
  const t = text || "";
  const hasBnRef = hasBdoBnReference(t);
  return /\bbdo\s*pay\b/i.test(t)
    || /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(t)
    || (hasBnRef && /\binsta\s*pay\b/i.test(t))
    || (hasBnRef && /\bbdo\b/i.test(t))
    || (hasBnRef && extractBdoInvoiceNumber(t) !== null);
}

function isMayaReceipt(text: string): boolean {
  const t = text || "";
  return /\bmaya\b/i.test(t)
    && (/\bsent\s+money\b/i.test(t)
      || /\bsent\s+money\s+via\b/i.test(t)
      || /\bcompleted\b/i.test(t)
      || /\breference\s+id\b/i.test(t)
      || /\binstapay\s+ref\b/i.test(t)
      || /\bqrph\b|\bqr\s*ph\b/i.test(t));
}

function hasMayaCompletedIndicator(text: string): boolean {
  return /\bcompleted\b/i.test(text || "");
}

function isBpiReceipt(text: string): boolean {
  const t = text || "";
  return /\bsent\s+via\s+bpi\b/i.test(t)
    || /\bbpi\b/i.test(t)
    || (/\btransfer\s+successful\b/i.test(t)
      && /\bconfirmation\s*(?:no|number|#)?\.?\b/i.test(t)
      && /\binsta\s*pay\b/i.test(t));
}

function hasGcashGxiDestination(text: string): boolean {
  return /\bgcash\s*\/\s*g-?xchange\b/i.test(text)
    || /\bg-?xchange\b/i.test(text)
    || /\bgcash\b/i.test(text);
}

function isGcashToGcashReceipt(text: string): boolean {
  const t = text || "";
  if (isBdoPayReceipt(t) || isMayaReceipt(t) || isBpiReceipt(t)) return false;
  return /\bsent\s+via\s+gcash\b/i.test(t)
    || /\bsent\s+through\s+gcash\b/i.test(t)
    || /\bgcash\s+receipt\b/i.test(t)
    || /\btotal\s+amount\s+sent\b/i.test(t);
}

function selectedMethodMismatch(provider: PaymentProvider, text: string): boolean {
  const bdoReceipt = isBdoPayReceipt(text);
  const mayaReceipt = isMayaReceipt(text);
  const bpiReceipt = isBpiReceipt(text);
  const gcashReceipt = isGcashToGcashReceipt(text);
  if (provider === "gcash") return bdoReceipt || mayaReceipt || bpiReceipt;
  if (provider === "bdopay") return gcashReceipt || mayaReceipt || bpiReceipt;
  if (provider === "maya") return gcashReceipt || bdoReceipt || bpiReceipt;
  if (provider === "bpi") return gcashReceipt || bdoReceipt || mayaReceipt;
  return false;
}

function hasExpectedReceiverName(text: string, expectedName: string): boolean {
  const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = (expectedName || "Pickle Bliss Court").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (expected.length >= 3 && upper.includes(expected)) return true;
  return upper.includes("PICKLEBLISSCOURT");
}

function extractBdoInvoiceNumber(text: string): string | null {
  const patterns = [
    /\binvoice\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
    /\binv\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const invoice = match ? digitsOnly(match[1]) : "";
    if (invoice.length >= 4 && invoice.length <= 20) return invoice;
  }
  return null;
}

function extractMayaInstapayRefNo(text: string): string | null {
  const patterns = [
    /\binstapay\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\binstapay\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractBpiTransactionRefNo(text: string): string | null {
  const patterns = [
    /\btransaction\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\btransaction\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractAmount(text: string): number | null {
  const normalized = normalizeOcrText(text)
    .replace(/\s+/g, " ")
    .trim();

  // GCash receipts can include unrelated decimals in footer/eco sections.
  // Prefer explicit payment amount labels before falling back to any decimal.
  const labeledAmountPatterns = [
    /total\s+amount\s+sent\s*(?:php|p)?\s*[:\-]?\s*([\d,]+\.\d{2})/i,
    /amount\s*(?:sent)?\s*(?:php|p)?\s*[:\-]?\s*([\d,]+\.\d{2})/i,
    /(?:php|p)\s*([\d,]+\.\d{2})/i,
  ];
  for (const pattern of labeledAmountPatterns) {
    const match = normalized.match(pattern);
    if (match) return parseFloat(match[1].replace(/,/g, ""));
  }

  // Prefer values near an amount keyword / peso sign.
  const near = text.match(/(?:amount|total|php|₱|p\s)\s*[:\-]?\s*([\d,]+\.\d{2})/i);
  if (near) return parseFloat(near[1].replace(/,/g, ""));
  const any = text.match(/\b([\d,]{1,9}\.\d{2})\b/);
  return any ? parseFloat(any[1].replace(/,/g, "")) : null;
}

function extractReceiptAmount(text: string): number | null {
  const normalized = normalizeOcrText(text)
    .replace(/\s+/g, " ")
    .trim();

  type AmountCandidate = { amount: number; score: number; index: number };
  const candidates: AmountCandidate[] = [];
  const addCandidate = (raw: string, score: number, index: number) => {
    const cleaned = raw
      .replace(/[oO]/g, "0")
      .replace(/[iIl|]/g, "1")
      .replace(/,/g, "")
      .replace(/\s+/g, "");
    const match = cleaned.match(/^(\d{1,7})[.](\d{2})$/);
    if (!match) return;
    const amount = parseFloat(`${match[1]}.${match[2]}`);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return;
    candidates.push({ amount, score, index });
  };
  const collect = (pattern: RegExp, score: number) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      addCandidate(match[1], score, match.index);
    }
  };

  // Prefer the GCash payment rows and keep footer/ad/eco numbers as fallback.
  collect(/\btotal\s+amount\s+sent\b.{0,40}?(?:php|peso|p)?\s*[:\-]?\s*([0-9oOiIl|,]+\.\d{2})/gi, 120);
  collect(/\bamount\s+sent\b.{0,35}?(?:php|peso|p)?\s*[:\-]?\s*([0-9oOiIl|,]+\.\d{2})/gi, 110);
  collect(/\bamount\b.{0,30}?(?:php|peso|p)?\s*[:\-]?\s*([0-9oOiIl|,]+\.\d{2})/gi, 95);
  collect(/(?:php|peso|p)\s*([0-9oOiIl|,]+\.\d{2})/gi, 80);

  if (candidates.length) {
    candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index) || (b.amount - a.amount));
    return candidates[0].amount;
  }

  const fallback = [...normalized.matchAll(/\b([0-9oOiIl|,]{1,9}\.\d{2})\b/g)]
    .map((m) => {
      const cleaned = m[1].replace(/[oO]/g, "0").replace(/[iIl|]/g, "1").replace(/,/g, "");
      return { amount: parseFloat(cleaned), index: m.index || 0 };
    })
    .filter((c) => Number.isFinite(c.amount) && c.amount > 0 && c.amount <= 100000)
    .sort((a, b) => a.index - b.index);
  return fallback.length ? fallback[0].amount : null;
}

// Normalize a PH mobile number to its 10 significant digits (drop 0/63 prefix).
function normalizeMobile(d: string): string {
  let x = digitsOnly(d);
  if (x.startsWith("63")) x = x.slice(2);
  if (x.startsWith("0")) x = x.slice(1);
  return x; // expect 10 digits: 9XXXXXXXXX
}

type NumberCheck = "match" | "wrong" | "unreadable";

function normalizedProvider(raw: string): PaymentProvider {
  const provider = raw.toLowerCase();
  if (provider === "bdopay" || provider === "maya" || provider === "bpi" || provider === "gotyme" || provider === "pnb") return provider;
  return "gcash";
}

function paymentMethodProvider(raw: unknown): PaymentProvider | null {
  const method = String(raw || "").toLowerCase();
  if (method === "gcash" || method === "bdopay" || method === "maya" || method === "bpi" || method === "gotyme" || method === "pnb") {
    return method as PaymentProvider;
  }
  return null;
}

function expectedMerchantForProvider(
  settings: Record<string, string>,
  provider: PaymentProvider,
): { number: string; name: string } {
  if (provider === "bdopay") {
    return {
      number: settings.bdopay_merchant_number || "",
      name: settings.bdopay_merchant_name || settings.payment_merchant_name || "Pickle Bliss Court",
    };
  }
  if (provider === "maya") {
    return {
      number: settings.maya_merchant_number || "",
      name: settings.maya_merchant_name || settings.payment_merchant_name || "Pickle Bliss Court",
    };
  }
  if (provider === "bpi") {
    return {
      number: settings.bpi_merchant_number || "",
      name: settings.bpi_merchant_name || settings.payment_merchant_name || "Pickle Bliss Court",
    };
  }
  if (provider === "gotyme") {
    return {
      number: settings.gotyme_merchant_number || "",
      name: settings.gotyme_merchant_name || "",
    };
  }
  if (provider === "pnb") {
    return {
      number: settings.pnb_merchant_number || "",
      name: settings.pnb_merchant_name || "",
    };
  }
  return {
    number: settings.gcash_merchant_number || "",
    name: settings.gcash_merchant_name || "",
  };
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function closeMoney(a: number, b: number): boolean {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01;
}

function parseJsonArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function rateForHour(hour: number, tiers: Array<Record<string, unknown>>, fallbackRate: number): number {
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

function chooseExpectedDue(total: number, storedDownpayment: number, settings: Record<string, string>): number {
  const half = roundMoney(total / 2);
  const mode = settings.payment_acceptance_mode || "both";
  if (mode === "full_payment_only") return total;
  if (mode === "downpayment_only") return half;
  if (closeMoney(storedDownpayment, total)) return total;
  if (closeMoney(storedDownpayment, half)) return half;
  throw new Error("Stored payment amount does not match current pricing");
}

function expectedOpenPlayAmount(booking: Record<string, unknown>, settings: Record<string, string>): number {
  const cfg = (() => {
    try { return settings.open_play_config ? JSON.parse(settings.open_play_config) : {}; }
    catch { return {}; }
  })() as Record<string, unknown>;
  const openPlayFee = toNumber(cfg.fee ?? settings.open_play_fee, 100);
  const platformFee = toNumber(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee);
  const total = roundMoney(openPlayFee + platformFee);
  return chooseExpectedDue(total, toNumber(booking.downpayment, -1), settings);
}

async function expectedBookingAmount(
  db: any,
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<number> {
  const courtId = String(booking.court_id || "");
  if (!courtId) return expectedOpenPlayAmount(booking, settings);

  const slots = Array.isArray(booking.slots)
    ? booking.slots.map(Number).filter(Number.isFinite)
    : [];
  if (slots.length === 0) throw new Error("Booking has no billable slots");

  const { data: court, error: courtErr } = await db
    .from("courts")
    .select("rate,rate_schedule")
    .eq("id", courtId)
    .single();
  if (courtErr || !court) throw courtErr || new Error("Court not found");

  const courtRow = court as Record<string, unknown>;
  const courtRate = toNumber(courtRow.rate);
  const courtTiers = parseJsonArray(courtRow.rate_schedule);
  const settingTiers = parseJsonArray(settings.pricing_tiers);
  const tiers = courtTiers.length ? courtTiers : settingTiers.length ? settingTiers : [{ from: 0, to: 24, rate: courtRate }];
  const courtTotal = slots.reduce((sum, hour) => sum + rateForHour(hour, tiers, courtRate), 0);
  const feeRate = toNumber(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee);
  const feeType = settings.fee_type === "flat" ? "flat" : "per_hour";
  const serviceFee = feeType === "flat" ? feeRate : feeRate * slots.length;
  const total = roundMoney(courtTotal + serviceFee);
  return chooseExpectedDue(total, toNumber(booking.downpayment, -1), settings);
}

async function loadBookingGroup(
  db: any,
  booking: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "");
  if (!groupRef) return [booking];
  const { data, error } = await db
    .from("bookings")
    .select("ref, booking_group_ref, court_id, slots, total, downpayment, gcash_ref, date, payment_status, status, full_name, created_at")
    .eq("booking_group_ref", groupRef)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

function bookingLogicalKey(row: Record<string, unknown>): string {
  const slots = Array.isArray(row.slots)
    ? row.slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  return [
    String(row.court_id || row.courtId || ""),
    String(row.date || ""),
    slots.join(","),
  ].join("|");
}

function uniqueBookingRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = bookingLogicalKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function expectedBookingGroupAmount(
  db: any,
  bookings: Array<Record<string, unknown>>,
  settings: Record<string, string>,
): Promise<number> {
  let due = 0;
  for (const row of uniqueBookingRows(bookings)) due += await expectedBookingAmount(db, row, settings);
  return roundMoney(due);
}

function bookingGroupStoredTotal(bookings: Array<Record<string, unknown>>): number {
  return roundMoney(uniqueBookingRows(bookings).reduce((sum, row) => sum + toNumber(row.total), 0));
}

function bookingUpdateQuery(
  db: any,
  booking: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  const groupRef = String(booking.booking_group_ref || "");
  const query = db.from("bookings").update(update);
  return groupRef ? query.eq("booking_group_ref", groupRef) : query.eq("ref", String(booking.ref || ""));
}

function checkReceiverNumber(text: string, expectedRaw: string): NumberCheck {
  const expected = normalizeMobile(expectedRaw);
  if (expected.length < 10) return "unreadable"; // no configured number to compare
  const last4 = expected.slice(-4);

  // Full mobile numbers in the receipt (handles +63 / 0 / 9 forms).
  const fullMatches = text.match(/(?:\+?63|0)?9\d{2}[\s\-•*x.]*\d{2,3}[\s\-•*x.]*\d{2,4}/gi) || [];
  let sawFull = false;
  for (const fm of fullMatches) {
    const norm = normalizeMobile(fm);
    if (norm.length >= 10) {
      sawFull = true;
      if (norm === expected) return "match";
    }
  }
  // Masked receipts often reveal only the last 4 digits.
  if (maskedDigitPattern(last4).test(text)) return "match";
  if (new RegExp(`(?:[•*xX#\\s\\-]{2,}|\\d)${last4}\\b`).test(text)) return "match";
  if (text.includes(last4)) return "match";

  // We positively saw a complete, different mobile number → confidently wrong.
  if (sawFull) return "wrong";
  return "unreadable";
}

// Loose masked-name match (e.g. "CO**TY**D P*CKL*B*LL" vs "PICKLE BLISS COURT").
function checkReceiverName(text: string, expectedName: string): "match" | "mismatch" | "unreadable" {
  const expected = (expectedName || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (expected.length < 3) return "unreadable";
  const upper = text.toUpperCase();
  // Compare on the alphabetic skeleton. Masked or incomplete names are neutral:
  // GCash commonly shows names like "AN*****A A.", which should not block a
  // valid receipt when number/ref/amount/date/time are correct.
  const tokens = expected.match(/.{1,4}/g) || [];
  let hits = 0;
  for (const t of tokens) {
    if (upper.replace(/[^A-Z]/g, "").includes(t)) hits++;
  }
  if (hits === 0) {
    // try first 3 visible letters
    if (upper.replace(/[^A-Z]/g, "").includes(expected.slice(0, 3))) return "match";
    return "unreadable";
  }
  return hits >= Math.ceil(tokens.length / 2) ? "match" : "unreadable";
}

// Best-effort "looks like a real GCash receipt" heuristic (soft signal only).
function looksLikeGcashReceipt(text: string): boolean {
  const t = text.toLowerCase();
  let score = 0;
  if (/ref(?:erence)?\s*(no|number|#)/.test(t)) score++;
  if (/gcash|bdo\s*pay|gotyme|maya|bpi|paymongo|qrph|insta\s*pay|pesonet|g-?xchange|gxi/.test(t)) score++;
  if (/sent|received|paid|transfer|amount|confirmation\s*(no|number|#)/.test(t)) score++;
  if (/\d{4}/.test(t)) score++;
  return score >= 2;
}

// Best-effort JPEG "edited in image software" detector (soft signal only).
function editedBySoftware(bytes: Uint8Array): boolean {
  // Scan the first 64KB for editor signatures embedded in EXIF/XMP.
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let s = "";
  for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i.test(s);
}

function googleVisionConfidence(annotation: Record<string, unknown> | null, text: string): number {
  if (!annotation) return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
  const pages = Array.isArray(annotation.pages) ? annotation.pages as Array<Record<string, unknown>> : [];
  if (pages.length && typeof pages[0].confidence === "number" && pages[0].confidence > 0) {
    return pages[0].confidence;
  }

  let total = 0;
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (typeof item.confidence === "number" && item.confidence > 0) {
      total += item.confidence;
      count++;
    }
    for (const key of ["blocks", "paragraphs", "words", "symbols"]) {
      const children = item[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
  };
  pages.forEach(visit);
  if (count > 0) return total / count;
  return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
}

async function googleVisionOCR(apiKey: string, base64: string): Promise<{ text: string; confidence: number }> {
  const content = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
        imageContext: { languageHints: ["en"] },
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vision error ${res.status}: ${errMsg(data)}`);
  const r = data?.responses?.[0];
  if (r?.error) throw new Error(`Vision: ${errMsg(r.error)}`);
  const text: string = r?.fullTextAnnotation?.text || r?.textAnnotations?.[0]?.description || "";
  return { text, confidence: googleVisionConfidence(r?.fullTextAnnotation || null, text) };
}

// Google Vision is the only OCR engine used for receipt verification.
function ocrCriticalGaps(text: string, provider: PaymentProvider, typedRef: string): string[] {
  if (!text) return ["text"];
  const gaps: string[] = [];
  if (!extractReference(text, provider, typedRef)) gaps.push("reference");
  if (extractReceiptAmount(text) == null) gaps.push("amount");
  if (provider !== "maya" && !parseReceiptDateTime(text).date) gaps.push("date");
  return gaps;
}

function ocrScore(result: { text: string; confidence: number }, provider: PaymentProvider, typedRef: string): number {
  const gaps = ocrCriticalGaps(result.text, provider, typedRef).length;
  return (result.text ? 100 : 0)
    + Math.min(80, result.text.length / 10)
    + result.confidence * 30
    - gaps * 35;
}

function needsOcrRetry(result: { text: string; confidence: number }, provider: PaymentProvider, typedRef: string): boolean {
  if (!result.text) return true;
  if (result.confidence < 0.55) return true;
  return ocrCriticalGaps(result.text, provider, typedRef).length > 0;
}

async function runOCR(
  visionKey: string,
  base64: string,
  bytes: Uint8Array,
  provider: PaymentProvider,
  typedRef: string,
): Promise<OcrResult> {
  if (visionKey) {
    let best: OcrResult | null = null;
    try {
      const v = await googleVisionOCR(visionKey, base64);
      best = { ...v, provider: "google_vision", primaryProvider: "google_vision", imageVariant: "original" };
      const gaps = ocrCriticalGaps(v.text, provider, typedRef);
      if (!needsOcrRetry(v, provider, typedRef)) {
        return best;
      }

      const variants = await buildOcrImageVariants(bytes);
      for (const variant of variants) {
        try {
          const retry = await googleVisionOCR(visionKey, variant.base64);
          const candidate: OcrResult = {
            ...retry,
            provider: "google_vision",
            primaryProvider: "google_vision",
            fallbackProvider: "google_vision",
            fallbackReason: `retry_${variant.label}`,
            imageVariant: variant.label,
          };
          if (!best || ocrScore(candidate, provider, typedRef) > ocrScore(best, provider, typedRef)) {
            best = candidate;
          }
          if (!needsOcrRetry(candidate, provider, typedRef)) return candidate;
        } catch (e) {
          console.error(`Vision OCR retry failed (${variant.label}):`, errMsg(e));
        }
      }
      if (best?.text) {
        const bestGaps = ocrCriticalGaps(best.text, provider, typedRef);
        return {
          ...best,
          fallbackReason: best.fallbackReason || (bestGaps.length ? `google_missing_${bestGaps.join("_")}` : undefined),
        };
      }
      console.error("Vision OCR returned no text:", gaps.join(","));
      return {
        text: "",
        confidence: 0,
        provider: "google_vision",
        primaryProvider: "google_vision",
        fallbackReason: gaps.length ? `google_no_text_missing_${gaps.join("_")}` : "google_no_text",
        imageVariant: "original",
      };
    } catch (e) {
      console.error("Vision OCR failed:", errMsg(e));
      const originalError = errMsg(e);
      const variants = await buildOcrImageVariants(bytes);
      for (const variant of variants) {
        try {
          const retry = await googleVisionOCR(visionKey, variant.base64);
          if (retry.text) {
            return {
              ...retry,
              provider: "google_vision",
              primaryProvider: "google_vision",
              fallbackProvider: "google_vision",
              fallbackReason: `original_failed_retry_${variant.label}`,
              imageVariant: variant.label,
            };
          }
        } catch (retryErr) {
          console.error(`Vision OCR retry failed (${variant.label}):`, errMsg(retryErr));
        }
      }
      return {
        text: "",
        confidence: 0,
        provider: "none",
        primaryProvider: "none",
        fallbackReason: `google_vision_failed: ${originalError}`,
      };
    }
  }
  return { text: "", confidence: 0, provider: "none", fallbackReason: "google_vision_key_missing" };
}

async function sendTelegram(message: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatIdRaw = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!botToken || !chatIdRaw) return;
  const chatIds = chatIdRaw.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(chatIds.map((chatId) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    })
  ));
}

// ── handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey =
    Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ error: "Missing SERVICE_ROLE_KEY" }, 500);
  const db = createClient(supabaseUrl, serviceRoleKey);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = (body.action as string) || "verify";

  if (action === "stage_upload") {
    try {
      const bookingRef = String(body.bookingRef || "").trim();
      const provider = normalizedProvider(String(body.provider || "gcash"));
      const contentType = String(body.contentType || "image/jpeg");
      if (!bookingRef) return json({ error: "bookingRef is required" }, 400);
      const capabilityHash = await holdTokenHash(body.holdToken);

      const { data: booking, error: bookingError } = await db
        .from("bookings")
        .select("ref, booking_group_ref, status, created_at, hold_token_hash")
        .eq("ref", bookingRef)
        .single();
      if (bookingError || !booking) return json({ error: "Booking hold was not found" }, 404);
      if (!freshVerifyingHold(booking as Record<string, unknown>)) {
        return json({ error: "Booking hold has expired or is no longer awaiting completion", code: "HOLD_EXPIRED" }, 409);
      }
      if (String(booking.hold_token_hash || "") !== capabilityHash) {
        return json({ error: "Invalid hold capability", code: "INVALID_HOLD_CAPABILITY" }, 403);
      }

      const groupRef = String(booking.booking_group_ref || "");
      let groupQuery = db.from("bookings").select("ref, status, created_at, hold_token_hash");
      groupQuery = groupRef ? groupQuery.eq("booking_group_ref", groupRef) : groupQuery.eq("ref", bookingRef);
      const { data: groupRows, error: groupError } = await groupQuery;
      if (groupError || !groupRows?.length) return json({ error: "Booking hold group was not found" }, 404);
      if (groupRows.some((row: Record<string, unknown>) =>
        !freshVerifyingHold(row) || String(row.hold_token_hash || "") !== capabilityHash
      )) {
        return json({ error: "One or more booking holds expired or do not belong to this checkout", code: "HOLD_EXPIRED" }, 409);
      }

      const { count: recentCount } = await db
        .from("receipt_staged_uploads")
        .select("id", { count: "exact", head: true })
        .eq("hold_token_hash", capabilityHash)
        .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
      if ((recentCount || 0) >= STAGED_UPLOAD_LIMIT_PER_HOLD) {
        return json({ error: "Too many receipt uploads for this checkout. Please contact the court owner.", code: "UPLOAD_LIMIT" }, 429);
      }

      let bytes: Uint8Array;
      try { bytes = base64ToBytes(String(body.imageBase64 || "")); }
      catch { return json({ error: "Receipt image encoding is invalid" }, 400); }
      if (!bytes.length) return json({ error: "Receipt image is empty" }, 400);
      if (bytes.length > MAX_BYTES) return json({ error: "Receipt image is too large (max 5 MB)" }, 413);
      const detected = safeReceiptMime(bytes, contentType);
      if (!detected) return json({ error: "Only valid JPEG, PNG, WebP, HEIC, or HEIF receipt images are accepted" }, 415);

      try { await cleanupExpiredStagedUploads(db); }
      catch (error) { console.error("opportunistic staged cleanup failed:", errMsg(error)); }

      const uploadId = crypto.randomUUID();
      const objectPath = `staged/${uploadId}/${crypto.randomUUID()}.${detected.ext}`;
      const imageHash = await sha256Hex(bytes);
      const createdMs = new Date(String(booking.created_at)).getTime();
      const expiresAt = new Date(createdMs + HOLD_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { error: uploadError } = await db.storage.from("receipts").upload(objectPath, bytes, {
        contentType: detected.contentType,
        upsert: false,
      });
      if (uploadError) {
        console.error("staged receipt storage failed:", errMsg(uploadError));
        return json({ error: "Receipt could not be stored. Please retry before confirming.", code: "STORAGE_UPLOAD_FAILED" }, 502);
      }

      const { error: insertError } = await db.from("receipt_staged_uploads").insert({
        id: uploadId,
        booking_ref: bookingRef,
        booking_group_ref: groupRef || null,
        hold_token_hash: capabilityHash,
        storage_path: objectPath,
        content_type: detected.contentType,
        byte_size: bytes.length,
        image_hash: imageHash,
        provider,
        status: "staged",
        expires_at: expiresAt,
      });
      if (insertError) {
        await db.storage.from("receipts").remove([objectPath]);
        console.error("staged receipt record failed:", errMsg(insertError));
        return json({ error: "Receipt upload could not be recorded. Please retry.", code: "UPLOAD_RECORD_FAILED" }, 500);
      }

      // A newly selected receipt replaces earlier unconsumed evidence for this
      // checkout. Claim rows before removing their private objects.
      const { data: replaced } = await db
        .from("receipt_staged_uploads")
        .update({ status: "abandoned" })
        .eq("booking_ref", bookingRef)
        .eq("hold_token_hash", capabilityHash)
        .eq("status", "staged")
        .neq("id", uploadId)
        .select("storage_path");
      if (replaced?.length) {
        const { error: removeError } = await db.storage.from("receipts").remove(replaced.map((row: { storage_path: string }) => row.storage_path));
        if (removeError) console.error("replaced staged receipt removal failed:", errMsg(removeError));
        else await db.from("receipt_staged_uploads")
          .update({ storage_deleted_at: new Date().toISOString() })
          .in("storage_path", replaced.map((row: { storage_path: string }) => row.storage_path))
          .eq("status", "abandoned");
      }

      return json({
        ok: true,
        uploadId,
        status: "staged",
        uploadedAt: new Date().toISOString(),
        expiresAt,
      });
    } catch (error) {
      const message = errMsg(error);
      const status = message === "Invalid hold capability" ? 403 : 500;
      return json({ error: status === 403 ? message : "Receipt upload failed. Please retry.", code: status === 403 ? "INVALID_HOLD_CAPABILITY" : "STAGE_UPLOAD_FAILED" }, status);
    }
  }

  if (action === "abandon_upload") {
    try {
      const bookingRef = String(body.bookingRef || "").trim();
      const uploadId = String(body.uploadId || "").trim();
      if (!bookingRef || !uploadId) return json({ error: "bookingRef and uploadId are required" }, 400);
      const capabilityHash = await holdTokenHash(body.holdToken);
      const { data: abandoned, error } = await db
        .from("receipt_staged_uploads")
        .update({ status: "abandoned" })
        .eq("id", uploadId)
        .eq("booking_ref", bookingRef)
        .eq("hold_token_hash", capabilityHash)
        .eq("status", "staged")
        .select("storage_path")
        .maybeSingle();
      if (error) return json({ error: "Receipt could not be abandoned" }, 500);
      if (!abandoned) return json({ error: "Staged receipt was not found or is no longer removable" }, 404);
      const { error: removeError } = await db.storage.from("receipts").remove([abandoned.storage_path]);
      if (removeError) console.error("abandoned staged receipt removal failed:", errMsg(removeError));
      else await db.from("receipt_staged_uploads")
        .update({ storage_deleted_at: new Date().toISOString() })
        .eq("id", uploadId)
        .eq("status", "abandoned");
      return json({ ok: true });
    } catch (error) {
      const message = errMsg(error);
      return json({ error: message === "Invalid hold capability" ? message : "Receipt could not be abandoned" }, message === "Invalid hold capability" ? 403 : 500);
    }
  }

  if (action === "finalize_booking") {
    try {
      const bookingRef = String(body.bookingRef || "").trim();
      const uploadId = String(body.uploadId || "").trim();
      const customer = body.customer && typeof body.customer === "object" ? body.customer as Record<string, unknown> : {};
      const payment = body.payment && typeof body.payment === "object" ? body.payment as Record<string, unknown> : {};
      const items = Array.isArray(body.items) ? body.items : [];
      if (!bookingRef || !uploadId || !items.length) {
        return json({ error: "bookingRef, uploadId, and booking items are required" }, 400);
      }
      const capabilityHash = await holdTokenHash(body.holdToken);
      const { data, error } = await db.rpc("finalize_staged_booking", {
        p_booking_ref: bookingRef,
        p_hold_token_hash: capabilityHash,
        p_upload_id: uploadId,
        p_full_name: String(customer.fullName || ""),
        p_contact_number: String(customer.contactNumber || ""),
        p_email: String(customer.email || ""),
        p_payment_method: String(payment.method || ""),
        p_payment_reference: String(payment.reference || ""),
        p_payment_flow: String(payment.flow || payment.method || ""),
        p_items: items,
      });
      if (error) {
        const message = errMsg(error);
        const conflict = /expired|no longer|slot|another checkout|already consumed/i.test(message);
        const forbidden = /capability|receipt service/i.test(message);
        return json({ error: message, code: conflict ? "FINALIZE_CONFLICT" : forbidden ? "INVALID_HOLD_CAPABILITY" : "FINALIZE_INVALID" }, conflict ? 409 : forbidden ? 403 : 400);
      }
      if (String(payment.method || "").trim().toLowerCase() === "maya") {
        // Maya is approved atomically by the staged-booking database trigger.
        // Return the persisted state instead of the RPC's legacy hard-coded
        // pending response so the browser never presents a successful Maya
        // checkout as awaiting review.
        const { data: persisted, error: persistedError } = await db
          .from("bookings")
          .select("status,payment_status,receipt_status")
          .eq("ref", bookingRef)
          .maybeSingle();
        if (persistedError) {
          console.error("finalized Maya booking state read failed:", errMsg(persistedError));
        }
        if (persisted) {
          return json({
            ...(data || { ok: true }),
            status: persisted.status,
            paymentStatus: persisted.payment_status,
            receiptStatus: persisted.receipt_status,
          });
        }
      }
      return json(data || { ok: true, status: "pending" });
    } catch (error) {
      const message = errMsg(error);
      return json({ error: message === "Invalid hold capability" ? message : "Booking could not be finalized", code: "FINALIZE_FAILED" }, message === "Invalid hold capability" ? 403 : 500);
    }
  }

  if (action === "cleanup_staged") {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "Unauthorized" }, 401);
    const { data: account } = await db.from("accounts").select("role").eq("id", userData.user.id).maybeSingle();
    if (!account || !["owner", "court_owner", "developer"].includes(String(account.role || ""))) {
      return json({ error: "Forbidden" }, 403);
    }
    const cleaned = await cleanupExpiredStagedUploads(db, Number(body.limit || STAGED_CLEANUP_BATCH));
    return json({ ok: true, cleaned });
  }

  // ── admin-only: mint a signed URL to view a stored receipt ────────────────
  if (action === "sign") {
    const bookingRef = String(body.bookingRef || "");
    const openPlayRegistrationId = String(body.openPlayRegistrationId || "");
    const hostSessionRegistrationId = String(body.hostSessionRegistrationId || "");
    if (!bookingRef && !openPlayRegistrationId && !hostSessionRegistrationId) {
      return json({ error: "bookingRef, openPlayRegistrationId, or hostSessionRegistrationId required" }, 400);
    }

    // Require a real signed-in user (anon key alone is rejected).
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "Unauthorized" }, 401);

    let path: string | null = null;
    if (hostSessionRegistrationId) {
      const { data: reg } = await db
        .from("open_play_host_session_registrations")
        .select("receipt_image_url")
        .eq("id", hostSessionRegistrationId)
        .single();
      path = reg?.receipt_image_url || null;
    } else if (openPlayRegistrationId) {
      const { data: reg } = await db
        .from("open_play_registrations")
        .select("receipt_image_url")
        .eq("id", openPlayRegistrationId)
        .single();
      path = reg?.receipt_image_url || null;
    } else {
      const { data: bk } = await db.from("bookings").select("receipt_image_url").eq("ref", bookingRef).single();
      path = bk?.receipt_image_url || null;
    }
    if (!path) return json({ error: "No receipt on file" }, 404);
    const { data: signed, error: signErr } = await db.storage.from("receipts").createSignedUrl(path, 300);
    if (signErr || !signed) return json({ error: errMsg(signErr || "sign failed") }, 500);
    return json({ ok: true, url: signed.signedUrl });
  }

  // ── verify a freshly-uploaded receipt ─────────────────────────────────────
  try {
    const bookingRef = String(body.bookingRef || "");
    let provider = normalizedProvider(String(body.provider || "gcash"));
    const imageBase64 = String(body.imageBase64 || "");
    let contentType = String(body.contentType || "image/jpeg");
    const stagedVerify = action === "verify_staged";
    // Optional: caller passes booking data so we can verify before saving to DB.
    // When present the DB lookup and the DB update at the end are both skipped.
    const inlineBookingData = (body.bookingData && typeof body.bookingData === "object")
      ? body.bookingData as Record<string, unknown>
      : null;
    if (!bookingRef) return json({ error: "bookingRef required" }, 400);
    if (!stagedVerify && !inlineBookingData) {
      return json({ error: "Booking receipts must be staged and finalized before verification", code: "STAGED_UPLOAD_REQUIRED" }, 400);
    }

    // Load the booking we are verifying against (skip if inline data provided).
    let booking: Record<string, unknown>;
    if (inlineBookingData) {
      booking = inlineBookingData;
    } else {
      const { data: bk, error: bErr } = await db
        .from("bookings")
        .select("ref, booking_group_ref, court_id, slots, total, downpayment, gcash_ref, payment_method, date, payment_status, status, full_name, created_at, hold_token_hash")
        .eq("ref", bookingRef)
        .single();
      if (bErr || !bk) return json({ error: "Booking not found" }, 404);
      booking = bk as Record<string, unknown>;
    }
    let bytes: Uint8Array;
    let objectPath: string;
    if (stagedVerify) {
      if (inlineBookingData) return json({ error: "bookingData is not accepted for staged verification" }, 400);
      const uploadId = String(body.uploadId || "").trim();
      if (!uploadId) return json({ error: "uploadId is required" }, 400);
      const capabilityHash = await holdTokenHash(body.holdToken);
      if (String(booking.hold_token_hash || "") !== capabilityHash) {
        return json({ error: "Invalid hold capability", code: "INVALID_HOLD_CAPABILITY" }, 403);
      }
      const { data: staged, error: stagedError } = await db
        .from("receipt_staged_uploads")
        .select("storage_path, content_type, image_hash, provider, status")
        .eq("id", uploadId)
        .eq("booking_ref", bookingRef)
        .eq("hold_token_hash", capabilityHash)
        .eq("status", "consumed")
        .single();
      if (stagedError || !staged) {
        return json({ error: "Finalized staged receipt was not found", code: "STAGED_RECEIPT_NOT_FOUND" }, 404);
      }
      objectPath = String(staged.storage_path);
      contentType = String(staged.content_type || "image/jpeg");
      provider = normalizedProvider(String(staged.provider || provider));
      const { data: objectData, error: downloadError } = await db.storage.from("receipts").download(objectPath);
      if (downloadError || !objectData) {
        console.error("staged receipt download failed:", errMsg(downloadError));
        return json({ error: "Stored receipt could not be read. The booking remains pending for manual review.", code: "STAGED_RECEIPT_READ_FAILED" }, 502);
      }
      bytes = new Uint8Array(await objectData.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES || !safeReceiptMime(bytes, contentType)) {
        return json({ error: "Stored receipt is invalid. The booking remains pending for manual review.", code: "STAGED_RECEIPT_INVALID" }, 422);
      }
      const downloadedHash = await sha256Hex(bytes);
      if (downloadedHash !== String(staged.image_hash || "")) {
        return json({ error: "Stored receipt integrity check failed. The booking remains pending for manual review.", code: "STAGED_RECEIPT_INTEGRITY" }, 409);
      }
    } else {
      if (!imageBase64) return json({ error: "imageBase64 required" }, 400);
      try { bytes = base64ToBytes(imageBase64); }
      catch { return json({ error: "Invalid image encoding" }, 400); }
      if (bytes.length === 0) return json({ error: "Empty image" }, 400);
      if (bytes.length > MAX_BYTES) return json({ error: "Image too large (max 5 MB)" }, 413);
      const detected = safeReceiptMime(bytes, contentType);
      if (!detected) return json({ error: "Unsupported or invalid receipt image" }, 415);
      contentType = detected.contentType;
      objectPath = `${bookingRef}/${Date.now()}-${crypto.randomUUID()}.${detected.ext}`;
      const { error: uploadError } = await db.storage.from("receipts").upload(objectPath, bytes, {
        contentType,
        upsert: false,
      });
      if (uploadError) {
        console.error("receipt upload failed:", errMsg(uploadError));
        return json({ error: "Receipt could not be stored. Please retry.", code: "STORAGE_UPLOAD_FAILED" }, 502);
      }
    }
    provider = paymentMethodProvider(booking.payment_method ?? booking.paymentMethod) || provider;

    const settingsRows = await db.from("settings").select("key,value");
    const settings: Record<string, string> = {};
    (settingsRows.data || []).forEach((r: { key: string; value: string }) => { settings[r.key] = r.value; });
    const expectedMerchant = expectedMerchantForProvider(settings, provider);
    const expectedNumber = expectedMerchant.number;
    const expectedName = expectedMerchant.name;
    let pricingError = "";
    let expectedAmount = Number(booking.downpayment ?? (Number(booking.total) || 0) / 2);
    let expectedTotal = Number(booking.total || 0);
    let bookingGroup: Array<Record<string, unknown>> = [booking];
    try {
      if (inlineBookingData && Number(booking.total || 0) > 0) {
        expectedTotal = roundMoney(Number(booking.total || 0));
        expectedAmount = chooseExpectedDue(expectedTotal, toNumber(booking.downpayment, expectedTotal), settings);
      } else {
        bookingGroup = await loadBookingGroup(db, booking);
        expectedAmount = await expectedBookingGroupAmount(db, bookingGroup, settings);
        expectedTotal = bookingGroupStoredTotal(bookingGroup);
      }
    } catch (err) {
      pricingError = errMsg(err);
    }
    const bookingGroupRefs = new Set(bookingGroup.map(row => String(row.ref || "")).filter(Boolean));

    // Hashes are stored for audit only. GCash validity is based on receipt details.
    const imageHash = await sha256Hex(bytes);
    const phash = await dHash(bytes);

    const flags: string[] = [];

    // Do not flag duplicate-looking images. GCash/BDO Pay/Maya receipt screens
    // share the same layout, so perceptual image matching creates false flags.
    // Reuse protection is handled by exact payment refs/invoices below.

    // ── OCR ─────────────────────────────────────────────────────────────────
    const visionKey = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
    const typedRef = normalizeReferenceForProvider(String(booking.gcash_ref || ""), provider);
    let ocrText = "";
    let ocrConfidence = 0;
    let ocrProvider: OcrResult["provider"] = "none";
    let ocrPrimaryProvider: OcrResult["primaryProvider"] = "none";
    let ocrFallbackProvider: OcrResult["fallbackProvider"] | null = null;
    let ocrFallbackReason: string | null = null;
    let ocrImageVariant: string | null = null;
    try {
      const ocr = await runOCR(visionKey, imageBase64, bytes, provider, typedRef);
      ocrText = ocr.text;
      ocrConfidence = ocr.confidence;
      ocrProvider = ocr.provider;
      ocrPrimaryProvider = ocr.primaryProvider || ocr.provider;
      ocrFallbackProvider = ocr.fallbackProvider || null;
      ocrFallbackReason = ocr.fallbackReason || null;
      ocrImageVariant = ocr.imageVariant || null;
    } catch (e) {
      console.error("Google Vision OCR failed:", errMsg(e));
    }
    if (!visionKey) {
      // No OCR provider configured at all — cannot verify content, manual review.
      flags.push("OCR_UNAVAILABLE");
    } else if (!ocrText) {
      // Google Vision ran but found no usable text, or the OCR call failed.
      // Keep this in manual review: clear mobile screenshots can still fail OCR
      // because of compression, screenshots-within-screenshots, or API latency.
      flags.push("IMAGE_UNREADABLE");
    }

    // ── field extraction ────────────────────────────────────────────────────
    const extractedRef = extractReference(ocrText, provider, typedRef);
    const extractedInvoice = provider === "bdopay" ? extractBdoInvoiceNumber(ocrText) : null;
    const extractedInstapayRefNo = null;
    const extractedBpiTransactionRefNo = provider === "bpi" ? extractBpiTransactionRefNo(ocrText) : null;
    const extractedAmount = extractReceiptAmount(ocrText);
    const { date: receiptDate, shifted: receiptDateTime } = parseReceiptDateTime(ocrText);
    const bookingStartedAt = toPhWallClockDate(booking.created_at || booking.createdAt);
    const bookingStartedDate = bookingStartedAt ? bookingStartedAt.toISOString().slice(0, 10) : null;
    const receiptAgeMinutes = bookingStartedAt && receiptDateTime
      ? (receiptDateTime.getTime() - bookingStartedAt.getTime()) / 60000
      : null;
    if (provider === "gcash" && typedRef.length !== 13) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bdopay" && !isBdoPayReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "maya" && !isMayaReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bpi" && !isBpiConfirmationNo(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }

    // ── content checks (only when OCR text exists) ──────────────────────────
    if (ocrText) {
      if (selectedMethodMismatch(provider, ocrText)) {
        flags.push("METHOD_MISMATCH");
      }

      if (provider === "gcash") {
        // GCash-to-GCash focused path. The receipt layout is consistent but OCR
        // can miss the small right-aligned timestamp, so unreadable date/time is
        // not a failure for GCash. Parsed dates/times are still enforced.
        if (!extractedRef && !flags.includes("REF_FORMAT_INVALID")) flags.push("REF_FORMAT_INVALID");
        else if (typedRef && extractedRef && extractedRef !== typedRef) flags.push("REF_MISMATCH");

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");

        if (receiptDate && bookingStartedDate && receiptDate !== bookingStartedDate) flags.push("DATE_NOT_TODAY");
        if (receiptDateTime && bookingStartedAt) {
          if ((receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES) flags.push("TIME_FUTURE");
          else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) flags.push("TIME_EXPIRED");
        }

        if (!isGcashToGcashReceipt(ocrText)) flags.push("GCASH_RECEIPT_UNREADABLE");

        const numCheck = checkReceiverNumber(ocrText, expectedNumber);
        if (numCheck === "wrong") flags.push("WRONG_GCASH_NUMBER");
        else if (numCheck === "unreadable" && expectedNumber) flags.push("NUMBER_UNREADABLE");

        const nameCheck = checkReceiverName(ocrText, expectedName);
        if (nameCheck === "mismatch") flags.push("RECEIVER_NAME_MISMATCH");
      } else if (provider === "bdopay") {
        // BDO Pay focused path: do not require GCash/GXI/Maya evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) flags.push("REF_MISMATCH");

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) flags.push("DATE_NOT_TODAY");
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if ((receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) flags.push("TIME_EXPIRED");

        if (!hasBdoPayIndicator(ocrText)) flags.push("BDO_PAY_UNREADABLE");
        if (!hasExpectedReceiverName(ocrText, expectedName)) flags.push("RECEIVER_NAME_UNREADABLE");
        if (!extractedInvoice) flags.push("INVOICE_UNREADABLE");
      } else if (provider === "maya") {
        // Collect Maya-specific audit signals. GCash-to-Maya receipts may fail
        // these OCR checks, but selected-Maya policy keeps the flags audit-only.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) flags.push("REF_MISMATCH");

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");

        if (!hasMayaIndicator(ocrText)) flags.push("MAYA_UNREADABLE");
        if (!hasMayaCompletedIndicator(ocrText)) flags.push("MAYA_UNREADABLE");
        const numCheck = checkReceiverNumber(ocrText, expectedNumber);
        if (numCheck === "wrong") flags.push("WRONG_RECEIVER_NUMBER");
        else if (numCheck === "unreadable" && expectedNumber) flags.push("NUMBER_UNREADABLE");
        if (!hasExpectedReceiverName(ocrText, expectedName)) flags.push("RECEIVER_NAME_UNREADABLE");
      } else if (provider === "bpi") {
        // BPI focused path: require BPI + InstaPay + GCash/G-Xchange destination,
        // but do not run the GCash-to-GCash verifier.
        if (!extractedRef) flags.push("BPI_CONFIRMATION_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) flags.push("REF_MISMATCH");

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) flags.push("DATE_NOT_TODAY");
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if ((receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) flags.push("TIME_EXPIRED");

        if (!hasBpiIndicator(ocrText)) flags.push("BPI_UNREADABLE");
        if (!hasInstapayQrphIndicator(ocrText)) flags.push("INSTAPAY_QRPH_UNREADABLE");
        if (!hasGcashGxiDestination(ocrText)) flags.push("GXI_DESTINATION_UNREADABLE");
        if (!hasExpectedReceiverName(ocrText, expectedName)) flags.push("RECEIVER_NAME_UNREADABLE");
      } else {
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) flags.push("REF_MISMATCH");

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");
      }

      // Authenticity heuristics — HARD: a non-receipt image should be rejected outright.
      if (!looksLikeGcashReceipt(ocrText)) flags.push("SUSPECTED_FAKE");
    }
    if (editedBySoftware(bytes)) flags.push("EDITED_METADATA");

    // Low OCR confidence → soft review signal.
    if (ocrText && ocrConfidence < 0.55) flags.push("LOW_OCR_CONFIDENCE");

    // ── reference reuse / replay guard ──────────────────────────────────────
    // Use the OCR-extracted ref when available, else the customer-typed ref.
    // GCash refs are stored as digits only; other providers are namespaced so
    // same-looking references from different banks do not collide.
    const rawRefForDedupe = extractedRef || typedRef || null;
    const refForDedupe = rawRefForDedupe
      ? provider === "gcash" ? rawRefForDedupe : `${provider}:${rawRefForDedupe}`
      : null;
    const dedupeKeys: Array<{ key: string; providerKey: string; duplicateFlag: string }> = [];
    if (refForDedupe) {
      dedupeKeys.push({ key: refForDedupe, providerKey: provider, duplicateFlag: "DUPLICATE_REF" });
    }
    if (provider === "bdopay" && extractedInvoice) {
      dedupeKeys.push({
        key: `bdopay_invoice:${extractedInvoice}`,
        providerKey: "bdopay_invoice",
        duplicateFlag: "DUPLICATE_INVOICE",
      });
    }
    if (provider === "maya" && extractedInstapayRefNo) {
      dedupeKeys.push({
        key: `maya_instapay:${extractedInstapayRefNo}`,
        providerKey: "maya_instapay",
        duplicateFlag: "DUPLICATE_INSTAPAY_REF",
      });
    }
    if (provider === "bpi" && extractedBpiTransactionRefNo) {
      dedupeKeys.push({
        key: `bpi_transaction:${extractedBpiTransactionRefNo}`,
        providerKey: "bpi_transaction",
        duplicateFlag: "DUPLICATE_BPI_TRANSACTION_REF",
      });
    }

    const alreadyClaimedByThisBooking = new Set<string>();
    for (const item of dedupeKeys) {
      const { data: existingRef } = await db
        .from("used_gcash_refs")
        .select("booking_ref")
        .eq("gcash_ref", item.key)
        .maybeSingle();
      if (existingRef && !bookingGroupRefs.has(String(existingRef.booking_ref || ""))) {
        flags.push(item.duplicateFlag);
      } else if (existingRef && bookingGroupRefs.has(String(existingRef.booking_ref || ""))) {
        alreadyClaimedByThisBooking.add(item.key);
      }
    }

    // ── decision routing ────────────────────────────────────────────────────
    const hasHard = flags.some((f) => HARD_FLAGS.has(f));
    const hasSoftOrUnreadable = flags.length > 0;
    // Venue policy: a booking paid through the Maya option is approved after
    // its receipt has been stored and the booking itself has been validated.
    // Customers may send to Maya from GCash, so receipt/OCR and duplicate flags
    // remain available for auditing but must not route Maya bookings to review
    // or rejection.
    const autoApproveMaya = provider === "maya";
    if (autoApproveMaya && !flags.includes("MAYA_POLICY_AUTO_APPROVED")) {
      flags.push("MAYA_POLICY_AUTO_APPROVED");
    }
    let result: "auto_approved" | "manual_review" | "rejected";
    if (autoApproveMaya) result = "auto_approved";
    else if (hasHard) result = "rejected";
    else if (hasSoftOrUnreadable) result = "manual_review";
    else result = "auto_approved";

    // Race-safe claim of payment ledger keys. The table's primary key on
    // gcash_ref is the source of truth if another request claims the same key.
    if (result === "auto_approved") {
      for (const item of dedupeKeys) {
        if (alreadyClaimedByThisBooking.has(item.key)) continue;
        const { error: claimErr } = await db
          .from("used_gcash_refs")
          .insert({ gcash_ref: item.key, booking_ref: bookingRef, provider: item.providerKey });
        if (claimErr) {
          console.error("payment ledger claim failed:", errMsg(claimErr));
          if (!flags.includes(item.duplicateFlag)) flags.push(item.duplicateFlag);
          if (!autoApproveMaya) {
            result = "rejected";
            break;
          }
        }
      }
    }

    // Policy approval is not evidence that OCR was confident. Preserve the
    // measured value for Maya so the audit trail remains truthful.
    const confidence = autoApproveMaya ? ocrConfidence
      : result === "auto_approved" ? Math.max(0.9, ocrConfidence)
      : result === "manual_review" ? 0.5 : 0.1;

    const extracted = {
      ref: extractedRef,
      invoice: extractedInvoice,
      instapayRefNo: extractedInstapayRefNo,
      bpiConfirmationNo: provider === "bpi" ? extractedRef : null,
      bpiTransactionRefNo: extractedBpiTransactionRefNo,
      amount: extractedAmount,
      date: receiptDate,
      time: receiptDateTime ? receiptDateTime.toISOString() : null,
      timePh12: formatPhDateTime12(receiptDateTime),
      bookingStartedAt: bookingStartedAt ? bookingStartedAt.toISOString() : null,
      bookingStartedAtPh12: formatPhDateTime12(bookingStartedAt),
      bookingStartedDate,
      receiptAgeMinutes,
      allowedPaymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
      allowedPaymentEarlyToleranceMinutes: PAYMENT_EARLY_TOLERANCE_MINUTES,
      expectedAmount,
      provider,
      approvalPolicy: autoApproveMaya ? "maya_auto_approve" : null,
      ocrProvider,
      ocrPrimaryProvider,
      ocrFallbackProvider,
      ocrFallbackReason,
      ocrImageVariant,
      ocrConfidence,
      ocrTextLength: ocrText.length,
      expectedReceiverNumber: provider === "bdopay" || provider === "bpi" ? null : expectedNumber || null,
      expectedReceiverName: expectedName || null,
    };

    // ── persist outcome on the booking ──────────────────────────────────────
    // Split into TWO updates so a transient failure on a single metadata field
    // (e.g. JSONB shape, missing column) cannot prevent the slot from being
    // released. Pass 1 = status invariants (the only fields that gate slot
    // availability). Pass 2 = receipt_* metadata for admin/audit display.
    const statusUpdate: Record<string, unknown> = {};
    if (result === "auto_approved") {
      const fullyPaid = expectedAmount >= expectedTotal - PESO_TOLERANCE;
      statusUpdate.payment_status = fullyPaid ? "paid" : "downpayment_paid";
      if (booking.status !== "completed" && booking.status !== "cancelled") {
        statusUpdate.status = "confirmed";
      }
    } else if (result === "manual_review") {
      statusUpdate.payment_status = "for_verification";
      if (booking.status !== "completed" && booking.status !== "cancelled") {
        statusUpdate.status = "pending";
      }
    } else if (result === "rejected") {
      // Cancel the booking immediately — invalid/fake receipt → slot must be freed.
      statusUpdate.status = "cancelled";
      statusUpdate.payment_status = "rejected";
    }

    const metadataUpdate: Record<string, unknown> = {
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: phash,
      receipt_status: result,
      receipt_flags: flags,
      receipt_extracted: extracted,
      receipt_confidence: confidence,
      receipt_verified_at: new Date().toISOString(),
    };

    let statusUpdateError: string | null = null;
    let metadataUpdateError: string | null = null;

    // Skip DB update when booking hasn't been saved yet (pre-save verification flow).
    if (!inlineBookingData) {
      // Pass 1 — status invariants (CRITICAL for slot release on rejection).
      if (Object.keys(statusUpdate).length > 0) {
        const { data: statusRows, error: sErr } = await bookingUpdateQuery(db, booking, statusUpdate)
          .select("ref, status, payment_status");
        if (sErr) {
          statusUpdateError = errMsg(sErr);
          console.error("booking STATUS update failed:", statusUpdateError, "payload=", JSON.stringify(statusUpdate));
        } else if (!statusRows || statusRows.length === 0) {
          statusUpdateError = `No row matched ref=${bookingRef}`;
          console.error(statusUpdateError);
        }
      }
      // Pass 2 — receipt_* metadata. A failure here MUST NOT block slot release.
      const { error: mErr } = await bookingUpdateQuery(db, booking, metadataUpdate);
      if (mErr) {
        metadataUpdateError = errMsg(mErr);
        console.error("booking METADATA update failed:", metadataUpdateError);
      }

      // Last-resort fallback: if rejection's status update failed, try once
      // more with just the cancel field. The slot MUST be freed on a rejected
      // receipt — no exceptions.
      if (statusUpdateError && result === "rejected") {
        const { error: fallbackErr } = await bookingUpdateQuery(db, booking, { status: "cancelled" });
        if (fallbackErr) {
          console.error("FALLBACK cancel also failed:", errMsg(fallbackErr));
        } else {
          console.error("FALLBACK cancel succeeded after status update failure");
          statusUpdateError = null;
        }
      }
    }

    // ── audit trail (immutable) ─────────────────────────────────────────────
    await db.from("receipt_verifications").insert({
      booking_ref: bookingRef,
      result,
      flags,
      extracted,
      confidence,
      image_hash: imageHash,
      phash,
      raw_ocr_text: ocrText || null,
    });

    // ── alert admin on anything needing a human ─────────────────────────────
    if (result !== "auto_approved") {
      const icon = result === "rejected" ? "❌" : "⚠️";
      const head = result === "rejected" ? "RECEIPT REJECTED — BOOKING CANCELLED" : "RECEIPT NEEDS REVIEW";
      await sendTelegram(
        `${icon} <b>${head}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 Ref: <code>${bookingRef}</code>\n` +
        `👤 ${booking.full_name || "—"}\n` +
        `💰 Expected: ₱${expectedAmount.toFixed(2)}` +
        (extractedAmount != null ? ` · Seen: ₱${extractedAmount.toFixed(2)}` : "") + `\n` +
        `🚩 Flags: <code>${flags.join(", ") || "none"}</code>\n` +
        (result === "rejected" ? `🗑 Booking auto-cancelled. Slot is now free.` : `👉 Open admin panel to review the receipt.`),
      );
    }

    return json({
      ok: true,
      status: result,
      flags: [],
      publicReason: autoApproveMaya
        ? "Maya payment approved automatically."
        : publicReceiptMessage(result, flags),
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: phash,
      receiptVerifiedAt: metadataUpdate.receipt_verified_at,
      ...(statusUpdateError ? { warning: `status update failed: ${statusUpdateError}` } : {}),
      ...(metadataUpdateError ? { metadataWarning: metadataUpdateError } : {}),
      message:
        result === "auto_approved" ? (autoApproveMaya ? "Maya payment approved automatically." : "Payment verified.")
        : result === "manual_review" ? "Received — the owner will verify your payment shortly."
        : "Your receipt could not be verified. Your booking has been cancelled — please try again with a valid receipt.",
    });
  } catch (err) {
    const message = errMsg(err);
    console.error("verify-gcash-receipt error:", message);
    if (message === "Invalid hold capability") {
      return json({ error: message, code: "INVALID_HOLD_CAPABILITY" }, 403);
    }
    return json({ error: message }, 500);
  }
});
