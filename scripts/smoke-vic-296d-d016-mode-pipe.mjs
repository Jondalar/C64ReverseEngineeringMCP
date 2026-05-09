#!/usr/bin/env node
// Spec 296d smoke — \$D016 / video-mode pipe latency.
//
// Verifies VICE x64sc pipe behavior:
//   - xscroll_pipe samples \$D016 & 7 only when visible gbuf enters
//     pipe0 (= end of FetchG cycle). Mid-line \$D016 write at cycle
//     N takes effect for cycle N+1's gbuf-entering-pipe0, not the
//     same cycle's still-emitting pixels.
//   - vmode16_pipe samples \$D016 & 0x10 (MCM) at pixel 4 of the
//     draw cycle. Holds vmode16_pipe2 at pixel 7.
//   - vmode11_pipe samples \$D011 & 0x60 (ECM/BMM) at end-of-cycle
//     (Φ6 in VICE) — drives next cycle's mode decision.

import { renderRasterLine } from "../dist/runtime/headless/vic/cycle-driven-line-renderer.js";
import {
  newDisplayPipeState, latchPipeRegs, samplePipe0, sampleVmode11,
  sampleVmode16, holdVmode16Pipe2, advancePipeStages,
} from "../dist/runtime/headless/vic/display-pipe.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-296d-d016-mode-pipe");

// ---------------------------------------------------------------------------
// Helper env: chargen $01 = solid bar, color RAM = 0x0e, screen RAM = $01.
// ---------------------------------------------------------------------------
function buildEnv() {
  const ram = new Uint8Array(0x10000);
  for (let i = 0; i < 40; i++) ram[0x0400 + i] = 0x01;
  const charRom = new Uint8Array(0x1000);
  for (let i = 0; i < 8; i++) charRom[0x01 * 8 + i] = 0xff;
  const colorRam = new Uint8Array(40);
  for (let i = 0; i < 40; i++) colorRam[i] = 0x0e;
  return { ram, charRom, colorRam };
}
function makeFetchCtx(env) {
  return {
    vbank_phi1: 0,
    vaddr_mask_phi1: 0x3fff,
    vaddr_offset_phi1: 0,
    vaddr_chargen_mask_phi1: 0x7000,
    vaddr_chargen_value_phi1: 0x1000,
    ecmActive: false,
    readRamPhi1: (a) => env.ram[a & 0xffff],
    readChargenRom: (a) => env.charRom[a & 0xfff],
  };
}

// ---------------------------------------------------------------------------
// Test 1: xscroll_pipe latency. Mid-line $D016 write at cycle 25 Φ2 should
// affect cycle 26+ pixel positions, NOT cycle 25.
// ---------------------------------------------------------------------------
{
  const env = buildEnv();
  const baseline = renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  const withMidWrite = renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    regOverrides: [
      { cycle: 25, phase: "phi2", reg: 0x16, value: 0x03 },
    ],
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  // Cycle 25 pixels (= 192..199) should be IDENTICAL between baseline
  // and mid-write — xscroll change at cycle 25 Φ2 doesn't affect the
  // pixels emitted DURING cycle 25 (those use xscroll latched at end
  // of cycle 24).
  let cycle25Same = true;
  for (let i = 192; i < 200; i++) {
    if (baseline.out[i] !== withMidWrite.out[i]) { cycle25Same = false; break; }
  }
  ok("xscroll mid-write at cycle 25.Φ2: cycle 25 pixels unchanged", cycle25Same,
     `baseline[192..199]=${[...baseline.out.slice(192,200)]} mid=${[...withMidWrite.out.slice(192,200)]}`);

  // Cycle 26 pixels (= 200..207): xscroll=3 takes effect → first 3 px
  // are bg (waiting for latch), last 5 are fg.
  // Baseline: cycle 26 with xscroll=0 → all 8 fg.
  // Mid-write: cycle 26 with xscroll=3 → 3 bg + 5 fg.
  const baselineCycle26 = [...baseline.out.slice(200, 208)];
  const midCycle26 = [...withMidWrite.out.slice(200, 208)];
  const baselineAllFg = baselineCycle26.every(v => v === 0x0e);
  const midSplit = midCycle26.slice(0, 3).every(v => v === 0x06) &&
                   midCycle26.slice(3, 8).every(v => v === 0x0e);
  ok("baseline cycle 26: all fg (xscroll=0)", baselineAllFg,
     `got ${baselineCycle26}`);
  ok("mid-write cycle 26: 3 bg + 5 fg (xscroll=3 latched between cycles)", midSplit,
     `got ${midCycle26}`);
}

