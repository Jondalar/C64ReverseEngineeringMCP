// Spec 615.13 — targeted drive ROM trap-PC spies.
// Captures snapshots when drive PC hits known 1541 DOS ROM entry points.

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
  drives: { [k: number]: any | null };
  cpu: { cpu_regs: { pc: number; a: number; x: number; y: number; sp: number; p: number } };
  cpud: any;
  clk_ptr: { value: number };
};

function drvR(addr: number): number {
  const page = (addr >> 8) & 0xff;
  const fn = drv.cpud?.read_func_ptr?.[page];
  return fn ? fn(drv, addr) & 0xff : 0;
}

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

// 1541 DOS ROM PC targets (per spec):
//   $E60A — ERROR (error code entry; A = error code)
//   $C44F — LOOKUP
//   $C4B5 — FNDFIL (find file in directory)
//   $C617 — SEARCH
//   $C6CE — GETNAM (parse filename)
//   $D475 — OPNIRD (open internal read)
//   $D9A0 — OPREAD (open for read)
const trapPCs = new Set([0xe60a, 0xc44f, 0xc4b5, 0xc617, 0xc6ce, 0xd475, 0xd9a0]);
const trapName: Record<number, string> = {
  0xe60a: "ERROR",
  0xc44f: "LOOKUP",
  0xc4b5: "FNDFIL",
  0xc617: "SEARCH",
  0xc6ce: "GETNAM",
  0xd475: "OPNIRD",
  0xd9a0: "OPREAD",
};

type Hit = {
  name: string;
  c64_clk: number;
  drv_clk: number;
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  p: number;
  // Top-of-stack (= return address PC-1 for RTS expectation).
  stack_top: { lo: number; hi: number };
  // Drive RAM error fields (1541 DOS):
  //   $26 = ERROR code zero-page
  //   $25 = status
  //   $80-$87 = command buffer
  //   $A3-$A9 = filename pointer/length
  err_26: number;
  err_25: number;
  status_a3: number;
  // Filename buffer at $0200-$020F (command channel buffer).
  cmdbuf: number[];
  // Secondary address / channel (zero page typical $83)
  zp_83: number;
  zp_84: number;
  zp_85: number;
};
const hits: Hit[] = [];
let enabled = false;
let totalCalls = 0;
const pcHistogram = new Map<number, number>();

drive_6510core_install_trace_hook(
  (pc: number, clk: number, _op: number, _p1: number, _p2hi: number) => {
    totalCalls++;
    if (enabled) {
      // Track all PCs in C000-FFFF range during capture window.
      if (pc >= 0xc000) pcHistogram.set(pc, (pcHistogram.get(pc) ?? 0) + 1);
    }
    if (!enabled || !trapPCs.has(pc)) return;
    if (hits.length >= 40) return;
    const r = drv.cpu.cpu_regs;
    const sp = r.sp & 0xff;
    const stackLo = drvR(0x0100 + ((sp + 1) & 0xff));
    const stackHi = drvR(0x0100 + ((sp + 2) & 0xff));
    const cmdbuf: number[] = [];
    for (let i = 0; i < 16; i++) cmdbuf.push(drvR(0x0200 + i));
    hits.push({
      name: trapName[pc] ?? "?",
      c64_clk: session.c64Cpu.cycles >>> 0,
      drv_clk: clk >>> 0,
      pc, a: r.a & 0xff, x: r.x & 0xff, y: r.y & 0xff, sp, p: r.p & 0xff,
      stack_top: { lo: stackLo, hi: stackHi },
      err_26: drvR(0x0026),
      err_25: drvR(0x0025),
      status_a3: drvR(0x00a3),
      cmdbuf,
      zp_83: drvR(0x0083),
      zp_84: drvR(0x0084),
      zp_85: drvR(0x0085),
    });
  },
);

// Boot — no capture (avoid noise)
session.runFor(2_000_000);

// LOAD$ — enable capture.
enabled = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
enabled = false;

console.log(`Total trace_hook calls: ${totalCalls}`);
console.log(`Unique drive PCs visited during LOAD$: ${pcHistogram.size}`);
console.log(`Top 15 drive PCs:`);
const top = [...pcHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [pc, n] of top) console.log(`  $${hex(pc, 4)} : ${n}`);
console.log(`\nCaptured ${hits.length} hits.\n`);
for (const h of hits) {
  const ret_pc = (h.stack_top.hi << 8) | h.stack_top.lo;
  const cmd_ascii = h.cmdbuf.map((b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
  ).join("");
  console.log(
    `[${h.name.padEnd(7)}] c64_clk=${String(h.c64_clk).padStart(10)} drv_clk=${String(h.drv_clk).padStart(10)} pc=$${hex(h.pc, 4)}`,
  );
  console.log(
    `   A=$${hex(h.a)} X=$${hex(h.x)} Y=$${hex(h.y)} SP=$${hex(h.sp)} P=$${hex(h.p)}  stack_top→$${hex(ret_pc, 4)}`,
  );
  console.log(
    `   $26(err)=$${hex(h.err_26)}  $25=$${hex(h.err_25)}  $A3=$${hex(h.status_a3)}  $83=$${hex(h.zp_83)} $84=$${hex(h.zp_84)} $85=$${hex(h.zp_85)}`,
  );
  console.log(
    `   $0200 cmdbuf: ${h.cmdbuf.map((b) => hex(b)).join(" ")}  ["${cmd_ascii}"]`,
  );
}
