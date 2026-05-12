#!/usr/bin/env node
// Spec 406 — C64 Phase F: per-N-cycle state diff smoke.
//
// Doctrine: 1:1 VICE x64sc port. Phase F step 27 says "Diff against
// VICE: same input file, same cycle count, dump CPU + VIC + CIA state
// every N cycles, compare. Any diff > 1 cycle is a bug to fix."
//
// Validation tier (OQ-406-2 resolved 2026-05-11): 10M cycles.
//
// Doc anchor: docs/vice-c64-arch.md §12 Phase F step 27 + §13 invariant 12
// (maincpu_clk monotonic except at hard reset).
// VICE source: vice/src/maincpu.c:526 maincpu_mainloop() (= the loop
//              that drives the 10M-cycle reference run).
//
// What this smoke proves
// ---------------------
// 10M-cycle deterministic-replay invariant. We boot the same canary
// twice with identical config + identical reset seed, sample CPU + VIC
// + CIA state every SAMPLE_EVERY cycles, and assert ZERO divergence
// across all samples. This is a prerequisite for true VICE diff (=
// without determinism, any VICE diff is noise).
//
// When a canned VICE trace is supplied via --vice-trace <path-to-jsonl>
// the script switches to true VICE-vs-headless mode using the same
// sampler. Default = self-diff (deterministic replay).
//
// Canary: 16-byte raster-IRQ setup PRG, inlined. Exercises CPU, VIC
// (raster latch + IRQ ACK), CIA1 (timer-A interrupt), and the alarm
// pipeline simultaneously — the four pieces Phase F step 27 calls out.
//
// State diff format per sample:
//   { cycle, pc, a, x, y, sp, p, rasterY, vicIrqStatus, ciaIcr }
//
// Usage:
//   node scripts/smoke-406-vice-diff-trace.mjs [--cycles 10000000] \
//                                              [--sample-every 100000] \
//                                              [--vice-trace <jsonl>]

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}

const cycles = parseInt(arg("cycles", "10000000"), 10);  // = 10M (Spec 406 validation tier).
const sampleEvery = parseInt(arg("sample-every", "100000"), 10);
const viceTracePath = arg("vice-trace", null);

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

console.log(`smoke-406-vice-diff-trace (Spec 406 / docs/vice-c64-arch.md §12 step 27)`);
console.log(`  budget: ${cycles.toLocaleString()} cycles`);
console.log(`  sample-every: ${sampleEvery.toLocaleString()} cycles`);
console.log(`  vice-trace: ${viceTracePath ?? "(none — running self-diff = deterministic replay)"}`);
console.log("");

// Canary PRG: raster IRQ setup at $0200 (load address).
// 16-byte fixture exercising raster-IRQ alarm path:
//   SEI                ; $0200: 78
//   LDA #$01           ; $0201: A9 01
//   STA $D01A          ; $0203: 8D 1A D0   ; enable raster IRQ
//   LDA #$80           ; $0206: A9 80
//   STA $D012          ; $0208: 8D 12 D0   ; latch raster line $80
//   CLI                ; $020B: 58
//   loop: NOP          ; $020C: EA
//         JMP loop     ; $020D: 4C 0C 02
// Total bytes = 16 (incl. 2-byte load addr header = NO — we inject
// directly into RAM at $0200 instead of using a PRG file).
const CANARY_ADDR = 0x0200;
const CANARY_BYTES = new Uint8Array([
  0x78,                     // SEI
  0xa9, 0x01,               // LDA #$01
  0x8d, 0x1a, 0xd0,         // STA $D01A
  0xa9, 0x80,               // LDA #$80
  0x8d, 0x12, 0xd0,         // STA $D012
  0x58,                     // CLI
  0xea,                     // NOP
  0x4c, 0x0c, 0x02,         // JMP $020C
]);

const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");

