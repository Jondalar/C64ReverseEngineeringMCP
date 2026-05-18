// Spec 615.13 v2 — full label-driven LOAD"$",8 path trace.
//
// Uses dos.lbl-derived addresses:
//   ROM: open=$D7B4, op021=$D7F3, op04=$D7FF, op041=$D815, op90=$D940,
//        op95=$D945, loadir=$DA55, opread=$D9A0, opnird=$D475,
//        parsxq=$C146, cmdset=$C2B3, cmderr=$C1C8, endcmd=$C194,
//        optsch=$C3CA, ffst=$C49D, srchst=$C5AC, search=$C617,
//        getnam=$C6CE, newdir=$C7B7, error=$E60A, stdir=$EC9E,
//        idle=$EBE7, listen=$EA2E, talk=$E909.
//   ZP:  sa=$83, orgsa=$84, atnpnd=$7C, lsnact=$79, tlkact=$7A,
//        track=$80, sector=$81, drvnum=$7F.
//   RAM: cmdbuf=$0200, tempsa=$024C, cmdsiz=$0274, filtbl=$027A,
//        filtrk=$0280.

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
  0xd7b4: "OPEN",
  0xd7f3: "OP021",
  0xd7ff: "OP04",
  0xd815: "OP041",
  0xd940: "OP90",
  0xd945: "OP95",
  0xd9a0: "OPREAD",
  0xda55: "LOADIR",
  0xe60a: "ERROR",
  0xec9e: "STDIR",
  0xebe7: "IDLE",
  0xea2e: "LISTEN",
  0xe909: "TALK",
};
const PCS = new Set(Object.keys(NAMES).map((k) => parseInt(k, 10)));

type Snap = {
  name: string;
  drv_clk: number;
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  ret: number;
  cmdbuf0: number;
  cmdsiz: number;
  sa: number;
  orgsa: number;
  tempsa: number;
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
  snaps.push({
    name: NAMES[pc]!,
    drv_clk: clk >>> 0,
    pc,
    a: r.a & 0xff,
    x: r.x & 0xff,
    y: r.y & 0xff,
    sp,
    ret: ((retHi << 8) | retLo) - 1,
    cmdbuf0: drvR(0x0200),
    cmdsiz: drvR(0x0274),
    sa: drvR(0x0083),
    orgsa: drvR(0x0084),
    tempsa: drvR(0x024c),
    lsnact: drvR(0x0079),
    tlkact: drvR(0x007a),
    atnpnd: drvR(0x007c),
  });
});

session.runFor(2_000_000);
armed = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
armed = false;

console.log(`Captured ${snaps.length} hits.\n`);
console.log("seq | name    | drv_clk    | A  X  Y  SP  | ret    | cmdbuf[0] cmdsiz | sa/orgsa tempsa | lsn/tlk/atnp");
for (let i = 0; i < snaps.length; i++) {
  const s = snaps[i]!;
  console.log(
    `${String(i).padStart(3)} | ${s.name.padEnd(7)} | ${String(s.drv_clk).padStart(10)} | $${hex(s.a)} $${hex(s.x)} $${hex(s.y)} $${hex(s.sp)}   | $${hex(s.ret, 4)} | $${hex(s.cmdbuf0)}        $${hex(s.cmdsiz)}    | $${hex(s.sa)}/$${hex(s.orgsa)}   $${hex(s.tempsa)}     | $${hex(s.lsnact)}/$${hex(s.tlkact)}/$${hex(s.atnpnd)}`,
  );
}

console.log(`\nPost-LOAD$ state:`);
console.log(`  cmdbuf=$${hex(drvR(0x0200))}  cmdsiz=$${hex(drvR(0x0274))}  filtbl=$${hex(drvR(0x027a))}  filtrk=$${hex(drvR(0x0280))}`);
console.log(`  sa($83)=$${hex(drvR(0x83))}  orgsa($84)=$${hex(drvR(0x84))}  tempsa=$${hex(drvR(0x024c))}`);
console.log(`  lsnact($79)=$${hex(drvR(0x79))}  tlkact($7A)=$${hex(drvR(0x7a))}  atnpnd($7C)=$${hex(drvR(0x7c))}`);
console.log(`  track($80)=$${hex(drvR(0x80))}  sector($81)=$${hex(drvR(0x81))}  drvnum($7F)=$${hex(drvR(0x7f))}`);
