#!/usr/bin/env node
// Sprint 98 verification — check if synthetic LOAD now completes
// after stepper-fix (head-position.ts forward sequence).

import { existsSync } from "node:fs";

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq < 0) args[a.slice(2)] = true;
  else args[a.slice(2, eq)] = a.slice(eq + 1);
}

const disk = args.disk ?? "samples/synthetic/1byte.g64";
const file = args.file ?? "X";
const budget = Number(args.budget ?? 30_000_000);
const bootInstructions = Number(args["boot-instructions"] ?? 800_000);

if (!existsSync(disk)) { console.error(`disk not found: ${disk}`); process.exit(2); }

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
  mode: "true-drive",
});
session.resetCold();
session.runFor(bootInstructions);
session.typeText(`LOAD"${file}",8,1\r`, 80_000, 80_000);

const c64 = session.c64Cpu;
const ram = session.c64Bus;
let lastPc = 0;
let basicReadyHit = false;
let loadCompletePc = -1;
let firstByteAt0801 = -1;

const startCyc = c64.cycles;
let pc;
for (let i = 0; i < budget; i++) {
  session.runFor(1);
  pc = c64.pc;
  // BASIC's READY prompt printer is around $A474 / $A488. Watch for return to those.
  if (pc >= 0xA470 && pc <= 0xA490 && lastPc !== pc) {
    if (!basicReadyHit) {
      basicReadyHit = true;
      console.log(`BASIC-ready-area at c64Cyc=${c64.cycles - startCyc} c64Pc=$${pc.toString(16).padStart(4,"0").toUpperCase()}`);
      console.log(`  $90 status=$${(ram.ram[0x90] ?? 0).toString(16)}`);
      console.log(`  RAM $0801=$${(ram.ram[0x0801] ?? 0).toString(16).padStart(2,"0")} (expect $42 for synthetic)`);
      console.log(`  RAM $0800-$0805: ${[0x0800,0x0801,0x0802,0x0803,0x0804,0x0805].map((a)=>(ram.ram[a]??0).toString(16).padStart(2,"0")).join(" ")}`);
    }
  }
  // Watch for $0801 getting written (the load destination after $0800/$0801).
  if (firstByteAt0801 === -1 && (ram.ram[0x0801] ?? 0) !== 0) {
    firstByteAt0801 = c64.cycles - startCyc;
    console.log(`first non-zero $0801 at c64Cyc=${firstByteAt0801} value=$${(ram.ram[0x0801] ?? 0).toString(16)}`);
  }
  lastPc = pc;
}

console.log(`---`);
console.log(`final c64Pc=$${pc.toString(16).padStart(4,"0").toUpperCase()} c64Cyc=${c64.cycles - startCyc}`);
console.log(`$90=$${(ram.ram[0x90] ?? 0).toString(16)} $0800=$${(ram.ram[0x0800]??0).toString(16)} $0801=$${(ram.ram[0x0801]??0).toString(16)} $0802=$${(ram.ram[0x0802]??0).toString(16)}`);
console.log(`drive head track: ${session.drive.headPosition.currentTrack}`);
console.log(`drive sp: $${session.drive.cpu.sp.toString(16)}`);
console.log(`basicReadyHit=${basicReadyHit}`);
console.log(`firstByteAt0801=${firstByteAt0801}`);

const success = (ram.ram[0x0801] ?? 0) === 0x42;
console.log(success ? "✓ SYNTHETIC LOAD SUCCESS" : "✗ load incomplete");
process.exit(success ? 0 : 1);
