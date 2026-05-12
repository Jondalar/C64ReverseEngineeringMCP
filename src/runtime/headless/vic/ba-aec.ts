// Spec 283 — VIC-II BA / AEC pin state machine.
//
// Mirrors VICE's dma.c dma_maincpu_steal_cycles(start_clk, num, sub)
// where `sub=3` is the BA pre-assert warning window. Real-HW behavior:
//   cycle N:    VIC asserts BA. CPU sees BA, continues.
//   cycle N+1:  CPU continues.
//   cycle N+2:  CPU continues.  (3rd cycle of warning).
//   cycle N+3:  AEC goes low. CPU stalled.
//   cycle N+3+M: VIC releases bus, CPU resumes.
//
// Special cases:
//   - RMW write phase: completes even with AEC low (VICE
//     maincpu_rmw_flag check). 6510 RMW = 3-cycle "read-modify-write"
//     where the W phase drives the bus from the CPU side.
//   - Read while BA low + 3 cycles passed: stall until BA high.
//   - Write while BA low: still executes (CPU drives bus during write).
//
// Per OQ2: BA asserted continuously from (first_DMA_cycle - 3) through
// the last DMA cycle, single block (= matches VICE behavior for normal
// multi-sprite scenarios).

import {
  PAL_BADLINE_FETCH_CYCLE,
  PAL_SPRITE_FETCH_CYCLE,
  PAL_CYCLES_PER_LINE,
  SPRITE_P_ACCESS_CYCLES,
  SPRITE_S_ACCESS_CYCLES,
  spriteSAccessStartCycle,
} from "./bus-owner-table.js";

/** Cycles BA is asserted before VIC actually takes the bus. Hardware
 *  fixed at 3 — used as `sub` arg in VICE's dma_steal_cycles. */
export const BA_PRE_ASSERT_CYCLES = 3;

/** Mutable per-CPU BA / AEC state. Held alongside the CPU + scheduler. */
export interface BaAecState {
  /** True when VIC has asserted BA this or a prior cycle (still low). */
  baLow: boolean;
  /** Cycle at which BA first went low; meaningful only while baLow. */
  baLowSinceCycle: number;
  /** True when (baLow && cycle >= baLowSinceCycle + 3). CPU stalls when
   *  this is true UNLESS in RMW write phase. */
  aecLow: boolean;
  /** True when current CPU instruction is in its RMW write phase
   *  (= W of a R-M-W sequence; see Cpu65xxVice). */
  rmwActive: boolean;
}

export function createBaAecState(): BaAecState {
  return {
    baLow: false,
    baLowSinceCycle: 0,
    aecLow: false,
    rmwActive: false,
  };
}

/**
 * Update BA / AEC for the current cycle. Called BEFORE the CPU step
 * decision so the scheduler can stall the CPU.
 *
 * @param state             mutable BA/AEC state
 * @param currentCycle      absolute CPU cycle counter
 * @param baAssertedThisCycle  true if VIC wants BA low this cycle
 * @returns { cpuStalled }  true if CPU must skip this cycle
 */
export function updateBaAec(
  state: BaAecState,
  currentCycle: number,
  baAssertedThisCycle: boolean,
): { cpuStalled: boolean } {
  if (baAssertedThisCycle) {
    if (!state.baLow) {
      state.baLow = true;
      state.baLowSinceCycle = currentCycle;
      state.aecLow = false;
    } else if (currentCycle >= state.baLowSinceCycle + BA_PRE_ASSERT_CYCLES) {
      state.aecLow = true;
    }
  } else {
    state.baLow = false;
    state.aecLow = false;
  }
  // RMW write phase exempt from AEC stall (1:1 VICE OQ1).
  const cpuStalled = state.aecLow && !state.rmwActive;
  return { cpuStalled };
}

/**
 * Whether VIC asserts BA at this `cycleInLine` (PAL 0..62). Per OQ2 =
 * single block: BA goes low 3 cycles before the first DMA cycle and
 * stays low through the last DMA cycle of the line.
 *
 * Badline window:  raw DMA = cycles 11..56 (matrix + p-access tail);
 *                  BA from cycle 8 (= 11-3) through 56.
 *
 * Sprite window:   raw DMA = cycles 54..(56 + 2*last_active_sprite),
 *                  BA from cycle 51 (= 54-3) through last s-access.
 *                  Combined with badline: continuous from 8 onwards.
 *
 * @param cycleInLine 0..62
 * @param isBadline   true if this line is a badline
 * @param spriteMask  bitmask of sprites active in DMA this line
 */
export function isBaAsserted(
  cycleInLine: number,
  isBadline: boolean,
  spriteMask: number,
): boolean {
  // Badline BA window
  if (isBadline) {
    if (cycleInLine >= PAL_BADLINE_FETCH_CYCLE - BA_PRE_ASSERT_CYCLES
        && cycleInLine <= PAL_SPRITE_FETCH_CYCLE + SPRITE_P_ACCESS_CYCLES - 1) {
      return true;
    }
  }
  // Sprite BA window — single block per OQ2
  if (spriteMask !== 0) {
    // Pre-warning starts 3 cycles before sprite-fetch (=54)
    const baStart = PAL_SPRITE_FETCH_CYCLE - BA_PRE_ASSERT_CYCLES;
    // Find the LAST active sprite's last s-access cycle
    let lastEnd = PAL_SPRITE_FETCH_CYCLE + SPRITE_P_ACCESS_CYCLES - 1;
    for (let s = 0; s < 8; s++) {
      if (!(spriteMask & (1 << s))) continue;
      const start = spriteSAccessStartCycle(s);
      const end = (start + SPRITE_S_ACCESS_CYCLES - 1) % PAL_CYCLES_PER_LINE;
      // Track linear last (sprite slots that wrap into next line are
      // handled by the linear-line check; their cycles 0..15 of "this"
      // line belong to the prior line's BA window).
      if (end > lastEnd) lastEnd = end;
    }
    if (cycleInLine >= baStart && cycleInLine <= lastEnd) return true;
    // Wrap-side: sprites 1..7 s-access wraps to cycles 0..15 of the
    // *next* line; those still need BA asserted carrying over from the
    // previous line. The scheduler must continue to consult this on
    // line transitions; here we assert BA for cycles 0..lastWrapEnd
    // when ANY sprite wraps.
    // Wrap-side detection: a sprite whose post-mod start cycle is
    // smaller than PAL_SPRITE_FETCH_CYCLE (= 54) belongs to the
    // wrap region (= cycles 0..N of the next line). Track the max
    // wrap-side end cycle.
    let wrapEnd = -1;
    for (let s = 0; s < 8; s++) {
      if (!(spriteMask & (1 << s))) continue;
      const start = spriteSAccessStartCycle(s);
      const end = (start + SPRITE_S_ACCESS_CYCLES - 1) % PAL_CYCLES_PER_LINE;
      if (start < PAL_SPRITE_FETCH_CYCLE) {
        // wraps past line end — wrap-side end is `end`
        if (end > wrapEnd) wrapEnd = end;
      }
    }
    if (wrapEnd >= 0 && cycleInLine <= wrapEnd) return true;
  }
  return false;
}
