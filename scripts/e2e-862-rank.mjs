#!/usr/bin/env node
// Spec 862 §7.3 and §7.4 — what a measurement changes.
//
//  §7.3  With a trace, a small saving in a routine called every frame ranks
//        above a larger one in code that runs once.
//  §7.4  `page-align` is exact: its reported gain equals the page-crossing
//        cycles 861 measured in the same trace.
//
// Both need a capture, and a capture needs a machine — which a CI runner does
// not have. So the ROWS are synthesised here and put through 861's own
// evaluator: the arithmetic under test is the real one, the store is the only
// thing that is not. What the synthesis cannot cover — that those rows are
// what a C64 actually produces — is `smoke:862`, which records a real capture
// on a machine of its own.
//
// The crossings are known by construction: `lda $10F0,x` with X from $27 down
// to $00 crosses on exactly the 24 iterations where X >= $10. That number is
// computed here from the index values, NOT from the code under test, so §7.4
// compares two independent answers rather than one implementation with itself.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:862-rank

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

console.log("Spec 862 §7.3 + §7.4 — frequency ranks, and a page crossing is a count\n");

if (!existsSync(join(ROOT, "dist/cost/trace-cost.js"))) {
  console.error("dist/ is not built — run npm run build:mcp");
  process.exit(2);
}
const load = async (p) => import(pathToFileURL(join(ROOT, p)).href);
const { evaluateTrace } = await load("dist/cost/trace-cost.js");
const { scanForCandidates } = await load("dist/optimise/candidates.js");
const { formatScan } = await load("dist/optimise/format.js");
const { opcodeTiming } = await load("dist/cost/cycles.js");

// ---------------------------------------------------------------- the bytes
//
//   $C000 hot     clc / clc / rts            the second clc is the candidate
//   $C003 cold    jsr plain / rts            a tail call, worth more per run
//   $C007 pager   ldx #$27 / lda $10F0,x / sta $0400,x / dex / bpl / rts
//   $C013 plain   lda #$00 / rts
//   $C016 idle    nop / jmp idle             the filler that makes the frames real

const LOAD = 0xc000;
const BYTES = new Uint8Array([
  0x18, 0x18, 0x60,                                  // C000 hot
  0x20, 0x13, 0xc0, 0x60,                            // C003 cold: jsr $C013 / rts
  0xa2, 0x27,                                        // C007 pager: ldx #$27
  0xbd, 0xf0, 0x10,                                  // C009 lda $10F0,x
  0x9d, 0x00, 0x04,                                  // C00C sta $0400,x
  0xca,                                              // C00F dex
  0x10, 0xf7,                                        // C010 bpl $C009
  0x60,                                              // C012 rts
  0xa9, 0x00, 0x60,                                  // C013 plain: lda #$00 / rts
  0xea, 0x4c, 0x16, 0xc0,                            // C016 idle: nop / jmp $C016
]);
const UNITS = [
  { label: "hot", start: 0xc000, end: 0xc002 },
  { label: "cold", start: 0xc003, end: 0xc006 },
  { label: "pager", start: 0xc007, end: 0xc012 },
  { label: "plain", start: 0xc013, end: 0xc015 },
];

// ---------------------------------------------------------------- the rows

// PAL's line length, and a SHORT frame. 861 reads both off the anchor (which
// is how it evaluates a capture from another video standard), and a four-line
// frame keeps the stream dense: a synthesised gap in the clock is not "idle
// time", it is a million stolen cycles, and 861 is right to call it that.
const CYCLES_PER_LINE = 63;
const LINES_PER_FRAME = 4;
const FRAME = CYCLES_PER_LINE * LINES_PER_FRAME;

const rows = [];
let clock = 0;
let seq = 0;
const regs = { a: 0, x: 0, y: 0, sp: 0xff, p: 0 };
/** One retired instruction: its own cycles advance the clock, nothing else. */
const retire = (pc, cycles, after = {}) => {
  Object.assign(regs, after);
  clock += cycles;
  rows.push({
    seq: seq++, clock, pc,
    opcode: BYTES[pc - LOAD], b1: BYTES[pc - LOAD + 1] ?? 0, b2: BYTES[pc - LOAD + 2] ?? 0,
    a: regs.a, x: regs.x, y: regs.y, sp: regs.sp, p: regs.p,
  });
};
const cyclesOf = (pc) => opcodeTiming(BYTES[pc - LOAD]).base;

