#!/usr/bin/env node
// Sprint 96 — peek 1541 drive RAM at known IEC-state slots to see if
// the drive entered LISTEN mode after C64 sent ATN+LISTEN $28.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
  traceIec: true, traceIecCapacity: 4096,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

// Run forward sampling drive state at intervals.
const driveRam = session.drive.bus.ram;
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
function snap(label) {
  const drv = session.drive.cpu;
  const r = (a) => driveRam[a];
  // 1541 well-known zeropage:
  //   $7C = ATN-pending flag (set by IRQ when ATN edge seen)
  //   $7D = some serial state
  //   $77 = command byte received
  //   $79 = listener / talker target storage
  //   $A0-$A2 = serial cmd bytes
  console.log(`${label}: drvPC=${W(drv.pc)} cyc=${session.c64Cpu.cycles}`+
              ` $7C=${r(0x7c).toString(16)} $77=${r(0x77).toString(16)} $79=${r(0x79).toString(16)}`+
              ` $7A=${r(0x7a).toString(16)} $7E=${r(0x7e).toString(16)} $F8=${r(0xf8).toString(16)}`+
              ` $A0=${r(0xa0).toString(16)} $A1=${r(0xa1).toString(16)} $A2=${r(0xa2).toString(16)}`);
}

snap("after-typing");
for (let chunk = 0; chunk < 30; chunk++) {
  session.runFor(50_000);
  snap(`chunk[${chunk}]`);
}

// Dump IEC trace to see what was sent.
console.log("\nIEC trace (all):");
const t = session.getIecTrace();
for (const e of t) {
  console.log(`  cyc=${e.cycle} side=${e.side} ATN=${e.atn} CLK=${e.clk} DATA=${e.data}  c64=${e.c64Atn}/${e.c64Clk}/${e.c64Data} drv=${e.drvClk}/${e.drvData}/ack${e.drvAtnAck}`);
  if (t.indexOf(e) > 50) break;
}
