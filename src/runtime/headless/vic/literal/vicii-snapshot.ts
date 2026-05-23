// Spec 705.A step 3 — RFL port of viciisc/vicii-snapshot.c
// (vicii_snapshot_write_module / vicii_snapshot_read_module).
//
// Source: /Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-snapshot.c
//         (SNAP_MAJOR 1 / SNAP_MINOR 4)
//
// The ACTIVE VIC continuation authority in this runtime is the literal-port
// global `LIT_TYPES.vicii` (vicii_t) + the file-static draw-cycle pipeline, NOT
// `VicIIVice` (which is a secondary alarm/bridge/diff model; its raster_y stays
// 0 in literal-port mode). VicIIVice.regs IS LIT_TYPES.vicii.regs (shared).
//
// This captures the SAME field set, in the SAME order, as vicii-snapshot.c,
// into a structured object embedded in the native C64RE RuntimeCheckpoint —
// VICE-shaped in content, not a VSF byte stream.
//
// SEAM (documented, Spec 705 §4): VICE also calls raster_snapshot_write/read on
// `vicii.raster` and raster_force_repaint. The TS literal port has NO `raster_t`
// (vicii-types.ts:95 — deferred); the visible/continuation raster state is
// carried by the IntegratedSession presentation fields
// (literalPortFb / literalPortFbStable / litLastRasterLine / lastLitBaLow),
// captured separately in the container. So raster_snapshot is intentionally
// NOT ported here.

import { vicii, VICII_SCREEN_TEXTCOLS, VICII_DRAW_BUFFER_SIZE, VICII_NUM_SPRITES } from "./vicii-types.js";
import {
  vicii_get_draw_cycle_state,
  vicii_set_draw_cycle_state,
  type DrawCycleSnapshot,
} from "./vicii-draw-cycle.js";
import { vicii_irq_set_line } from "./vicii-irq.js";

export interface LiteralVicSpriteSnapshot {
  data: number; mc: number; mcbase: number; pointer: number; exp_flop: number; x: number;
}

export interface LiteralVicLightPenSnapshot {
  state: number; triggered: number; x: number; y: number; x_extra_bits: number; trigger_cycle: number;
}

/** Structured mirror of viciisc/vicii-snapshot.c, same field order. */
export interface LiteralVicSnapshot {
  model: number;
  regs: number[];            // [0x40]
  raster_cycle: number;
  cycle_flags: number;
  raster_line: number;
  start_of_frame: number;
  irq_status: number;
  raster_irq_line: number;
  raster_irq_triggered: number;
  vbuf: number[];            // [40]
  cbuf: number[];            // [40]
  gbuf: number;
  dbuf_offset: number;
  dbuf: number[];            // [520]
  ysmooth: number;
  allow_bad_lines: number;
  sprite_sprite_collisions: number;
  sprite_background_collisions: number;
  clear_collisions: number;
  idle_state: number;
  vcbase: number;
  vc: number;
  rc: number;
  vmli: number;
  bad_line: number;
  light_pen: LiteralVicLightPenSnapshot;
  reg11_delay: number;
  prefetch_cycles: number;
  sprite_display_bits: number;
  sprite_dma: number;
  last_color_reg: number;
  last_color_value: number;
  last_read_phi1: number;
  last_bus_phi2: number;
  vborder: number;
  set_vborder: number;
  main_border: number;
  refresh_counter: number;
  color_ram: number[];       // [0x400]
  sprite: LiteralVicSpriteSnapshot[]; // [8]
  drawCycle: DrawCycleSnapshot;
}

// The literal port is PAL-only (project doctrine: PAL first). VICE writes
// vicii_resources.model as a sanity byte and ignores a mismatch on read
// (FIXME in vicii-snapshot.c:236). Mirror that: a fixed marker, not enforced.
const VICII_MODEL_MARKER = 0;

// PORT OF: vicii-snapshot.c:111-207 (vicii_snapshot_write_module).
// `colorRam` is the live C64 color RAM ($D800-$DBFF, 0x400 bytes) supplied by
// the kernel (it is NOT part of the 64K RAM image).
export function vicii_snapshot_write(colorRam: Uint8Array): LiteralVicSnapshot {
  const v = vicii;
  const sprite: LiteralVicSpriteSnapshot[] = [];
  for (let i = 0; i < VICII_NUM_SPRITES; i++) {
    const s = v.sprite[i]!;
    sprite.push({ data: s.data, mc: s.mc, mcbase: s.mcbase, pointer: s.pointer, exp_flop: s.exp_flop, x: s.x });
  }
  return {
    model: VICII_MODEL_MARKER,
    regs: Array.from(v.regs.subarray(0, 0x40)),
    raster_cycle: v.raster_cycle,
    cycle_flags: v.cycle_flags,
    raster_line: v.raster_line,
    start_of_frame: v.start_of_frame,
    irq_status: v.irq_status,
    raster_irq_line: v.raster_irq_line,
    raster_irq_triggered: v.raster_irq_triggered,
    vbuf: Array.from(v.vbuf.subarray(0, VICII_SCREEN_TEXTCOLS)),
    cbuf: Array.from(v.cbuf.subarray(0, VICII_SCREEN_TEXTCOLS)),
    gbuf: v.gbuf,
    dbuf_offset: v.dbuf_offset,
    dbuf: Array.from(v.dbuf.subarray(0, VICII_DRAW_BUFFER_SIZE)),
    ysmooth: v.ysmooth,
    allow_bad_lines: v.allow_bad_lines,
    sprite_sprite_collisions: v.sprite_sprite_collisions,
    sprite_background_collisions: v.sprite_background_collisions,
    clear_collisions: v.clear_collisions,
    idle_state: v.idle_state,
    vcbase: v.vcbase,
    vc: v.vc,
    rc: v.rc,
    vmli: v.vmli,
    bad_line: v.bad_line,
    light_pen: {
      state: v.light_pen.state, triggered: v.light_pen.triggered,
      x: v.light_pen.x, y: v.light_pen.y, x_extra_bits: v.light_pen.x_extra_bits,
      trigger_cycle: v.light_pen.trigger_cycle,
    },
    reg11_delay: v.reg11_delay,
    prefetch_cycles: v.prefetch_cycles,
    sprite_display_bits: v.sprite_display_bits,
    sprite_dma: v.sprite_dma,
    last_color_reg: v.last_color_reg,
    last_color_value: v.last_color_value,
    last_read_phi1: v.last_read_phi1,
    last_bus_phi2: v.last_bus_phi2,
    vborder: v.vborder,
    set_vborder: v.set_vborder,
    main_border: v.main_border,
    refresh_counter: v.refresh_counter,
    color_ram: Array.from(colorRam.subarray(0, 0x400)),
    sprite,
    drawCycle: vicii_get_draw_cycle_state(),
  };
}

