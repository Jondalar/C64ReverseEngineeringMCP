// Spec 145 — CIA serial port / SDR (shift register) module 1:1 VICE port.
//
// Source: VICE 3.7.1 src/core/ciacore.c — `ciacore_intsdr()` lines
// 1723-1830, `schedule_sdr_alarm()` lines 1709-1713,
// `strange_extra_sdr_flags()` lines 690-737, `ciacore_set_cnt()`
// lines 1649-1695, `ciacore_set_sp()` lines 1697-1700,
// `ciacore_set_sdr()` lines 1631-1647 + the CIA_SDR_* delay-line
// constants at lines 79-123.
//
// VICE uses an N-bit "mercury delay-line" (`sdr_delay`) to schedule
// near-future SDR / CNT events without needing multiple alarms with
// ambiguous ordering. Each cycle the sdr_alarm fires, processes the
// "0"-position bits, then shifts the delay word LEFT one slot and
// clears the LEFTMOST + protected fence bits. This module ports the
// constants verbatim and exposes the alarm callback as
// `sdrTickCallback`. The owning CIA core owns the alarm.
//
// Hybrid naming: VICE field names verbatim — `sdr_delay`, `sdr_valid`,
// `sdr_force_finish`, `sr_bits`, `shifter`, `cnt_in_state`,
// `cnt_out_state`, `sp_in_state`. Public method exports camelCase.

