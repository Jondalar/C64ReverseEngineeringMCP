#!/usr/bin/env node
// Sprint 98 / Spec 096 — probe why C64 lands at LOAD entry $F4CB
// repeatedly instead of staying in ACPTR retry. Logs SP + stack
// return-address chain on every $F4CB hit, plus the moment the
// preceding RTS / JSR / JMP fired.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq < 0) args[a.slice(2)] = true;
  else args[a.slice(2, eq)] = a.slice(eq + 1);
}

const disk = args.disk ?? "samples/synthetic/1byte.g64";
const file = args.file ?? "X";
const outPath = args.out ?? "samples/traces/load-reentry-probe.txt";
const budget = Number(args.budget ?? 2_000_000);
const bootInstructions = Number(args["boot-instructions"] ?? 800_000);
const maxHits = Number(args["max-hits"] ?? 5);

if (!existsSync(disk)) {
  console.error(`disk not found: ${disk}`);
  process.exit(2);
}

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

const { session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(bootInstructions);
session.typeText(`LOAD"${file}",8,1\r`, 80_000, 80_000);

const lines = [];
const log = (s) => { lines.push(s); };

const c64 = session.c64Cpu;
const ram = session.c64Bus;

const F4CB = 0xf4cb;
const F501 = 0xf501; // ACPTR call site
const EE13 = 0xee13; // ACPTR entry
const EDFE = 0xedfe; // UNTLK entry
const F540 = 0xf540; // somewhere in LOAD post-EOI / cleanup

let lastPc = 0;
let hits = 0;
let prevPc = 0;
const interestingPcs = new Set([F4CB, F501, EE13, EDFE]);

log(`probe: disk=${disk} file=${file} budget=${budget}`);
log(`boot done, LOAD typed at c64Cyc=${c64.cycles}, sp=$${c64.sp.toString(16)}`);

for (let i = 0; i < budget; i++) {
  prevPc = c64.pc;
  session.runFor(1);
  const pc = c64.pc;

  if (pc === F4CB && lastPc !== F4CB) {
    hits++;
    const sp = c64.sp;
    // Read 4 bytes BELOW current sp+1 — these are just-popped (sp, sp-1)
    // and pre-pop slot (sp-2, sp-3). The bytes at addresses (sp-1, sp)
    // are what RTS just popped to set PC.
    const justPopped = [];
    for (let off = -3; off <= 0; off++) {
      const addr = 0x0100 + ((sp + off) & 0xff);
      justPopped.push(ram.ram[addr] ?? 0);
    }
    const poppedLo = justPopped[2]; // sp-1
    const poppedHi = justPopped[3]; // sp+0
    const poppedTarget = ((poppedLo | (poppedHi << 8)) + 1) & 0xffff;
    // Stack state above current SP (still on stack).
    const stackBytes = [];
    for (let s = 1; s <= 16; s++) {
      const addr = 0x0100 + ((sp + s) & 0xff);
      stackBytes.push(ram.ram[addr] ?? 0);
    }
    const retAddrs = [];
    for (let s = 0; s < stackBytes.length - 1; s += 2) {
      const ret = stackBytes[s] | (stackBytes[s + 1] << 8);
      retAddrs.push(ret);
    }
    log(`---`);
    log(`HIT ${hits} c64Pc=$F4CB c64Cyc=${c64.cycles} sp=$${sp.toString(16).padStart(2, "0")} prevPc=$${prevPc.toString(16).padStart(4, "0").toUpperCase()}`);
    log(`just-popped [sp-3..sp]: ${justPopped.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
    log(`popped-target (sp-1,sp → +1): $${poppedTarget.toString(16).padStart(4, "0").toUpperCase()}`);
    log(`stack [sp+1..+16]: ${stackBytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
    log(`return-addr candidates (PC-1 → +1): ${retAddrs.map((a) => "$" + ((a + 1) & 0xffff).toString(16).padStart(4, "0").toUpperCase()).join(", ")}`);
    log(`status: \$90=$${(ram.ram[0x90] ?? 0).toString(16).padStart(2, "0")} \$A5=${ram.ram[0xa5] ?? 0} \$BA=$${(ram.ram[0xba] ?? 0).toString(16).padStart(2, "0")} \$B9=$${(ram.ram[0xb9] ?? 0).toString(16).padStart(2, "0")}`);
    if (hits >= maxHits) break;
  }
  lastPc = pc;
}

log(`---`);
log(`total $F4CB hits: ${hits} after ${budget} c64-instr budget`);

// Continue past LOAD-entry hit to capture drive's stuck-state RAM.
// Sample drive zeropage when drive is parked in $C2FE / $D6BB / $D7BB
// (filename-parse / directory-lookup loop).
const drv = session.drive;
const drvBus = drv.bus;
let drvSampleCount = 0;
for (let i = 0; i < 1_000_000 && drvSampleCount < 6; i++) {
  session.runFor(1);
  const drvPc = drv.cpu.pc;
  if (drvPc >= 0xD6B0 && drvPc <= 0xD6C0) {
    drvSampleCount++;
    if (drvSampleCount % 1 === 0) {
      const zp = [];
      for (let a = 0; a < 0x100; a++) zp.push(drvBus.ram[a] ?? 0);
      const hex = (b) => b.toString(16).padStart(2, "0");
      log(`---`);
      log(`DRV-SAMPLE ${drvSampleCount} c64Cyc=${c64.cycles} drvCyc=${drv.cpu.cycles} drvPc=$${drvPc.toString(16).padStart(4,"0").toUpperCase()}`);
      log(`drvZP $00-$1F: ${zp.slice(0x00, 0x20).map(hex).join(" ")}`);
      log(`drvZP $20-$3F: ${zp.slice(0x20, 0x40).map(hex).join(" ")}`);
      log(`drvZP $40-$5F: ${zp.slice(0x40, 0x60).map(hex).join(" ")}`);
      log(`drvZP $60-$7F: ${zp.slice(0x60, 0x80).map(hex).join(" ")}`);
      log(`drvZP $80-$9F: ${zp.slice(0x80, 0xA0).map(hex).join(" ")}`);
    }
    // Skip ahead some cycles before next sample to spread out.
    for (let s = 0; s < 2000 && i < budget; s++) { session.runFor(1); i++; }
  }
}

if (!existsSync("samples/traces")) mkdirSync("samples/traces", { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`wrote ${outPath} (${lines.length} lines, hits=${hits})`);
process.exit(0);
