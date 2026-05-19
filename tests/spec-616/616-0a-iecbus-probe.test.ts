// Spec 616 Task 616.0a (iecbus probe) — sample full bus state during
// Scramble stall to see if drive-side DATA-release actually propagates
// to c64 $DD00 view.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);
const { iecbus } = await import(
  "../../dist/runtime/headless/vice1541/iecbus.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(
  session,
  8,
  resolvePath(import.meta.dirname, "..", "..", "samples/scramble_infinity.d64"),
);
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

const drv = (session.kernel.drive1541 as { unit: any }).unit;
function drvRead(addr: number): number {
  const fn = drv.cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
  return fn ? fn(drv, addr) & 0xff : 0;
}
function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

console.log(
  "cyc       | c64-PC | drv-PC | $1800 | drv-1801 PA | drv_bus[8] | drv_data[8] | drv_port | cpu_bus | cpu_port",
);
console.log("-".repeat(115));

for (let i = 0; i < 12; i++) {
  session.runFor(250_000);
  const c64 = session.c64Cpu;
  const dpc = drv.cpu.cpu_regs;
  console.log(
    `${session.c64Cpu.cycles.toString().padStart(8)}  |  $${hex(c64.pc, 4)} |  $${hex(dpc.pc, 4)} |  $${hex(drvRead(0x1800))}  |  $${hex(drvRead(0x1801))}      |  $${hex(iecbus.drv_bus[8]!)}       |  $${hex(iecbus.drv_data[8]!)}      |  $${hex(iecbus.drv_port)}     |  $${hex(iecbus.cpu_bus)}   |  $${hex(iecbus.cpu_port)}`,
  );
}
