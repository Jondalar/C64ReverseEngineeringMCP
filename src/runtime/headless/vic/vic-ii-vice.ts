// Spec 150 — VIC-II 1:1 VICE port (B-level: bus stealing + raster IRQ +
// register R/W + per-scanline snapshot for renderer).
//
// Source (VICE 3.7.1):
//   - src/vicii/vicii.c (~1555 LOC) — init/reset/powerup, vbank,
//     update_memory_ptrs (~776), update_video_mode (~1020).
//   - src/vicii/vicii-mem.c (~2077 LOC) — register R/W:
//     vicii_store (~1290), vicii_read (~1677), d011_store (~330),
//     d012_store (~375), d016_store (~511), d018_store (~604),
//     d019_store (~616), d01a_store (~646), d01112_read (~1583),
//     d019_read (~1599), d01e_read (~1618), d01f_read (~1641).
//   - src/vicii/vicii-irq.c (~273 LOC) — vicii_irq_set_line (~42),
//     vicii_irq_raster_set (~64), vicii_irq_set_raster_line (~112),
//     vicii_irq_check_state (~165), vicii_irq_alarm_handler (~252).
//   - src/vicii/vicii-fetch.c (~606 LOC) — do_matrix_fetch (~135),
//     handle_fetch_matrix (~174), check_sprite_dma (~267).
//   - src/vicii/vicii-badline.c (~204 LOC) — line_becomes_bad (~75),
//     vicii_badline_check_state (~185).
//   - src/vicii/viciitypes.h — struct vicii_s + macros (cycle 11
//     fetch, 2-cycle raster IRQ delay).
//   - src/dma.c — dma_maincpu_steal_cycles (~39) primitive.
//
// What this implements (B-level, Spec 150 scope):
//   - All register R/W $D000-$D03F with mirror across $D000-$D3FF
//     (64-byte stride) — wired by `installVicII`.
//   - Reads with side effects: $D011/$D012 raster_y live, $D019 IRQ
//     status with bit-7 summary, $D01E/$D01F collision read-clears
//     (flag-only), $D01A high-nibble forced 1s, $D016 high-2-bits
//     forced 1s, $D018 bit-0 forced 1, $D02F/$D030..$D03F open-bus
//     0xff, color regs upper-nibble forced 1s.
//   - Writes with side effects: $D011 raster-IRQ comparator + DEN
//     latch + ysmooth, $D012 comparator low byte, $D015 sprite enable
//     (used by sprite_dma cycle counting), $D017 y-expand, $D018
//     memory pointers, $D019 IRQ-flag clear (1-to-clear), $D01A IRQ
//     mask (low 4 bits writable, high nibble masked).
//   - Bus-stealing: badline (40 char-fetch + 3 color-fetch = 43
//     cycles) on lines 0x30..0xf7 when DEN=1 and (raster_y & 7) ==
//     ysmooth; sprite DMA = 2 cycles per active sprite + 3 fixed
//     pointer-fetch when ANY sprite enabled and y-match.
//   - Raster IRQ: alarm fires at line-start clock when line ==
//     raster_irq_line (with line-0 +1 cycle delay matching VICE
//     vicii_irq_set_raster_line). Sets irq_status bit 0 + bit 7 then
//     calls backend.setIrqLine(true).
//   - Per-scanline snapshot: captureScanline() emits snapshot
//     (rasterLine + d011/d016/d018/d020-d026 + sprite pos/colors/
//     enable/flags) at every line entry; renderer (vic-renderer.ts,
//     unchanged in Phase 1) consumes via getScanlineSnapshots().
//
// What this does NOT implement (V3 backlog per Spec 150 §"Out of scope"):
//   - Pixel rendering (kept in vic-renderer.ts).
//   - Actual sprite-sprite / sprite-bg collision detection (geometry
//     / alpha) — collision IRQ source bits and read-clear semantics
//     ARE implemented but the bits are never set internally at
//     B-level.
//   - Lightpen actual position ($D013/$D014 always read 0 at B-level).
//   - Per-revision quirks (6569 vs 8565 vs 6567 vs 8562).
//   - Interlace, hires bitmap pixel detail, overscan tricks.
//
// Hybrid naming: internal struct fields use VICE names verbatim where
// the name comes from struct vicii_s (`regs`, `irq_status`,
// `raster_irq_line`, `raster_irq_clk`, `raster_y`, `bad_line`,
// `allow_bad_lines`, `vbank_phi1`, `vbank_phi2`, `screen_ptr`,
// `chargen_ptr`, `bitmap_ptr`, `cycles_per_line`, `screen_height`,
// `first_dma_line`, `last_dma_line`, `sprite_fetch_msk`,
// `last_read`). Public class API camelCase. uint helpers from
// `../util/uint.ts`.

