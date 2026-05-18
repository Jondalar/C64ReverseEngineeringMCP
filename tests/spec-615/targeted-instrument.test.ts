// Spec 615.12 targeted instrument — drive_move_head call context +
// first directory-read GCR/rotation state. No volltrace.

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
  resolvePath(import.meta.dirname, "..", "..", "samples/POLARBEAR.d64"),
);
session.resetCold("pal-default");

const vice = session.kernel.drive1541!;
const drv = (vice as { unit: unknown }).unit as {
  drives: { [k: number]: any | null };
  via2: any;
  clk_ptr: { value: number };
  cpu: { cpu_regs: { pc: number } };
};
const d0 = drv.drives[0]!;
const via2 = drv.via2;

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

// ---------- (1) drive_move_head spy via HT setter ----------
type MoveEvent = {
  c64_clk: number;
  drv_clk: number;
  drv_pc: number;
  step: number;
  ht_before: number;
  ht_after: number;
  via2_prb_latch: number;
  via2_ddrb: number;
  via2_oldpb: number;
  // Effective byte = (latch & ddrb) | (some_input_bits & ~ddrb) — drive ROM wrote latch; observed byte is what drive ROM intended.
};
const moves: MoveEvent[] = [];

let _ht = d0.current_half_track;
Object.defineProperty(d0, "current_half_track", {
  configurable: true,
  enumerable: true,
  get() { return _ht; },
  set(v: number) {
    if (v !== _ht) {
      moves.push({
        c64_clk: session.c64Cpu.cycles >>> 0,
        drv_clk: drv.clk_ptr.value >>> 0,
        drv_pc: drv.cpu.cpu_regs.pc & 0xffff,
        step: v - _ht,
        ht_before: _ht,
        ht_after: v,
        via2_prb_latch: via2.via[0] & 0xff,
        via2_ddrb: via2.via[2] & 0xff,
        via2_oldpb: via2.oldpb & 0xff,
      });
    }
    _ht = v;
  },
});

// ---------- (2) via2 read_prb / read_pra spy during directory read window ----------
type ReadEvent = {
  kind: "read_prb" | "read_pra";
  c64_clk: number;
  drv_clk: number;
  drv_pc: number;
  ret: number;
  ht: number;
  gcr_slot: number;
  gcr_size: number;
  gcr_ptr_null: boolean;
  gcr_head_offset: number;
  gcr_read: number;
  byte_ready_level: number;
  byte_ready_edge: number;
};
const reads: ReadEvent[] = [];
let captureReads = false;
const origReadPrb = via2.read_prb;
const origReadPra = via2.read_pra;
via2.read_prb = (ctx: any) => {
  const ret = origReadPrb(ctx) & 0xff;
  if (captureReads && reads.length < 50) {
    reads.push({
      kind: "read_prb",
      c64_clk: session.c64Cpu.cycles >>> 0,
      drv_clk: drv.clk_ptr.value >>> 0,
      drv_pc: drv.cpu.cpu_regs.pc & 0xffff,
      ret,
      ht: d0.current_half_track,
      gcr_slot: d0.current_half_track - 2,
      gcr_size: d0.GCR_current_track_size,
      gcr_ptr_null: d0.GCR_track_start_ptr === null,
      gcr_head_offset: d0.GCR_head_offset,
      gcr_read: d0.GCR_read,
      byte_ready_level: d0.byte_ready_level,
      byte_ready_edge: d0.byte_ready_edge,
    });
  }
  return ret;
};
via2.read_pra = (ctx: any) => {
  const ret = origReadPra(ctx) & 0xff;
  if (captureReads && reads.length < 50) {
    reads.push({
      kind: "read_pra",
      c64_clk: session.c64Cpu.cycles >>> 0,
      drv_clk: drv.clk_ptr.value >>> 0,
      drv_pc: drv.cpu.cpu_regs.pc & 0xffff,
      ret,
      ht: d0.current_half_track,
      gcr_slot: d0.current_half_track - 2,
      gcr_size: d0.GCR_current_track_size,
      gcr_ptr_null: d0.GCR_track_start_ptr === null,
      gcr_head_offset: d0.GCR_head_offset,
      gcr_read: d0.GCR_read,
      byte_ready_level: d0.byte_ready_level,
      byte_ready_edge: d0.byte_ready_edge,
    });
  }
  return ret;
};

// ---------- Boot ----------
session.runFor(2_000_000);
console.log(`Post-boot HT = ${d0.current_half_track}`);
console.log(`Boot moves: ${moves.length}`);
for (const m of moves) {
  console.log(
    `  drv_pc=$${hex(m.drv_pc, 4)} drv_clk=${m.drv_clk}  HT ${m.ht_before}→${m.ht_after} (${m.step >= 0 ? "+" : ""}${m.step})  via2: PRB_latch=$${hex(m.via2_prb_latch)} DDRB=$${hex(m.via2_ddrb)} oldpb=$${hex(m.via2_oldpb)}`,
  );
}

// ---------- LOAD$ window — capture reads ----------
const moveCountBefore = moves.length;
captureReads = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
captureReads = false;

console.log("");
console.log(`Post-LOAD$ HT = ${d0.current_half_track}`);
console.log(`Moves during LOAD$: ${moves.length - moveCountBefore}`);
for (let i = moveCountBefore; i < moves.length; i++) {
  const m = moves[i]!;
  console.log(
    `  drv_pc=$${hex(m.drv_pc, 4)} drv_clk=${m.drv_clk}  HT ${m.ht_before}→${m.ht_after} (${m.step >= 0 ? "+" : ""}${m.step})  via2: PRB_latch=$${hex(m.via2_prb_latch)} DDRB=$${hex(m.via2_ddrb)} oldpb=$${hex(m.via2_oldpb)}`,
  );
}

console.log("");
console.log(`First ${Math.min(reads.length, 30)} via2 reads during LOAD$:`);
console.log("kind     | drv_pc | ret | HT | slot | size | ptr | hd_off | GCR_read | bry_l/e");
for (let i = 0; i < Math.min(reads.length, 30); i++) {
  const r = reads[i]!;
  console.log(
    `${r.kind.padEnd(8)} | $${hex(r.drv_pc, 4)}  | $${hex(r.ret)} | ${r.ht} | ${r.gcr_slot.toString().padStart(2)}   | ${r.gcr_size.toString().padStart(5)} | ${r.gcr_ptr_null ? "NULL" : "set "} | ${r.gcr_head_offset.toString().padStart(6)} | $${hex(r.gcr_read)}      | ${r.byte_ready_level}/${r.byte_ready_edge}`,
  );
}
