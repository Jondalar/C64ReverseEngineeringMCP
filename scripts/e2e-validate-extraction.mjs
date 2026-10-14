// Spec 784 B4 + Spec 907 D4 — validate a manifest against the loader-lens READ-SET.
// A correct manifest passes; a sector the run never reached is "not seen" (never a FAIL);
// a span the run read past, or a read whose bytes landed elsewhere, FAILs; a read block
// the manifest missed is reported unclaimed. The read-set is drive-side
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

// Spec 907 D4 CHANGED this case. A trailing span the run never read (T33/S5 after the last
// read span) is "not seen in this run" — a run proves use, never non-use — so it no longer
// FAILs; it used to be called a mismatch.
const trailing = validateExtraction(readSet, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 5, length: 254 },
]));
ok(trailing.verdict === "pass", "trailing span the run never read → not seen, NOT a FAIL (907 D4)", trailing.verdict);
ok(trailing.notSeenSpans === 1 && trailing.mismatched.length === 0 && trailing.readPast.length === 0, "T33/S5 counted as not seen", JSON.stringify({ n: trailing.notSeenSpans }));

// Read past it: the run read spans on BOTH sides of T33/S5 and never T33/S5.
const past = validateExtraction(readSet, mk([
  { kind: "sector", track: 33, sector: 0, length: 254 },
  { kind: "sector", track: 33, sector: 5, length: 254 },
  { kind: "sector", track: 33, sector: 1, length: 254 },
]));
ok(past.verdict === "fail", "interior span the run read past → FAIL", past.verdict);
ok(past.readPast.length === 1 && past.readPast[0].sector === 5, "the span read past (T33/S5) is named", JSON.stringify(past.readPast));

// S5 — 91 payloads, the run loaded two of them.
const many = {
  manifestVersion: 1, extractor: "im2", sourceImage: "im2.g64",
  loaderModels: [{ id: "im2", kind: "sector-stream" }],
  payloads: Array.from({ length: 91 }, (_, i) => ({
    name: `P${i}.PRG`, derivedBy: "im2", loadAddress: 0x1000 + i * 0x100, format: "raw",
    spans: [
      { kind: "sector", track: i + 1, sector: 0, length: 254 },
      { kind: "sector", track: i + 1, sector: 1, length: 254 },
    ],
  })),
};
const mm = validateManifest(many).manifest;
const loadedTwo = [[1, 0], [1, 1], [2, 0], [2, 1]].map(([track, sector], n) => ({ halftrack: track * 2, track, sector, bytes: 320, cycle: 100 + n }));
const s5 = validateExtraction(loadedTwo, mm);
ok(s5.verdict === "pass", "S5 91-payload manifest, two loaded → not FAIL", s5.verdict);
ok(s5.payloadsReached === 2 && s5.payloadsTotal === 91, "S5 coverage: reached 2 of 91", `${s5.payloadsReached}/${s5.payloadsTotal}`);
ok(s5.matchedSpans === 4 && s5.notSeenSpans === 178 && s5.mismatched.length === 0 && s5.readPast.length === 0, "S5 the rest are not seen", JSON.stringify({ m: s5.matchedSpans, n: s5.notSeenSpans }));

// S5 — a real contradiction: sector 0 was read, its bytes landed at $8000, the manifest
// says P0 lands at $1000.
const land = (track, sector, dest, len) => ({
  kind: "landing", source: { medium: "disk", halftrack: track * 2, track, sector },
  c64Dest: dest, len, sha256: "00", cycleStart: 1, transferReads: 9,
});
const okLandings = validateExtraction(loadedTwo, mm, { landings: [land(1, 0, 0x1000, 254), land(1, 1, 0x10fe, 254), land(2, 0, 0x1100, 254)] });
ok(okLandings.verdict === "pass" && okLandings.landingsEvaluated, "S5 landings inside the claiming payloads' extents → PASS", okLandings.verdict);
const bad = validateExtraction(loadedTwo, mm, { landings: [land(1, 0, 0x8000, 254)] });
ok(bad.verdict === "fail" && bad.mismatched.length === 1 && bad.mismatched[0].sector === 0, "S5 read sector whose bytes landed where the manifest does not say → mismatch, FAIL", JSON.stringify(bad.mismatched.map((m) => m.reason)));
const packed = validateManifest({ ...many, payloads: many.payloads.map((p) => ({ ...p, format: "prg", packer: "exomizer" })) }).manifest;
const bp = validateExtraction(loadedTwo, packed, { landings: [land(1, 0, 0x8000, 254)] });
ok(bp.verdict === "pass", "a packed payload lands elsewhere by design → landing not judged", bp.verdict);
const noLand = validateExtraction(loadedTwo, mm);
ok(!noLand.landingsEvaluated, "without a landing map the mismatch class is reported as not judged");

// Cart slot span → skipped (Spec 785), not counted as a mismatch.
const cart = validateExtraction(readSet, mk([
  { kind: "slot", bank: 3, slot: "ROML", offsetInBank: 0, length: 8192 },
]));
ok(cart.skippedSlotSpans === 1 && cart.verdict === "pass", "slot span skipped (Spec 785), no false mismatch", JSON.stringify({ skipped: cart.skippedSlotSpans, verdict: cart.verdict }));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  validate-extraction B4: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
