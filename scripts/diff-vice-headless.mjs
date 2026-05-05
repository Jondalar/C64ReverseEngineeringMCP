#!/usr/bin/env node
// V2 1541-silicon — diff VICE baseline vs headless baseline.
// Outputs first divergence point + drive PC class summary per game.

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const SAMPLES_ROOT = resolvePath("samples/traces/v2-baseline");
const games = ["mm-s1", "im2", "lnr-s1", "motm", "polarbear"];

function classify(pc) {
  if (pc >= 0xCC00) return "drive-rom";
  if (pc >= 0x0800) return "open-bus";
  if (pc >= 0x0700) return "ram-0700";
  if (pc >= 0x0400) return "ram-0400";
  if (pc >= 0x0300) return "ram-0300";
  if (pc >= 0x0200) return "ram-0200";
  if (pc >= 0x0100) return "stack";
  return "zp";
}

for (const g of games) {
  const dir = resolvePath(SAMPLES_ROOT, g);
  const viceJson = resolvePath(dir, "trace.jsonl");
  const headlessJson = resolvePath(dir, "headless-trace.jsonl");
  if (!existsSync(viceJson) || !existsSync(headlessJson)) {
    console.log(`[${g}] missing trace`); continue;
  }
  const vice = readFileSync(viceJson, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const headless = readFileSync(headlessJson, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  const viceClasses = new Map();
  const headlessClasses = new Map();
  for (const s of vice) viceClasses.set(classify(s.drvPc), (viceClasses.get(classify(s.drvPc)) ?? 0) + 1);
  for (const s of headless) headlessClasses.set(classify(s.drvPc), (headlessClasses.get(classify(s.drvPc)) ?? 0) + 1);

  console.log(`\n[${g}]`);
  console.log(`  vice   samples=${vice.length}, c64Pc final=$${vice[vice.length-1].c64Pc.toString(16)}, drvPc final=$${vice[vice.length-1].drvPc.toString(16)}`);
  console.log(`  hl     samples=${headless.length}, c64Pc final=$${headless[headless.length-1].c64Pc.toString(16)}, drvPc final=$${headless[headless.length-1].drvPc.toString(16)}`);
  console.log(`  vice drive-PC classes:`);
  for (const [k, v] of [...viceClasses.entries()].sort((a,b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v} samples (${(v/vice.length*100).toFixed(1)}%)`);
  }
  console.log(`  headless drive-PC classes:`);
  for (const [k, v] of [...headlessClasses.entries()].sort((a,b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v} samples (${(v/headless.length*100).toFixed(1)}%)`);
  }
  // Find first sample where drive-PC class diverges (use class, not exact PC, since timing
  // shifts make per-cycle PC compare unreliable across emulators).
  const minLen = Math.min(vice.length, headless.length);
  let firstDiv = -1;
  for (let i = 0; i < minLen; i++) {
    if (classify(vice[i].drvPc) !== classify(headless[i].drvPc)) {
      firstDiv = i; break;
    }
  }
  if (firstDiv >= 0) {
    console.log(`  first class divergence at sample ${firstDiv} (ts ~${vice[firstDiv].ts}):`);
    console.log(`    vice  drvPc=$${vice[firstDiv].drvPc.toString(16)} (${classify(vice[firstDiv].drvPc)})`);
    console.log(`    hl    drvPc=$${headless[firstDiv].drvPc.toString(16)} (${classify(headless[firstDiv].drvPc)})`);
  } else {
    console.log(`  no class divergence in ${minLen} aligned samples`);
  }
}
