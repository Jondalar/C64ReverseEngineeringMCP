// Spec 784 B4 — validate a manifest against the loader-lens landing map.
// THE point: a manifest span claiming a sector the loader NEVER read is flagged
// mismatched (the wrong-interpretation bug class); a correct manifest passes; a
// loader landing the manifest missed is reported unclaimed. Run after build:mcp.
import { validateExtraction } from "../dist/server-tools/validate-extraction.js";
import { validateManifest } from "../dist/server-tools/loader-manifest.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("validate-extraction B4 — manifest vs landing-map diff\n");

// The loader really read track 33 sectors 0,1,2 (ground truth).
const landingMap = [
  { source: { halftrack: 66, track: 33, sector: 0 }, c64Dest: 0x0800, len: 254, sha256: "a".repeat(64), cycleStart: 10 },
  { source: { halftrack: 66, track: 33, sector: 1 }, c64Dest: 0x08fe, len: 254, sha256: "b".repeat(64), cycleStart: 500 },
  { source: { halftrack: 66, track: 33, sector: 2 }, c64Dest: 0x09fc, len: 254, sha256: "c".repeat(64), cycleStart: 900 },
];

const mk = (spans) => validateManifest({
  manifestVersion: 1, extractor: "pawn-serial", sourceImage: "the_pawn_s1.g64",
  loaderModels: [{ id: "pawn-serial", kind: "sector-stream" }],
  payloads: [{ name: "PAWN.PRG", derivedBy: "pawn-serial", loadAddress: 0x0800, format: "raw", spans }],
}).manifest;

// Correct manifest — claims exactly the sectors the loader read (0,1).
const correct = validateExtraction(landingMap, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 1, length: 254 },
]));
ok(correct.verdict === "pass", "correct manifest → PASS", correct.verdict);
ok(correct.matchedSpans === 2 && correct.mismatched.length === 0, "2 spans matched, 0 mismatched");
ok(correct.unclaimed.some((u) => u.sector === 2), "sector 2 (read but unclaimed) reported unclaimed", JSON.stringify(correct.unclaimed));

// Wrong manifest — claims sector 5, which the loader never read.
const wrong = validateExtraction(landingMap, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 5, length: 254 },
]));
ok(wrong.verdict === "fail", "manifest with a wrong span → FAIL", wrong.verdict);
ok(wrong.mismatched.length === 1 && wrong.mismatched[0].sector === 5, "the wrong span (T33/S5) flagged mismatched", JSON.stringify(wrong.mismatched));

// Cart slot span → skipped (Spec 785), not counted as a mismatch.
const cart = validateExtraction(landingMap, mk([
  { kind: "slot", bank: 3, slot: "ROML", offsetInBank: 0, length: 8192 },
]));
ok(cart.skippedSlotSpans === 1 && cart.verdict === "pass", "slot span skipped (Spec 785), no false mismatch", JSON.stringify({ skipped: cart.skippedSlotSpans, verdict: cart.verdict }));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  validate-extraction B4: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