// The anchor's own row, so the stream starts somewhere: evaluateTrace skips the
// first row (it has nothing to subtract from).
retire(0xc000, 2);

// `pager` runs once, at the start. 40 iterations, X counting $27 → $00.
let expectedCrossings = 0;
retire(0xc007, 2, { x: 0x27 });                      // ldx #$27
for (let k = 0; k < 40; k += 1) {
  const x = 0x27 - k;
  const crosses = (0xf0 + x) > 0xff;                 // $10F0 + X leaves page $10
  if (crosses) expectedCrossings += 1;
  retire(0xc009, cyclesOf(0xc009) + (crosses ? 1 : 0));         // lda $10F0,x
  retire(0xc00c, cyclesOf(0xc00c));                             // sta $0400,x — a store never pays
  retire(0xc00f, cyclesOf(0xc00f), { x: x - 1 });               // dex
  const taken = x - 1 >= 0;
  retire(0xc010, 2 + (taken ? 1 : 0));                          // bpl (same page both ways)
}
retire(0xc012, 6);                                   // rts

// `cold` runs ONCE in the whole capture, and saves 9 cycles when it does.
retire(0xc003, 6);                                   // jsr $C013
retire(0xc013, 2);                                   // plain: lda #$00
retire(0xc015, 6);                                   // plain: rts
retire(0xc006, 6);                                   // cold: rts

/** Real instructions, until the clock reaches `until`. Never a jump in the clock. */
const idleUntil = (until) => {
  while (clock + 5 <= until) { retire(0xc016, 2); retire(0xc017, 3); }
  while (clock < until) retire(0xc016, 2);
};
idleUntil(3 * FRAME);

// `hot` runs ten times a frame, for four more frames, saving 2 cycles each time.
const HOT_PER_FRAME = 10;
const HOT_FRAMES = 4;
for (let f = 0; f < HOT_FRAMES; f += 1) {
  for (let i = 0; i < HOT_PER_FRAME; i += 1) { retire(0xc000, 2); retire(0xc001, 2); retire(0xc002, 6); }
  idleUntil((4 + f) * FRAME);
}
const FRAMES = Math.round(clock / FRAME);

const anchor = { clock: 0, line: 0, cycle: 0, cyclesPerLine: CYCLES_PER_LINE, linesPerFrame: LINES_PER_FRAME };
const trace = evaluateTrace(rows, [], {
  cpu: "c64", anchor, keepInstances: rows.length + 1,
  routines: UNITS.map((u) => ({ id: u.label, label: u.label, start: u.start, end: u.end })),
});

check(trace.stolen === 0, "the synthesised stream prices out exactly: 861 finds no stolen cycle in it", `stolen ${trace.stolen}`);
check(trace.frames === FRAMES, `861 reads ${FRAMES} frames out of it`, `frames ${trace.frames}`);
check(rows.length > 400, "the stream is dense — no gap in the clock that would read as a stolen cycle", `${rows.length} rows`);

// What 861 itself charged for page crossings at the indexed read, read back out
// of its own per-instance arithmetic.
const measuredCrossings = trace.instances
  .filter((i) => i.pc === 0xc009 && i.exact)
  .reduce((n, i) => n + (i.staticCycles - opcodeTiming(i.opcode).base), 0);
check(
  measuredCrossings === expectedCrossings,
  `§7.4 861 charges a page-crossing cycle on exactly the ${expectedCrossings} iterations whose index leaves the page`,
  `861 says ${measuredCrossings}, the index values say ${expectedCrossings}`,
);

// ---------------------------------------------------------------- the scan

const report = scanForCandidates({
  image: { load: LOAD, bytes: BYTES },
  units: UNITS,
  trace,
  freeZp: null,
  limit: 50,
});

const find = (rule, unit) => report.candidates.find((c) => c.rule.id === rule && c.unit === unit);

