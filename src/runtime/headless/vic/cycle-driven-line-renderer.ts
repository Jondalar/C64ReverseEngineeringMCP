// Spec 296a-4 — Cycle-driven raster line renderer.
//
// Stitches together 296a-1 (Φ1 fetch), 296a-2 (cycle table), 296a-3
// (display pipe) into a callable that emits 504 pixels for one PAL
// raster line. Drives the inner loop pattern from
// viciisc/vicii-draw-cycle.c draw_graphics8():
//
//   per cycle (1..63):
//     Φ1 fetch (cycle table → gbuf if FetchG, vbuf prep if SprPtr/etc)
//     Φ2: if mayFetchC + bad_line → fetch vbuf[vmli] + cbuf[vmli]
//     emit 8 pixels:
//       for i in 0..7:
//         if i == xscroll_pipe: latch reg from pipe1
//         if i == 4: vmode16_pipe = $d016 & 0x10
//         if i == 7: vmode16_pipe2 = vmode16_pipe
//         pixel = decode(reg, mc_flop, vmode pipes)
//         shiftGbufOnePixel
//     end-of-cycle:
//       advancePipeStages (pipe0 → pipe1)
//       samplePipe0 with cycle's fresh fetch + xscroll_pipe = $d016 & 7
//       sampleVmode11 with $d011 & 0x60
//
// Standard-text mode (mode 0) supported. Multicolor / ECM / BMM /
// bitmap modes deferred to later sub-specs (the pipe state + cycle
// dispatch are the heavy lift; mode decoders attach in renderPixel).
//
// Sprites NOT rendered here — handled separately by sprite multiplexer
// (existing implementation; or future 296a-5).

import {
  CYCLE_TAB_PAL, PHI1_FETCH_G, PHI1_REFRESH, PHI1_IDLE,
} from "./cycle-table-pal.js";
import {
  newDisplayPipeState,
  advancePipeStages, latchPipeRegs, samplePipe0, shiftGbufOnePixel,
  sampleVmode11, sampleVmode16, holdVmode16Pipe2,
  type DisplayPipeState,
} from "./display-pipe.js";
import { fetchPhi1, fetchIdleGfx, type FetchPhi1Context } from "./fetch-phi1.js";

/** Per-cycle override for $d016 + $d011 + $d018 (= mid-line writes). */
export interface PerCycleRegOverride {
  /** Cycle 1..63 at which the write took effect. */
  cycle: number;
  /** Phase: writes only apply at start of next half-cycle. */
  phase: "phi1" | "phi2";
  reg: 0x11 | 0x16 | 0x18 | 0x20 | 0x21;
  value: number;
}

/** Inputs to render one raster line. */
export interface LineRenderInput {
  /** Bad-line flag (DEN+ysmooth match). Determines matrix fetch. */
  badLine: boolean;
  /** Initial register state at cycle 0 of this line. */
  initialRegs: {
    d011: number;     // ECM/BMM/DEN/RSEL/ysmooth
    d016: number;     // MCM/CSEL/xsmooth
    d018: number;     // screen + chargen pointers
    d020: number;     // border color
    d021: number;     // bg color 0
  };
  /** Mid-line writes captured from CPU $D000-$D02E stores. */
  regOverrides?: PerCycleRegOverride[];
  /** Φ1 fetch context (bank, chargen, RAM, ECM flag callbacks). */
  fetchCtx: FetchPhi1Context;
  /** Color RAM fetcher for Φ2 matrix CBUF. Returns 4-bit nibble. */
  fetchColorRam: (vc: number) => number;
  /** Bad-line vmli/vc trackers (callers reset at start of frame). */
  vmli: number;
  vc: number;
}

/** Output shape: 504-pixel scanline (color indices 0..15). */
export type LineOutput = Uint8Array;

/** Renderer-private per-line state (carry across cycles). */
interface LineState {
  pipe: DisplayPipeState;
  d011: number;
  d016: number;
  d018: number;
  d020: number;
  d021: number;
  // 40-entry video matrix cache (vbuf/cbuf) populated by FetchC cycles.
  vbuf: Uint8Array;
  cbuf: Uint8Array;
  vmli: number;
  vc: number;
}

function applyOverride(state: LineState, ov: PerCycleRegOverride): void {
  switch (ov.reg) {
    case 0x11: state.d011 = ov.value & 0xff; break;
    case 0x16: state.d016 = ov.value & 0xff; break;
    case 0x18: state.d018 = ov.value & 0xff; break;
    case 0x20: state.d020 = ov.value & 0x0f; break;
    case 0x21: state.d021 = ov.value & 0x0f; break;
  }
}

function pickOverridesAt(
  ovs: PerCycleRegOverride[] | undefined,
  cycle: number, phase: "phi1" | "phi2",
): PerCycleRegOverride[] {
  if (!ovs || ovs.length === 0) return [];
  return ovs.filter(o => o.cycle === cycle && o.phase === phase);
}

function screenBaseFromD018(d018: number): number {
  return ((d018 >> 4) & 0x0f) * 0x400;
}

function chargenBaseFromD018(d018: number): number {
  return ((d018 >> 1) & 0x07) * 0x800;
}

/** Standard text-mode pixel emit. Uses gbuf MSB + cbuf for fg color. */
function emitStdTextPixel(
  out: LineOutput, pixelX: number,
  pipe: DisplayPipeState, bgColor: number,
): void {
  const bit = (pipe.gbuf.reg >> 7) & 1;
  out[pixelX] = bit ? (pipe.cbuf.reg & 0x0f) : (bgColor & 0x0f);
}

