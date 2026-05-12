// Spec 047 (Sprint 40) — code-island demotion smoke. Tests the
// demoteBrokenCodeIslands helper in isolation with a synthetic
// segment list + buffer that contains the broken-code patterns
// (JAM opcodes, undocumented runs, branches into unknown).

import assert from "node:assert/strict";
import { demoteBrokenCodeIslands } from "../dist/pipeline/analysis/pipeline.cjs";

// Body covers $0801-$0820, contains a fake "code" island at $0810
// that has a JAM opcode + adjacent undocumented opcodes + a
// branch into the surrounding unknown segment.
const body = Buffer.alloc(0x21);
//   $0801: SEI / NOP / NOP / NOP / NOP / NOP / NOP / NOP (= 8 bytes legit code)
body.writeUInt8(0x78, 0);
for (let i = 1; i < 8; i += 1) body.writeUInt8(0xea, i);
//   $0809..$080F: random data filler
for (let i = 8; i < 0x0f; i += 1) body.writeUInt8(0xff, i);
//   $0810: pretends to be a code island BUT:
//     $0810: 02       JAM
//     $0811: 7b 6b    undocumented pair
//     $0813: d0 fa    BNE -6 → target = $0810 (in-island)
//     $0815: f0 ee    BEQ -18 → target = $0805 (mid-instruction in unknown — counts as branch into data)
//     $0817..$0820: padding
body.writeUInt8(0x02, 0x10);
body.writeUInt8(0x7b, 0x11);
body.writeUInt8(0x6b, 0x12);
body.writeUInt8(0xd0, 0x13);
body.writeUInt8(0xfa, 0x14);
body.writeUInt8(0xf0, 0x15);
body.writeUInt8(0xee, 0x16);

const mapping = {
  format: "prg",
  loadAddress: 0x0801,
  startAddress: 0x0801,
  endAddress: 0x0801 + body.length - 1,
  fileOffset: 0,
  fileSize: body.length,
};

// Construct a segment list as the analyzer would have produced
// before demote: a code island at $0810-$0816 plus surrounding
// unknown segments.
const segments = [
  {
    kind: "code",
    start: 0x0801,
    end: 0x0808,
    length: 8,
    score: { confidence: 0.9, reasons: ["legit pre-island code"] },
    analyzerIds: ["code"],
    xrefs: [],
  },
  {
    kind: "unknown",
    start: 0x0809,
    end: 0x080f,
    length: 7,
    score: { confidence: 0.3, reasons: ["filler"] },
    analyzerIds: [],
    xrefs: [],
  },
  {
    kind: "code",
    start: 0x0810,
    end: 0x0816,
    length: 7,
    score: { confidence: 0.8, reasons: ["greedy probe extended into island"] },
    analyzerIds: ["probable-code"],
    xrefs: [],
  },
  {
    kind: "unknown",
    start: 0x0817,
    end: 0x0821,
    length: 11,
    score: { confidence: 0.3, reasons: ["filler"] },
    analyzerIds: [],
    xrefs: [],
  },
];

const result = demoteBrokenCodeIslands(segments, body, mapping, 0.3);
assert.equal(result.changed, true, "demote pass changed something");
// After demote + mergeSegments, the broken island is folded into
// the surrounding unknown span. Check the address range $0810 is
// no longer classified as code.
const containing = result.segments.find((s) => 0x0810 >= s.start && 0x0810 <= s.end);
assert.ok(containing, "containing segment found");
assert.notEqual(containing.kind, "code", "address $0810 is no longer in a code segment");

// The original code segment at $0810 should now carry the
// demote reason somewhere in the chain. Check at least one
// unknown segment claims the demote.
const demotedReasoned = result.segments.find((s) => s.kind === "unknown" && (s.score?.reasons ?? []).some((r) => /Demoted from code/.test(r)));
assert.ok(demotedReasoned, "at least one segment carries the demote reason");
assert.match(demotedReasoned.score.reasons.join("\n"), /JAM/);

// Aggressive mode (0.45) demotes too.
const aggressive = demoteBrokenCodeIslands(segments, body, mapping, 0.45);
assert.equal(aggressive.changed, true);

// Idempotency: re-running on already-demoted segments does not
// flip them back.
const second = demoteBrokenCodeIslands(result.segments, body, mapping, 0.3);
assert.equal(second.changed, false, "second pass on already-demoted segments is stable");

console.log("sprint 40 smoke test passed");
