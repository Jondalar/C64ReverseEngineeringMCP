// Spec 616 Task 616.0a — reproduce Scramble stage-1 stall.
// Per §5A recipe. Step-debug ONLY — no trace.
//
// Action: mount Scramble.d64, type LOAD"*",8,1, run until stall settles,
// dump c64 PC + regs + $dd00 + drive PC + drive regs + $1800-$1803 +
// disasm both sides at stall PC.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const DISK = "samples/scramble_infinity.d64";
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "..", DISK));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

// Per §5A.2 — run 3M cycles to land at stall.
session.runFor(3_000_000);

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

const c64 = session.c64Cpu;
const ram = (session.c64Bus as { ram: Uint8Array }).ram;
console.log(`=== c64 ===`);
console.log(`  PC=$${hex(c64.pc, 4)}  A=$${hex(c64.a)}  X=$${hex(c64.x)}  Y=$${hex(c64.y)}  SP=$${hex(c64.sp)}  P=$${hex(c64.flags)}`);
console.log(`  $DD00 (CIA2 PA latch in RAM) = $${hex(ram[0xdd00]!)}`);
console.log(`  $0090 ST status = $${hex(ram[0x0090]!)}`);
console.log(`  $00BA dev = $${hex(ram[0x00ba]!)}`);
console.log(`  $00B7 fnlen = $${hex(ram[0x00b7]!)}`);

// disasm $e5c0..$e5e0
const e5c0 = Array.from({ length: 32 }, (_, i) => ram[0xe5c0 + i]!);
console.log(`  RAM dump $e5c0..$e5df:`);
console.log(`    ${e5c0.slice(0, 16).map((b) => hex(b)).join(" ")}`);
console.log(`    ${e5c0.slice(16, 32).map((b) => hex(b)).join(" ")}`);

// Wait — $e5c0 is KERNAL ROM. Reading RAM[$e5c0] returns whatever RAM was
// last written there, NOT the KERNAL ROM bytes (RAM is shadowed by ROM
// when $01.3 = 1). Need to read via the bus' bank-routing. Use ROM blob.
const kernal = (session as unknown as { _kernalRom?: Uint8Array })._kernalRom;
let kernalBlob: Uint8Array | null = null;
if (kernal instanceof Uint8Array) kernalBlob = kernal;
else {
  // Resolve via filesystem.
  const fs = await import("node:fs");
  const path = resolvePath(import.meta.dirname, "..", "..", "resources/roms/kernal-901227-03.bin");
  if (fs.existsSync(path)) kernalBlob = new Uint8Array(fs.readFileSync(path));
}
if (kernalBlob) {
  // KERNAL ROM maps $E000-$FFFF → offset 0..0x1FFF.
  const off = 0xe5c0 - 0xe000;
  const slice = kernalBlob.slice(off, off + 32);
  console.log(`  KERNAL ROM $e5c0..$e5df:`);
  console.log(`    ${Array.from(slice.slice(0, 16)).map((b) => hex(b)).join(" ")}`);
  console.log(`    ${Array.from(slice.slice(16, 32)).map((b) => hex(b)).join(" ")}`);
}

// Drive state
const drv = (session.kernel.drive1541 as { unit: { drives: any[]; cpu: any } }).unit;
const d0 = drv.drives[0];
const dcpu = drv.cpu;
console.log(`\n=== drive 8 ===`);
console.log(`  drive PC=$${hex(dcpu.cpu_regs.pc, 4)}  A=$${hex(dcpu.cpu_regs.a)}  X=$${hex(dcpu.cpu_regs.x)}  Y=$${hex(dcpu.cpu_regs.y)}  SP=$${hex(dcpu.cpu_regs.sp)}  P=$${hex(dcpu.cpu_regs.p)}`);
console.log(`  drive clk = ${drv.clk_ptr.value}`);
console.log(`  drive.current_half_track = ${d0.current_half_track}`);
console.log(`  drive.GCR_image_loaded = ${d0.GCR_image_loaded}`);

// Read drive RAM $1800-$1803 (VIA1 PA/PB/DDR/DDR) via drive memory map.
function drvRead(addr: number): number {
  const fn = drv.cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
  return fn ? fn(drv, addr) & 0xff : 0;
}
console.log(`  $1800 PB (DATA/CLK/ATN-in)  = $${hex(drvRead(0x1800))}`);
console.log(`  $1801 PA                    = $${hex(drvRead(0x1801))}`);
console.log(`  $1802 DDRB                  = $${hex(drvRead(0x1802))}`);
console.log(`  $1803 DDRA                  = $${hex(drvRead(0x1803))}`);
console.log(`  $1C00 VIA2 PB (head/motor)  = $${hex(drvRead(0x1c00))}`);
console.log(`  $1C0D VIA2 IFR              = $${hex(drvRead(0x1c0d))}`);
console.log(`  $180D VIA1 IFR              = $${hex(drvRead(0x180d))}`);
console.log(`  ZP $00 / $01                = $${hex(drvRead(0x00))} $${hex(drvRead(0x01))}`);
console.log(`  ZP $77 (cmd-stat)           = $${hex(drvRead(0x77))}`);
console.log(`  ZP $7C                      = $${hex(drvRead(0x7c))}`);

// Screen
function decodeScreen(): string {
  let s = "";
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
console.log(`\n=== screen (last 6 non-blank rows) ===`);
const lines: string[] = [];
for (let r = 0; r < 25; r++) {
  const ln = scr.slice(r * 40, r * 40 + 40).trimEnd();
  if (ln.length > 0) lines.push(ln);
}
for (const ln of lines.slice(-6)) console.log(`  | ${ln}`);
