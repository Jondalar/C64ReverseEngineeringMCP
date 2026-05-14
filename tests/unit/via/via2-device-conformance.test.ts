// Spec 443 review — VIA2 device-level conformance unit tests.
//
// Targets the actual VIA2 drive-head paths:
//   - makeGcrShifterCoupling readPa / readPb
//   - makeGcrShifterCoupling onPaOutputChanged / onPbOutputChanged
//   - Via2d1541 storePcr / setCa2 / setCb2 (drive_t shadow updates)
//
// Each assertion cites VICE source lines (via2d.c).
//
// Run via:
//   npx tsx tests/unit/via/via2-device-conformance.test.ts

import { strict as assert } from "node:assert";
import {
  alarmContextNew,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  makeDrive_t,
  type Drive_t,
} from "../../../src/runtime/headless/drive/drive-t.js";
import { HeadPosition } from "../../../src/runtime/headless/drive/head-position.js";
import { makeGcrShifterCoupling } from "../../../src/runtime/headless/drive/via2-gcr-shifter-coupling.js";
import {
  rotation_init,
  rotation_reset,
  _rotation_state_for_test,
} from "../../../src/runtime/headless/drive/rotation.js";
import { Via2d1541 } from "../../../src/runtime/headless/via/via2d1541.js";
import { VIA_PCR } from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---------------------------------------------------------------------------
// Minimal GcrShifter stub — coupling only needs a small surface for the
// no-shadow legacy branch and for the motor/density setter calls.
// ---------------------------------------------------------------------------
function makeShifterStub() {
  const calls: string[] = [];
  return {
    dataByte: 0,
    syncBit: 1,           // 1 = no sync
    writeProtectSense: () => 0x10,
    setMotor: (on: boolean) => { calls.push(`setMotor:${on}`); },
    setDensity: (z: 0 | 1 | 2 | 3) => { calls.push(`setDensity:${z}`); },
    clearDensityOverride: () => { calls.push("clearDensity"); },
    calls,
  };
}

function makeHarness(opts: { withShadow: boolean; startTrack?: number } = { withShadow: true }) {
  let clk = 100n;
  const head = new HeadPosition({ startTrack: opts.startTrack ?? 18 });
  const shifter = makeShifterStub();
  let shadow: Drive_t | undefined;
  if (opts.withShadow) {
    shadow = makeDrive_t({ drive: 0, mynumber: 0, clk_ptr: () => clk });
    shadow.GCR_image_loaded = 1;
    shadow.read_only = 0;
    rotation_init(0, 0);
    rotation_reset(shadow);
  }
  const coupling = makeGcrShifterCoupling({
    shifter: shifter as any,
    headPosition: head,
    shadowDrive: shadow,
  });
  return {
    coupling, head, shifter, shadow,
    advance: (n: bigint) => { clk += n; },
    getClk: () => clk,
  };
}

// ---------------------------------------------------------------------------
// readPa — VICE via2d.c:463-484
// ---------------------------------------------------------------------------
test("coupling.readPa with shadowDrive: calls rotation_byte_read, clears byte_ready_level, returns GCR_read", () => {
  const h = makeHarness({ withShadow: true });
  h.shadow!.GCR_read = 0x55;
  h.shadow!.byte_ready_level = 1;
  h.shadow!.req_ref_cycles = 0;
  const byte = h.coupling.readPa();
  // rotation_byte_read consumes req_ref_cycles internally (VICE rotation.c:1068).
  // We observe the *side effects*: GCR_read passthrough + byte_ready_level cleared.
  assert.equal(byte, 0x55, "readPa returns GCR_read");
  assert.equal(h.shadow!.byte_ready_level, 0, "byte_ready_level cleared");
});

test("coupling.readPa during attach delay: rotation_byte_read forces GCR_read = 0", () => {
  const h = makeHarness({ withShadow: true });
  h.shadow!.GCR_read = 0x55;
  h.shadow!.attach_clk = h.getClk();   // attach NOW; delay window not yet elapsed
  const byte = h.coupling.readPa();
  // VICE rotation.c:1054-1055: during attach window, GCR_read forced 0.
  assert.equal(byte, 0, "GCR_read forced 0 inside attach window");
});

test("coupling.readPa without shadowDrive: returns shifter.dataByte", () => {
  const h = makeHarness({ withShadow: false });
  h.shifter.dataByte = 0x77;
  assert.equal(h.coupling.readPa(), 0x77);
});

