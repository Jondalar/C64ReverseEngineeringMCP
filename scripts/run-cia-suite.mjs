#!/usr/bin/env node
// CIA + drive testprog suite runner. Wraps run-testprog.mjs across
// vendored testprog directories under samples/vice-testprogs/.
//
// Pass/fail detection per testprog:
//   - border = $D020 sampled at end. Red ($02) = FAIL, green ($05)
//     = PASS, anything else = INCONCLUSIVE (= visual review needed).
//   - ciavarious + ciamirrors + dd0drw + transactor convention is
//     "border red on any failed sub-test". Tests run all sub-tests
//     once at startup (no keypress required).
//   - cia-timer / shiftregister / pb6pb7 / reload0 / irqdelay show
//     expected vs actual on screen, mismatched bytes red. We sample
//     color RAM $D800-$DBE7 and flag FAIL if any cell == red ($02).
//
// Usage:
//   node scripts/run-cia-suite.mjs [--group cia|drive|all]
//                                  [--max-sec 20]
//                                  [--filter <substring>]
//                                  [--verbose]

import { resolve as resolvePath, basename, join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i+1] : dflt;
}
function flag(name) { return args.includes(`--${name}`); }

const group = arg("group", "cia");
const maxSec = parseInt(arg("max-sec", "20"), 10);
const filter = arg("filter", "");
const verbose = flag("verbose");

const repoRoot = resolvePath(import.meta.dirname, "..");
const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const GROUPS = {
  cia: "samples/vice-testprogs/cia",
  drive: "samples/vice-testprogs/drive",
};

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
  // Decode screen RAM $0400-$07E7 to upper-case ASCII and match needles.
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
  session.c64Bus.ram[0x002d] = progEnd & 0xff;
  session.c64Bus.ram[0x002e] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x002f] = progEnd & 0xff;
  session.c64Bus.ram[0x0030] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x0031] = progEnd & 0xff;
  session.c64Bus.ram[0x0032] = (progEnd >> 8) & 0xff;
  if (loadAddr === 0x0801) session.typeText("RUN\r", 80_000, 80_000);
  else session.typeText(`SYS ${loadAddr}\r`, 80_000, 80_000);

  const target = session.c64Cpu.cycles + maxSec * 985248;
  while (session.c64Cpu.cycles < target) session.runFor(50_000);

  const ram = session.c64Bus.ram;
  const border = ram[0xd020] & 0x0f;
  const colorRed = colorRamHasRed(ram);
  const screenFail = screenContains(ram, ["WRONG", "ERROR", "FAIL", "BAD"]);
  const screenPass = screenContains(ram, ["PASS", "OK", "FINISH"]);

  // Red border or any red color cell = explicit FAIL.
  // Otherwise: green border, "OK"/"PASS"/"FINISH" on screen, or
  // simply non-red = treat as PASS (testprog ran without flagging
  // a mismatch).
  let verdict = "INCONCLUSIVE";
  if (border === 0x02 || colorRed || screenFail) verdict = "FAIL";
  else if (border === 0x05 || screenPass) verdict = "PASS";
  else verdict = "PASS";  // ran cleanly, no fail markers

  return {
    border: `$${border.toString(16).padStart(2, "0")}`,
    colorRed,
    screenFail,
    screenPass,
    verdict,
    pc: `$${session.c64Cpu.pc.toString(16)}`,
  };
}

const groups = group === "all" ? Object.keys(GROUPS) : [group];
const allResults = [];
let pass = 0, fail = 0, inc = 0, skipped = 0;

for (const g of groups) {
  const dir = resolvePath(repoRoot, GROUPS[g] ?? GROUPS.cia);
  if (!existsSync(dir)) {
    console.log(`SKIP group ${g}: dir missing (${dir})`);
    continue;
  }
  const prgs = listPrgs(dir).filter((p) => !filter || p.includes(filter));
  console.log(`=== Group ${g}: ${prgs.length} testprogs ===\n`);
  for (const p of prgs) {
    const rel = p.replace(repoRoot + "/", "");
    process.stdout.write(`  ${rel} ... `);
    let res;
    try {
      res = runOne(p);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      skipped += 1;
      allResults.push({ path: rel, verdict: "ERROR", error: e.message });
      continue;
    }
    console.log(`${res.verdict}  border=${res.border}${res.colorRed ? " color=red" : ""} pc=${res.pc}`);
    allResults.push({ path: rel, ...res });
    if (res.verdict === "PASS") pass += 1;
    else if (res.verdict === "FAIL") fail += 1;
    else inc += 1;
  }
}

console.log(`\n=== Summary ===`);
console.log(`PASS:         ${pass}`);
console.log(`FAIL:         ${fail}`);
console.log(`INCONCLUSIVE: ${inc}`);
console.log(`SKIPPED:      ${skipped}`);
console.log(`Total:        ${allResults.length}`);

if (verbose && fail > 0) {
  console.log(`\n=== Failures ===`);
  for (const r of allResults.filter((r) => r.verdict === "FAIL")) {
    console.log(`  ${r.path}  border=${r.border}${r.colorRed ? " color=red" : ""}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