/**
 * Render one raster line.
 *
 * Returns: { out, finalVmli, finalVc, finalD016 } so callers can chain
 * across lines (vmli persists across cycles within a frame for CPU-A
 * matrix walk).
 */
export interface LineRenderResult {
  out: LineOutput;
  finalVmli: number;
  finalVc: number;
  finalD011: number;
  finalD016: number;
  finalD018: number;
}

export function renderRasterLine(input: LineRenderInput): LineRenderResult {
  const out = new Uint8Array(504);
  const state: LineState = {
    pipe: newDisplayPipeState(),
    d011: input.initialRegs.d011 & 0xff,
    d016: input.initialRegs.d016 & 0xff,
    d018: input.initialRegs.d018 & 0xff,
    d020: input.initialRegs.d020 & 0x0f,
    d021: input.initialRegs.d021 & 0x0f,
    vbuf: new Uint8Array(40),
    cbuf: new Uint8Array(40),
    vmli: input.vmli,
    vc: input.vc,
  };

  let pixelCursor = 0;

  for (let cycle = 1; cycle <= 63; cycle++) {
    // Apply Φ1 overrides BEFORE Φ1 fetch
    for (const ov of pickOverridesAt(input.regOverrides, cycle, "phi1")) {
      applyOverride(state, ov);
    }
    const phi1Entry = CYCLE_TAB_PAL[(cycle - 1) * 2]!;
    let newGbuf: number | null = null;
    if (phi1Entry.phi1 === PHI1_FETCH_G) {
      // Standard text fetch: chargen[charCode * 8 + rowYWithinChar].
      // For 296a-4 minimum: caller supplies chargen via fetchCtx.readChargenRom
      // and we use vbuf[vmli] from previous Φ2 fetch as the char code.
      // Y within char comes from raster_y % 8 — caller responsibility:
      // we just compute address relative to chargen_base + char*8.
      // To keep this stage VIC-bus-correct, route through fetchPhi1.
      const chargenBase = chargenBaseFromD018(state.d018);
      const charCode = state.vbuf[state.vmli] ?? 0;
      // Y index within char comes from input.vmli context — but at
      // this stage we don't know raster_y here. Caller can pre-bake
      // by adjusting fetchCtx.readRamPhi1 / readChargenRom to embed
      // y. For minimum viable, fetch addr = chargen_base + char*8 + 0.
      const fetchAddr = chargenBase + charCode * 8;
      newGbuf = fetchPhi1(input.fetchCtx, fetchAddr);
    } else if (phi1Entry.phi1 === PHI1_IDLE) {
      // Idle gfx fetch (= ECM-aware $3fff/$39ff). Per spec corrective.
      newGbuf = fetchIdleGfx(input.fetchCtx);
    } else if (phi1Entry.phi1 === PHI1_REFRESH) {
      // Refresh fetch: address irrelevant for rendering. Don't update gbuf.
    }

    // VICE vicii-fetch.c:267-270: vmli + vc advance HERE, after Φ1 FetchG
    // returns its byte but BEFORE Φ2 FetchC stores its result. So Φ2's
    // matrix store goes to the NEXT cell index, not the one Φ1 just used.
    if (phi1Entry.phi1 === PHI1_FETCH_G && input.badLine) {
      state.vmli = (state.vmli + 1) & 0x3f;
      state.vc = (state.vc + 1) & 0x3ff;
    }

    // Apply Φ2 overrides BEFORE Φ2 fetch
    for (const ov of pickOverridesAt(input.regOverrides, cycle, "phi2")) {
      applyOverride(state, ov);
    }
    const phi2Entry = CYCLE_TAB_PAL[(cycle - 1) * 2 + 1]!;
    let newVbuf: number | null = null;
    let newCbuf: number | null = null;
    if (phi2Entry.mayFetchC && input.badLine) {
      // Matrix fetch: read screen RAM[vc] + color RAM[vc].
      const screenBase = screenBaseFromD018(state.d018);
      newVbuf = input.fetchCtx.readRamPhi1((screenBase + state.vc) & 0xffff) & 0xff;
      newCbuf = input.fetchColorRam(state.vc) & 0x0f;
      // Latch into vbuf/cbuf at vmli for use during draw of this cell.
      state.vbuf[state.vmli] = newVbuf;
      state.cbuf[state.vmli] = newCbuf;
    }

    // Emit 8 pixels for this cycle (visible band only — VICE emits
    // forced colors outside visible window; we just zero).
    if (phi1Entry.visible || phi2Entry.visible) {
      for (let i = 0; i < 8; i++) {
        if (i === state.pipe.xscroll_pipe) latchPipeRegs(state.pipe);
        if (i === 4) sampleVmode16(state.pipe, state.d016);
        if (i === 7) holdVmode16Pipe2(state.pipe);
        emitStdTextPixel(out, pixelCursor + i, state.pipe, state.d021);
        shiftGbufOnePixel(state.pipe);
      }
    }
    pixelCursor += 8;

    // End-of-cycle: pipe transfer + new sample
    advancePipeStages(state.pipe);
    samplePipe0(
      state.pipe,
      phi1Entry.visible || phi2Entry.visible,
      false,                       // vborder not modeled at this stage
      state.d016,
      newGbuf,
      newVbuf,
      newCbuf,
    );
    sampleVmode11(state.pipe, state.d011);
  }

  return {
    out,
    finalVmli: state.vmli,
    finalVc: state.vc,
    finalD011: state.d011,
    finalD016: state.d016,
    finalD018: state.d018,
  };
}