// ---------------------------------------------------------------------------
// readPb — VICE via2d.c:486-512
// ---------------------------------------------------------------------------
test("coupling.readPb with shadowDrive sync: clears byte_ready_level, returns sync|wps|0x6f = 0x7f", () => {
  const h = makeHarness({ withShadow: true });
  // Force sync state: rotation_sync_found returns 0 when last_read_data == 0x3ff (and read mode + no attach).
  _rotation_state_for_test(0).last_read_data = 0x3ff;
  h.shadow!.read_write_mode = 1;
  h.shadow!.attach_clk = 0n;
  h.shadow!.byte_ready_level = 1;
  const byte = h.coupling.readPb();
  // wps = drive_writeprotect_sense = 0x10 for writable disk.
  // syncByte = rotation_sync_found = 0 (sync detected).
  // expected = (0 | 0x10 | 0x6f) = 0x7f. rotation_rotate_disk consumes
  // req_ref_cycles internally (VICE rotation.c:601,898,918,1020).
  assert.equal(byte, 0x7f, "(sync 0 | wps 0x10 | 0x6f) = 0x7f");
  assert.equal(h.shadow!.byte_ready_level, 0, "byte_ready_level cleared");
});

test("coupling.readPb with no-sync state: returns 0x80 | 0x10 | 0x6f = 0xff", () => {
  const h = makeHarness({ withShadow: true });
  _rotation_state_for_test(0).last_read_data = 0;   // != 0x3ff → no sync
  h.shadow!.read_write_mode = 1;
  h.shadow!.attach_clk = 0n;
  const byte = h.coupling.readPb();
  assert.equal(byte, 0xff);
});

// ---------------------------------------------------------------------------
// onPaOutputChanged — VICE via2d.c:180-192 store_pra
// ---------------------------------------------------------------------------
test("coupling.onPaOutputChanged: stores GCR_write_value + clears byte_ready_level", () => {
  const h = makeHarness({ withShadow: true });
  h.shadow!.byte_ready_level = 1;
  h.coupling.onPaOutputChanged!(0xab, 0xff, "or");
  assert.equal(h.shadow!.GCR_write_value, 0xab);
  assert.equal(h.shadow!.byte_ready_level, 0);
});

// ---------------------------------------------------------------------------
// onPbOutputChanged — VICE via2d.c:199-355
// ---------------------------------------------------------------------------

// Motor-on edge → byte_ready_active bit 2 set + rotation_begins
test("onPbOutputChanged motor-on edge: byte_ready_active bit 2 set", () => {
  const h = makeHarness({ withShadow: true, startTrack: 18 });
  h.shadow!.byte_ready_active = 0;
  // Write 1: motor off baseline (no edge needed yet but seed lastPbOrValue).
  h.coupling.onPbOutputChanged!(0x00, 0xff);
  // Write 2: motor on. byte_ready_active gets BRA_MOTOR_ON (0x04).
  h.coupling.onPbOutputChanged!(0x04, 0xff);
  assert.equal(h.shadow!.byte_ready_active & 0x04, 0x04);
});

// Density write → rotation_speed_zone_set propagates
test("onPbOutputChanged density bits: rotation_speed_zone_set updates rotation_t.speed_zone", () => {
  const h = makeHarness({ withShadow: true });
  // PB5/PB6 = density, set zone = 2 (= bits 0b10 in PB5..6 = 0x40).
  h.coupling.onPbOutputChanged!(0x40, 0xff);
  assert.equal(_rotation_state_for_test(0).speed_zone, 2);
});

// byte_ready_level epilogue
test("onPbOutputChanged epilogue: byte_ready_level cleared", () => {
  const h = makeHarness({ withShadow: true });
  h.shadow!.byte_ready_level = 1;
  h.coupling.onPbOutputChanged!(0x00, 0xff);
  assert.equal(h.shadow!.byte_ready_level, 0);
});

// Stepper move single (no Bug-1083 case): seed motor-on FIRST without
// stepper change, then change stepper while motor stays on.
test("onPbOutputChanged motor-on + step+1 (no edge): single move via applyStepBits", () => {
  const h = makeHarness({ withShadow: true, startTrack: 18 });
  // Write 1: stepBits=2 (matches initial old_stepper_pos=2), motor ON (0x06).
  //   applyStepBits: new=2, old=2 → stepCount=0 → no move.
  //   motorEdge from poldpb=0: motorEdge=true; but new(2)==oldBefore(2) → no Bug-1083 fire.
  h.coupling.onPbOutputChanged!(0x06, 0xff);
  assert.equal(h.head.currentHalfTrack, 36);
  // Write 2: stepBits=3, motor STILL ON (0x07). poldpb=0x06, motorEdge=false.
  //   applyStepBits moves: stepCount=+1 → 36→37.
  //   Bug-1083: motorEdge false → no second move.
  h.coupling.onPbOutputChanged!(0x07, 0xff);
  assert.equal(h.head.currentHalfTrack, 37);
});

