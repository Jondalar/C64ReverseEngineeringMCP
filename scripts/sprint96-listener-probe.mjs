#!/usr/bin/env node
// Sprint 96 part 8 — track $79 (listener-active) transitions + drive
// PC visits to key ATN-dispatch addresses during LOAD"*",8,1.
// Also watch JOB LOOP / READ HEADER addresses:
//   $F510  read header entry
//   $F556  search header (sync wait)
//   $F575  decode header
//   $F423  IRQ enter (job-loop poll)
// Critical addresses (from 1541 ROM 901229-05 disasm):
//   $E853  ATN handler entry
//   $E87C  receive byte (ACPTR)
//   $E87F  CMP #$3F (UNLISTEN)
//   $E8A1  CMP $77 (LISTEN target)
//   $E8A7  STA $79=1 (listener activated)
//   $E8B0  AND #$60 (SECOND channel prefix)
//   $E8B2  CMP #$60 (SECOND match)
//   $E8E3  LDA $79 (listener check)
//   $E8E7  JSR $EA2E (filename byte receive)
//   $EA2E  filename byte receive entry
//   $EA44  ACPTR for filename byte
//   $EA48  JSR $CFB7 (store byte to channel buffer)

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

const watchPcs = new Set([0xe853, 0xe87c, 0xe87f, 0xe8a1, 0xe8a7,
  0xe8b0, 0xe8b2, 0xe8e3, 0xe8e7, 0xea2e, 0xea44, 0xea48, 0xebe7,
  0xea4e, 0xeae3, 0xea4b,
  0xf510, 0xf556, 0xf575, 0xf423, 0xebff, 0xec40, 0xec42,
  0xf3be, 0xf56a, 0xd5a7]);
const visits = new Map();
const events = [];
let prev79 = -1, prev77 = -1, prev85 = -1;

for (let i = 0; i < 25_000_000; i++) {
  session.runFor(1);
  const dpc = session.drive.cpu.pc;
  if (watchPcs.has(dpc)) {
    visits.set(dpc, (visits.get(dpc) ?? 0) + 1);
    if ((visits.get(dpc) ?? 0) <= 6) {
      events.push({ pc: dpc, c64Cyc: session.c64Cpu.cycles, a: session.drive.cpu.a, ram79: session.drive.bus.ram[0x79], ram77: session.drive.bus.ram[0x77], ram85: session.drive.bus.ram[0x85] });
    }
  }
  const r79 = session.drive.bus.ram[0x79];
  const r77 = session.drive.bus.ram[0x77];
  const r85 = session.drive.bus.ram[0x85];
  if (r79 !== prev79 || r77 !== prev77 || r85 !== prev85) {
    if (events.length < 600) events.push({ tag: "ramΔ", c64Cyc: session.c64Cpu.cycles, drvPc: dpc, ram79: r79, ram77: r77, ram85: r85 });
    prev79 = r79; prev77 = r77; prev85 = r85;
  }
}

console.log("PC visit counts:");
const W4 = (n) => "$"+n.toString(16).toUpperCase().padStart(4,"0");
const W = (n) => "$"+(n & 0xff).toString(16).padStart(2,"0");
const labels = {
  0xe853: "ATN entry", 0xe87c: "ACPTR call", 0xe87f: "CMP #$3F UNLISTEN",
  0xe8a1: "CMP $77 LISTEN", 0xe8a7: "STA $79=1 listener-active",
  0xe8b0: "AND #$60 SECOND", 0xe8b2: "CMP #$60", 0xe8e3: "LDA $79 check",
  0xe8e7: "JSR $EA2E filename rx", 0xea2e: "EA2E entry",
  0xea44: "ACPTR filename byte", 0xea48: "JSR $CFB7 store",
  0xea4e: "EA4E exit path", 0xebe7: "back to idle",
};
for (const pc of [...watchPcs].sort()) {
  const c = visits.get(pc) ?? 0;
  console.log(`  ${W4(pc)} ${labels[pc] ?? ""}: ${c}`);
}
console.log("\nFirst 60 events (in order):");
for (const e of events.slice(0, 60)) {
  if (e.tag === "ramΔ") {
    console.log(`  cyc=${e.c64Cyc} drvPC=${W4(e.drvPc)} RAM Δ → $77=${W(e.ram77)} $79=${W(e.ram79)} $85=${W(e.ram85)}`);
  } else {
    console.log(`  cyc=${e.c64Cyc} drvPC=${W4(e.pc)} A=${W(e.a)} (${labels[e.pc]??""}) $77=${W(e.ram77)} $79=${W(e.ram79)} $85=${W(e.ram85)}`);
  }
}