function captureSamples(label) {
  const { session } = startIntegratedSession({
    diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");
  // Boot to ready (= 2M cycles of KERNAL reset path).
  session.runFor(2_000_000);

  // Inject canary at $0200 and jump CPU there.
  for (let i = 0; i < CANARY_BYTES.length; i++) {
    session.c64Bus.ram[CANARY_ADDR + i] = CANARY_BYTES[i];
  }
  // Stop typing/BASIC and set PC directly. Spec 406 Phase F step 27
  // requires "same input file, same cycle count" — using SYS via
  // BASIC adds nondeterminism from input timing. Direct PC set =
  // identical entry every run.
  session.c64Cpu.pc = CANARY_ADDR;

  const samples = [];
  const startCycle = session.c64Cpu.cycles;
  const targetEnd = startCycle + cycles;

  let nextSampleCycle = startCycle;
  // Use small run quanta so we can sample close to each sampleEvery
  // boundary. runFor() may overshoot by a few cycles per call (= last
  // instruction in the budget completes past target); we accept that
  // jitter and capture at the next observation, which keeps both runs
  // aligned because they overshoot identically.
  const QUANTUM = Math.max(1, Math.floor(sampleEvery / 4));
  while (session.c64Cpu.cycles < targetEnd) {
    if (session.c64Cpu.cycles >= nextSampleCycle) {
      const cpu = session.c64Cpu;
      const vic = session.vic;
      const cia1 = session.cia1;
      // Field cites:
      //  - vic.raster_y          : src/runtime/headless/vic/vic-ii-vice.ts:315
      //                            = VICE raster_y (vicii.c:vicii.raster.current_line)
      //  - vic.regs[0x19]        : VIC IRQ status latch ($D019)
      //  - cia1.icrFlags         : src/runtime/headless/cia/cia6526-vice.ts:729
      //                            = VICE irqflags & 0x1f (cia-core.c)
      samples.push({
        cycle: cpu.cycles - startCycle,
        pc: cpu.pc & 0xffff,
        a: cpu.a & 0xff,
        x: cpu.x & 0xff,
        y: cpu.y & 0xff,
        sp: cpu.sp & 0xff,
        p: cpu.p & 0xff,
        rasterY: (vic?.raster_y ?? 0) & 0x1ff,
        vicIrqStatus: (vic?.regs?.[0x19] ?? 0) & 0x8f,
        ciaIcr: (cia1?.icrFlags ?? 0) & 0xff,
      });
      nextSampleCycle += sampleEvery;
    }
    session.runFor(QUANTUM);
  }
  return samples;
}

console.log(`run 1: capturing ${Math.ceil(cycles / sampleEvery)} samples...`);
const samplesA = captureSamples("A");
console.log(`  captured ${samplesA.length} samples`);

// VICE-mode: parse the canned jsonl, expect samples [{cycle,pc,a,...}]
// per line, same schema as captureSamples. The script tolerates a
// missing trace gracefully (= falls through to self-diff).
let samplesB;
let mode;
if (viceTracePath && existsSync(viceTracePath)) {
  console.log(`run 2: loading VICE trace from ${viceTracePath}...`);
  const raw = readFileSync(viceTracePath, "utf8").trim().split("\n");
  samplesB = raw.map((l) => JSON.parse(l));
  console.log(`  loaded ${samplesB.length} VICE samples`);
  mode = "vice-vs-headless";
} else {
  console.log(`run 2: re-capturing with identical config (deterministic replay)...`);
  samplesB = captureSamples("B");
  console.log(`  captured ${samplesB.length} samples`);
  mode = "self-diff (replay determinism)";
}

console.log(`\ncomparing ${samplesA.length} vs ${samplesB.length} samples (mode=${mode})...`);

let divergences = 0;
const firstDivergences = [];
const fieldNames = ["pc", "a", "x", "y", "sp", "p", "rasterY", "vicIrqStatus", "ciaIcr"];

const n = Math.min(samplesA.length, samplesB.length);
for (let i = 0; i < n; i++) {
  const a = samplesA[i];
  const b = samplesB[i];
  if (a.cycle !== b.cycle) {
    divergences += 1;
    if (firstDivergences.length < 5) {
      firstDivergences.push({ idx: i, field: "cycle", a: a.cycle, b: b.cycle });
    }
    continue;
  }
  for (const f of fieldNames) {
    if (a[f] !== b[f]) {
      divergences += 1;
      if (firstDivergences.length < 5) {
        firstDivergences.push({ idx: i, cycle: a.cycle, field: f, a: a[f], b: b[f] });
      }
    }
  }
}

if (samplesA.length !== samplesB.length) {
  console.log(`WARN: sample count mismatch (${samplesA.length} vs ${samplesB.length}) — comparing first ${n}`);
}

console.log(`\n=== Diff result ===`);
console.log(`samples compared : ${n}`);
console.log(`divergences      : ${divergences}`);
if (firstDivergences.length > 0) {
  console.log(`first divergences:`);
  for (const d of firstDivergences) {
    console.log(`  idx=${d.idx} cycle=${d.cycle ?? "n/a"} field=${d.field} A=${d.a} B=${d.b}`);
  }
}

// Spec 406 Acceptance §5: "zero divergence over 10M cycles".
const ok = divergences === 0;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}  (mode=${mode})`);
process.exit(ok ? 0 : 1);