import { u32, type BYTE, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// SDR delay-line bit layout — ciacore.c lines 79-123 verbatim.
// ---------------------------------------------------------------------------

// "countdown to toggling CNT"
export const CIA_SDR_TOGGLE_CNT2 = 0x0001;
export const CIA_SDR_TOGGLE_CNT1 = 0x0002;
export const CIA_SDR_TOGGLE_CNT0 = 0x0004;
export const CIA_SDR_TOGGLE_CNT_1 = 0x0008;

// "countdown to NOT toggling CNT"
export const CIA_SDR_NOGGLE_CNT2 = 0x0010;
export const CIA_SDR_NOGGLE_CNT1 = 0x0020;
export const CIA_SDR_NOGGLE_CNT0 = 0x0040;
export const CIA_SDR_NOGGLE_CNT_1 = 0x0080;

// "countdown to setting the SDR IRQ"
export const CIA_SDR_SET_SDR_IRQ3 = 0x0100;
export const CIA_SDR_SET_SDR_IRQ2 = 0x0200;
export const CIA_SDR_SET_SDR_IRQ1 = 0x0400;
export const CIA_SDR_SET_SDR_IRQ0 = 0x0800;

// CNT-output history (4 bits).
export const CIA_SDR_CNT0 = 0x1000;
export const CIA_SDR_CNT1 = 0x2000;
export const CIA_SDR_CNT2 = 0x4000;
export const CIA_SDR_CNT3 = 0x8000;

// "countdown to setting shifter from SDR"
export const CIA_SDR_SET3 = 0x00010000;
export const CIA_SDR_SET2 = 0x00020000;
export const CIA_SDR_SET1 = 0x00040000;
export const CIA_SDR_SET0 = 0x00080000;

// Fence bit (must be cleared every shift).
export const CIA_SDR_LEFTMOST = 0x00100000;

// VICE: CIA_SDR_CLEAR — bits cleared right after the shift-left.
export const CIA_SDR_CLEAR =
  CIA_SDR_NOGGLE_CNT2 |
  CIA_SDR_SET_SDR_IRQ3 |
  CIA_SDR_CNT0 |
  CIA_SDR_SET3 |
  CIA_SDR_LEFTMOST;

// VICE: CIA_SDR_ACTIVE — any bits whose presence keeps the alarm running.
export const CIA_SDR_ACTIVE =
  CIA_SDR_TOGGLE_CNT2 |
  CIA_SDR_TOGGLE_CNT1 |
  CIA_SDR_TOGGLE_CNT0 |
  CIA_SDR_TOGGLE_CNT_1 |
  CIA_SDR_NOGGLE_CNT2 |
  CIA_SDR_NOGGLE_CNT1 |
  CIA_SDR_NOGGLE_CNT0 |
  CIA_SDR_NOGGLE_CNT_1 |
  CIA_SDR_SET_SDR_IRQ3 |
  CIA_SDR_SET_SDR_IRQ2 |
  CIA_SDR_SET_SDR_IRQ1 |
  CIA_SDR_SET_SDR_IRQ0 |
  CIA_SDR_SET3 |
  CIA_SDR_SET2 |
  CIA_SDR_SET1 |
  CIA_SDR_SET0;

export const ALL_SDR_CNT = CIA_SDR_CNT0 | CIA_SDR_CNT1 | CIA_SDR_CNT2 | CIA_SDR_CNT3;

export const ALL_SDR_TOGGLE_CNT =
  CIA_SDR_TOGGLE_CNT2 | CIA_SDR_TOGGLE_CNT1 | CIA_SDR_TOGGLE_CNT0 | CIA_SDR_TOGGLE_CNT_1;
export const ALL_SDR_NOGGLE_CNT =
  CIA_SDR_NOGGLE_CNT2 | CIA_SDR_NOGGLE_CNT1 | CIA_SDR_NOGGLE_CNT0 | CIA_SDR_NOGGLE_CNT_1;

/**
 * VICE: cia_context_t SDR-relevant fields (cia.h lines 127-131,
 * 167-169). Lives on the CIA core; this module receives a reference.
 */
export interface CiaSdrState {
  /** VICE: unsigned int sr_bits — half-bits remaining to shift. */
  sr_bits: number;
  /** VICE: bool sdr_valid — SDR latch holds a byte ready to load. */
  sdr_valid: boolean;
  /** VICE: bool sdr_force_finish — direction-flip cleanup pending. */
  sdr_force_finish: boolean;
  /** VICE: uint16_t shifter — the actual 16-bit shift register. */
  shifter: number;
  /** VICE: uint32_t sdr_delay — mercury-delay-line of pending events. */
  sdr_delay: number;
  /** VICE: bool sp_in_state — input level on SP pin. */
  sp_in_state: boolean;
  /** VICE: bool cnt_in_state — input level on CNT pin. */
  cnt_in_state: boolean;
  /** VICE: bool cnt_out_state — output level on CNT pin (we drive it). */
  cnt_out_state: boolean;
}

export function makeSdrState(): CiaSdrState {
  return {
    sr_bits: 0,
    sdr_valid: false,
    sdr_force_finish: false,
    shifter: 0,
    // VICE reset (ciacore.c line 643): seed the CNT history with all 1s
    // so the first shift won't spurious-trigger a toggle.
    sdr_delay: CIA_SDR_CNT0 | CIA_SDR_CNT1 | CIA_SDR_CNT2 | CIA_SDR_CNT3,
    sp_in_state: true,
    cnt_in_state: true,
    cnt_out_state: true,
  };
}

/**
 * VICE: ciacore_reset() SDR portion (ciacore.c lines 641-647).
 * Note: sp_in_state / cnt_in_state per VICE init code (ciacore_init
 * lines 2125-2127) are set ONCE at init and NOT reset — they stay
 * across resets because they reflect the external pin state.
 */
export function sdrReset(sdr: CiaSdrState): void {
  sdr.sr_bits = 0;
  sdr.sdr_valid = false;
  sdr.sdr_force_finish = false;
  sdr.shifter = 0;
  sdr.sdr_delay = CIA_SDR_CNT0 | CIA_SDR_CNT1 | CIA_SDR_CNT2 | CIA_SDR_CNT3;
  sdr.cnt_out_state = true;
  // sp_in_state / cnt_in_state: caller decides; per VICE they are NOT
  // reset by ciacore_reset.
}

/**
 * Result of one sdr_alarm dispatch. The CIA core uses these to fold
 * the side-effects (IRQ flag set, store_sdr backend pulse, set_cnt /
 * set_sp pin pulses) into its own register layer + IRQ pipeline.
 */
export interface SdrTickResult {
  /** Set CIA_IM_SDR via cia_set_irq_flag() at rclk. */
  setSdrIrq: boolean;
  /** Output byte completed; call backend.storeSdr(byte). */
  storedByte: number | null;
  /** CNT pin transitioned; call backend.setCnt(value). */
  cntChanged: { value: boolean } | null;
  /** SP pin pulse (output); call backend.setSp(bit). */
  spPulse: { bit: boolean } | null;
  /** Should the alarm stay active for the next cycle? */
  reschedule: boolean;
}

/**
 * VICE: ciacore_intsdr (ciacore.c lines 1723-1830), MINUS the
 * `alarm_clk(ta_alarm) == rclk` ordering hack (handled in caller via
 * priority-queue alarm context). Returns a SdrTickResult so the CIA
 * core can drive its IRQ pipeline + backend pulses synchronously.
 *
 * `cCia[CIA_SDR]` is read directly to honor "load on SET0" and
 * "load on TOGGLE_CNT0 finish" — same as VICE.
 */
export function sdrTickCallback(
  sdr: CiaSdrState,
  cCia: Uint8Array,
  CIA_SDR_REG: number,
): SdrTickResult {
  let feed = 0;
  const result: SdrTickResult = {
    setSdrIrq: false,
    storedByte: null,
    cntChanged: null,
    spPulse: null,
    reschedule: false,
  };

  // ciacore.c lines 1736-1750 — SET0 → load shifter from SDR latch.
  if (sdr.sdr_delay & CIA_SDR_SET0) {
    if (sdr.sr_bits === 0) {
      sdr.sr_bits = 16;
      sdr.shifter = (cCia[CIA_SDR_REG]! << 1) & 0xffff;
    } else if (sdr.sr_bits === 1) {
      sdr.shifter = (sdr.shifter | cCia[CIA_SDR_REG]!) & 0xffff;
      sdr.sr_bits = 17;
    } else {
      sdr.sdr_valid = true;
    }
  }

  // ciacore.c lines 1752-1801 — TOGGLE_CNT0 → CNT toggle + bit-out.
  if (sdr.sdr_delay & CIA_SDR_TOGGLE_CNT0) {
    if (sdr.sr_bits && (--sdr.sr_bits & 1)) {
      // Output a bit on SP; drop CNT.
      const bit = ((sdr.shifter >> 8) & 1) !== 0;
      result.spPulse = { bit };
      sdr.cnt_out_state = false;
      result.cntChanged = { value: false };

      if (sdr.sr_bits === 1) {
        // Byte fully shifted out; report it; schedule SDR IRQ.
        const byte = (sdr.shifter >>> 8) & 0xff;
        result.storedByte = byte;
        feed |= CIA_SDR_SET_SDR_IRQ2;
        if (sdr.sdr_valid) {
          sdr.shifter = (sdr.shifter | cCia[CIA_SDR_REG]!) & 0xffff;
          sdr.sdr_valid = false;
          sdr.sr_bits = 17;
        }
      }
    } else {
      // Either sr_bits==0 or after-decrement is even → shift left, raise CNT.
      sdr.shifter = (sdr.shifter << 1) & 0xffff;
      sdr.cnt_out_state = true;
      result.cntChanged = { value: true };
    }
  }

  // ciacore.c lines 1804-1807 — SET_SDR_IRQ0 → arm CIA_IM_SDR.
  if (sdr.sdr_delay & CIA_SDR_SET_SDR_IRQ0) {
    result.setSdrIrq = true;
  }

  // ciacore.c lines 1809-1815 — apply feed, then shift left, then clear
  // fence + leftmost, then refresh CNT history bit from cnt_out_state.
  sdr.sdr_delay = u32(sdr.sdr_delay | feed);
  sdr.sdr_delay = u32(sdr.sdr_delay << 1);
  sdr.sdr_delay = u32(sdr.sdr_delay & ~CIA_SDR_CLEAR);

  if (sdr.cnt_out_state) {
    sdr.sdr_delay = u32(sdr.sdr_delay | CIA_SDR_CNT0);
  }

  // ciacore.c lines 1817-1829 — decide reschedule.
  let active = (sdr.sdr_delay & CIA_SDR_ACTIVE) !== 0;
  if (!active) {
    const all_cnt = sdr.sdr_delay & ALL_SDR_CNT;
    if (all_cnt !== 0 && all_cnt !== ALL_SDR_CNT) {
      active = true;
    }
  }
  result.reschedule = active;

  return result;
}

/**
 * VICE: schedule_sdr_alarm (ciacore.c lines 1709-1713). Sets the
 * given feed bits in sdr_delay; caller is responsible for arming the
 * sdr_alarm at rclk after this returns true.
 */
export function scheduleSdrFeed(sdr: CiaSdrState, feed: number): void {
  sdr.sdr_delay = u32(sdr.sdr_delay | feed);
}

/**
 * VICE: strange_extra_sdr_flags (ciacore.c lines 690-737). Called from
 * CRA write when the SP-mode bit changes. Returns whether the caller
 * needs to schedule sdr_alarm at rclk.
 */
export function strangeExtraSdrFlags(
  sdr: CiaSdrState,
  byte: BYTE,
): { schedule: boolean } {
  // CIA_CRA_SPMODE_OUT = 0x40 (cia.h line 78). At entry, `byte` holds
  // the new CRA value; the caller has already verified the SP-mode bit
  // toggled.
  let schedule = false;

  if (
    (sdr.sr_bits > 1 && sdr.sr_bits < 15) ||
    (sdr.sr_bits === 15 && !(sdr.sdr_delay & CIA_SDR_CNT2))
  ) {
    sdr.sdr_delay = u32(sdr.sdr_delay | CIA_SDR_SET_SDR_IRQ2);
    schedule = true;
  }

  // CIA_CRA_SPMODE_OUT = 0x40 → 0 means input direction.
  if ((byte & 0x40) === 0) {
    // OUT → IN: maybe forceFinish.
    let forceFinish = false;
    const cnt_wanted = CIA_SDR_CNT1 | CIA_SDR_CNT2;
    forceFinish = (sdr.sdr_delay & cnt_wanted) !== cnt_wanted;
    if (!forceFinish) {
      if (
        sdr.sr_bits !== 2 &&
        !(sdr.sdr_delay & CIA_SDR_TOGGLE_CNT2) &&
        !(sdr.sdr_delay & CIA_SDR_TOGGLE_CNT1) &&
        (sdr.sdr_delay & CIA_SDR_TOGGLE_CNT0)
      ) {
        forceFinish = true;
      }
    }
    sdr.sdr_force_finish = forceFinish;
  } else {
    // IN → OUT.
    if (!sdr.cnt_out_state && sdr.sr_bits !== 0) {
      sdr.shifter = (sdr.shifter << 1) & 0xffff;
    }
    if (sdr.sdr_force_finish) {
      sdr.sdr_delay = u32(sdr.sdr_delay | CIA_SDR_SET_SDR_IRQ2);
      schedule = true;
      sdr.sdr_force_finish = false;
    }
  }

  return { schedule };
}

/**
 * VICE: ciacore_set_sdr (ciacore.c lines 1631-1647). External sources
 * inject a whole byte at once. Returns whether the caller should fire
 * an async CIA_IM_SDR interrupt + unset the sdr_alarm.
 */
export function setSdrExternal(
  sdr: CiaSdrState,
  cCia: Uint8Array,
  CIA_SDR_REG: number,
  cra: BYTE,
  data: BYTE,
): { signalIrq: boolean } {
  // CIA_CRA_SPMODE_IN = 0 (cia.h line 79).
  if ((cra & 0x40) === 0) {
    cCia[CIA_SDR_REG] = u8Clamp(data);
    return { signalIrq: true };
  }
  return { signalIrq: false };
}

function u8Clamp(x: number): number { return x & 0xff; }

/**
 * VICE: ciacore_set_cnt (ciacore.c lines 1649-1695). External CNT pin
 * driver. Returns whether a byte was completed (caller forwards it
 * through ciacore_set_sdr).
 */
export function setCntExternal(
  sdr: CiaSdrState,
  cra: BYTE,
  data: boolean,
): { completedByte: number | null } {
  let completedByte: number | null = null;
  if (data !== sdr.cnt_in_state) {
    if ((cra & 0x40) === 0) {
      // SP-mode = IN.
      if (!data && sdr.sr_bits === 0) {
        sdr.sr_bits = 16;
      }
      sdr.sr_bits--;
      if (data) {
        // Rising edge: shift in.
        sdr.shifter = (sdr.shifter << 1) & 0xffff;
        sdr.shifter = (sdr.shifter | (sdr.sp_in_state ? 1 : 0)) & 0xffff;
        if (sdr.sr_bits === 0) {
          completedByte = sdr.shifter & 0xff;
        }
      }
    }
    sdr.cnt_in_state = data;
  }
  return { completedByte };
}

// CLOCK is unused at this layer (the CIA core converts result.reschedule
// into an alarm_set(rclk+1) call). We re-export the type for tests that
// want to match VICE function signatures.
export type { CLOCK };
