// Spec 296a-3 — VIC display pipe state (1:1 viciisc/vicii-draw-cycle.c).
//
// Three buffered registers: gbuf (graphics byte), vbuf (char code),
// cbuf (color RAM). Each has pipe0 → pipe1 → reg stages. The reg
// stage is what's currently driving pixel output. Pipe0 is sampled
// at the cycle where the matrix/graphics fetch lands; pipe1 is the
// 1-cycle delay before reg latches at xscroll_pipe.
//
// xscroll_pipe samples $d016 & 7 when visible gbuf enters pipe0.
// vmode11_pipe samples D011[6:5] (ECM/BMM) per VICE color_latency rule.
// vmode16_pipe samples D016[4] (MCM) at pixel 4; vmode16_pipe2 = pipe
// delayed 1 pixel for the multicolor decision boundary at pixel 7.
//
// VICE source:
//   src/viciisc/vicii-draw-cycle.c:65-75   — pipe register declarations
//   src/viciisc/vicii-draw-cycle.c:152-158 — pipe latch at i==xscroll_pipe
//   src/viciisc/vicii-draw-cycle.c:227-295 — draw_graphics8 inner loop
//   src/viciisc/vicii-draw-cycle.c:243-266 — vmode register sampling
//
// This module models the pipe shape only (state + advance helpers).
// The actual pixel-emission is in 296a-4 (cycle-driven renderer).

/** Three-stage register: pipe0 (just-sampled) → pipe1 (1-cycle late) → reg (latched at xscroll). */
export interface PipeReg {
  pipe0: number;
  pipe1: number;
  reg: number;
}

export function newPipeReg(): PipeReg {
  return { pipe0: 0, pipe1: 0, reg: 0 };
}

/** Reset pipe to all zero. */
export function resetPipeReg(p: PipeReg): void {
  p.pipe0 = 0;
  p.pipe1 = 0;
  p.reg = 0;
}

/** Display pipe state for one VIC chip. */
export interface DisplayPipeState {
  gbuf: PipeReg;
  vbuf: PipeReg;
  cbuf: PipeReg;
  /**
   * D016 & 7 latched at the cycle where gbuf enters pipe0.
   * Triggers reg latch when pixel-x in cycle == xscroll_pipe.
   */
  xscroll_pipe: number;
  /**
   * Multicolor flip-flop (= alternates 0/1 per pixel inside a cell).
   * Used to extract MCM bit-pairs from gbuf_reg.
   */
  gbuf_mc_flop: number;
  /**
   * D011[6:5] sampled at Φ6 of the previous cycle. Drives ECM/BMM
   * decision for pixel emission in current cycle.
   */
  vmode11_pipe: number;
  /**
   * D016[4] sampled at pixel 4 of the draw cycle. Drives MCM decision
   * for the second half of the cycle.
   */
  vmode16_pipe: number;
  /**
   * vmode16_pipe delayed 1 pixel = the value used at pixel 7 to decide
   * whether the last pixel of the cycle is MCM or hi-res.
   */
  vmode16_pipe2: number;
}

export function newDisplayPipeState(): DisplayPipeState {
  return {
    gbuf: newPipeReg(),
    vbuf: newPipeReg(),
    cbuf: newPipeReg(),
    xscroll_pipe: 0,
    gbuf_mc_flop: 1,
    vmode11_pipe: 0,
    vmode16_pipe: 0,
    vmode16_pipe2: 0,
  };
}

export function resetDisplayPipe(s: DisplayPipeState): void {
  resetPipeReg(s.gbuf);
  resetPipeReg(s.vbuf);
  resetPipeReg(s.cbuf);
  s.xscroll_pipe = 0;
  s.gbuf_mc_flop = 1;
  s.vmode11_pipe = 0;
  s.vmode16_pipe = 0;
  s.vmode16_pipe2 = 0;
}

