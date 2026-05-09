#!/usr/bin/env node
// Spec 296b smoke — badline matrix latch lifetime parity.
//
// Verifies viciisc/vicii-fetch.c invariants:
//   - vbuf[vmli] and cbuf[vmli] are LATCHED at Φ2 FetchC of bad line
//   - CPU writes to screen RAM / color RAM AFTER the latch DO NOT
//     change the displayed cell on this line
//   - Display reads use the latched vbuf[]/cbuf[], not live RAM
//
// Drives the bug: motm / Scramble Infinity menu text mutates between
// frames because (pre-fix) renderer read screen RAM live during draw,
// catching mid-row CPU writes.

import { renderRasterLine } from "../dist/runtime/headless/vic/cycle-driven-line-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-296b-matrix-lifetime");

// Synthetic 64KB RAM. Screen RAM at $0400..$042F = char $01 (solid block).
// Char $01 chargen = $ff (full bar). Color RAM = $0e (light blue).
function buildEnv() {
  const ram = new Uint8Array(0x10000);
  for (let i = 0; i < 40; i++) ram[0x0400 + i] = 0x01;
  const charRom = new Uint8Array(0x1000);
  for (let i = 0; i < 8; i++) charRom[0x01 * 8 + i] = 0xff;
  for (let i = 0; i < 8; i++) charRom[0x05 * 8 + i] = 0x55; // alternating-bit char
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

// --- Test 1: baseline — char $01 across the row → all $ff bitmaps, all fg. ---
{
  const env = buildEnv();
  const r = renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  let fg = 0;
  for (let x = 240; x < 240 + 40; x++) if (r.out[x] === 0x0e) fg++;
  ok("baseline: middle of visible band = fg pixels", fg >= 35,
     `got ${fg}/40 fg pixels`);
}

// --- Test 2: CPU writes screen RAM[0..39] mid-line should NOT affect render. ---
//
// Real-HW: bad-line FetchC happens at Φ2 of cycles 15..54. Once the matrix
// latch is taken at cycle N, CPU writes to that screen-RAM cell on cycles
// > N must not alter what's drawn for the cell.
//
// This test simulates the "CPU mutates RAM mid-line" by injecting a
// fetch that returns DIFFERENT data per cycle. We compare:
//   (a) Render with stable RAM (= all $01)
//   (b) Render where readRamPhi1 returns $05 after a synthetic point
// Result (b) should still match (a), because the renderer uses the
// vbuf latched at Φ2 — NOT the live RAM during emit.
//
// Concrete: hijack readRamPhi1 to return $01 for ANY $0400+N read, but
// the renderer is supposed to read each cell exactly ONCE (at FetchC),
// store in vbuf, then emit from vbuf for 8 pixels. So mutating RAM
// mid-emit (i.e. between cells already fetched and cells not yet
// fetched) only affects future cells, never past cells.
//
// Direct equivalent test: render line 1, then mutate RAM, then render
// line 2. Cells already drawn on line 1 are not affected.
{
  const env = buildEnv();
  const r1 = renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  // Mutate RAM after line 1 has been latched
  for (let i = 0; i < 40; i++) env.ram[0x0400 + i] = 0x05;
  // Re-render line 1 = same vmli/vc start. Should reflect NEW ram values
  // (= we re-fetch at FetchC), but within a single line the matrix is
  // latched at cycle 15 Φ2. To prove "no live RAM during emit" we'd
  // need to mutate RAM mid-line. Approximate: render two consecutive
  // lines where we mutate between them.
  const r2 = renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  // r1 fetched $01 → emit $ff → all fg pixels.
  // r2 fetched $05 → emit $55 (alternating) → fg/bg/fg/bg per pair.
  const r1AllFg = [...r1.out.slice(240, 240+40)].every(v => v === 0x0e);
  const r2NotAllFg = [...r2.out.slice(240, 240+40)].some(v => v === 0x06);
  ok("RAM mutation BETWEEN lines IS reflected (= matrix re-fetched per line)",
     r1AllFg && r2NotAllFg);
}

// --- Test 3: live-RAM-during-emit prevention. ---
//
// Inject a bus-read tracker. Verify that during one bad line render,
// each screen-RAM cell ($0400+N) is read AT MOST ONCE per line via
// readRamPhi1. If renderer used live RAM during emit, each cell would
// be read 8+ times (once per pixel).
{
  const env = buildEnv();
  const screenReadCounts = new Uint16Array(40);
  const fetchCtx = {
    ...makeFetchCtx(env),
    readRamPhi1: (a) => {
      if (a >= 0x0400 && a < 0x0428) screenReadCounts[a - 0x0400]++;
      return env.ram[a & 0xffff];
    },
  };
  renderRasterLine({
    badLine: true,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx,
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  let allOnce = true;
  for (let i = 0; i < 40; i++) {
    if (screenReadCounts[i] > 1) { allOnce = false; break; }
  }
  ok("each screen RAM cell read AT MOST ONCE per badline (no live-emit reads)",
     allOnce, `counts: ${[...screenReadCounts].join(",")}`);
}

// --- Test 4: vmli/vc lifecycle on idle (= non-bad) line. ---
//
// On an idle line, FetchC does not happen → vbuf/cbuf are not refreshed
// → cells emit from previously-latched values (or initial 0 on this
// line if no prior). Render should still complete without error.
{
  const env = buildEnv();
  const r = renderRasterLine({
    badLine: false,
    initialRegs: { d011: 0x1b, d016: 0x00, d018: 0x14, d020: 0x0e, d021: 0x06 },
    fetchCtx: makeFetchCtx(env),
    fetchColorRam: (vc) => env.colorRam[vc % 40],
    vmli: 0, vc: 0,
  });
  ok("idle line: render completes (no fetchC fired but pipe still emits)",
     r.out.length === 504);
  ok("idle line: vmli unchanged from input", r.finalVmli === 0);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
