#!/usr/bin/env node
// Spec 100 (M1.3) — deterministic reset profile smoke.
//
// 5 cold resets with the same profile + same input sequence;
// hash full state at cycle ~100k; all hashes must equal.

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const disk = "samples/synthetic/1byte.g64";
if (!existsSync(disk)) { console.error(`fixture missing: ${disk}`); process.exit(2); }

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

function snapshotHash(session) {
  const c64Ram = session.c64Bus.ram;
  const drvRam = session.drive.bus.ram;
  const h = createHash("md5");
  h.update(c64Ram);
  h.update(drvRam);
  // Also hash a few CPU register fields.
  const cpu = session.c64Cpu;
  const drv = session.drive.cpu;
  h.update(Buffer.from([
    cpu.pc & 0xff, (cpu.pc >> 8) & 0xff, cpu.a, cpu.x, cpu.y, cpu.sp, cpu.flags,
    drv.pc & 0xff, (drv.pc >> 8) & 0xff, drv.a, drv.x, drv.y, drv.sp, drv.flags,
  ]));
  return h.digest("hex");
}

const TARGET_CYCLES = 100_000;
const ITERATIONS = 5;

const hashes = [];
for (let iter = 0; iter < ITERATIONS; iter++) {
  const { session } = startIntegratedSession({ diskPath: disk, mode: "true-drive" });
  session.resetCold("pal-default");
  while (session.c64Cpu.cycles < TARGET_CYCLES) {
    session.runFor(1);
  }
  const h = snapshotHash(session);
  hashes.push(h);
  console.log(`  iter ${iter + 1}: cycles=${session.c64Cpu.cycles} hash=${h}`);
}

const allEqual = hashes.every((h) => h === hashes[0]);
console.log("---");
if (allEqual) {
  console.log(`PASS: all ${ITERATIONS} resets produced identical state at cycle ${TARGET_CYCLES}`);
  process.exit(0);
}
console.log(`FAIL: hashes diverged across ${ITERATIONS} resets`);
const seen = new Set(hashes);
console.log(`  unique hashes: ${seen.size}`);
process.exit(1);