// Bug-1083: motor-on edge with stepper change → SECOND drive_move_head call
test("Bug-1083 motor-on edge + stepper change: SECOND move fires (trackHalf+2)", () => {
  const h = makeHarness({ withShadow: true, startTrack: 18 });
  // trackHalf=36 → old_stepper=(36-2)&3=2.
  // Write 1: stepBits=3, motor OFF (PB=0x03). applyStepBits gated off,
  // no move. lastPbOrValue := 0x03.
  h.coupling.onPbOutputChanged!(0x03, 0xff);
  assert.equal(h.head.currentHalfTrack, 36, "no move with motor off");
  // Write 2: stepBits=3, motor ON (PB=0x07). poldpb=0x03, motorEdge=ON.
  // First move (applyStepBits with motorOn=true): new=3, old=2 → stepCount=+1,
  //   trackHalf 36→37.
  // Bug-1083 block: motorEdge && newStepperPos(3) != oldStepperPosBefore(2)
  //   && motorOn → second move: stepInward → 37→38.
  h.coupling.onPbOutputChanged!(0x07, 0xff);
  assert.equal(h.head.currentHalfTrack, 38, "Bug-1083 second move (38 not 37)");
});

// Bug-1083 negative: motor-edge but stepper unchanged → no second move
test("Bug-1083 motor-on edge + stepper UNCHANGED: NO extra move", () => {
  const h = makeHarness({ withShadow: true, startTrack: 18 });
  // Write 1: stepBits=2, motor OFF.  trackHalf=36, lastPbOrValue=0x02.
  h.coupling.onPbOutputChanged!(0x02, 0xff);
  // Write 2: stepBits=2 (UNCHANGED), motor ON. motorEdge yes; new=2, old=2.
  // applyStepBits: stepCount=0 → no move.  Bug-1083: new == old → no second move.
  h.coupling.onPbOutputChanged!(0x06, 0xff);
  assert.equal(h.head.currentHalfTrack, 36);
});

// Bug-1083 negative: stepper change but no motor edge → no Bug-1083 fire
test("Bug-1083 NO motor edge: no second move (only applyStepBits)", () => {
  const h = makeHarness({ withShadow: true, startTrack: 18 });
  // Write 1: stepBits=2, motor ON (PB=0x06).  applyStepBits: new=2, old=2 → 0.
  //   No move.  lastPbOrValue=0x06.
  h.coupling.onPbOutputChanged!(0x06, 0xff);
  assert.equal(h.head.currentHalfTrack, 36);
  // Write 2: stepBits=3 (+1), motor STILL ON. motorEdge = no (bit 2 unchanged).
  //   applyStepBits moves: stepCount=+1 → 36→37.
  //   Bug-1083: motorEdge false → no second move.
  h.coupling.onPbOutputChanged!(0x07, 0xff);
  assert.equal(h.head.currentHalfTrack, 37);
});

// ---------------------------------------------------------------------------
// Via2d1541 storePcr / setCa2 / setCb2 — VICE via2d.c:72-93 + 95-111 + 170-178
// ---------------------------------------------------------------------------
function makeVia2() {
  const ctx = alarmContextNew("test");
  let clk = 100n;
  const shadow = makeDrive_t({ drive: 0, mynumber: 0, clk_ptr: () => clk });
  shadow.GCR_image_loaded = 1;
  rotation_init(0, 0);
  rotation_reset(shadow);
  const v2 = new Via2d1541({
    alarmContext: ctx,
    clkRef: () => Number(clk),
    setIrq: () => undefined,
    shadowDrive: shadow,
  });
  return { via2: v2, shadow, advance: (n: bigint) => { clk += n; } };
}

test("Via2d1541 storePcr: read_write_mode = pcrval & 0x20", () => {
  const h = makeVia2();
  h.via2.via.store(VIA_PCR, 0x20);   // bit 5 = read mode
  assert.equal(h.shadow.read_write_mode, 0x20);
  h.via2.via.store(VIA_PCR, 0x00);   // bit 5 cleared = write mode
  assert.equal(h.shadow.read_write_mode, 0x00);
});

test("Via2d1541 storePcr: byte_ready_active bit 1 mirrors pcrval bit 1", () => {
  const h = makeVia2();
  // Pre-set bit 2 (motor) to ensure it stays.
  h.shadow.byte_ready_active = 0x04;
  h.via2.via.store(VIA_PCR, 0x02);   // bit 1 = BRA_BYTE_READY
  assert.equal(h.shadow.byte_ready_active & 0x02, 0x02);
  assert.equal(h.shadow.byte_ready_active & 0x04, 0x04, "motor bit preserved");
  h.via2.via.store(VIA_PCR, 0x00);
  assert.equal(h.shadow.byte_ready_active & 0x02, 0x00, "bit 1 cleared");
});

// ----------------------------------------------------------------------------
// Spec 444 — VIA2 reset mirrors led_status = 1 to shadowDrive
// (VICE via2d.c:423-431).
//
test("Via2d1541 reset sets shadowDrive.led_status = 1 (via2d.c:429)", () => {
  const h = makeVia2();
  h.shadow.led_status = 0;
  h.via2.via.reset();   // triggers backend.reset
  assert.equal(h.shadow.led_status, 1);
});

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia2-device-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
