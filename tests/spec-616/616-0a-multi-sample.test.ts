// Spec 616 Task 616.0a (multi-sample) — track drive + c64 PC over time
// during Scramble stage-1 stall. Establishes whether drive is stuck in
// $E9A4 / atn100 path or moving through.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
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

console.log("cyc       | c64 PC | A  X  Y  | drv PC | A  X  Y  SP | $1800 PB | $DD00 | drv-IFR | c64-A.7");
console.log("-".repeat(110));

// Sample every 250k cycles for 12 samples (3M cycles range = catches stall).
for (let i = 0; i < 12; i++) {
  session.runFor(250_000);
  const c64 = session.c64Cpu;
  const dpc = drv.cpu.cpu_regs;
  const ram = (session.c64Bus as { ram: Uint8Array }).ram;
  console.log(
    `${session.c64Cpu.cycles.toString().padStart(8)}  |  $${hex(c64.pc, 4)} | $${hex(c64.a)} $${hex(c64.x)} $${hex(c64.y)} | $${hex(dpc.pc, 4)} | $${hex(dpc.a)} $${hex(dpc.x)} $${hex(dpc.y)} $${hex(dpc.sp)} | $${hex(drvRead(0x1800))}       | $${hex(ram[0xdd00]!)}    | $${hex(drvRead(0x180d))}      | $${(c64.a & 0x80) ? "1" : "0"}`,
  );
}

// Final screen + key state
function decodeScreen(): string {
  let s = "";
  const ram = (session.c64Bus as { ram: Uint8Array }).ram;
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0) s += "@";
    else if (c >= 1 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
const scr = decodeScreen();
const lines: string[] = [];
for (let r = 0; r < 25; r++) {
  const ln = scr.slice(r * 40, r * 40 + 40).trimEnd();
  if (ln.length > 0) lines.push(ln);
}
console.log(`\nScreen (last 4 non-blank):`);
for (const ln of lines.slice(-4)) console.log(`  | ${ln}`);
