import { extractGcashRef, referenceIsPhone, historyTransferRecipient } from "./reference.ts";
function eq(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
Deno.test("Ian: spaced labelled reference wins over phone, amounts and ad prices", () => {
  eq(extractGcashRef("+63 9••••7914\nAmount 330.00\nTotal Amount Sent ₱330.00\nRef No. 9045 391 205507 Sep 24, 2026 3:46 PM\n₱2,000.00 ₱8,300.00", "0639303528010"), "9045391205507");
});
Deno.test("never combine unrelated lines into a thirteen-digit reference", () => {
  eq(extractGcashRef("05\n330.00\n3300.00"), null);
  eq(extractGcashRef("+63 930 352 8010\nAmount 330.00", "0639303528010"), null);
});
Deno.test("label can be on preceding line; original references remain unchanged", () => {
  eq(extractGcashRef("Reference Number\n4045381372264\nSep 24, 2026"), "4045381372264");
  eq(extractGcashRef("Ref No. 5045 411 255060\nSep 25, 2026"), "5045411255060");
  eq(extractGcashRef("Ref No. 9045402282430"), "9045402282430");
});
Deno.test("wrong typed reference never overrides labelled OCR evidence", () => {
  eq(extractGcashRef("9045402282430\nRef No. 9045391205507", "9045402282430"), "9045391205507");
  eq(extractGcashRef("Ref No. 9045402282430\nRef No. 9045391205507"), null);
  eq(extractGcashRef("Ref No. 90454022824300"), null);
});
Deno.test("detect own phone variants without rejecting unrelated transaction IDs", () => {
  eq(referenceIsPhone("0639303528010", "09303528010"), true);
  eq(referenceIsPhone("639303528010", "+63 930 352 8010"), true);
  eq(referenceIsPhone("9045391205507", "09303528010"), false);
  eq(referenceIsPhone("0639303528010", ""), false);
});
Deno.test("transaction history identifies destination, not sender; credit is not outgoing payment", () => {
  const receipt = "Transaction Details\nTransfer from 09350369184 to 09088947914\nAmount -495.00\nDate & Time Sep 24, 2026 10:23 AM\nReference Number 4045381372264";
  eq(historyTransferRecipient(receipt), "09088947914");
  eq(historyTransferRecipient(receipt.replace("-495.00", "495.00")), null);
  eq(historyTransferRecipient(receipt.replace("Transfer from", "Received from")), null);
  const photographed = "10:24-\nAmount\nTransaction Details\nTransfer from 09350369184 to 09088947914\nVO 4G+ LTE 37\n-495.00\nDate & Time\nSep 24, 2026 10:23 AM\nReference Number\n4045381372264\nHave questions or concerns about this transaction? Get Help";
  eq(historyTransferRecipient(photographed), "09088947914");
  eq(historyTransferRecipient(photographed.replace('-495.00','495.00')), null);
  eq(historyTransferRecipient(photographed.replace('-495.00','495.00\n-0.05')), null);
});
