#!/usr/bin/env node
// Spec 415 — 1541 Phase I step 40: per-cycle drive CPU state diff.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase I step 40:
//         "Diff against VICE: same image, same input, dump drive CPU
//          state every N cycles."
//       §14 invariant 1 (rotation_rotate_disk runs exactly once per
//         drive CPU cycle — = the determinism prerequisite).
//       §14 invariant 12 (drivecpu_execute is push-mode).
//
// VICE: src/drive/drivecpu.c:356 drivecpu_execute(),
//       src/drive/drive.c:991 drive_cpu_execute_one() (the per-call
//         entry that the host invokes per CPU quantum).
//
// Validation tier (OQ-415-3 resolved 2026-05-11): 10M drive cycles.
// At ~1 MHz drive clock = ~10s wall-time at native speed.
//
// What this smoke proves
// ---------------------
// 10M drive-cycle deterministic-replay invariant for the canary canon
// (motm boot). We boot the same image twice with identical config +
// identical reset seed, sample the drive CPU state every SAMPLE_EVERY
// drive cycles, and assert ZERO divergence across all samples. This
// is a prerequisite for true VICE drive diff (= without determinism,
// any VICE diff is noise).
//
// When a canned VICE drive trace is supplied via --vice-trace
// <path-to-jsonl> the script switches to true VICE-vs-headless mode
// using the same sampler. Default = self-diff (deterministic replay).
//
// Canary: motm boot. motm = G64 fastloader (AB-fastloader at $4278),
// per memo `motm-via1-ca1` it is the canonical drive-side canary.
//
// State diff format per sample:
//   { driveCycle, drivePc, a, x, y, sp, p, headTrack,
//     via1OrBPb, via2Orb }
//
// Usage:
//   node scripts/smoke-415-drive-diff-trace.mjs [--cycles 10000000] \
//                                               [--sample-every 100000] \
//                                               [--vice-trace <jsonl>]

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}

const driveCyclesBudget = parseInt(arg("cycles", "10000000"), 10);  // = 10M (Spec 415 OQ-415-3).
const sampleEvery = parseInt(arg("sample-every", "100000"), 10);
const viceTracePath = arg("vice-trace", null);

const repoRoot = resolvePath(import.meta.dirname, "..");
const canaryDisk = resolvePath(repoRoot, "samples/motm.g64");

if (!existsSync(canaryDisk)) {
  console.error(`canary disk missing: ${canaryDisk}`);
  process.exit(1);
}

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

console.log(`smoke-415-drive-diff-trace (Spec 415 / docs/vice-1541-arch.md §13 Phase I step 40)`);
console.log(`  canary: ${canaryDisk.replace(repoRoot + "/", "")}`);
console.log(`  budget: ${driveCyclesBudget.toLocaleString()} drive cycles`);
console.log(`  sample-every: ${sampleEvery.toLocaleString()} drive cycles`);
console.log(`  vice-trace: ${viceTracePath ?? "(none — running self-diff = deterministic replay)"}`);
console.log("");

// Drive runs at ~1 MHz, host C64 at ~985 248 Hz PAL → drive cycles
// ≈ c64 cycles × (1_000_000 / 985_248) ≈ ×1.015. We budget by drive
// cycles directly via session.drive.cpu.cycles.
function captureDriveSamples(label) {
  const { session } = startIntegratedSession({
    diskPath: canaryDisk,
    mode: "true-drive",
    useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");
  // Boot to KERNAL READY (~2M c64 cycles ≈ ~2M drive cycles).
  session.runFor(2_000_000);

  // Issue LOAD"*",8,1 → motm fastloader takes over (= the canary).
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

  const samples = [];
  const startDriveCycle = session.drive.cpu.cycles;
  const targetEnd = startDriveCycle + driveCyclesBudget;

  let nextSampleCycle = startDriveCycle;
  // Use small run quanta so we sample close to each sampleEvery
  // boundary. session.runFor() may overshoot by a few drive cycles per
  // call; we accept that jitter and capture at the next observation,
  // which keeps both runs aligned because they overshoot identically
  // (= deterministic replay assumption).
  const QUANTUM = Math.max(50_000, Math.floor(sampleEvery / 2));
  while (session.drive.cpu.cycles < targetEnd) {
    if (session.drive.cpu.cycles >= nextSampleCycle) {
      const drv = session.drive;
      const cpu = drv.cpu;
      const via1 = drv.bus.via1;
      const via2 = drv.bus.via2;
      // Field cites:
      //  - drv.cpu.{pc,a,x,y,sp,flags,cycles}
      //      = drivecpu.c:568-640 drivecpu_snapshot_write_module
      //  - drv.bus.via1.orb (PB output latch incl. driveid bits)
      //      = via1d1541.c:212 store_prb / 337 read_prb
      //  - drv.bus.via2.orb (stepper + motor + density bits)
      //      = via2d.c:232-311 store_prb (stepper Δ-phase logic)
      //  - session.headPosition.currentTrack
      //      = drive.h:236 drive_t.current_half_track
      samples.push({
        driveCycle: cpu.cycles - startDriveCycle,
        drivePc: cpu.pc & 0xffff,
        a: cpu.a & 0xff,
        x: cpu.x & 0xff,
        y: cpu.y & 0xff,
        sp: cpu.sp & 0xff,
        p: (cpu.flags ?? cpu.p ?? 0) & 0xff,
        headTrack: session.headPosition?.currentTrack ?? 0,
        via1Orb: via1.orb & 0xff,
        via2Orb: via2.orb & 0xff,
      });
      nextSampleCycle += sampleEvery;
    }
    session.runFor(QUANTUM);
  }
  return samples;
}

console.log(`run 1: capturing drive samples (~${Math.ceil(driveCyclesBudget / sampleEvery)} samples)...`);
const tStart = Date.now();
const samplesA = captureDriveSamples("A");
const tA = ((Date.now() - tStart) / 1000).toFixed(1);
console.log(`  captured ${samplesA.length} samples (${tA}s wall)`);

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
  const tStartB = Date.now();
  samplesB = captureDriveSamples("B");
  const tB = ((Date.now() - tStartB) / 1000).toFixed(1);
  console.log(`  captured ${samplesB.length} samples (${tB}s wall)`);
  mode = "self-diff (replay determinism)";
}

console.log(`\ncomparing ${samplesA.length} vs ${samplesB.length} samples (mode=${mode})...`);

let divergences = 0;
const firstDivergences = [];
const fieldNames = [
  "drivePc", "a", "x", "y", "sp", "p",
  "headTrack", "via1Orb", "via2Orb",
];

const n = Math.min(samplesA.length, samplesB.length);
for (let i = 0; i < n; i++) {
  const a = samplesA[i];
  const b = samplesB[i];
  if (a.driveCycle !== b.driveCycle) {
    divergences += 1;
    if (firstDivergences.length < 5) {
      firstDivergences.push({ idx: i, field: "driveCycle", a: a.driveCycle, b: b.driveCycle });
    }
    continue;
  }
  for (const f of fieldNames) {
    if (a[f] !== b[f]) {
      divergences += 1;
      if (firstDivergences.length < 5) {
        firstDivergences.push({
          idx: i, driveCycle: a.driveCycle, field: f, a: a[f], b: b[f],
        });
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
    console.log(`  idx=${d.idx} driveCycle=${d.driveCycle ?? "n/a"} field=${d.field} A=${d.a} B=${d.b}`);
  }
}

// Spec 415 Acceptance: zero divergence over 10M drive cycles.
const ok = divergences === 0;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}  (mode=${mode})`);
process.exit(ok ? 0 : 1);
