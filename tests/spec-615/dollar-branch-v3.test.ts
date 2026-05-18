// Spec 615.13 v3 — trap EVERY instruction PC in OPEN-to-CMDERR window.
// Identify EXACT instruction where drive jumps to CMDERR.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);
const { drive_6510core_install_trace_hook } = await import(
  "../../dist/runtime/headless/vice1541/drive_6510core.js"
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
  resolvePath(import.meta.dirname, "..", "..", "samples/POLARBEAR.d64"),
);
session.resetCold("pal-default");

const vice = session.kernel.drive1541!;
const drv = (vice as { unit: unknown }).unit as {
  cpu: { cpu_regs: { pc: number; a: number; x: number; y: number; sp: number; p: number } };
  cpud: any;
};
function drvR(a: number): number {
  const fn = drv.cpud?.read_func_ptr?.[(a >> 8) & 0xff];
  return fn ? fn(drv, a) & 0xff : 0;
}
function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

// Capture every drive instruction in ranges $D7B4-$D825 (OPEN+op021+op04+op041)
// AND $DA55-$DA90 (LOADIR) AND $C1C8-$C200 (CMDERR) AND $C2B3-$C310 (CMDSET).
const inRange = (pc: number): boolean =>
  (pc >= 0xd7b4 && pc <= 0xd825) ||
  (pc >= 0xda55 && pc <= 0xda90) ||
  (pc >= 0xc1c8 && pc <= 0xc200) ||
  (pc >= 0xc2b3 && pc <= 0xc310);

type Hit = { pc: number; clk: number; a: number; x: number; y: number };
const hits: Hit[] = [];
let armed = false;
let active = false; // strict capture window after OPEN entry

drive_6510core_install_trace_hook((pc: number, clk: number) => {
  if (!armed) return;
  if (pc === 0xd7b4) active = true;
  if (!active) return;
  if (!inRange(pc)) return;
  if (hits.length >= 200) return;
  const r = drv.cpu.cpu_regs;
  hits.push({ pc, clk: clk >>> 0, a: r.a & 0xff, x: r.x & 0xff, y: r.y & 0xff });
  if (pc === 0xc1c8 || pc === 0xda55 || pc === 0xe60a) {
    // Stop capturing once we hit terminal (CMDERR, LOADIR, ERROR).
    if (hits.length > 1) active = false;
  }
});

session.runFor(2_000_000);
armed = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
armed = false;

console.log(`Captured ${hits.length} instruction PCs (OPEN→terminal window):`);
console.log("idx | drv_clk    | pc      | A  X  Y");
for (let i = 0; i < hits.length; i++) {
  const h = hits[i]!;
  console.log(`${String(i).padStart(3)} | ${String(h.clk).padStart(10)} | $${hex(h.pc, 4)}   | $${hex(h.a)} $${hex(h.x)} $${hex(h.y)}`);
}
