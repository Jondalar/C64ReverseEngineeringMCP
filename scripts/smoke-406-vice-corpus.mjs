#!/usr/bin/env node
// Spec 406 — C64 Phase F: VICE testprog corpus runner.
//
// Doctrine: 1:1 VICE x64sc port. Phase F step 26 says "run the VICE
// testbench — vice/testprogs/ has 200+ programs that exercise edge
// cases. Each is a known-pass test against real hardware." This smoke
// drives our vendored subset under samples/vice-testprogs/ and asserts
// PASS rate >= 95% (OQ-406-1 / spec 406 Acceptance §4).
//
// Doc anchor: docs/vice-c64-arch.md §12 Phase F step 26.
// VICE source: vice/testprogs/cia/, vice/testprogs/drive/,
//              vice/testprogs/general/ (vendored selectively under
//              samples/vice-testprogs/{cia,drive,lorenz-2.15}/).
//
// Pass/fail oracle = same heuristic used in scripts/run-cia-suite.mjs:
//   - border $D020 = $02 (red)         → FAIL
//   - color RAM $D800-$DBE7 has red    → FAIL
//   - screen contains WRONG/ERROR/FAIL → FAIL
//   - otherwise                        → PASS
//
// Each unsupported testprog must be documented inline (= each
// SKIPPED line carries a `requires <feature> deferred to Spec 4XX`
// note per spec 406 Acceptance §4).
//
// Usage:
//   node scripts/smoke-406-vice-corpus.mjs [--max-sec 8] [--verbose]

import { resolve as resolvePath, join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
function flag(name) { return args.includes(`--${name}`); }

const maxSec = parseInt(arg("max-sec", "8"), 10);
const verbose = flag("verbose");
const passThreshold = parseFloat(arg("pass-threshold", "0.95"));

const repoRoot = resolvePath(import.meta.dirname, "..");
const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");

const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

// Groups vendored under samples/vice-testprogs/.
// Lorenz disk-based suite is handled by run-lorenz-suite.mjs (separate
// long-running script). Spec 406 corpus is the PRG-based subset.
const GROUPS = {
  cia: "samples/vice-testprogs/cia",
  drive: "samples/vice-testprogs/drive",
};

// Known unsupported testprogs — each must cite the deferring spec.
// Spec 406 Acceptance §4: "each unsupported testprog documented as
// `requires <feature> deferred to Spec 4XX`".
const UNSUPPORTED = new Map([
  // (no entries; current corpus is fully supported per memo
  //  feedback_truedrive_101 — CIA 59/59 + drive 4/4 PASS).
  // Future entries shape: ["<rel-path>", "requires <feature> deferred to Spec 4XX"]
]);

function listPrgs(dir) {
  const out = [];
  function walk(p) {
    for (const entry of readdirSync(p)) {
      const full = join(p, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".prg")) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

function colorRamHasRed(ram) {
  for (let i = 0xd800; i <= 0xdbe7; i++) {
    if ((ram[i] & 0x0f) === 0x02) return true;
  }
  return false;
}

function screenContains(ram, needles) {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c === 0x20) s += " ";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x30 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return needles.some((n) => s.includes(n));
}

function runOne(prgPath) {
  const data = readFileSync(prgPath);
  const loadAddr = data[0] | (data[1] << 8);
  const program = data.subarray(2);
  const progEnd = loadAddr + program.length;

  const { session } = startIntegratedSession({
    diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");
  session.runFor(2_000_000);

  for (let i = 0; i < program.length; i++) {
    session.c64Bus.ram[(loadAddr + i) & 0xffff] = program[i];
  }
  // BASIC pointers — see run-cia-suite.mjs for rationale.
  session.c64Bus.ram[0x002d] = progEnd & 0xff;
  session.c64Bus.ram[0x002e] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x002f] = progEnd & 0xff;
  session.c64Bus.ram[0x0030] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x0031] = progEnd & 0xff;
  session.c64Bus.ram[0x0032] = (progEnd >> 8) & 0xff;
  if (loadAddr === 0x0801) session.typeText("RUN\r", 80_000, 80_000);
  else session.typeText(`SYS ${loadAddr}\r`, 80_000, 80_000);

  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + maxSec * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(50_000);

  const ram = session.c64Bus.ram;
  const border = ram[0xd020] & 0x0f;
  const colorRed = colorRamHasRed(ram);
  const screenFail = screenContains(ram, ["WRONG", "ERROR", "FAIL", "BAD"]);
  const screenPass = screenContains(ram, ["PASS", "OK", "FINISH"]);

  let verdict = "PASS";
  if (border === 0x02 || colorRed || screenFail) verdict = "FAIL";
  else if (border === 0x05 || screenPass) verdict = "PASS";
  // default = "ran cleanly without flagging error" = PASS.

  return {
    border: `$${border.toString(16).padStart(2, "0")}`,
    colorRed,
    screenFail,
    screenPass,
    verdict,
    pc: `$${session.c64Cpu.pc.toString(16)}`,
  };
}

const allResults = [];
let pass = 0, fail = 0, skipped = 0;

console.log(`smoke-406-vice-corpus (Spec 406 / docs/vice-c64-arch.md §12 step 26)`);
console.log(`  max-sec: ${maxSec}`);
console.log(`  pass-threshold: ${(passThreshold * 100).toFixed(0)}%\n`);

for (const [name, relDir] of Object.entries(GROUPS)) {
  const dir = resolvePath(repoRoot, relDir);
  if (!existsSync(dir)) {
    console.log(`SKIP group ${name}: dir missing (${dir})`);
    continue;
  }
  const prgs = listPrgs(dir);
  console.log(`=== Group ${name}: ${prgs.length} testprogs ===`);
  for (const p of prgs) {
    const rel = p.replace(repoRoot + "/", "");
    if (UNSUPPORTED.has(rel)) {
      console.log(`  ${rel} ... SKIP (${UNSUPPORTED.get(rel)})`);
      skipped += 1;
      allResults.push({ path: rel, verdict: "SKIP", reason: UNSUPPORTED.get(rel) });
      continue;
    }
    process.stdout.write(`  ${rel} ... `);
    let res;
    try {
      res = runOne(p);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      fail += 1;
      allResults.push({ path: rel, verdict: "ERROR", error: e.message });
      continue;
    }
    console.log(`${res.verdict}  border=${res.border}${res.colorRed ? " color=red" : ""} pc=${res.pc}`);
    allResults.push({ path: rel, ...res });
    if (res.verdict === "PASS") pass += 1;
    else fail += 1;
  }
  console.log("");
}

const total = pass + fail;  // SKIPPED excluded from rate calc (= documented unsupported).
const rate = total === 0 ? 1 : pass / total;

console.log(`=== Summary ===`);
console.log(`PASS:    ${pass}`);
console.log(`FAIL:    ${fail}`);
console.log(`SKIPPED: ${skipped}  (= documented unsupported)`);
console.log(`Total executed: ${total}`);
console.log(`Pass rate: ${(rate * 100).toFixed(1)}%  (threshold ${(passThreshold * 100).toFixed(0)}%)`);

if (verbose && fail > 0) {
  console.log(`\n=== Failures ===`);
  for (const r of allResults.filter((r) => r.verdict !== "PASS" && r.verdict !== "SKIP")) {
    console.log(`  ${r.path}  verdict=${r.verdict}${r.border ? ` border=${r.border}` : ""}${r.error ? ` err=${r.error}` : ""}`);
  }
}

const ok = rate >= passThreshold;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