// ---- §7.4 -----------------------------------------------------------------
{
  const c = find("page-align", "pager");
  check(!!c, "§7.4 the indexed read is a page-align candidate", c ? `${c.rule.id} at $${c.at.toString(16)}` : "no candidate");
  if (c) {
    check(
      c.gainInCapture === measuredCrossings,
      "§7.4 its reported gain IS the page-crossing cycles 861 measured — not an estimate of them",
      `gain ${c.gainInCapture}, 861 ${measuredCrossings}`,
    );
    check(c.deltaCycles === -1, "…one cycle per crossing", `Δ ${c.deltaCycles}`);
    check(c.executionsInCapture === expectedCrossings, "…counted over the crossings, not over every execution of the instruction", `${c.executionsInCapture} of 40 executions`);
    check(c.verdict === "MEASURED", "…and it says it is a measurement, not a proof that two versions are the same");
  }
}

// ---- §7.3 -----------------------------------------------------------------
{
  const hot = find("known-carry", "hot");
  const cold = find("tail-call", "cold");
  check(!!hot && !!cold, "§7.3 both candidates are found: 2 cycles in code that runs often, 9 in code that runs once");
  if (hot && cold) {
    check(hot.deltaCycles === -2 && cold.deltaCycles === -9, "…and the per-execution saving really is the smaller one that runs often", `${hot.deltaCycles} against ${cold.deltaCycles}`);
    check(
      hot.executionsInCapture === HOT_PER_FRAME * HOT_FRAMES && cold.executionsInCapture === 1,
      "…the capture says how often each ran",
      `${hot.executionsInCapture} against ${cold.executionsInCapture} execution(s)`,
    );
    check(
      hot.executionsPerFrame > 1 && cold.executionsPerFrame < 1,
      "…so one is more than once a frame and the other is less",
      `${hot.executionsPerFrame.toFixed(2)}/frame against ${cold.executionsPerFrame.toFixed(2)}/frame`,
    );
    check(
      hot.gainPerFrame > cold.gainPerFrame,
      "§7.3 the small saving in the hot routine has the larger gain per frame",
      `${hot.gainPerFrame} against ${cold.gainPerFrame}`,
    );
    const order = report.candidates.map((c) => `${c.rule.id}@${c.unit}`);
    check(
      order.indexOf("known-carry@hot") < order.indexOf("tail-call@cold"),
      "…and the list is ordered by that, so it ranks above it",
      order.join(" > "),
    );
  }
  check(report.ranking === "measured", "…and the report says it ranked on a measurement");
  check(/ranked by gain per frame, from the capture/.test(formatScan(report, "x")), "…in so many words");
}

// ---- §2: hot code first ---------------------------------------------------
{
  const order = report.lookedAt.map((l) => l.unit);
  check(order[0] === "pager", "§2 it looked at the busiest routine first", order.join(" > "));
  check(/\d+ cycles measured over \d+ frame\(s\)/.test(report.lookedAt[0].why), "…and says how busy it was", report.lookedAt[0].why);
  const idle = report.lookedAt.find((l) => l.unit === "plain");
  check(!!idle && !/nothing in this capture ran here/.test(idle.why), "…and a routine the capture DID run is not called idle", idle?.why ?? "");
}

// ---- without the trace, the same input gives the static answer -------------
{
  const still = scanForCandidates({ image: { load: LOAD, bytes: BYTES }, units: UNITS, freeZp: null, limit: 50 });
  check(still.ranking === "static", "without the capture the report ranks statically");
  const order = still.candidates.map((c) => `${c.rule.id}@${c.unit}`);
  check(
    order.indexOf("tail-call@cold") < order.indexOf("known-carry@hot"),
    "…and then the LARGER single saving comes first, which is the whole point of having the measurement",
    order.join(" > "),
  );
  const again = scanForCandidates({ image: { load: LOAD, bytes: BYTES }, units: UNITS, freeZp: null, limit: 50 });
  check(
    JSON.stringify(again.candidates.map((c) => [c.rule.id, c.at, c.staticGain])) ===
      JSON.stringify(still.candidates.map((c) => [c.rule.id, c.at, c.staticGain])),
    "§5 the same input gives the same list",
  );
}

console.log(`\n${failCount ? "RED" : "GREEN"}  e2e-862-rank: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
