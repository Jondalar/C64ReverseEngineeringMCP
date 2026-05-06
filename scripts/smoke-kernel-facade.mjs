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

console.log(`---`);
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
