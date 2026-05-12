#!/usr/bin/env node
// Bug 39 — instrument the LOAD"*",8,1 path. Capture every $DD00 write,
// every drive PC sample, and the IEC line state at the moment KERNAL
// gives up with ?DEVICE NOT PRESENT.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
  traceIec: true, traceIecCapacity: 1024,
  traceDrive: true, traceDriveCapacity: 1024,
});
session.resetCold();
session.runFor(800_000);
console.log(`Warm. PC=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);

session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
console.log(`LOAD typed. cyc=${session.c64Cpu.cycles}`);

// Run in chunks until either cycle budget exhausted or PC stays inside
// KERNAL ATN-LISTEN code for a while.
const RD = (a) => session.c64Bus.read(a);
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
const t0 = Date.now();

// Watch for KERNAL serial routines. Key PCs:
//   $ED0C = LISTEN entry
//   $ED40 = SECOND
//   $EDB9 = TKSA
//   $EE13 = ACPTR (read serial byte)
//   $EE85 = ATN handler
//   $F4A5 = LOAD secondary
//   $F495 = SEARCH
let atnObserved = 0;
const dd00Writes = [];
let lastDd00Pa = 0xff, lastDd00Ddr = 0;
const cia2 = session.cia2;

// Snapshot helpers.
function dump(label) {
  const iec = session.iecBus.snapshot();
  console.log(`${label}: PC=${W(session.c64Cpu.pc)} cyc=${session.c64Cpu.cycles}  drvPC=${W(session.drive.cpu.pc)} drvCyc=${session.drive.cpu.cycles}  IEC ATN=${iec.line.atn?1:0} CLK=${iec.line.clk?1:0} DATA=${iec.line.data?1:0}  c64=${iec.c64.atnReleased?1:0}/${iec.c64.clkReleased?1:0}/${iec.c64.dataReleased?1:0}  drv=${iec.drive.clkReleased?1:0}/${iec.drive.dataReleased?1:0}/ack${iec.drive.atnAckReleased?1:0}`);
}

dump("post-typing");

// Run 30M cycles in steps; snapshot whenever PC crosses interesting threshold.
const SNAPSHOT_PCS = new Set([0xed0c, 0xed40, 0xedb9, 0xee13, 0xee85, 0xeed3, 0xf495, 0xf4a5, 0xf5af]);
let lastSnapPc = -1;
const PC_LOG_LIMIT = 30;
let pcLogCount = 0;
for (let chunk = 0; chunk < 150; chunk++) {
  session.runFor(200_000);
  const pc = session.c64Cpu.pc;
  if (SNAPSHOT_PCS.has(pc) && pc !== lastSnapPc && pcLogCount < PC_LOG_LIMIT) {
    dump(`hit ${W(pc)}`);
    lastSnapPc = pc;
    pcLogCount++;
  }
  // Bail if KERNAL printed DEVICE NOT PRESENT (text appears at row 9).
  // PETSCII '?' = $3F at $0400 + 9*40 = $04E8
  if (RD(0x04e8) === 0x3f) {
    console.log(`!! ?DEVICE NOT PRESENT printed at chunk ${chunk}`);
    break;
  }
}

console.log("");
console.log(`Final state after ${Date.now() - t0}ms:`);
dump("END");

console.log("");
console.log(`IEC trace last 30 edges:`);
const trace = session.getIecTrace().slice(-30);
for (const e of trace) {
  console.log(`  cyc=${e.cycle} side=${e.side} ATN=${e.atn} CLK=${e.clk} DATA=${e.data} | c64Atn=${e.c64Atn} c64Clk=${e.c64Clk} c64Data=${e.c64Data} drvClk=${e.drvClk} drvData=${e.drvData} drvACK=${e.drvAtnAck}`);
}

console.log("");
console.log(`Drive PC trace last 30 (after dedupe):`);
const dpc = session.getDrivePcTrace().slice(-30);
for (const e of dpc) console.log(`  cyc=${e.cycle} drv=${W(e.pc)}`);
