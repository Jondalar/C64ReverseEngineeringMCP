// Spec 784 B4 — validate a manifest against the loader-lens READ-SET (Option A).
// THE point: a manifest span claiming a sector the loader NEVER read is flagged
// mismatched (the wrong-interpretation bug class); a correct manifest passes; a
// read block the manifest missed is reported unclaimed. The read-set is drive-side
// truth (BLOCK_READ 0x35), immune to write-time buffering. Run after build:mcp.
import { validateExtraction } from "../dist/server-tools/validate-extraction.js";
import { validateManifest } from "../dist/server-tools/loader-manifest.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("validate-extraction B4 — manifest vs read-set diff\n");

// The loader really read track 33 sectors 0,1,2 (ground truth read-set).
const readSet = [
  { halftrack: 66, track: 33, sector: 0, bytes: 254, cycle: 10 },
  { halftrack: 66, track: 33, sector: 1, bytes: 254, cycle: 500 },
  { halftrack: 66, track: 33, sector: 2, bytes: 254, cycle: 900 },
];

const mk = (spans) => validateManifest({
  manifestVersion: 1, extractor: "pawn-serial", sourceImage: "the_pawn_s1.g64",
  loaderModels: [{ id: "pawn-serial", kind: "sector-stream" }],
  payloads: [{ name: "PAWN.PRG", derivedBy: "pawn-serial", loadAddress: 0x0800, format: "raw", spans }],
}).manifest;

// Correct manifest — claims exactly the sectors the loader read (0,1).
const correct = validateExtraction(readSet, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 1, length: 254 },
]));
ok(correct.verdict === "pass", "correct manifest → PASS", correct.verdict);
ok(correct.matchedSpans === 2 && correct.mismatched.length === 0, "2 spans matched, 0 mismatched");
ok(correct.unclaimed.some((u) => u.sector === 2), "sector 2 (read but unclaimed) reported unclaimed", JSON.stringify(correct.unclaimed));

// Wrong manifest — claims sector 5, which the loader never read.
const wrong = validateExtraction(readSet, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 5, length: 254 },
]));
ok(wrong.verdict === "fail", "manifest with a wrong span → FAIL", wrong.verdict);
ok(wrong.mismatched.length === 1 && wrong.mismatched[0].sector === 5, "the wrong span (T33/S5) flagged mismatched", JSON.stringify(wrong.mismatched));

// Cart slot span → skipped (Spec 785), not counted as a mismatch.
const cart = validateExtraction(readSet, mk([
  { kind: "slot", bank: 3, slot: "ROML", offsetInBank: 0, length: 8192 },
]));
ok(cart.skippedSlotSpans === 1 && cart.verdict === "pass", "slot span skipped (Spec 785), no false mismatch", JSON.stringify({ skipped: cart.skippedSlotSpans, verdict: cart.verdict }));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  validate-extraction B4: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
