#!/usr/bin/env node
// Inspect drive VIA1 T1 timer state at stall.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { startIntegratedSession: _ } = { startIntegratedSession };
const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 6 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const vice = session.kernel.drive1541;
const drv = vice.unit;
const via1 = drv.via1d1541;

function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }

console.log(`drv.clk_ptr.value = ${drv.clk_ptr.value}`);
console.log(`drive PC = $${hex(drv.cpu.cpu_regs.pc, 4)}`);
console.log("");
console.log("=== VIA1 T1 timer state ===");
console.log(`via1.via[T1CL=$04]    = $${hex(via1.via[0x04] ?? 0)}`);
console.log(`via1.via[T1CH=$05]    = $${hex(via1.via[0x05] ?? 0)}`);
console.log(`via1.via[T1LL=$06]    = $${hex(via1.via[0x06] ?? 0)}`);
console.log(`via1.via[T1LH=$07]    = $${hex(via1.via[0x07] ?? 0)}`);
console.log(`via1.via[ACR=$0B]     = $${hex(via1.via[0x0b] ?? 0)} (T1 mode in bits 6-7)`);
console.log(`via1.ifr              = $${hex(via1.ifr ?? 0)} (bit 6 = T1)`);
console.log(`via1.ier              = $${hex(via1.ier ?? 0)} (bit 6 = T1 IRQ enable)`);
console.log("");
console.log(`via1.t1zero  = ${via1.t1zero}  (clk+${via1.t1zero - drv.clk_ptr.value})`);
console.log(`via1.t1reload= ${via1.t1reload} (clk+${via1.t1reload - drv.clk_ptr.value})`);
console.log(`via1.t1_pb7  = ${via1.t1_pb7}`);
console.log("");
console.log(`Counter T1C live = $${hex((via1.t1zero - drv.clk_ptr.value) & 0xffff, 4)}`);

// Step drive a bit + see if T1 underflow fires.
console.log("\n=== Advance 100K c64 cycles + check T1 IFR ===");
let lastIfr = via1.ifr & 0xff;
let lastT1c = (via1.t1zero - drv.clk_ptr.value) & 0xffff;
for (let i = 0; i < 10; i++) {
  session.runFor(10_000);
  const ifr = via1.ifr & 0xff;
  const t1c = (via1.t1zero - drv.clk_ptr.value) & 0xffff;
  console.log(`  i=${i}: drv_clk=${drv.clk_ptr.value} IFR=$${hex(ifr)} t1zero=${via1.t1zero} t1c=$${hex(t1c,4)} ifr_t1_changed=${(ifr & 0x40) !== (lastIfr & 0x40)}`);
  lastIfr = ifr;
  lastT1c = t1c;
}