import {
  alarmContextNextPendingClk,
  alarmNew,
  alarmSet,
  alarmUnset,
  CLOCK_MAX,
  type Alarm,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import { u8, u16, u32, type BYTE, type WORD, type CLOCK } from "../util/uint.js";
import { getBusOwner } from "./bus-owner-table.js";
import {
  fetchMatrix,
  type BadlineFetchResult,
  type BadlineBus,
} from "./badline-fetch.js";

// ---------------------------------------------------------------------------
// Constants — viciitypes.h verbatim.
// ---------------------------------------------------------------------------

/** viciitypes.h #define VICII_FETCH_CYCLE 11 — first badline fetch cycle. */
export const VICII_FETCH_CYCLE = 11;

/** viciitypes.h #define VICII_RASTER_IRQ_DELAY 2 — 6510 IRQ-detect lag. */
export const VICII_RASTER_IRQ_DELAY = 2;

/** viciitypes.h #define VICII_SCREEN_TEXTCOLS 40 — chars per badline. */
export const VICII_SCREEN_TEXTCOLS = 40;

/** viciitypes.h #define VICII_NUM_SPRITES 8. */
export const VICII_NUM_SPRITES = 8;

// PAL timing — Christian Bauer "VIC Article" + vicii-timing.c.
export const VICII_PAL_CYCLES_PER_LINE = 63;
export const VICII_PAL_SCREEN_HEIGHT = 312;
export const VICII_NTSC_CYCLES_PER_LINE = 65;
export const VICII_NTSC_SCREEN_HEIGHT = 263;

/** First / last lines on which a badline can occur — vicii.first_dma_line
 *  / last_dma_line; for PAL these are 0x30 (48) and 0xf7 (247) per
 *  vicii-timing.c. */
export const VICII_FIRST_DMA_LINE = 0x30;
export const VICII_LAST_DMA_LINE = 0xf7;

/** Sprite-DMA fixed pointer-fetch overhead (cycles 58..60 of the line
 *  in PAL). 3 cycles regardless of sprite count — vicii-fetch.c
 *  handle_check_sprite_dma + handle_fetch_sprite group "p-access". */
export const VICII_SPRITE_DMA_FIXED_CYCLES = 3;

/** Per-sprite s-access: 2 cycles. vicii-fetch.c handle_fetch_sprite
 *  num_cycles = sf->num. */
export const VICII_SPRITE_DMA_PER_SPRITE_CYCLES = 2;

/** Total badline cost: 40 char fetch + 3 color RAM fetch — vicii-
 *  fetch.c do_matrix_fetch line 161
 *  `dma_maincpu_steal_cycles(... TEXTCOLS + 3 - sub, sub)`. */
export const VICII_BADLINE_TOTAL_CYCLES = VICII_SCREEN_TEXTCOLS + 3;

// IRQ source bits in $D019 (vicii-irq.c).
export const VICII_IRQ_RASTER = 0x01;
export const VICII_IRQ_SBCOLL = 0x02; // sprite-bg
export const VICII_IRQ_SSCOLL = 0x04; // sprite-sprite
export const VICII_IRQ_LIGHTPEN = 0x08;
export const VICII_IRQ_SUMMARY = 0x80;

// Register addresses ($D000 + offset). VICE switch labels in
// vicii_store / vicii_read.
export const VICII_R_SP_X_LO_BASE = 0x00; // $D000-$D00E even
export const VICII_R_SP_Y_BASE = 0x01; // $D001-$D00F odd
export const VICII_R_SP_X_MSB = 0x10;
export const VICII_R_CTRL1 = 0x11; // $D011
export const VICII_R_RASTER = 0x12; // $D012
export const VICII_R_LP_X = 0x13;
export const VICII_R_LP_Y = 0x14;
export const VICII_R_SP_ENABLE = 0x15;
export const VICII_R_CTRL2 = 0x16; // $D016
export const VICII_R_SP_Y_EXP = 0x17;
export const VICII_R_MEM_PTR = 0x18;
export const VICII_R_IRQ_STATUS = 0x19;
export const VICII_R_IRQ_MASK = 0x1a;
export const VICII_R_SP_PRIO = 0x1b;
export const VICII_R_SP_MC = 0x1c;
export const VICII_R_SP_X_EXP = 0x1d;
export const VICII_R_SP_SP_COLL = 0x1e;
export const VICII_R_SP_BG_COLL = 0x1f;
export const VICII_R_BORDER = 0x20;
export const VICII_R_BG0 = 0x21;
export const VICII_R_BG1 = 0x22;
export const VICII_R_BG2 = 0x23;
export const VICII_R_BG3 = 0x24;
export const VICII_R_SP_MC_COL_1 = 0x25;
export const VICII_R_SP_MC_COL_2 = 0x26;
export const VICII_R_SP_COL_BASE = 0x27; // $D027-$D02E

// ---------------------------------------------------------------------------
// Backend interface — VICE function-pointer table abstracted as TS object.
// Mirrors CIA / VIA pattern. The integrated session installs callbacks
// that drive maincpu cycle pause + IRQ line + memory bus reads.
// ---------------------------------------------------------------------------

export interface VicBackend {
  /**
   * VICE: dma_maincpu_steal_cycles(start_clk, num, sub). Pause maincpu
   * for `count` cycles starting from `clk`. Drive_clk advances normally
   * (lockstep scheduler honors maincpu pause — Spec 150 § refinement 3).
   */
  stealCpuCycles: (count: number, clk: CLOCK) => void;

  /**
   * VICE: maincpu_set_irq(int_num, value). Drive the maincpu IRQ line
   * via the interrupt collector. `asserted` true → raise, false → lower.
   */
  setIrqLine: (asserted: boolean, clk: CLOCK) => void;

  /**
   * VICE: vicii.ram_base_phi1[addr] / phi2 fetch. B-level: data is
   * optional (we count cycles, not bytes). Default returns 0.
   */
  readVbus?: (addr: WORD) => BYTE;

  /**
   * VICE: mem_color_ram_vicii[addr]. B-level: data optional. Default 0.
   */
  readColorRam?: (addr: WORD) => BYTE;
}

// ---------------------------------------------------------------------------
// Spec 262a: per-cycle reg-write log entry. Captures every $D000-$D02E
// write within a scanline, plus CIA2 PA-bank changes (reg=0x80, Spec
// 262b). `cycleInLine` is `raster_cycle` (0..62 PAL / 0..64 NTSC) at
// the time of the write — same as VICE VICII_RASTER_CYCLE(clk).
// ---------------------------------------------------------------------------

/** Special "reg" code for CIA2 PA-bank changes in the per-cycle log. */
export const VICII_LOG_CIA2_PA = 0x80;

export interface RegLogEntry {
  cycleInLine: number;
  reg: number;
  value: number;
}

export interface ScanlineRegLog {
  rasterLine: number;
  writes: RegLogEntry[];
}

// ---------------------------------------------------------------------------
// Per-scanline snapshot — preserved field shape + extras for renderer
// compatibility. Kept compatible-superset of the legacy
// `peripherals/vic-ii.ts` ScanlineSnapshot so vic-renderer.ts can
// consume either source unchanged in Phase 2.
// ---------------------------------------------------------------------------
export interface ScanlineState {
  rasterLine: number;
  d011: BYTE; d016: BYTE; d018: BYTE;
  d020: BYTE; d021: BYTE; d022: BYTE; d023: BYTE; d024: BYTE;
  d025: BYTE; d026: BYTE;
  spritePos: { x: number; y: number; color: number; xMsb: boolean }[];
  spriteEnable: BYTE;
  spritePtrs: number[]; // filled by renderer from VIC bank, B-level: zeros
  spriteFlags: { mc: BYTE; xExpand: BYTE; yExpand: BYTE; priority: BYTE };
}

// ---------------------------------------------------------------------------
// VicIIVice options.
// ---------------------------------------------------------------------------

export interface VicIIViceOptions {
  /** Backend wiring (CPU pause / IRQ line / memory bus). */
  backend: VicBackend;
  /** Maincpu alarm context (Spec 149). */
  alarmContext: AlarmContext;
  /** Function returning the current CPU clock (VICE: maincpu_clk). */
  clkPtr: () => CLOCK;
  /** Optional name for alarm channels / debug. */
  name?: string;
  /** PAL by default. setNtsc() flips at runtime. */
  ntsc?: boolean;
}

// ---------------------------------------------------------------------------
// VicIIVice — B-level alarm-driven core.
// ---------------------------------------------------------------------------

export class VicIIVice {
  // ---- VICE struct fields (verbatim) -----------------------------------
  /** VICE: uint8_t regs[0x50] — register file. We allocate $50 to match
   *  but only $00..$3f are functional at B-level. */
  public readonly regs = new Uint8Array(0x50);

  /** VICE: int irq_status — bits 0..3 + bit 7 summary. */
  public irq_status = 0;

  /** VICE: unsigned int raster_irq_line — compare value 0..312. */
  public raster_irq_line = 0;

  /** VICE: CLOCK raster_irq_clk — alarm fire clock; CLOCK_MAX disables. */
  public raster_irq_clk: CLOCK = CLOCK_MAX;

  /** VICE: int allow_bad_lines — set true once DEN seen on first_dma_line. */
  public allow_bad_lines = 0;

  /** VICE: int bad_line — true while current line is currently bad. */
  public bad_line = 0;

  /** VICE: unsigned int screen_height — 312 PAL / 263 NTSC. */
  public screen_height: number = VICII_PAL_SCREEN_HEIGHT;

  /** VICE: int cycles_per_line. */
  public cycles_per_line: number = VICII_PAL_CYCLES_PER_LINE;

  /** VICE: unsigned int first_dma_line / last_dma_line. */
  public first_dma_line: number = VICII_FIRST_DMA_LINE;
  public last_dma_line: number = VICII_LAST_DMA_LINE;

  /** VICE: int vbank_phi1 / vbank_phi2 — 0/0x4000/0x8000/0xc000. */
  public vbank_phi1 = 0;
  public vbank_phi2 = 0;

  /** VICE: uint8_t last_read — for RMW + $D019 latch. */
  public last_read: BYTE = 0;

  // Pointers within the selected video bank. Mirror VICE struct names;
  // values updated on $D018 / vbank change. B-level uses these for
  // snapshot only; renderer fetches actual data.
  /** VICE: uint8_t *screen_ptr — base of 1KB screen RAM in VIC bank. */
  public screen_ptr = 0;
  /** VICE: uint8_t *chargen_ptr — base of 2KB char ROM in VIC bank. */
  public chargen_ptr = 0;
  /** VICE: uint8_t *bitmap_low_ptr — base of 8KB bitmap. */
  public bitmap_ptr = 0;

  // Live raster position. VICE derives via VICII_RASTER_Y(maincpu_clk)
  // / VICII_RASTER_CYCLE(maincpu_clk). We track explicitly so the
  // per-cycle hook is O(1) and we don't need maincpu_clk here.
  /** VICE: VICII_RASTER_Y(clk) — current scanline. */
  public raster_y = 0;

  /**
   * Spec 205-A c7: kernel-installed callback fired on every raster
   * line transition (after raster_y advances). `clk` is c64 clock.
   */
  public onRasterLine?: (raster_y: number, clk: number) => void;
  /** Spec 205-A c7: fired when raster_y wraps back to 0 (frame end → start). */
  public onFrame?: (clk: number) => void;
  /** VICE: VICII_RASTER_CYCLE(clk) — current cycle within line. */
  public raster_cycle = 0;

  /** VICE: unsigned int sprite_fetch_msk — sprites currently DMA'd. */
  public sprite_fetch_msk = 0;

  // Per-scanline snapshot buffer (consumed by renderer).
  public scanlineSnapshots: ScanlineState[] = [];

  // -----------------------------------------------------------------------
  // Spec 262a: per-cycle reg-write log. `currentLineLog` accumulates
  // writes for the line currently being executed; on raster line wrap
  // it's flushed into `frameLineLogs`. The whole frame buffer is cleared
  // when raster_y wraps back to 0 (= new frame start). The renderer
  // (Spec 262d, future) consumes this; per-line snapshots stay populated
  // as a fallback for the existing per-char-row renderer.
  // -----------------------------------------------------------------------
  public currentLineLog: ScanlineRegLog = { rasterLine: 0, writes: [] };
  public frameLineLogs: ScanlineRegLog[] = [];

  // -----------------------------------------------------------------------
  // Spec 280e: per-line badline DMA result (vbuf + cbuf + bitmapBuf).
  //
  // Set on each bad line (isBadline() true) at raster_y transition.
  // Null on non-bad lines (= renderer uses idle $3fff filler).
  // Cleared to null at frame wrap (raster_y → 0).
  // Per-line accessor getCurrentLineMatrix() consumed by Spec 280c renderer.
  //
  // badlineBus is optional: when wired (e.g. from integrated-session),
  // the real fetch runs; when null the matrix stays null (B-level mode,
  // cycle-count accounting only).
  // -----------------------------------------------------------------------
  public currentLineMatrix: BadlineFetchResult | null = null;
  /** Wire to enable real badline DMA fetches.  Leave null for cycle-only mode. */
  public badlineBus: BadlineBus | null = null;

  // ---- alarms (Spec 149 foundation) -----------------------------------
  /** VICE: vicii.raster_irq_alarm — fires at vicii_irq_set_raster_line
   *  computed clk. Callback = vicii_irq_alarm_handler. */
  public readonly raster_irq_alarm: Alarm;

  // ---- backend + clock provider ---------------------------------------
  public readonly backend: VicBackend;
  public readonly alarmContext: AlarmContext;
  public readonly clkPtr: () => CLOCK;
  public readonly name: string;

  /** Cumulative cycles counted into bus-stealing this line — debug only. */
  private linesStolen = 0;

  /**
   * Spec 280g: when true, `tick()` no longer charges block bus-stealing
   * via backend.stealCpuCycles(). Instead, the per-cycle scheduler is
   * expected to call `getBusStallForCycle(raster_cycle)` BEFORE each
   * CPU step and skip the CPU step if it returns true. The drive +
   * peripherals still tick (= master clock advances). This mirrors
   * VICE's BA-low CPU stalling.
   *
   * Default false (= legacy block accounting via computeLineSteal).
   */
  public usePerCycleBusStealing = false;

  constructor(opts: VicIIViceOptions) {
    this.backend = opts.backend;
    this.alarmContext = opts.alarmContext;
    this.clkPtr = opts.clkPtr;
    this.name = opts.name ?? "VICII";

    if (opts.ntsc) this.setNtsc();

    // VICE: vicii_irq_init (vicii-irq.c line 267) — alloc raster_irq alarm.
    this.raster_irq_alarm = alarmNew(
      this.alarmContext,
      `${this.name}_RasterIrq`,
      (offset, _data) => this.rasterIrqAlarmHandler(offset),
      this,
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle — VICE: vicii_powerup (vicii.c line 603) + vicii_reset
  // (vicii.c line 454).
  // -------------------------------------------------------------------------

  /** VICE: vicii_powerup() — full state to power-on defaults, then
   *  calls vicii_reset(). */
  powerup(): void {
    this.regs.fill(0);
    this.irq_status = 0;
    this.raster_irq_line = 0;
    this.raster_irq_clk = 1; // VICE line 609.
    this.allow_bad_lines = 0;
    this.bad_line = 0;
    this.vbank_phi1 = 0;
    this.vbank_phi2 = 0;
    this.raster_y = 0;
    this.raster_cycle = 0;
    this.sprite_fetch_msk = 0;
    this.last_read = 0;
    this.screen_ptr = 0;
    this.chargen_ptr = 0;
    this.bitmap_ptr = 0;
    this.scanlineSnapshots.length = 0;
    this.linesStolen = 0;
    // Spec 262a: drop log buffers on powerup.
    this.currentLineLog = { rasterLine: 0, writes: [] };
    this.frameLineLogs = [];
    // Spec 280e: reset badline matrix.
    this.currentLineMatrix = null;
    this.reset();
  }

  /** VICE: vicii_reset() — zeroes core sub-state, schedules raster IRQ
   *  alarm at clk=1 (matches line-0 +1-cycle quirk). */
  reset(): void {
    this.regs[VICII_R_CTRL1] = 0; // line 475.
    this.regs[VICII_R_RASTER] = 0; // line 476.
    this.regs[VICII_R_IRQ_MASK] = 0; // line 489.
    this.raster_irq_line = 0; // line 473.
    this.raster_irq_clk = 0; // line 474.
    this.irq_status = 0;
    this.allow_bad_lines = 0;
    this.bad_line = 0;
    this.sprite_fetch_msk = 0;
    this.scanlineSnapshots.length = 0;
    // Spec 262a: per-cycle log resets too.
    this.currentLineLog = { rasterLine: this.raster_y, writes: [] };
    this.frameLineLogs.length = 0;

    // VICE line 480: alarm_set(raster_irq_alarm, 1).
    alarmSet(this.raster_irq_alarm, 1);

    // Initial backend pulse (IRQ line low).
    this.backend.setIrqLine(false, this.clkPtr());
  }

  // -------------------------------------------------------------------------
  // Per-cycle scheduler hook — bus stealing.
  //
  // Called by the lockstep scheduler ONCE for each maincpu cycle that
  // wants to start. If the current cycle is a badline-fetch or sprite-
  // DMA cycle, we invoke `backend.stealCpuCycles(count, clk)` which
  // advances maincpu_clk past the stolen window in one shot — exactly
  // mirroring VICE's `dma_maincpu_steal_cycles`.
  //
  // Equivalent VICE flow: vicii_fetch_alarm_handler ⇒ do_matrix_fetch
  // (vicii-fetch.c 135) ⇒ dma_maincpu_steal_cycles for VICII_SCREEN_
  // TEXTCOLS + 3 cycles, plus handle_fetch_sprite ⇒ steal num_cycles
  // (2 per sprite). At B-level we collapse that into one steal-call
  // per-line at the entry point of each potential stealing region.
  // -------------------------------------------------------------------------

  /**
   * Advance the chip by N CPU cycles, accumulating stolen cycles to
   * report back. Caller (scheduler) honors `stolenCycles` as additional
   * maincpu pause beyond the N normal cycles.
   *
   * VICE pattern: each cycle the chip alarm-context dispatches any
   * pending fetch / draw / IRQ alarm. We follow the same shape, but at
   * B-level we only need raster IRQ alarm (already wired) + per-line
   * bus-stealing accumulation.
   */
  tick(cycles: number): { stolenCycles: number } {
    if (cycles <= 0) return { stolenCycles: 0 };
    let stolen = 0;
    let remaining = cycles;
    while (remaining > 0) {
      const stepThisLine = Math.min(this.cycles_per_line - this.raster_cycle, remaining);
      this.raster_cycle += stepThisLine;
      remaining -= stepThisLine;

      if (this.raster_cycle >= this.cycles_per_line) {
        // Line wrap — advance raster_y, capture snapshot, fire IRQ if
        // matching. Per VICE vicii_irq_alarm_handler: actual raster IRQ
        // is alarm-driven; we keep alarm-driven semantics by also
        // checking immediate match here (so callers that don't pump the
        // alarm context still get IRQ flag set — needed for the
        // existing rendering pipeline + tests).
        this.raster_cycle = 0;
        // Spec 262a: flush completed line's reg-write log. Push even
        // if empty so frameLineLogs is rasterLine-indexed.
        this.frameLineLogs.push(this.currentLineLog);
        this.raster_y = (this.raster_y + 1) % this.screen_height;
        if (this.raster_y === 0) {
          this.scanlineSnapshots.length = 0;
          // Spec 262a: new frame — clear frame-wide log buffer.
          this.frameLineLogs.length = 0;
          // Spec 280e: clear badline matrix at frame wrap.
          this.currentLineMatrix = null;
          // Spec 205-A c7: frame boundary — wrap to line 0.
          this.onFrame?.(this.clkPtr());
        }
        // Spec 262a: start fresh log for the new line. (Done after the
        // raster_y advance so rasterLine matches the now-current line.)
        this.currentLineLog = { rasterLine: this.raster_y, writes: [] };
        // Spec 205-A c7: raster line transition.
        this.onRasterLine?.(this.raster_y, this.clkPtr());
        this.captureScanline();

        // Bus stealing for this line — VICE handle_fetch_matrix +
        // handle_check_sprite_dma + handle_fetch_sprite. At B-level we
        // collapse to one accounting call per line.
        //
        // Spec 280g: also primes `bad_line` + `sprite_fetch_msk` for
        // the new per-cycle bus-owner table. When per-cycle stealing
        // is enabled, we still call computeLineSteal() so those
        // fields are populated for getBusStallForCycle(), but we
        // discard the count (the scheduler will stall the CPU one
        // cycle at a time instead of in a block).
        const lineSteal = this.computeLineSteal();
        if (!this.usePerCycleBusStealing && lineSteal > 0) {
          stolen += lineSteal;
          // Notify backend so maincpu_clk can be advanced explicitly.
          this.backend.stealCpuCycles(lineSteal, this.clkPtr());
        }

        // Spec 280e: badline DMA matrix fetch.  If a bus is wired and
        // this is a bad line, populate currentLineMatrix (vbuf+cbuf).
        // charRowStart = mem_counter = (raster_y - first_dma_line) / 8 * 40
        // (standard linear layout; advanced usage can override via
        // badlineBus = null to skip).
        if (this.bad_line && this.badlineBus !== null) {
          // Sub-row 0 here — caller (renderer) owns sub-row per pixel line.
          // We fetch at sub-row 0 because fetchMatrix only needs vbuf/cbuf;
          // the renderer calls fetchChargen/fetchBitmap per sub-row using
          // the stored vbuf from currentLineMatrix.
          const charRowStart =
            Math.floor((this.raster_y - this.first_dma_line) / 8) * 40;
          const { vbuf, cbuf } = fetchMatrix(
            this.badlineBus,
            this.vbank_phi2,
            this.screen_ptr,
            charRowStart,
          );
          this.currentLineMatrix = {
            vbuf,
            cbuf,
            bitmapBuf: new Uint8Array(40), // renderer fills per sub-row
          };
        } else if (!this.bad_line) {
          this.currentLineMatrix = null;
        }

        // Raster IRQ comparator. VICE handles via alarm at
        // vicii_irq_set_raster_line; we also raise the flag in-line so
        // poll-based callers (current scheduler) see it without
        // requiring alarm dispatch.
        if (this.raster_y === this.raster_irq_line) {
          this.viciiIrqRasterSet();
        }
      }
    }
    return { stolenCycles: stolen };
  }

  /**
   * Compute total cycles VIC will steal on this line (just-entered).
   * Reproduces VICE accounting:
   *   - Badline (when allow_bad_lines && (raster_y & 7) == ysmooth &&
   *     line in [first_dma_line..last_dma_line]): 40 char fetch + 3
   *     color RAM = VICII_BADLINE_TOTAL_CYCLES.
   *   - Sprite DMA: VICII_SPRITE_DMA_FIXED_CYCLES (3 pointer-fetch)
   *     when ANY active sprite, plus
   *     VICII_SPRITE_DMA_PER_SPRITE_CYCLES * popcount(active_msk).
   *     Active = enabled && y-match. (VICE check_sprite_dma 267 +
   *     handle_fetch_sprite num_cycles.)
   *
   * NOTE: B-level approximation — VICE charges char-fetch and sprite-
   * fetch at different cycles within the line; the maincpu sees them
   * sequentially. Total cycles match; intra-line phase does not. Spec
   * 150 §point 16 marks this as acceptable for KERNAL serial timing
   * because KERNAL writes $DD00 outside the badline window.
   *
   * Spec 280g: this block-charge accounting is the LEGACY path. When
   * `usePerCycleBusStealing=true`, `tick()` still calls this to prime
   * `bad_line` + `sprite_fetch_msk` for the per-cycle bus-owner table
   * but discards the returned count. To be removed in 280f once all
   * paths run on the per-cycle accounting.
   *
   * @deprecated since Spec 280g — use getBusStallForCycle() in
   * scheduler integration. Kept callable for legacy paths.
   */
  private computeLineSteal(): number {
    let steal = 0;

    // Badline — VICE vicii-fetch.c do_matrix_fetch line 145..167.
    // Condition: allow_bad_lines && (current_line & 7) == ysmooth &&
    // in [first_dma_line..last_dma_line]. allow_bad_lines becomes true
    // when DEN ($D011 bit 4) is seen high on first_dma_line, per
    // d011_store line 347-353.
    const ctrl1 = this.regs[VICII_R_CTRL1]!;
    const ysmooth = ctrl1 & 7;
    if (ctrl1 & 0x10) {
      // DEN active: maintain allow_bad_lines flag per VICE.
      if (this.raster_y === this.first_dma_line) this.allow_bad_lines = 1;
    } else if (this.raster_y === this.first_dma_line) {
      // DEN low at first_dma_line — VICE clears allow_bad_lines.
      this.allow_bad_lines = 0;
    }
    if (
      this.allow_bad_lines !== 0
      && (this.raster_y & 7) === ysmooth
      && this.raster_y >= this.first_dma_line
      && this.raster_y <= this.last_dma_line
    ) {
      this.bad_line = 1;
      steal += VICII_BADLINE_TOTAL_CYCLES;
    } else {
      this.bad_line = 0;
    }

    // Sprite DMA — VICE check_sprite_dma vicii-fetch.c 267-309. A
    // sprite DMAs when sprite_status->visible_msk bit set AND y ==
    // (current_line & 0xff). At B-level we only need the cycle cost.
    const enable = this.regs[VICII_R_SP_ENABLE]!;
    if (enable !== 0) {
      let active = 0;
      let count = 0;
      const yLine = this.raster_y & 0xff;
      for (let s = 0; s < VICII_NUM_SPRITES; s++) {
        if (!(enable & (1 << s))) continue;
        const spy = this.regs[VICII_R_SP_Y_BASE + s * 2]!;
        if (spy === yLine) {
          active |= 1 << s;
          count++;
        }
      }
      this.sprite_fetch_msk = active;
      if (count > 0) {
        // VICE handle_fetch_sprite: num_cycles per sprite-fetch slot.
        // Pointer-fetch (3 cycles fixed) only happens when at least one
        // sprite is active per check_sprite_dma 274.
        steal += VICII_SPRITE_DMA_FIXED_CYCLES;
        steal += VICII_SPRITE_DMA_PER_SPRITE_CYCLES * count;
      } else {
        this.sprite_fetch_msk = 0;
      }
    } else {
      this.sprite_fetch_msk = 0;
    }

    this.linesStolen = steal;
    return steal;
  }

  /**
   * Spec 280g — per-cycle bus-owner check used by the cycle-lockstep
   * scheduler. Returns true iff VIC owns the bus on `cycleInLine` of
   * the current scanline (= CPU should stall this cycle).
   *
   * Reads cached `bad_line` + `sprite_fetch_msk` populated at line
   * entry by computeLineSteal(). The scheduler MUST call this before
   * each CPU step when `usePerCycleBusStealing` is enabled. If
   * cycleInLine is unspecified, the live `raster_cycle` is used.
   *
   * Note: this is purely a query; the bus-owner table is pure (see
   * bus-owner-table.ts). State priming happens in computeLineSteal()
   * once per line wrap inside `tick()`.
   */
  getBusStallForCycle(cycleInLine?: number): boolean {
    const c = cycleInLine ?? this.raster_cycle;
    return getBusOwner(c, this.bad_line !== 0, this.sprite_fetch_msk) === "vic";
  }

  // -------------------------------------------------------------------------
  // Register R/W — VICE: vicii_store / vicii_read (vicii-mem.c).
  // -------------------------------------------------------------------------

  /**
   * VICE: vicii_read (vicii-mem.c 1677). Reproduced 1:1 for the
   * documented register set; DTV / VIC-IIe / extended-feature paths are
   * out of scope for B-level (Spec 150 §"Out of scope").
   */
  read(addr: WORD): BYTE {
    const a = addr & 0x3f; // VICE line 1681 (non-extended).

    switch (a) {
      // Sprite X LSB / Y position — straight reg read.
      case 0x00: case 0x02: case 0x04: case 0x06:
      case 0x08: case 0x0a: case 0x0c: case 0x0e:
      case 0x01: case 0x03: case 0x05: case 0x07:
      case 0x09: case 0x0b: case 0x0d: case 0x0f:
      case VICII_R_SP_X_MSB:
        return u8(this.regs[a]!);

      case VICII_R_CTRL1:
      case VICII_R_RASTER:
        return this.d01112Read(a);

      case VICII_R_LP_X:
      case VICII_R_LP_Y:
        // B-level: lightpen position not modeled — return 0 (VICE
        // returns vicii.light_pen.x/y which initialise to 0).
        return 0;

      case VICII_R_SP_ENABLE:
        return u8(this.regs[a]!);

      case VICII_R_CTRL2:
        // VICE line 1745: reg | 0xc0 (high 2 bits open).
        return u8(this.regs[a]! | 0xc0);

      case VICII_R_SP_Y_EXP:
        return u8(this.regs[a]!);

      case VICII_R_MEM_PTR:
        // VICE line 1755: reg | 0x01 (bit 0 open).
        return u8(this.regs[a]! | 0x01);

      case VICII_R_IRQ_STATUS:
        return this.d019Read();

      case VICII_R_IRQ_MASK:
        // VICE line 1770: reg | 0xf0 (high nibble open).
        return u8(this.regs[a]! | 0xf0);

      case VICII_R_SP_PRIO:
      case VICII_R_SP_MC:
      case VICII_R_SP_X_EXP:
        return u8(this.regs[a]!);

      case VICII_R_SP_SP_COLL:
        return this.d01eRead();

      case VICII_R_SP_BG_COLL:
        return this.d01fRead();

      case VICII_R_BORDER:
      case VICII_R_BG0:
      case VICII_R_BG1:
      case VICII_R_BG2:
      case VICII_R_BG3:
        // VICE 1796 / 1804: reg | 0xf0 (high nibble open).
        return u8(this.regs[a]! | 0xf0);

      case VICII_R_SP_MC_COL_1:
      case VICII_R_SP_MC_COL_2:
        return u8(this.regs[a]! | 0xf0);

      case 0x27: case 0x28: case 0x29: case 0x2a:
      case 0x2b: case 0x2c: case 0x2d: case 0x2e:
        // VICE 1822: sprite color | 0xf0.
        return u8(this.regs[a]! | 0xf0);

      case 0x2f:
      case 0x30:
        // VICE 1832 / 1842: non-VIC-IIe always returns 0xff.
        return 0xff;

      default:
        // 0x31..0x3f all open (0xff) at B-level.
        return 0xff;
    }
  }

  /**
   * VICE: vicii_store (vicii-mem.c 1290). Reproduced for the documented
   * set; DTV / VIC-IIe writes treated as unmodeled (latch to regs[]).
   */
  write(addr: WORD, value: BYTE): void {
    const a = addr & 0x3f; // VICE line 1295.
    const v = u8(value);

    // Spec 262a: append reg write to per-cycle log. Only registers in
    // the documented $D000-$D02E range carry pixel-relevant state for
    // the V3 pixel-perfect renderer; collisions ($D01E/$D01F) and
    // open registers above $D02E are excluded — they're either RO or
    // don't affect rendering. Lightpen ($D013/$D014) writes are
    // ignored by VICE so we skip them too.
    if (
      a <= VICII_R_SP_COL_BASE + 7
      && a !== VICII_R_LP_X
      && a !== VICII_R_LP_Y
      && a !== VICII_R_SP_SP_COLL
      && a !== VICII_R_SP_BG_COLL
    ) {
      this.currentLineLog.writes.push({
        cycleInLine: this.raster_cycle,
        reg: a,
        value: v,
      });
    }

    switch (a) {
      case 0x00: case 0x02: case 0x04: case 0x06:
      case 0x08: case 0x0a: case 0x0c: case 0x0e:
        // store_sprite_x_position_lsb — latch + (renderer reads).
        this.regs[a] = v;
        // V3.1 fix: sprite-pos changes mid-frame = multiplexer trick.
        this.captureScanline();
        break;

      case 0x01: case 0x03: case 0x05: case 0x07:
      case 0x09: case 0x0b: case 0x0d: case 0x0f:
        // sprite y position
        this.regs[a] = v;
        this.captureScanline();
        break;

      case VICII_R_SP_X_MSB:
        this.regs[a] = v;
        this.captureScanline();
        break;

      case VICII_R_CTRL1:
        this.d011Store(v);
        return;

      case VICII_R_RASTER:
        this.d012Store(v);
        return;

      case VICII_R_LP_X:
      case VICII_R_LP_Y:
        // VICE: no-op (writes ignored — line 1349-1350).
        return;

      case VICII_R_SP_ENABLE:
        this.regs[a] = v;
        // V3.1 fix: capture sprite enable changes for raster effects.
        this.captureScanline();
        break;

      case VICII_R_CTRL2:
        this.regs[a] = v;
        // V3.1 fix: capture d016 (multicolor + X-scroll + CSEL) for
        // raster effects. Required for split-screen modes (motm ingame).
        this.captureScanline();
        break;

      case VICII_R_SP_Y_EXP:
        this.regs[a] = v;
        this.captureScanline();
        break;

      case VICII_R_MEM_PTR:
        this.d018Store(v);
        return;

      case VICII_R_IRQ_STATUS:
        this.d019Store(v);
        return;

      case VICII_R_IRQ_MASK:
        this.d01aStore(v);
        return;

      case VICII_R_SP_PRIO:
      case VICII_R_SP_MC:
      case VICII_R_SP_X_EXP:
        this.regs[a] = v;
        break;

      case VICII_R_SP_SP_COLL:
      case VICII_R_SP_BG_COLL:
        // VICE collision_store: writes do NOT alter the collision
        // latches (read-only at runtime). Mirror that behavior.
        return;

      case VICII_R_BORDER:
      case VICII_R_BG0:
      case VICII_R_BG1:
      case VICII_R_BG2:
      case VICII_R_BG3:
      case VICII_R_SP_MC_COL_1:
      case VICII_R_SP_MC_COL_2:
        this.regs[a] = u8(v & 0x0f); // colors are 4-bit.
        // V3.1 fix: capture color changes for raster effects.
        this.captureScanline();
        break;

      case 0x27: case 0x28: case 0x29: case 0x2a:
      case 0x2b: case 0x2c: case 0x2d: case 0x2e:
        this.regs[a] = u8(v & 0x0f); // sprite colors 4-bit.
        this.captureScanline();
        break;

      case 0x2f:
      case 0x30:
        // VIC-IIe extended-keyboard-row + VIC-IIe-extension. Latch
        // for snapshot fidelity but no behavioural effect at B-level.
        this.regs[a] = v;
        break;

      default:
        // 0x31..0x3f unused at non-DTV; VICE prints debug and ignores.
        // Latch for snapshot completeness.
        if (a < 0x50) this.regs[a] = v;
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Per-register store helpers — VICE inline statics in vicii-mem.c.
  // -------------------------------------------------------------------------

  /** VICE: d01112_read (vicii-mem.c 1583). Live raster_y exposure. */
  private d01112Read(addr: number): BYTE {
    let rasterY = this.raster_y;
    // VICE line 1576: line 0 cycle 0 quirk — counter advances 1 cycle
    // late, so reads at that exact moment see screen_height-1.
    if (rasterY === 0 && this.raster_cycle === 0) rasterY = this.screen_height - 1;
    if (addr === VICII_R_CTRL1) {
      // line 1590: keep low 7 bits of regs, append bit 8 of raster.
      this.last_read = u8((this.regs[VICII_R_CTRL1]! & 0x7f) | ((rasterY & 0x100) >> 1));
    } else {
      this.last_read = u8(rasterY & 0xff);
    }
    return this.last_read;
  }

  /** VICE: d011_store (vicii-mem.c 330). Updates ysmooth, allow_bad_lines,
   *  raster IRQ comparator (high bit), DEN, then re-evaluates. */
  private d011Store(value: BYTE): void {
    // VICE line 342: vicii_irq_check_state(value, 1).
    this.viciiIrqCheckState(value, true);

    // line 347-353: allow_bad_lines update.
    if (this.raster_y === this.first_dma_line && this.raster_cycle === 0) {
      this.allow_bad_lines = (value & 0x10) ? 1 : 0;
    }

    this.regs[VICII_R_CTRL1] = u8(value);
    // ysmooth lives in low 3 bits (VICE: vicii.raster.ysmooth = value & 7).
    // We keep it implicit via regs[CTRL1] & 7 in computeLineSteal.

    // Mid-line snapshot recapture so renderer sees DEN/RSEL flips.
    this.captureScanline();
  }

  /** VICE: d012_store (vicii-mem.c 375). Comparator low byte. */
  private d012Store(value: BYTE): void {
    if (value === this.regs[VICII_R_RASTER]) return;
    this.regs[VICII_R_RASTER] = u8(value);
    // VICE line 385: vicii_irq_check_state(value, 0).
    this.viciiIrqCheckState(value, false);
  }

  /** VICE: d018_store (vicii-mem.c 604). Update memory pointers. */
  private d018Store(value: BYTE): void {
    if (this.regs[VICII_R_MEM_PTR] === value) return;
    this.regs[VICII_R_MEM_PTR] = u8(value);
    this.viciiUpdateMemoryPtrs();
    this.captureScanline();
  }

  /** VICE: d019_store (vicii-mem.c 616). 1-to-clear on bits 0..3. */
  private d019Store(value: BYTE): void {
    // VICE line 640: vicii.irq_status &= ~((value & 0xf) | 0x80).
    // Clearing any source bit also clears the bit-7 summary (recomputed
    // in vicii_irq_set_line below).
    this.irq_status &= ~((value & 0x0f) | 0x80);
    this.viciiIrqSetLine();
  }

  /** VICE: d01a_store (vicii-mem.c 646). Low nibble writable. */
  private d01aStore(value: BYTE): void {
    this.regs[VICII_R_IRQ_MASK] = u8(value & 0x0f);
    this.viciiIrqSetLine();
  }

  /** VICE: d019_read (vicii-mem.c 1599). Bit-7 summary inferred from
   *  irq_status & mask. */
  private d019Read(): BYTE {
    // VICE line 1612: irq_status | 0x70 (bits 4..6 open).
    let val: BYTE = u8(this.irq_status | 0x70);
    // Bit 7 already set by viciiIrqSetLine when masked source pending.
    // VICE also overlays "raster crossed line end before alarm" — at
    // B-level we keep the simpler steady-state inference.
    if ((this.irq_status & this.regs[VICII_R_IRQ_MASK]! & 0x0f) !== 0) {
      val |= 0x80;
    } else {
      val &= 0x7f;
    }
    this.last_read = val;
    return val;
  }

  /** VICE: d01e_read (vicii-mem.c 1618). Read-clears sprite-sprite
   *  collision latch + clears IRQ. */
  private d01eRead(): BYTE {
    // VICE line 1623: vicii_irq_sscoll_clear() — drop bit 2.
    this.irq_status &= ~VICII_IRQ_SSCOLL;
    this.viciiIrqSetLine();
    const v = this.regs[VICII_R_SP_SP_COLL]!;
    this.regs[VICII_R_SP_SP_COLL] = 0;
    return u8(v);
  }

  /** VICE: d01f_read (vicii-mem.c 1641). Read-clears sprite-bg
   *  collision latch + clears IRQ. */
  private d01fRead(): BYTE {
    this.irq_status &= ~VICII_IRQ_SBCOLL;
    this.viciiIrqSetLine();
    const v = this.regs[VICII_R_SP_BG_COLL]!;
    this.regs[VICII_R_SP_BG_COLL] = 0;
    return u8(v);
  }

  // -------------------------------------------------------------------------
  // IRQ — VICE: vicii-irq.c.
  // -------------------------------------------------------------------------

  /**
   * VICE: vicii_irq_set_line (vicii-irq.c 42). Recomputes irq_status
   * bit 7 + drives backend.setIrqLine.
   */
  viciiIrqSetLine(): void {
    if (this.irq_status & this.regs[VICII_R_IRQ_MASK]! & 0x0f) {
      this.irq_status |= VICII_IRQ_SUMMARY;
      this.backend.setIrqLine(true, this.clkPtr());
    } else {
      this.irq_status &= 0x7f;
      this.backend.setIrqLine(false, this.clkPtr());
    }
  }

  /**
   * VICE: vicii_irq_raster_set (vicii-irq.c 64). Set raster IRQ flag
   * + propagate.
   */
  viciiIrqRasterSet(): void {
    this.irq_status |= VICII_IRQ_RASTER;
    this.viciiIrqSetLine();
  }

  /**
   * VICE: vicii_irq_check_state (vicii-irq.c 165). On $D011 / $D012
   * write: recompute raster_irq_line; if it now matches current
   * raster_y AND raster IRQ enabled, schedule alarm immediately.
   *
   * `high` parameter: true = bit 8 from $D011 bit 7; false = low byte
   * from $D012.
   */
  private viciiIrqCheckState(value: BYTE, high: boolean): void {
    let irqLine: number;
    if (high) {
      irqLine = (this.raster_irq_line & 0xff) | ((value & 0x80) << 1);
    } else {
      irqLine = (this.raster_irq_line & 0x100) | u8(value);
    }
    if (irqLine === this.raster_irq_line) return;

    this.viciiIrqSetRasterLine(irqLine);

    // VICE line 186-241: complex RMW + line-cycle-0 corrections. We
    // inline the simple "line == new compare → fire now" path which
    // covers the common KERNAL serial case; full RMW handling is
    // deferred to V3 (Spec 150 §"Out of scope" — pixel-exact quirks).
    if (this.regs[VICII_R_IRQ_MASK]! & 0x01 && this.raster_y === this.raster_irq_line) {
      this.viciiIrqRasterSet();
    }
  }

  /**
   * VICE: vicii_irq_set_raster_line (vicii-irq.c 112). Compute fire
   * clock + (re)arm raster_irq_alarm.
   */
  viciiIrqSetRasterLine(line: number): void {
    if (line === this.raster_irq_line && this.raster_irq_clk !== CLOCK_MAX) return;

    if (line < this.screen_height) {
      const clk = this.clkPtr();
      const lineStartClk = u32(clk - this.raster_cycle);
      const currentLine = this.raster_y;
      let fireClk: CLOCK;
      // VICE 127-137: pick the next line == compare in the same or
      // next frame.
      if (line > currentLine) {
        fireClk = u32(lineStartClk + VICII_RASTER_IRQ_DELAY + this.cycles_per_line * (line - currentLine));
      } else {
        fireClk = u32(lineStartClk + VICII_RASTER_IRQ_DELAY + this.cycles_per_line * (line + this.screen_height - currentLine));
      }
      // VICE line 144-146: line 0 +1 cycle delay.
      if (line === 0) fireClk = u32(fireClk + 1);

      this.raster_irq_clk = fireClk;
      alarmSet(this.raster_irq_alarm, fireClk);
    } else {
      this.raster_irq_clk = CLOCK_MAX;
      alarmUnset(this.raster_irq_alarm);
    }

    this.raster_irq_line = line;
  }

  /** VICE: vicii_irq_alarm_handler (vicii-irq.c 252). */
  rasterIrqAlarmHandler(_offset: CLOCK): void {
    this.viciiIrqRasterSet();
    // VICE: vicii_irq_next_frame — re-arm alarm for next frame.
    this.raster_irq_clk = u32(this.raster_irq_clk + this.screen_height * this.cycles_per_line);
    alarmSet(this.raster_irq_alarm, this.raster_irq_clk);
  }

  /**
   * VICE: vicii_irq_set_line — public wrapper for backend / tests so
   * a flag-only collision can drive IRQ propagation correctly.
   */
  setSpriteSpriteCollisionFlag(mask: BYTE): void {
    this.regs[VICII_R_SP_SP_COLL] = u8(mask);
    if (mask !== 0) {
      this.irq_status |= VICII_IRQ_SSCOLL;
      this.viciiIrqSetLine();
    }
  }
  setSpriteBgCollisionFlag(mask: BYTE): void {
    this.regs[VICII_R_SP_BG_COLL] = u8(mask);
    if (mask !== 0) {
      this.irq_status |= VICII_IRQ_SBCOLL;
      this.viciiIrqSetLine();
    }
  }

  // -------------------------------------------------------------------------
  // Memory pointers — VICE: vicii_update_memory_ptrs (vicii.c 776).
  // B-level: we just decode the $D018 + vbank into pointer offsets so
  // callers / renderer can grab the right bank for sprite-pointer reads.
  // -------------------------------------------------------------------------

  private viciiUpdateMemoryPtrs(): void {
    const r18 = this.regs[VICII_R_MEM_PTR]!;
    // Screen RAM = (r18 >> 4) << 10 within bank.
    this.screen_ptr = ((r18 >> 4) & 0x0f) << 10;
    // Char ROM = (r18 >> 1 & 7) << 11 within bank.
    this.chargen_ptr = ((r18 >> 1) & 0x07) << 11;
    // Bitmap = bit 3 of r18 ? 0x2000 : 0x0000 within bank.
    this.bitmap_ptr = (r18 & 0x08) ? 0x2000 : 0x0000;
  }

  /** Set VIC bank — called from CIA2 PA bits 0..1. */
  setVbank(num: number): void {
    const tmp = (num & 0x03) << 14;
    this.vbank_phi1 = tmp;
    this.vbank_phi2 = tmp;
    this.viciiUpdateMemoryPtrs();
  }

  // -------------------------------------------------------------------------
  // Per-scanline snapshot — emitted on line entry + on color-affecting
  // register writes mid-line. Last-write-wins per line.
  // -------------------------------------------------------------------------

  captureScanline(): void {
    const last = this.scanlineSnapshots[this.scanlineSnapshots.length - 1];
    const snap: ScanlineState = {
      rasterLine: this.raster_y,
      d011: this.regs[VICII_R_CTRL1]!,
      d016: this.regs[VICII_R_CTRL2]!,
      d018: this.regs[VICII_R_MEM_PTR]!,
      d020: this.regs[VICII_R_BORDER]!,
      d021: this.regs[VICII_R_BG0]!,
      d022: this.regs[VICII_R_BG1]!,
      d023: this.regs[VICII_R_BG2]!,
      d024: this.regs[VICII_R_BG3]!,
      d025: this.regs[VICII_R_SP_MC_COL_1]!,
      d026: this.regs[VICII_R_SP_MC_COL_2]!,
      spritePos: Array.from({ length: 8 }, (_, s) => ({
        x: this.regs[s * 2]!,
        y: this.regs[s * 2 + 1]!,
        color: this.regs[VICII_R_SP_COL_BASE + s]!,
        xMsb: (this.regs[VICII_R_SP_X_MSB]! & (1 << s)) !== 0,
      })),
      spriteEnable: this.regs[VICII_R_SP_ENABLE]!,
      spritePtrs: Array.from({ length: 8 }, () => 0),
      spriteFlags: {
        mc: this.regs[VICII_R_SP_MC]!,
        xExpand: this.regs[VICII_R_SP_X_EXP]!,
        yExpand: this.regs[VICII_R_SP_Y_EXP]!,
        priority: this.regs[VICII_R_SP_PRIO]!,
      },
    };
    if (last && last.rasterLine === this.raster_y) {
      this.scanlineSnapshots[this.scanlineSnapshots.length - 1] = snap;
    } else {
      this.scanlineSnapshots.push(snap);
    }
  }

  /**
   * Spec 262b: record a CIA2 PA-bank change in the per-cycle log.
   * Wired by the kernel's CIA2 storePa hook so the future Spec 262d
   * pixel-perfect renderer can reconstruct VIC bank changes that
   * occur mid-frame (= MM split-screen, FLI bank-swap, FLD).
   *
   * The log carries the full PA byte; bits 0..1 select the VIC bank
   * (inverted, per VICE c64cia2.c:151 `vbank = (~tmp) & 3`). The
   * renderer is responsible for the inversion — we keep raw bytes
   * to match how VICE captures CIA2 PRA history.
   */
  recordCia2PaChange(value: BYTE): void {
    this.currentLineLog.writes.push({
      cycleInLine: this.raster_cycle,
      reg: VICII_LOG_CIA2_PA,
      value: u8(value),
    });
  }

  /** Spec 262a: renderer access — completed lines for the current frame. */
  getFrameLineLogs(): readonly ScanlineRegLog[] {
    return this.frameLineLogs;
  }

  /**
   * Spec 280e: per-line accessor for the Spec 280c renderer.
   *
   * Returns the vbuf+cbuf fetched on the current bad line, or null if
   * this line is not a bad line (= idle/border/not-in-DMA-range) or if
   * no badlineBus is wired.
   *
   * The renderer reads vbuf[i] to find char codes and cbuf[i] for
   * foreground colors.  bitmapBuf is initially zeroed; the renderer
   * should call fetchChargen() / fetchBitmap() from badline-fetch.ts
   * for the appropriate sub-row and fill bitmapBuf itself.
   */
  getCurrentLineMatrix(): BadlineFetchResult | null {
    return this.currentLineMatrix;
  }

  /** Renderer access. */
  getScanlineSnapshot(): ScanlineState {
    return this.scanlineSnapshots[this.scanlineSnapshots.length - 1] ?? {
      rasterLine: this.raster_y,
      d011: 0, d016: 0, d018: 0,
      d020: 0, d021: 0, d022: 0, d023: 0, d024: 0,
      d025: 0, d026: 0,
      spritePos: Array.from({ length: 8 }, () => ({ x: 0, y: 0, color: 0, xMsb: false })),
      spriteEnable: 0,
      spritePtrs: Array.from({ length: 8 }, () => 0),
      spriteFlags: { mc: 0, xExpand: 0, yExpand: 0, priority: 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Region selection.
  // -------------------------------------------------------------------------

  setNtsc(): void {
    this.cycles_per_line = VICII_NTSC_CYCLES_PER_LINE;
    this.screen_height = VICII_NTSC_SCREEN_HEIGHT;
  }
  setPal(): void {
    this.cycles_per_line = VICII_PAL_CYCLES_PER_LINE;
    this.screen_height = VICII_PAL_SCREEN_HEIGHT;
  }

  /** True iff masked source bit set; mirrors VICE
   *  vicii.irq_status & vicii.regs[0x1a] semantics. */
  irqAsserted(): boolean {
    return (this.irq_status & this.regs[VICII_R_IRQ_MASK]! & 0x0f) !== 0;
  }

  // -------------------------------------------------------------------------
  // Legacy compatibility surface — mirrors peripherals/vic-ii.ts public API
  // so that integrated-session.ts, vic-renderer.ts and vic-fidelity-tests.ts
  // can migrate without touching their own call-sites. Mirrors the pattern
  // established by Cia6526Vice and Via1d1541 Phase 2 compat shims.
  // -------------------------------------------------------------------------

  /** Legacy alias: raster_y exposed as rasterLine (matching old VicII). */
  get rasterLine(): number { return this.raster_y; }
  set rasterLine(v: number) { this.raster_y = v; }

  /** Legacy alias: screen_height - 1 exposed as maxRasterLine. */
  get maxRasterLine(): number { return this.screen_height - 1; }

  /** Legacy alias: cycles_per_line. */
  get cyclesPerLine(): number { return this.cycles_per_line; }

  /** Legacy alias: raster_cycle exposed as horizontalCycle. */
  get horizontalCycle(): number { return this.raster_cycle; }

  /**
   * Legacy: screenRamOffset() — decoded from $D018 bits 7..4.
   * Equivalent to peripherals/vic-ii.ts VicII.screenRamOffset().
   */
  screenRamOffset(): number {
    return this.screen_ptr;
  }

  /**
   * Legacy: charRomOffsetWithinBank() — decoded from $D018 bits 3..1.
   * Equivalent to peripherals/vic-ii.ts VicII.charRomOffsetWithinBank().
   */
  charRomOffsetWithinBank(): number {
    return this.chargen_ptr;
  }

  /**
   * Legacy: bitmapBaseWithinBank() — decoded from $D018 bit 3.
   * Equivalent to peripherals/vic-ii.ts VicII.bitmapBaseWithinBank().
   */
  bitmapBaseWithinBank(): number {
    return this.bitmap_ptr;
  }
}

// ---------------------------------------------------------------------------
// Bus install — $D000-$D3FF mirror tile (64-byte stride).
// ---------------------------------------------------------------------------

export interface MemoryBus {
  registerIoHandler(addr: number, h: { read: (a: number) => number; write: (a: number, v: number) => void }): void;
}

export function installVicIIVice(bus: MemoryBus, vic: VicIIVice): void {
  for (let mirror = 0; mirror < 0x400; mirror += 0x40) {
    for (let r = 0; r < 0x40; r++) {
      const a = 0xd000 + mirror + r;
      const reg = r;
      bus.registerIoHandler(a, {
        read: () => vic.read(reg),
        write: (_addr, value) => vic.write(reg, value),
      });
    }
  }
}
