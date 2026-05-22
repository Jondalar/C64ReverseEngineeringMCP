// Spec 615 step 1 — trace drive ROM TALK frame on motm.g64.
// Find where dir-emit hangs.

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
  resolvePath(import.meta.dirname, "..", "..", "samples/motm.g64"),
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

const NAMES: Record<number, string> = {
  0xc146: "PARSXQ",
  0xc1c8: "CMDERR",
  0xc2b3: "CMDSET",
  0xc3ca: "OPTSCH",
  0xc49d: "FFST",
  0xc5ac: "SRCHST",
  0xc617: "SEARCH",
  0xc6ce: "GETNAM",
  0xc7b7: "NEWDIR",
  0xcff1: "PUTBYT",
  0xd0eb: "FNDRCH",
  0xd1e2: "GETRCH",
  0xd475: "OPNIRD",
  0xd7b4: "OPEN",
  0xd7f3: "OP021",
  0xd940: "OP90",
  0xd9a0: "OPREAD",
  0xda55: "LOADIR",
  0xe60a: "ERROR",
  0xec9e: "STDIR",
  0xecea: "DIR1",
  0xed0d: "DIR10",
  0xed23: "DIR3",
  0xebe7: "IDLE",
  0xea2e: "LISTEN",
  0xe909: "TALK",
  0xe90f: "TALK1",
  0xe916: "TLK05",
  0xe925: "TALK2",
  0xe937: "TLK02",
  0xe941: "TLK03",
  0xe94b: "NOEOI",
  0xe999: "FRMERX",
  0xef5f: "FRETS",
};
const PCS = new Set(Object.keys(NAMES).map((k) => parseInt(k, 10)));

type Snap = {
  name: string;
  drv_clk: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  ret: number;
  cmd0: number;
  sa: number;
  orgsa: number;
  lsnact: number;
  tlkact: number;
  chnrdy_x: number;  // chnrdy[lindx]
  dirlst: number;
};
const hits: Snap[] = [];
let armed = false;
let stopAfterTalk = 0;

drive_6510core_install_trace_hook((pc: number, clk: number) => {
  if (!armed || !PCS.has(pc)) return;
  if (hits.length >= 80) { armed = false; return; }
  const r = drv.cpu.cpu_regs;
  const sp = r.sp & 0xff;
  const retLo = drvR(0x0100 + ((sp + 1) & 0xff));
  const retHi = drvR(0x0100 + ((sp + 2) & 0xff));
  const lindx = drvR(0x82);
  hits.push({
    name: NAMES[pc]!,
    drv_clk: clk >>> 0,
    a: r.a & 0xff,
    x: r.x & 0xff,
    y: r.y & 0xff,
    sp,
    ret: ((retHi << 8) | retLo) - 1,
    cmd0: drvR(0x0200),
    sa: drvR(0x83),
    orgsa: drvR(0x84),
    lsnact: drvR(0x79),
    tlkact: drvR(0x7a),
    chnrdy_x: drvR(0xf2 + lindx),
    dirlst: drvR(0x0254),  // dirlst per ramvar layout (= cmdwat-1 area; approx)
  });
  // After TALK2 hit a few times → stop.
  if (pc === 0xe925) stopAfterTalk++;
  if (stopAfterTalk > 10) armed = false;
});

session.runFor(2_000_000);
armed = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 60 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
armed = false;

console.log(`Final c64 PC = $${session.c64Cpu.pc.toString(16)}  cycles=${session.c64Cpu.cycles}`);

// Screen
function decodeScreen(ram: Uint8Array): string {
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
const ram = (session.c64Bus as { ram: Uint8Array }).ram;
const screen = decodeScreen(ram);
console.log("Screen last 5 rows:");
for (let row = 5; row < 15; row++) console.log(`  | ${screen.slice(row*40, row*40+40)}`);

console.log(`Captured ${hits.length} hits on motm.g64 LOAD\$ trace:\n`);
console.log("seq | name    | drv_clk    | A  X  Y  SP  | ret    | cmd0 sa/orgsa lsn/tlk chnrdy");
for (let i = 0; i < hits.length; i++) {
  const h = hits[i]!;
  console.log(
    `${String(i).padStart(3)} | ${h.name.padEnd(7)} | ${String(h.drv_clk).padStart(10)} | $${hex(h.a)} $${hex(h.x)} $${hex(h.y)} $${hex(h.sp)}   | $${hex(h.ret, 4)} | $${hex(h.cmd0)}  $${hex(h.sa)}/$${hex(h.orgsa)}  $${hex(h.lsnact)}/$${hex(h.tlkact)}  $${hex(h.chnrdy_x)}`,
  );
}