// ---------------------------------------------------------------------------
// Test 2: xscroll_pipe holds previous value when not-visible cycle samples.
// ---------------------------------------------------------------------------
{
  const s = newDisplayPipeState();
  // Visible cycle: latches xscroll = 5
  samplePipe0(s, true, false, 0x05, 0x00, null, null);
  ok("visible: xscroll_pipe = 5", s.xscroll_pipe === 5);
  // Not-visible cycle: xscroll_pipe holds previous
  samplePipe0(s, false, false, 0x07, 0x00, null, null);
  ok("not-visible: xscroll_pipe holds 5 (does not pick up 7)", s.xscroll_pipe === 5);
}

// ---------------------------------------------------------------------------
// Test 3: vmode16_pipe latency — sampled mid-cycle at pixel 4.
// ---------------------------------------------------------------------------
{
  const s = newDisplayPipeState();
  // Initial state
  ok("vmode16_pipe initially 0", s.vmode16_pipe === 0);
  // Sample with $d016 = 0x10 (MCM bit set)
  sampleVmode16(s, 0xff);  // any value with bit 4 set
  ok("vmode16_pipe samples bit 4 only", s.vmode16_pipe === 0x10);
  // hold pipe2 at pixel 7
  holdVmode16Pipe2(s);
  ok("vmode16_pipe2 = vmode16_pipe", s.vmode16_pipe2 === 0x10);
  // Now sample again with bit 4 cleared
  sampleVmode16(s, 0x00);
  ok("vmode16_pipe re-samples to 0", s.vmode16_pipe === 0);
  ok("vmode16_pipe2 still holds previous", s.vmode16_pipe2 === 0x10);
}

// ---------------------------------------------------------------------------
// Test 4: vmode11_pipe samples $d011 & 0x60 (ECM/BMM bits) at end-of-cycle.
// ---------------------------------------------------------------------------
{
  const s = newDisplayPipeState();
  // ECM=1 BMM=0 → 0x40
  sampleVmode11(s, 0x40 | 0x1b);
  ok("vmode11_pipe ECM only: 0x40", s.vmode11_pipe === 0x40);
  // ECM=0 BMM=1 → 0x20
  sampleVmode11(s, 0x20 | 0x1b);
  ok("vmode11_pipe BMM only: 0x20", s.vmode11_pipe === 0x20);
  // Both: 0x60
  sampleVmode11(s, 0x60 | 0x1b);
  ok("vmode11_pipe ECM+BMM: 0x60", s.vmode11_pipe === 0x60);
  // Neither
  sampleVmode11(s, 0x1b);
  ok("vmode11_pipe neither: 0", s.vmode11_pipe === 0);
}

// ---------------------------------------------------------------------------
// Test 5: pipe0 → pipe1 → reg latency (= 2-cycle delay).
// ---------------------------------------------------------------------------
{
  const s = newDisplayPipeState();
  // Cycle N: sample
  samplePipe0(s, true, false, 0x00, 0xaa, 0xbb, 0x05);
  ok("after sample: pipe0 = sampled, pipe1/reg still 0",
     s.gbuf.pipe0 === 0xaa && s.gbuf.pipe1 === 0 && s.gbuf.reg === 0);
  // End of cycle N: advance pipe0 → pipe1
  advancePipeStages(s);
  ok("after advance: pipe1 = pipe0, pipe0 unchanged",
     s.gbuf.pipe1 === 0xaa);
  // Start of cycle N+1: sample new pipe0
  samplePipe0(s, true, false, 0x00, 0xcc, null, null);
  ok("cycle N+1 sample: pipe0 = new, pipe1 = previous, reg still 0",
     s.gbuf.pipe0 === 0xcc && s.gbuf.pipe1 === 0xaa && s.gbuf.reg === 0);
  // Latch at xscroll
  latchPipeRegs(s);
  ok("latch: reg = pipe1 (= 2-cycle-old sample)", s.gbuf.reg === 0xaa);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
