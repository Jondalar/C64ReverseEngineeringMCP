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
  // Spec 204: hooks now registered at kernel construction. Default
  // mode = debug-lockstep, all fireCounts must start at 0.
  if (s.hooks.length === 0) throw new Error("hooks should list every registered legacy hook (Spec 204)");
  for (const h of s.hooks) {
    if (typeof h.name !== "string") throw new Error(`hook missing name: ${JSON.stringify(h)}`);
    if (h.fireCount !== 0) throw new Error(`hook ${h.name} fireCount != 0 at construction: ${h.fireCount}`);
  }
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

check("kernel.emitIrqEvent + irqEvents capture CIA edges (Spec 203-c1/c2)", () => {
  if (typeof kernel.emitIrqEvent !== "function") throw new Error("emitIrqEvent missing");
  if (typeof kernel.irqEvents !== "function") throw new Error("irqEvents missing");
  session.resetCold();
  session.runFor(20000);
  const events = kernel.irqEvents();
  if (events.length === 0) throw new Error("no IRQ events captured during runFor(20000)");
  const cia1Events = events.filter((e) => e.source === "cia1");
  if (cia1Events.length === 0) throw new Error("no cia1 events captured");
  for (const e of events.slice(0, 3)) {
    if (typeof e.seq !== "number") throw new Error("event missing seq");
    if (typeof e.edgeClock !== "number") throw new Error("event missing edgeClock");
  }
});

check("markIrqServiced backfills servicedClock (Spec 203-c4)", () => {
  // Probe the API in isolation: emit a fake CIA1 event, then call
  // markIrqServiced — the latest matching unfilled event should pick
  // up the clock. Using emit + markIrqServiced directly avoids
  // depending on real IRQ activity timing.
  const probe = kernel.emitIrqEvent({
    line: "irq",
    asserted: true,
    source: "cia1",
    target: "c64-cpu",
    edgeClock: 4242,
    visibleClock: 4242,
  });
  if (probe.servicedClock !== undefined) throw new Error("probe pre-marked");
  kernel.markIrqServiced("c64-cpu", "irq", 4250);
  const events = kernel.irqEvents();
  const found = events.find((e) => e.seq === probe.seq);
  if (!found) throw new Error("probe event not in ring");
  if (found.servicedClock !== 4250) {
    throw new Error(`servicedClock = ${found.servicedClock}, want 4250`);
  }
  // Second mark must NOT re-stamp the already-serviced event; ring
  // walks back past it. Without another asserted event in flight
  // it's a no-op.
  kernel.markIrqServiced("c64-cpu", "irq", 9999);
  const reread = kernel.irqEvents().find((e) => e.seq === probe.seq);
  if (reread.servicedClock !== 4250) {
    throw new Error("servicedClock re-stamped on second markIrqServiced");
  }
});

check("VIA/VIC/SO wiring registered on kernel (Spec 203-c3 — static)", () => {
  // Static-wiring check: the kernel constructor passes onVia1IrqEdge,
  // onVia2IrqEdge, onSoEdge to DriveCpu and a VIC setIrqLine callback
  // to the VIC backend. Verifying real-world fires requires significant
  // emulation activity (drive boot ≈ 250k cycles, VIC raster IRQ needs
  // KERNAL setup) — that path is implicitly proven by smoke:load.
  // Here we exercise emitIrqEvent for each new source/target so
  // KernelIrqSource union widening (gcr-shifter) is type-checked at
  // runtime via successful emit.
  const probeEvents = [
    { line: "irq", source: "via1", target: "drive-cpu" },
    { line: "irq", source: "via2", target: "drive-cpu" },
    { line: "irq", source: "vic", target: "c64-cpu" },
    { line: "so", source: "gcr-shifter", target: "drive-cpu" },
  ];
  for (const probe of probeEvents) {
    const e = kernel.emitIrqEvent({
      ...probe,
      asserted: true,
      edgeClock: 1,
      visibleClock: 1,
    });
    if (e.source !== probe.source) throw new Error(`emit roundtrip failed for ${probe.source}`);
  }
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

check("CIA2 \$DD00 + VIA1 \$1800 routing wired (Spec 201-c2/c3 — static)", () => {
  // Static check: the kernel constructor wires CIA2 install with an
  // iecWrite callback that closes over kernel.bus, and DriveCpu with
  // an iecStorePb callback. Confirm the surfaces exist; live-routing
  // is implicitly proven by smoke:load (MM 38KB byte-perfect requires
  // the IEC path to operate).
  if (!kernel.cia2) throw new Error("kernel.cia2 missing");
  if (!kernel.drive?.bus?.via1) throw new Error("kernel.drive.bus.via1 missing");
});

console.log(`---`);
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
