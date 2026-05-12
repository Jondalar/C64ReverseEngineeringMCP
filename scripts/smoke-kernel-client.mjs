#!/usr/bin/env node
// Spec 206 smoke — verify IntegratedSession can be used through the
// KernelClient surface for all V2/V3 client operations.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

// Use a synthetic disk image — samples/* is gitignored so real game
// disks (motm.g64 etc.) are not available in CI. smoke:gen runs first
// in quick.yml and produces samples/synthetic/1block.g64.
const { session } = startIntegratedSession({
  diskPath: resolvePath(repoRoot, "samples/synthetic/1block.g64"),
  mode: "true-drive",
  useMicrocodedCpu: true,
});

console.log("=== Spec 206 KernelClient surface smoke ===\n");

test("resetCold('pal-default')", () => {
  session.resetCold("pal-default");
});

test("c64Clock() / driveClock(8)", () => {
  const c = session.c64Cpu.cycles;
  const d = session.drive.cpu.cycles;
  if (typeof c !== "number" || typeof d !== "number") throw new Error("not numbers");
});

test("status() — mode + clocks + hooks + media", () => {
  const status = session.kernel.status();
  if (!status.mode) throw new Error("no mode");
  if (typeof status.c64Clock !== "number") throw new Error("no c64Clock");
  if (!Array.isArray(status.hooks)) throw new Error("no hooks");
  if (!Array.isArray(status.mediaSlots)) throw new Error("no mediaSlots");
});

test("run() with cycle budget", () => {
  const before = session.c64Cpu.cycles;
  session.runFor(800_000);
  if (session.c64Cpu.cycles - before < 100_000) throw new Error("not enough cycles");
});

test("typeText() input", () => {
  session.typeText("R", 80_000, 80_000);
  // Just verify call didn't throw.
});

test("readMemory() c64 ram", () => {
  const ram = session.c64Bus.ram;
  if (ram.length !== 65536) throw new Error("c64 RAM not 64K");
});

test("readMemory() drive8 ram", () => {
  const ram = session.drive.bus.ram;
  if (ram.length !== 0x0800) throw new Error("drive RAM not 2K");
});

test("readRegisters() c64", () => {
  const cpu = session.c64Cpu;
  if (typeof cpu.pc !== "number") throw new Error("no PC");
  if (typeof cpu.a !== "number") throw new Error("no A");
  if (typeof cpu.cycles !== "number") throw new Error("no cycles");
});

test("trace() returns controller", () => {
  const tc = session.kernel.trace();
  if (!tc) throw new Error("no trace controller");
  if (typeof tc.publish !== "function") throw new Error("no publish");
});

test("renderToPng() — 384x272 cropped (VICE x64sc default)", () => {
  const r = session.renderToPng("/tmp/spec206-smoke.png");
  if (r.width !== 384 || r.height !== 272) throw new Error(`unexpected size ${r.width}x${r.height}`);
  if (r.bytes < 100) throw new Error("png too small");
});

test("snapshot() / restore()", () => {
  // IntegratedSession exposes session-snapshot via separate path — verify it exists
  if (typeof session.kernel.snapshot !== "function") throw new Error("no snapshot");
});

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 206 KernelClient smoke: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