/**
 * Latch pipe1 → reg for all three buffers + reset mc-flop.
 * Mirrors vicii-draw-cycle.c:152-158 (pipe transfer at i==xscroll_pipe).
 * Caller arranges to invoke this when pixel index in current cycle
 * reaches xscroll_pipe.
 */
export function latchPipeRegs(s: DisplayPipeState): void {
  s.gbuf.reg = s.gbuf.pipe1;
  s.vbuf.reg = s.vbuf.pipe1;
  s.cbuf.reg = s.cbuf.pipe1;
  s.gbuf_mc_flop = 1;
}

/**
 * Advance pipe0 → pipe1 for all three buffers.
 * Called at the end of each draw cycle (vicii-draw-cycle.c:268-272 area).
 */
export function advancePipeStages(s: DisplayPipeState): void {
  s.gbuf.pipe1 = s.gbuf.pipe0;
  s.vbuf.pipe1 = s.vbuf.pipe0;
  s.cbuf.pipe1 = s.cbuf.pipe0;
}

/**
 * Sample new pipe0 inputs at end-of-cycle.
 *   - gbuf pipe0 = freshly fetched graphics byte (or 0 if not visible)
 *   - vbuf/cbuf pipe0 = freshly fetched matrix entry (or untouched if no FetchC this cycle)
 *   - xscroll_pipe = D016 & 7 if visible+!vborder, else hold previous
 *
 * Mirrors vicii-draw-cycle.c:275-294. Pass nulls for buffers that
 * weren't fetched this cycle (= keep previous pipe0).
 */
export function samplePipe0(
  s: DisplayPipeState,
  visible: boolean,
  vborderActive: boolean,
  d016LowBits: number,
  newGbuf: number | null,
  newVbuf: number | null,
  newCbuf: number | null,
): void {
  if (visible && !vborderActive) {
    s.gbuf.pipe0 = newGbuf !== null ? newGbuf & 0xff : 0;
    s.xscroll_pipe = d016LowBits & 0x07;
  } else {
    s.gbuf.pipe0 = 0;
  }
  if (newVbuf !== null) s.vbuf.pipe0 = newVbuf & 0xff;
  if (newCbuf !== null) s.cbuf.pipe0 = newCbuf & 0x0f;
}

/**
 * Shift gbuf_reg left by 1 + toggle mc_flop. Called once per emitted
 * pixel in the inner loop (vicii-draw-cycle.c:288-289).
 */
export function shiftGbufOnePixel(s: DisplayPipeState): void {
  s.gbuf.reg = (s.gbuf.reg << 1) & 0xff;
  s.gbuf_mc_flop ^= 1;
}

/**
 * Sample mid-cycle vmode pipes. Call at appropriate pixel position
 * inside the inner loop:
 *   - vmode11_pipe samples at end-of-cycle (Φ6 in VICE)
 *   - vmode16_pipe samples at pixel 4
 *   - vmode16_pipe2 = vmode16_pipe value AT pixel 7 (= delayed 1 px)
 *
 * Caller pattern (per draw_graphics8 loop):
 *   for i in 0..7:
 *     if i == xscroll_pipe: latchPipeRegs()
 *     if i == 4: vmode16_pipe = d016 & 0x10
 *     if i == 7: vmode16_pipe2 = vmode16_pipe (= retained for next cycle pixel 0)
 *     emit pixel using current reg+mc_flop+vmode pipes
 *     shiftGbufOnePixel()
 *   end-of-cycle: vmode11_pipe = d011 & 0x60
 */
export function sampleVmode16(s: DisplayPipeState, d016: number): void {
  s.vmode16_pipe = d016 & 0x10;
}
export function holdVmode16Pipe2(s: DisplayPipeState): void {
  s.vmode16_pipe2 = s.vmode16_pipe;
}
export function sampleVmode11(s: DisplayPipeState, d011: number): void {
  s.vmode11_pipe = d011 & 0x60;
}
