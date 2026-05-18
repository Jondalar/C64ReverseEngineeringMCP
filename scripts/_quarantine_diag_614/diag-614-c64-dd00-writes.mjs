#!/usr/bin/env node
// Capture c64 $DD00 writes during full LOAD"$",8 session.
// Find LAST write before stall. Decode CLK/DATA/ATN bits.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

// Hook iecBus.setC64Output to capture each c64-write to $DD00 (PA).
const iec = session.iecBus;
const writes = [];
const origSet = iec.setC64Output.bind(iec);
iec.setC64Output = (cia2Pa, ddrMask, effClk, cs) => {
  const c64Pc = session.c64Cpu.pc & 0xffff;
  writes.push({
    clk: effClk,
    c64Pc,
    pa: cia2Pa & 0xff,
    ddr: ddrMask & 0xff,
    // bits 3,4,5 = ATN_OUT, CLK_OUT, DATA_OUT (transistor on = pull)
    atnPull: (cia2Pa & 0x08) !== 0,
    clkPull: (cia2Pa & 0x10) !== 0,
    dataPull: (cia2Pa & 0x20) !== 0,
  });
  return origSet(cia2Pa, ddrMask, effClk, cs);
};

session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 8 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }

console.log(`Total c64 $DD00 writes during LOAD: ${writes.length}`);
console.log(`Final c64 state: PC=$${hex(session.c64Cpu.pc,4)} cycles=${session.c64Cpu.cycles}`);
console.log("");
console.log("Last 30 writes:");
console.log("idx | clk        | c64_pc | pa  | ddr | ATN CLK DATA (1=pulled)");
console.log("----+------------+--------+-----+-----+------------------------");
const last = writes.slice(-30);
for (let i = 0; i < last.length; i++) {
  const w = last[i];
  console.log(
    `${String(writes.length - last.length + i).padStart(3)} | ${String(w.clk).padStart(10)} | $${hex(w.c64Pc, 4)}  | $${hex(w.pa)} | $${hex(w.ddr)} | ${w.atnPull?1:0}    ${w.clkPull?1:0}    ${w.dataPull?1:0}`
  );
}
