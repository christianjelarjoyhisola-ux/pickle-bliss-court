// Only receipt-labelled or contiguous references are evidence. Never concatenate
// phone numbers, prices, dates or advertising copy into a transaction reference.
export function extractGcashRef(text: string, _typedRef = ""): string | null {
  const clean = text.normalize("NFKC").replace(/[\u00a0\u2007\u202f]/g, " ");
  const digit = "[0-9oOiIl|sSbB]";
  const labelled = new RegExp(
    "\\bref(?:erence)?(?:[ \\t]*(?:no\\.?|number|#))?\\.?[ \\t]*[:#]?[ \\t]*(?:\\r?\\n[ \\t]*)?(" +
      digit + "(?:[ \\t-]*" + digit + "){12})(?![ \\t-]*[0-9])", "gi",
  );
  const refs = new Set<string>();
  for (const match of clean.matchAll(labelled)) {
    refs.add(match[1].replace(/[oO]/g, "0").replace(/[iIl|]/g, "1")
      .replace(/[sS]/g, "5").replace(/[bB]/g, "8").replace(/\D/g, ""));
  }
  if (refs.size) return refs.size === 1 ? [...refs][0] : null;
  const standalone = new Set([...clean.matchAll(/\b\d{13}\b/g)].map(m => m[0]));
  return standalone.size === 1 ? [...standalone][0] : null;
}

export function referenceIsPhone(reference: string, phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (!/^(?:0|63)?9\d{9}$/.test(digits)) return false;
  const tail = digits.slice(-10);
  return [tail, "0" + tail, "63" + tail, "063" + tail].includes(reference.replace(/\D/g, ""));
}

export function historyTransferRecipient(text: string): string | null {
  if (!/transaction\s+details/i.test(text) || !extractGcashRef(text)) return null;
  // Phone photos can put the Amount heading before the title/transfer text in
  // OCR reading order. Require one debit immediately before Date & Time; never
  // turn a positive credit or an unrelated footer number into an outgoing sum.
  const amountBlock = text.match(/\bamount\b([\s\S]{0,250}?)\bdate\s*&?\s*time/i)?.[1] || "";
  if (!/(?:^|\s)[-−]\s*\d[\d,]*\.\d{2}\s*$/.test(amountBlock)
    || (amountBlock.match(/\d[\d,]*\.\d{2}/g) || []).length !== 1) return null;
  const match = text.match(/transfer\s+from\s+(?:0|\+?63)9\d{9}\s+to\s+((?:0|\+?63)9\d{9})\b/i);
  if (!match) return null;
  return "0" + match[1].replace(/\D/g, "").slice(-10);
}
