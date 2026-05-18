#!/usr/bin/env node
// Verify: drive truly stuck at $E9E5? clk_ptr advancing? ROM bytes around $E9E5?

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
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 8 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const vice = session.kernel.drive1541;
const drv = vice.unit;
const cpud = drv.cpud;
function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }

function drvRead(addr) {
  try {
    const fn = cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
    if (!fn) return -1;
    return fn(drv, addr) & 0xff;
  } catch (e) {
    return -2;
  }
}

console.log(`drive PC = $${hex(drv.cpu.cpu_regs.pc, 4)}`);
console.log(`drive clk_ptr = ${drv.clk_ptr.value}`);
console.log(`c64.cycles = ${session.c64Cpu.cycles}`);
console.log("");
console.log(`Drive ROM bytes around $E9E5 (proper read_func_ptr path):`);
for (let a = 0xe9e0; a <= 0xea00; a++) {
  process.stdout.write(`$${hex(a,4)}=${hex(drvRead(a))} `);
  if (((a + 1) & 7) === 0) process.stdout.write("\n");
}
console.log("");

// Advance c64 a bit + check drive PC + clk movement.
console.log("Drive PC + clk_ptr over 20 c64 instructions:");
const startClk = drv.clk_ptr.value;
let lastPc = drv.cpu.cpu_regs.pc;
for (let i = 0; i < 20; i++) {
  session.runFor(1, { cycleBudget: 200 });
  const pc = drv.cpu.cpu_regs.pc;
  const clk = drv.clk_ptr.value;
  const moved = pc !== lastPc ? "*" : " ";
  console.log(`  ${i}: drv_PC=$${hex(pc,4)}${moved}  drv_clk=${clk}  (delta=${clk - startClk})  c64_clk=${session.c64Cpu.cycles}`);
  lastPc = pc;
}
