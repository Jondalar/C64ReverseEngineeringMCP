#!/usr/bin/env node
// Spec 200-c6 — kernel facade smoke.
//
// Asserts Spec 200 acceptance criteria:
//   - kernel.status() returns valid KernelStatus shape
//   - kernel.c64Clock() advances after runCycles(N)
//   - kernel.driveClock(8) advances after run
//   - kernel.driveClock(10) throws for unmounted device
//   - kernel constructor exposes alarms (Spec 200-c2 ownership)
//   - kernel exposes c64Bus, c64Cpu, cia1, cia2, vic, sid, framebuffer
//     (Spec 200-c3 ownership)
//   - kernel exposes parser, drive, gcrShifter, headPosition
//     (Spec 200-c4 ownership)
//
// Uses the synthetic 1-block fixture (low-cost, no MM ROM needed).

import { existsSync } from "node:fs";

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

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

console.log("kernel-facade smoke — Spec 200 acceptance");

const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});

const kernel = session.kernel;

check("kernel attached to session", () => {
  if (!kernel) throw new Error("session.kernel is undefined");
});

check("kernel.status() valid shape", () => {
  const s = kernel.status();
  if (typeof s.mode !== "string") throw new Error(`mode not string: ${typeof s.mode}`);
  if (s.mode !== "debug-lockstep") throw new Error(`mode != debug-lockstep, got ${s.mode}`);
  if (!Array.isArray(s.hooks)) throw new Error("hooks not array");
  if (s.hooks.length !== 0) throw new Error(`hooks not empty: ${JSON.stringify(s.hooks)}`);
  if (s.video !== "PAL") throw new Error(`video != PAL by default, got ${s.video}`);
  if (typeof s.c64Clock !== "number") throw new Error("c64Clock not number");
  if (!s.driveClocks || typeof s.driveClocks[8] !== "number") throw new Error("driveClocks[8] not number");
  if (!Array.isArray(s.mediaSlots) || s.mediaSlots.length === 0) throw new Error("mediaSlots empty");
});

check("kernel owns alarm contexts (Spec 200-c2)", () => {
  if (!kernel.alarms?.maincpu) throw new Error("alarms.maincpu missing");
  if (!kernel.alarms?.drivecpu) throw new Error("alarms.drivecpu missing");
  if (kernel.alarms.maincpu !== session.maincpuAlarmContext) {
    throw new Error("session.maincpuAlarmContext != kernel.alarms.maincpu (alias broken)");
  }
});

check("kernel owns C64 chips (Spec 200-c3)", () => {
  for (const f of ["c64Bus", "c64Cpu", "cia1", "cia2", "vic", "sid", "framebuffer", "iecBus"]) {
    if (!kernel[f]) throw new Error(`kernel.${f} missing`);
    if (kernel[f] !== session[f]) throw new Error(`session.${f} != kernel.${f} (alias broken)`);
  }
});

check("kernel owns drive + disk (Spec 200-c4)", () => {
  for (const f of ["drive", "parser", "trackBuffer", "headPosition", "gcrShifter", "diskProvider"]) {
    if (!kernel[f]) throw new Error(`kernel.${f} missing`);
    if (kernel[f] !== session[f]) throw new Error(`session.${f} != kernel.${f} (alias broken)`);
  }
});

check("kernel.c64Clock() advances after runCycles(N)", () => {
  session.resetCold();
  const before = kernel.c64Clock();
  kernel.runCycles(1000);
  const after = kernel.c64Clock();
  if (after <= before) throw new Error(`c64Clock did not advance: before=${before} after=${after}`);
});

check("kernel.driveClock(8) returns number", () => {
  const v = kernel.driveClock(8);
  if (typeof v !== "number") throw new Error(`driveClock(8) not number: ${typeof v}`);
});

check("kernel.driveClock(10) throws for unmounted device", () => {
  let threw = false;
  try {
    kernel.driveClock(10);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("driveClock(10) did not throw");
});

check("kernel.bus exposes KernelBus surface (Spec 201-c1)", () => {
  if (!kernel.bus) throw new Error("kernel.bus missing");
  for (const m of ["c64Read", "c64Write", "driveRead", "driveWrite"]) {
    if (typeof kernel.bus[m] !== "function") throw new Error(`kernel.bus.${m} not function`);
  }
});

check("kernel.bus.c64Read($DD00) returns IEC PA bits", () => {
  const ctx = {
    side: "c64",
    clock: kernel.c64Clock(),
    pc: 0,
    opcode: 0,
    phase: "phi2",
    addr: 0xdd00,
    access: "read",
  };
  const v = kernel.bus.c64Read(0xdd00, ctx);
  if (typeof v !== "number") throw new Error(`c64Read returned ${typeof v}`);
  if (v < 0 || v > 0xff) throw new Error(`c64Read returned ${v} out of byte range`);
});

check("kernel.bus.driveRead(8, $1800) returns drive bus byte", () => {
  const ctx = {
    side: "drive",
    device: 8,
    clock: kernel.driveClock(8),
    pc: 0,
    opcode: 0,
    phase: "phi2",
    addr: 0x1800,
    access: "read",
  };
  const v = kernel.bus.driveRead(8, 0x1800, ctx);
  if (typeof v !== "number") throw new Error(`driveRead returned ${typeof v}`);
});

check("kernel.catchUpDrive exists and is no-op safe (Spec 202-c1)", () => {
  if (typeof kernel.catchUpDrive !== "function") {
    throw new Error("kernel.catchUpDrive missing");
  }
  // Calling for non-mounted device must be a silent no-op.
  kernel.catchUpDrive(10, 0);
  // Calling for device 8 at current clock must not throw.
  kernel.catchUpDrive(8, kernel.driveClock(8));
});

check("CIA2 \$DD00 + VIA1 \$1800 calls reach KernelBus during run (Spec 201-c2/c3)", () => {
  // Wrap kernel.bus methods to count calls; reset session and run.
  let c64dd00Writes = 0;
  let drv1800Writes = 0;
  const realC64Write = kernel.bus.c64Write.bind(kernel.bus);
  const realDriveWrite = kernel.bus.driveWrite.bind(kernel.bus);
  kernel.bus.c64Write = (addr, value, ctx) => {
    if (addr === 0xdd00) c64dd00Writes++;
    return realC64Write(addr, value, ctx);
  };
  kernel.bus.driveWrite = (device, addr, value, ctx) => {
    if (addr === 0x1800) drv1800Writes++;
    return realDriveWrite(device, addr, value, ctx);
  };
  try {
    session.resetCold();
    session.runFor(5000);
  } finally {
    kernel.bus.c64Write = realC64Write;
    kernel.bus.driveWrite = realDriveWrite;
  }
  if (c64dd00Writes === 0) throw new Error("no \$DD00 writes routed through bus during run");
  if (drv1800Writes === 0) throw new Error("no \$1800 writes routed through bus during run");
});

console.log(`---`);
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
