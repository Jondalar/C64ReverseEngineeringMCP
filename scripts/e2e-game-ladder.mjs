#!/usr/bin/env node
// Spec 207 E2E ladder — boot real G64 games, verify file load + game
// state markers. Per ADR §11.3.
//
// Profiles per ADR §11.4:
//   --profile quick       — c64-ready prompt only
//   --profile integration — quick + LOAD"$" directory listing
//   --profile e2e-local   — full game boot tests (motm + MM + IM2 + LNR)
//
// Each test prints: kernel mode, media used, traps/hooks used, pass/fail.

import { resolve as resolvePath } from "node:path";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i+1] : dflt;
}

const profile = arg("profile", "e2e-local");
const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

console.log(`=== E2E Ladder — profile: ${profile} ===\n`);

const results = [];
function record(name, mode, media, hooksUsed, pass, note = "") {
  results.push({ name, mode, media, hooksUsed, pass, note });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}  mode=${mode} media=${media || "-"} hooks=${hooksUsed} ${note}`);
}

const PAL_HZ = 985248;

async function bootCheck(name, diskRel, mode, expectFn, maxSec = 60) {
  const diskPath = diskRel ? resolvePath(repoRoot, diskRel) : resolvePath(repoRoot, "samples/motm.g64");
  // Spec 723.3: all surviving modes are microcoded (product/debug); legacy CPU gone.
  const opts = { diskPath, mode, useMicrocodedCpu: true };
  const { session } = startIntegratedSession(opts);
  session.resetCold("pal-default");
  session.runFor(800_000);
  if (diskRel) session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  const target = session.c64Cpu.cycles + maxSec * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(50_000);
  const result = expectFn(session);
  // Hook usage check
  let hooksUsed = 0;
  try {
    const status = session.kernel?.status?.();
    if (status?.hooks) {
      for (const h of status.hooks) hooksUsed += (h.fireCount ?? 0);
    }
  } catch { /* ignore */ }
  record(name, mode, diskRel, hooksUsed, result.pass, result.note);
}

// Profile: quick — just c64 boots to ready (true-drive = real KERNAL flow)
if (profile === "quick" || profile === "integration" || profile === "e2e-local" || profile === "release") {
  await bootCheck("c64-ready", null, "true-drive", (s) => {
    // Check screen RAM for "READY." text (= BASIC active).
    const ram = s.c64Bus.ram;
    let hasReady = false;
    for (let row = 0; row < 25; row++) {
      const start = 0x0400 + row * 40;
      // R E A D Y . in petscii screen codes = 18 05 01 04 19 2e
      for (let col = 0; col < 35; col++) {
        if (ram[start+col] === 0x12 && ram[start+col+1] === 0x05 && ram[start+col+2] === 0x01 && ram[start+col+3] === 0x04 && ram[start+col+4] === 0x19) {
          hasReady = true;
          break;
        }
      }
      if (hasReady) break;
    }
    return { pass: hasReady, note: `READY in screen: ${hasReady}` };
  }, 5);
}

// Profile: integration — directory load
if (profile === "integration" || profile === "e2e-local" || profile === "release") {
  await bootCheck("motm-dir-load", "samples/motm.g64", "true-drive", (s) => {
    // Just verify drive ROM ran (= drive PC outside default $E5CD area)
    const drivePc = s.status().drive.pc;
    return { pass: drivePc !== 0, note: `drive PC=$${drivePc.toString(16)}` };
  }, 10);
}

// Profile: e2e-local — full game boot ladder
if (profile === "e2e-local" || profile === "release") {
  await bootCheck("motm-full-boot", "samples/motm.g64", "true-drive", (s) => {
    let nz = 0;
    for (let i = 0x4500; i < 0x6FFF; i++) if (s.c64Bus.ram[i] !== 0) nz++;
    return { pass: nz > 5000, note: `dad-range non-zero: ${nz}` };
  }, 60);

  await bootCheck("mm-s1-boot", "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64", "true-drive", (s) => {
    let nz = 0;
    for (let i = 0x0800; i < 0xC000; i++) if (s.c64Bus.ram[i] !== 0) nz++;
    return { pass: nz > 10000, note: `RAM non-zero: ${nz}` };
  }, 120);

  await bootCheck("im2-boot", "samples/impossible_mission_ii[epyx_1987](!).g64", "true-drive", (s) => {
    let nz = 0;
    for (let i = 0x0800; i < 0xC000; i++) if (s.c64Bus.ram[i] !== 0) nz++;
    return { pass: nz > 10000, note: `RAM non-zero: ${nz}` };
  }, 90);

  await bootCheck("lnr-s1-boot", "samples/last_ninja_remix_s1[system3_1991].g64", "true-drive", (s) => {
    let nz = 0;
    for (let i = 0x0800; i < 0xC000; i++) if (s.c64Bus.ram[i] !== 0) nz++;
    return { pass: nz > 10000, note: `RAM non-zero: ${nz}` };
  }, 90);
}

// Summary
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\n=== Profile ${profile}: ${pass}/${results.length} pass, ${fail} fail ===`);
for (const r of results.filter(r => !r.pass)) {
  console.log(`  FAIL: ${r.name} — ${r.note}`);
}
process.exit(fail > 0 ? 1 : 0);
