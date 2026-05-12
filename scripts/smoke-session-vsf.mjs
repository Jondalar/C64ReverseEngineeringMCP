#!/usr/bin/env node
// Spec 251 smoke — IntegratedSession VSF round-trip.
//
// Scenarios: c64-ready (true-drive), motm-stage-1 (after dir-load).
// For each: save VSF → fresh session → load VSF → compare key
// state byte-equal.

import { resolve as resolvePath } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const tmpDir = "/tmp/c64re-vsf-smoke";
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);
const { saveSessionVsf, loadSessionVsf } = await import(
  `${repoRoot}/dist/runtime/headless/vsf/session-vsf.js`
);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ name, pass: false, err: e.message }); console.log(`  FAIL  ${name}: ${e.message}`); }
}

console.log("=== Spec 251 — IntegratedSession VSF round-trip ===\n");

function captureKeyState(session) {
  return {
    cpuRegs: { pc: session.c64Cpu.pc, a: session.c64Cpu.a, x: session.c64Cpu.x, y: session.c64Cpu.y, sp: session.c64Cpu.sp, flags: session.c64Cpu.flags, cycles: session.c64Cpu.cycles },
    ramHash: hashBytes(session.c64Bus.ram),
    cpuPortDir: session.c64Bus.getCpuPortDirection(),
    cpuPortVal: session.c64Bus.getCpuPortValue(),
    cia1Regs: hashBytes(session.cia1.c_cia),
    cia2Regs: hashBytes(session.cia2.c_cia),
    vicRegs: hashBytes(session.vic.regs),
    sidRegs: hashBytes(session.sid.regs),
    driveCpuRegs: { pc: session.drive.cpu.pc, a: session.drive.cpu.a, x: session.drive.cpu.x, y: session.drive.cpu.y, sp: session.drive.cpu.sp, flags: session.drive.cpu.flags, cycles: session.drive.cpu.cycles },
    driveRamHash: hashBytes(session.drive.bus.ram),
  };
}

function hashBytes(arr) {
  // FNV-1a (cheap stable hash)
  let h = 0x811c9dc5;
  for (const b of arr) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function statesEqual(a, b) {
  if (a.cpuRegs.pc !== b.cpuRegs.pc) return `pc ${a.cpuRegs.pc.toString(16)} vs ${b.cpuRegs.pc.toString(16)}`;
  if (a.cpuRegs.a !== b.cpuRegs.a) return "a";
  if (a.cpuRegs.x !== b.cpuRegs.x) return "x";
  if (a.cpuRegs.y !== b.cpuRegs.y) return "y";
  if (a.cpuRegs.sp !== b.cpuRegs.sp) return "sp";
  if (a.cpuRegs.flags !== b.cpuRegs.flags) return "flags";
  if (a.cpuRegs.cycles !== b.cpuRegs.cycles) return `cycles ${a.cpuRegs.cycles} vs ${b.cpuRegs.cycles}`;
  if (a.ramHash !== b.ramHash) return `ram hash ${a.ramHash.toString(16)} vs ${b.ramHash.toString(16)}`;
  if (a.cpuPortDir !== b.cpuPortDir) return "cpuPortDir";
  if (a.cpuPortVal !== b.cpuPortVal) return "cpuPortVal";
  if (a.cia1Regs !== b.cia1Regs) return "cia1Regs";
  if (a.cia2Regs !== b.cia2Regs) return "cia2Regs";
  if (a.vicRegs !== b.vicRegs) return "vicRegs";
  if (a.sidRegs !== b.sidRegs) return "sidRegs";
  if (a.driveCpuRegs.pc !== b.driveCpuRegs.pc) return `drive pc ${a.driveCpuRegs.pc.toString(16)} vs ${b.driveCpuRegs.pc.toString(16)}`;
  if (a.driveRamHash !== b.driveRamHash) return "driveRam";
  return null;
}

test("c64-ready scenario round-trip", () => {
  const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
  const opts = { diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true };

  const s1 = startIntegratedSession(opts).session;
  s1.resetCold("pal-default");
  s1.runFor(1_500_000); // boot to READY
  const state1 = captureKeyState(s1);
  const vsfPath = `${tmpDir}/c64-ready.vsf`;
  saveSessionVsf(s1, vsfPath);

  const s2 = startIntegratedSession(opts).session;
  s2.resetCold("pal-default");
  // intentionally DON'T run, so initial state differs
  loadSessionVsf(s2, vsfPath);
  const state2 = captureKeyState(s2);

  const diff = statesEqual(state1, state2);
  if (diff) throw new Error(`state diff: ${diff}`);
});

test("motm-dir-load scenario round-trip", () => {
  const opts = { diskPath: resolvePath(repoRoot, "samples/motm.g64"), mode: "fast-trap", useMicrocodedCpu: false };
  const s1 = startIntegratedSession(opts).session;
  s1.resetCold("pal-default");
  s1.runFor(1_500_000);
  s1.typeText('LOAD"$",8\r', 80_000, 80_000);
  s1.runFor(5_000_000);
  const state1 = captureKeyState(s1);
  const vsfPath = `${tmpDir}/motm-dir.vsf`;
  saveSessionVsf(s1, vsfPath);

  const s2 = startIntegratedSession(opts).session;
  s2.resetCold("pal-default");
  loadSessionVsf(s2, vsfPath);
  const state2 = captureKeyState(s2);

  const diff = statesEqual(state1, state2);
  if (diff) throw new Error(`state diff: ${diff}`);
});

test("VSF reject older version", () => {
  // Forge a VSF file with version 1.0 (= older than 2.0)
  const magic = new TextEncoder().encode("VICE Snapshot File");
  const buf = new Uint8Array(magic.length + 2 + 4);
  buf.set(magic, 0);
  buf[magic.length] = 1; // major
  buf[magic.length + 1] = 0; // minor
  buf[magic.length + 2] = 0x43; // 'C'
  buf[magic.length + 3] = 0x36; // '6'
  buf[magic.length + 4] = 0x34; // '4'
  buf[magic.length + 5] = 0x00; // null term
  const oldPath = `${tmpDir}/old.vsf`;
  writeFileSync(oldPath, buf);

  const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
  const s = startIntegratedSession({ diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true }).session;
  let threw = false;
  try { loadSessionVsf(s, oldPath); }
  catch (e) {
    threw = true;
    if (!e.message.includes("3.7+")) throw new Error(`wrong error: ${e.message}`);
  }
  if (!threw) throw new Error("expected version reject");
});

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 251 VSF round-trip: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