// PORT OF: vicii-snapshot.c:209-340 (vicii_snapshot_read_module).
// Restores LIT_TYPES.vicii + draw-cycle + color RAM, then runs the VICE-shaped
// post-processing (raster_line clamp + IRQ re-assert). `colorRamOut` is the
// live color-RAM view to write back into.
export function vicii_snapshot_read(snap: LiteralVicSnapshot, colorRamOut: Uint8Array): void {
  const v = vicii;
  // model (snap.model) — sanity only; VICE ignores a mismatch (FIXME). No-op.
  v.regs.set(snap.regs.slice(0, 0x40));
  v.raster_cycle = snap.raster_cycle;
  v.cycle_flags = snap.cycle_flags;
  v.raster_line = snap.raster_line;
  v.start_of_frame = snap.start_of_frame;
  v.irq_status = snap.irq_status;
  v.raster_irq_line = snap.raster_irq_line;
  v.raster_irq_triggered = snap.raster_irq_triggered;
  v.vbuf.set(snap.vbuf.slice(0, VICII_SCREEN_TEXTCOLS));
  v.cbuf.set(snap.cbuf.slice(0, VICII_SCREEN_TEXTCOLS));
  v.gbuf = snap.gbuf;
  v.dbuf_offset = snap.dbuf_offset;
  v.dbuf.set(snap.dbuf.slice(0, VICII_DRAW_BUFFER_SIZE));
  v.ysmooth = snap.ysmooth;
  v.allow_bad_lines = snap.allow_bad_lines;
  v.sprite_sprite_collisions = snap.sprite_sprite_collisions;
  v.sprite_background_collisions = snap.sprite_background_collisions;
  v.clear_collisions = snap.clear_collisions;
  v.idle_state = snap.idle_state;
  v.vcbase = snap.vcbase;
  v.vc = snap.vc;
  v.rc = snap.rc;
  v.vmli = snap.vmli;
  v.bad_line = snap.bad_line;
  v.light_pen.state = snap.light_pen.state;
  v.light_pen.triggered = snap.light_pen.triggered;
  v.light_pen.x = snap.light_pen.x;
  v.light_pen.y = snap.light_pen.y;
  v.light_pen.x_extra_bits = snap.light_pen.x_extra_bits;
  v.light_pen.trigger_cycle = snap.light_pen.trigger_cycle;
  v.reg11_delay = snap.reg11_delay;
  v.prefetch_cycles = snap.prefetch_cycles;
  v.sprite_display_bits = snap.sprite_display_bits;
  v.sprite_dma = snap.sprite_dma;
  v.last_color_reg = snap.last_color_reg;
  v.last_color_value = snap.last_color_value;
  v.last_read_phi1 = snap.last_read_phi1;
  v.last_bus_phi2 = snap.last_bus_phi2;
  v.vborder = snap.vborder;
  v.set_vborder = snap.set_vborder;
  v.main_border = snap.main_border;
  v.refresh_counter = snap.refresh_counter;
  for (let i = 0; i < VICII_NUM_SPRITES; i++) {
    const s = snap.sprite[i]!;
    const d = v.sprite[i]!;
    d.data = s.data; d.mc = s.mc; d.mcbase = s.mcbase; d.pointer = s.pointer; d.exp_flop = s.exp_flop; d.x = s.x;
  }
  vicii_set_draw_cycle_state(snap.drawCycle);

  colorRamOut.set(snap.color_ram.slice(0, 0x400));

  // Post-processing (vicii-snapshot.c:316-332):
  //   - raster.current_line clamp: the TS port has no raster_t; raster_line is
  //     restored directly above and the visible line is owned by the session
  //     presentation seam. No raster_t to clamp here.
  //   - re-assert the VIC IRQ line from the restored irq_status (VICE:
  //     interrupt_restore_irq when irq_status & 0x80). vicii_irq_set_line()
  //     re-evaluates (irq_status & enable) and drives the CPU IRQ host.
  //   - raster_force_repaint: TS re-renders from the presentation FB; no-op.
  vicii_irq_set_line();
}
