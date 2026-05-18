// Spec 615.13 — source-authoritative LOAD"$",8 branch decision.
//
// Per resources/dos1541-source/open.s:
//   open.s:7   open: sta tempsa; jsr cmdset; ldx cmdbuf
//   open.s:35  op021: cpx #'$'; bne op041; lda tempsa; bne op04; jmp loadir
//   open.s:202 op90: lda filtrk; bne op100; lda #flntfd; jmp cmderr  ← FILE NOT FOUND emit
//   open.s:355 loadir: prepare directory load
//   lookup.s:258 srchst: start dir scan at dirtrk=18 sector=1 via opnird
//
// Trap PCs (user-supplied):
//   $C146 PARSXQ, $C194 ENDCMD, $C1C8 CMDERR, $C2B3 CMDSET,
//   $C3CA OPTSCH, $C49D FFST, $C5AC SRCHST, $C617 SEARCH,
//   $C6CE GETNAM, $C7B7 NEWDIR, $D475 OPNIRD, $D9A0 OPREAD,
//   $E60A ERROR.
//
// Capture at each hit:
//   - cmdbuf[$0200..$020F]
//   - sa ($84), orgsa ($85), error_code ($26)
//   - lsnact/tlkact/atnpnd ($79/$7A/$7C)
//   - A,X,Y,SP,P
//   - top-of-stack return addr (= caller).

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
function drvR(addr: number): number {
  const fn = drv.cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
  return fn ? fn(drv, addr) & 0xff : 0;
}
function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

const NAMES: Record<number, string> = {
  0xc146: "PARSXQ",
  0xc194: "ENDCMD",
  0xc1c8: "CMDERR",
  0xc2b3: "CMDSET",
  0xc3ca: "OPTSCH",
  0xc49d: "FFST",
  0xc5ac: "SRCHST",
  0xc617: "SEARCH",
  0xc6ce: "GETNAM",
  0xc7b7: "NEWDIR",
  0xd475: "OPNIRD",
  0xd9a0: "OPREAD",
  0xe60a: "ERROR",
};
const PCS = new Set(Object.keys(NAMES).map((k) => parseInt(k, 10)));

type Snap = {
  name: string;
  c64_clk: number;
  drv_clk: number;
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  p: number;
  ret: number;
  cmdbuf: number[];
  sa: number;
  orgsa: number;
  err_26: number;
  lsnact: number;
  tlkact: number;
  atnpnd: number;
};
const snaps: Snap[] = [];
let armed = false;

drive_6510core_install_trace_hook((pc: number, clk: number) => {
  if (!armed || !PCS.has(pc) || snaps.length >= 60) return;
  const r = drv.cpu.cpu_regs;
  const sp = r.sp & 0xff;
  const retLo = drvR(0x0100 + ((sp + 1) & 0xff));
  const retHi = drvR(0x0100 + ((sp + 2) & 0xff));
  const ret = ((retHi << 8) | retLo) - 1;
  const cmdbuf: number[] = [];
  for (let i = 0; i < 16; i++) cmdbuf.push(drvR(0x0200 + i));
  snaps.push({
    name: NAMES[pc]!,
    c64_clk: session.c64Cpu.cycles >>> 0,
    drv_clk: clk >>> 0,
    pc,
    a: r.a & 0xff,
    x: r.x & 0xff,
    y: r.y & 0xff,
    sp,
    p: r.p & 0xff,
    ret,
    cmdbuf,
    sa: drvR(0x0084),
    orgsa: drvR(0x0085),
    err_26: drvR(0x0026),
    lsnact: drvR(0x0079),
    tlkact: drvR(0x007a),
    atnpnd: drvR(0x007c),
  });
});

// Boot — no capture.
session.runFor(2_000_000);

// LOAD$ — capture.
armed = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
armed = false;

console.log(`Captured ${snaps.length} ROM trap hits.\n`);
console.log("seq | name    | drv_clk    | A  X  Y  SP P  | ret    | sa/orgsa | err_26 | cmdbuf[0..7] (ascii)");
for (let i = 0; i < snaps.length; i++) {
  const s = snaps[i]!;
  const ascii = s.cmdbuf.slice(0, 8).map((b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
  ).join("");
  console.log(
    `${String(i).padStart(3)} | ${s.name.padEnd(7)} | ${String(s.drv_clk).padStart(10)} | $${hex(s.a)} $${hex(s.x)} $${hex(s.y)} $${hex(s.sp)} $${hex(s.p)} | $${hex(s.ret, 4)} | $${hex(s.sa)}/$${hex(s.orgsa)}    | $${hex(s.err_26)}     | ${s.cmdbuf.slice(0, 8).map((b) => hex(b)).join(" ")}  "${ascii}"`,
  );
}

// Final cmdbuf snapshot (post-LOAD$).
console.log(`\nPost-LOAD$ cmdbuf[$0200..$0210]:`);
let line = "  ";
for (let i = 0; i < 16; i++) line += hex(drvR(0x0200 + i)) + " ";
console.log(line);
let ascii = "  ASCII: ";
for (let i = 0; i < 16; i++) {
  const b = drvR(0x0200 + i);
  ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}
console.log(ascii);
console.log(`  sa=$${hex(drvR(0x0084))}  orgsa=$${hex(drvR(0x0085))}  err($26)=$${hex(drvR(0x0026))}`);
console.log(`  lsnact($79)=$${hex(drvR(0x0079))}  tlkact($7A)=$${hex(drvR(0x007a))}  atnpnd($7C)=$${hex(drvR(0x007c))}`);
