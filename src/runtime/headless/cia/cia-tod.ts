// Spec 145 — CIA Time-Of-Day (TOD) module 1:1 VICE port.
//
// Source: VICE 3.7.1 src/core/ciacore.c — `ciacore_inttod()` lines
// 1854-2003 + `check_ciatodalarm()` line 236-242 + TOD store/read paths
// in `ciacore_store_internal()` lines 860-912 and `ciacore_read()`
// lines 1260-1276.
//
// Spec 403 / OQ-403-2 (RESOLVED) — docs/vice-c64-arch.md §6.4.
//   - The TOD alarm rate is the power-supply tick rate, NOT 1/10 s.
//     `todticks = ticks_per_sec / power_freq` (ciacore.c:1879)
//     ≈ 19705 cycles (PAL @ 50Hz) or 17046 cycles (NTSC @ 60Hz).
//   - CRA bit 7 does NOT change the alarm rate; it changes the
//     ring-counter match value: match=4 for 50Hz, match=5 for 60Hz
//     (ciacore.c:1920-1921). BCD counter advances 10Hz when the host
//     power frequency matches the CRA bit 7 selection. Mismatched
//     selection runs TOD at the wrong wall-clock speed (well-known
//     PAL/NTSC software pitfall).
//
// The TOD is a BCD clock (HR/MIN/SEC/10ths) driven by a 50/60Hz power
// tick. VICE schedules `tod_alarm` at `clk + todticks` and the alarm
// callback advances the BCD digits, divides 50/60 ticks down to 10Hz
// internally via a 3-bit ring counter, then re-arms.
//
// In this 1:1 port we expose the TOD as a small object with verbatim
// VICE field names. The owning Cia6526Vice owns the alarm and pumps
// the alarm callback through here. The module itself does NOT touch
// the alarm context directly so it stays usable in unit tests where
// we want to drive the tick callback synchronously.
//
// Hybrid naming: internal fields = VICE names (snake_case where C uses
// it; small struct uses C-equivalent identifiers): `todalarm`,
// `todlatch`, `todstopped`, `todlatched`, `todticks`, `todclk`,
// `todtickcounter`, `power_freq`, `power_tickcounter`, `power_ticks`,
// `ticks_per_sec`. Public methods camelCase.
//
// `c_cia` (the 16-byte register backing array) lives on the CIA core;
// this module receives a reference into it for the four TOD register
// slots ($08-$0B = CIA_TOD_TEN..CIA_TOD_HR), which it reads and writes
// directly to keep VICE behavior bit-identical.
//
// Bug 1143 reset note: VICE sets `c_cia[CIA_TOD_HR] = 1` at reset
// because that is the most common power-on value, and zero-init causes
// some software to misbehave. We mirror that.

import { u8, u32, type BYTE, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Register offsets (cia.h lines 51-54). Local copies so this module can
// be unit-tested without importing the full CIA core.
// ---------------------------------------------------------------------------
export const CIA_TOD_TEN = 8;
export const CIA_TOD_SEC = 9;
export const CIA_TOD_MIN = 10;
export const CIA_TOD_HR = 11;

// CRA bit 7 — TOD input frequency select (cia.h line 80-82).
export const CIA_CRA_TODIN_50HZ = 0x80;

// CRB bit 7 — TOD register write target select (cia.h line 90-92).
export const CIA_CRB_ALARM_ALARM = 0x80;

/**
 * VICE: cia_context_t TOD-relevant fields (cia.h lines 126-145).
 * Public — lives on the CIA core but we keep it self-contained here for
 * unit tests. The CIA core uses an instance via composition.
 */
export interface CiaTodState {
  /** VICE: uint8_t todalarm[4] — alarm 10ths/sec/min/hr, BCD. */
  todalarm: Uint8Array;
  /** VICE: uint8_t todlatch[4] — latched register snapshot for read-on-HR. */
  todlatch: Uint8Array;
  /** VICE: char todlatched — 1 = latch valid (HR was read). */
  todlatched: number;
  /** VICE: char todstopped — 1 = clock halted (HR write). */
  todstopped: number;
  /** VICE: CLOCK todticks — clock cycles between two power ticks. */
  todticks: CLOCK;
  /** VICE: CLOCK todclk — absolute clk for the next scheduled tick. */
  todclk: CLOCK;
  /** VICE: uint8_t todtickcounter — 3-bit ring counter (0..5). */
  todtickcounter: number;
  /** VICE: int power_freq — 50 or 60 (Hz); 0 = no power source. */
  power_freq: number;
  /** VICE: int power_tickcounter — counts ticks within current second. */
  power_tickcounter: number;
  /** VICE: CLOCK power_ticks — accumulated tick distance within sec. */
  power_ticks: CLOCK;
  /** VICE: CLOCK ticks_per_sec — system clock per second (PAL=985248). */
  ticks_per_sec: CLOCK;
}

/**
 * Construct a fresh TOD state struct in reset condition. Mirrors VICE
 * `ciacore_reset()` (ciacore.c lines 649-656) for the TOD parts.
 *
 * VICE PAL default: ticks_per_sec=985248, power_freq=50, todticks=19705.
 */
export function makeTodState(ticksPerSec: CLOCK = 985248, powerFreq = 50): CiaTodState {
  return {
    todalarm: new Uint8Array(4),
    todlatch: new Uint8Array(4),
    todlatched: 0,
    todstopped: 1,
    todticks: u32(ticksPerSec / Math.max(1, powerFreq)),
    todclk: 0,
    todtickcounter: 0,
    power_freq: powerFreq,
    power_tickcounter: 0,
    power_ticks: 0,
    ticks_per_sec: u32(ticksPerSec),
  };
}

/**
 * VICE: ciacore_reset() TOD section (ciacore.c lines 649-656).
 * Resets latch, alarm, ring counter; loads default HR=1; arms tod_alarm.
 *
 * Caller must arm the alarm with `tod.todclk` after this returns.
 */
export function todReset(tod: CiaTodState, cCia: Uint8Array, currentClk: CLOCK): void {
  tod.todalarm.fill(0);
  tod.todlatched = 0;
  tod.todstopped = 1;
  // Bug #1143: HR defaults to 1 (the most common power-on value).
  cCia[CIA_TOD_HR] = 1;
  // Snapshot current TOD registers into latch.
  tod.todlatch[0] = cCia[CIA_TOD_TEN]!;
  tod.todlatch[1] = cCia[CIA_TOD_SEC]!;
  tod.todlatch[2] = cCia[CIA_TOD_MIN]!;
  tod.todlatch[3] = cCia[CIA_TOD_HR]!;
  tod.todclk = currentClk + tod.todticks; // Spec 743 — absolute clk, monotonic
  tod.todtickcounter = 0;
  tod.power_tickcounter = 0;
  tod.power_ticks = 0;
}

/**
 * VICE: check_ciatodalarm (ciacore.c lines 236-242).
 *
 * Compare the 4 BCD register bytes against the alarm. Match → caller
 * sets CIA_IM_TOD via cia_set_irq_flag. We return a boolean since the
 * IRQ machinery lives in the CIA core.
 */
export function checkCiaTodAlarm(tod: CiaTodState, cCia: Uint8Array): boolean {
  return (
    tod.todalarm[0] === cCia[CIA_TOD_TEN] &&
    tod.todalarm[1] === cCia[CIA_TOD_SEC] &&
    tod.todalarm[2] === cCia[CIA_TOD_MIN] &&
    tod.todalarm[3] === cCia[CIA_TOD_HR]
  );
}

/**
 * VICE: ciacore_inttod (ciacore.c lines 1854-2003) but WITHOUT the
 * `power_freq == 0` early-return path (handled by caller arming) and
 * WITHOUT the TODRANDOM jitter (deterministic emulation, matches the
 * `ifndef TODRANDOM` branch in VICE which we always take so behavior
 * is repeatable across runs).
 *
 * Returns `true` if a TOD-alarm match was hit (caller sets CIA_IM_TOD).
 * Updates `tod.todclk` to the next scheduled fire-clk; caller is
 * responsible for re-arming the alarm with that value.
 */
export function todTickCallback(
  tod: CiaTodState,
  cCia: Uint8Array,
  cra: BYTE,
  currentClk: CLOCK,
): boolean {
  if (tod.power_freq === 0) {
    // Mirrors VICE early-return: re-check in ~1/10s.
    tod.todclk = currentClk + 100000; // Spec 743 — absolute clk, monotonic
    return false;
  }

  // ciacore.c lines 1879-1903 — schedule next tick using the 50/60Hz
  // bookkeeping (no TODRANDOM here for determinism).
  tod.todticks = u32(Math.floor(tod.ticks_per_sec / tod.power_freq));
  const tclk = u32(Math.floor((tod.power_tickcounter * tod.ticks_per_sec) / tod.power_freq));
  if (tod.power_ticks < tclk) {
    tod.todticks = u32(tod.todticks + 1);
  } else if (tod.power_ticks > tclk) {
    tod.todticks = u32(tod.todticks - 1);
  }
  tod.power_tickcounter++;
  if (tod.power_tickcounter >= tod.power_freq) {
    tod.todticks = u32(tod.ticks_per_sec - tod.power_ticks);
    tod.power_tickcounter = 0;
    tod.power_ticks = 0;
  } else {
    tod.power_ticks = u32(tod.power_ticks + tod.todticks);
  }

  tod.todclk = currentClk + tod.todticks; // Spec 743 — absolute clk, monotonic

  // ciacore.c lines 1908-1933 — 3-bit ring counter that divides power
  // ticks down to 10Hz. 50Hz matches at counter=4, 60Hz matches at 5.
  let update = 0;
  if (!tod.todstopped) {
    update = (tod.todtickcounter === ((cra & CIA_CRA_TODIN_50HZ) ? 4 : 5)) ? 1 : 0;
    if (update) {
      tod.todtickcounter = 0;
    } else {
      tod.todtickcounter++;
      if (tod.todtickcounter > 5) tod.todtickcounter = 0;
    }
  }

  if (!update) return false;

  // ciacore.c lines 1935-2002 — advance the BCD counters.
  let ts = cCia[CIA_TOD_TEN]! & 0x0f;
  let sl = cCia[CIA_TOD_SEC]! & 0x0f;
  let sh = (cCia[CIA_TOD_SEC]! >> 4) & 0x07;
  let ml = cCia[CIA_TOD_MIN]! & 0x0f;
  let mh = (cCia[CIA_TOD_MIN]! >> 4) & 0x07;
  let hl = cCia[CIA_TOD_HR]! & 0x0f;
  let hh = (cCia[CIA_TOD_HR]! >> 4) & 0x01;
  let pm = cCia[CIA_TOD_HR]! & 0x80;

  ts = (ts + 1) & 0x0f;
  if (ts === 10) {
    ts = 0;
    sl = (sl + 1) & 0x0f;
    if (sl === 10) {
      sl = 0;
      sh = (sh + 1) & 0x07;
      if (sh === 6) {
        sh = 0;
        ml = (ml + 1) & 0x0f;
        if (ml === 10) {
          ml = 0;
          mh = (mh + 1) & 0x07;
          if (mh === 6) {
            mh = 0;
            // Hours 1-12 with AM/PM toggle.
            if (((hh === 1) && (hl === 2)) || ((hh === 0) && (hl === 9))) {
              hl = hh;
              hh ^= 1;
            } else {
              hl = (hl + 1) & 0x0f;
              if ((hh === 1) && (hl === 2)) pm ^= 0x80;
            }
          }
        }
      }
    }
  }

  cCia[CIA_TOD_TEN] = u8(ts);
  cCia[CIA_TOD_SEC] = u8(sl | (sh << 4));
  cCia[CIA_TOD_MIN] = u8(ml | (mh << 4));
  cCia[CIA_TOD_HR] = u8(hl | (hh << 4) | pm);

  return checkCiaTodAlarm(tod, cCia);
}

/**
 * VICE: TOD store path — ciacore.c lines 860-912.
 *
 * Returns `true` if the write changed anything that should trigger a
 * `check_ciatodalarm` call (used by the caller to fold into the IFR
 * pipeline). CRB bit 7 selects time-vs-alarm target.
 */
export function todStore(
  tod: CiaTodState,
  cCia: Uint8Array,
  addr: number,
  byte: BYTE,
  crb: BYTE,
): boolean {
  // Mask byte per VICE addr-specific rules.
  let v = u8(byte);
  if (addr === CIA_TOD_HR) {
    v &= 0x9f;
    // Flip AM/PM on hour 12 (only when writing time, not alarm).
    if ((v & 0x1f) === 0x12 && (crb & CIA_CRB_ALARM_ALARM) === 0) {
      v ^= 0x80;
    }
  } else if (addr === CIA_TOD_MIN || addr === CIA_TOD_SEC) {
    v &= 0x7f;
  } else if (addr === CIA_TOD_TEN) {
    v &= 0x0f;
  }

  let changed = false;
  if (crb & CIA_CRB_ALARM_ALARM) {
    const idx = addr - CIA_TOD_TEN;
    changed = tod.todalarm[idx] !== v;
    tod.todalarm[idx] = v;
  } else {
    if (addr === CIA_TOD_TEN) {
      // Restart ticking on TEN write (mirrors VICE).
      if (tod.todstopped) {
        tod.todtickcounter = 0;
        tod.todstopped = 0;
      }
    }
    if (addr === CIA_TOD_HR) {
      tod.todstopped = 1;
    }
    changed = cCia[addr] !== v;
    if (changed) cCia[addr] = v;
  }

  return changed;
}

/**
 * VICE: TOD read path — ciacore.c lines 1260-1276.
 *
 * Reading HR latches all 4 registers; reading TEN releases the latch.
 * Returns the byte to be reported to the CPU.
 */
export function todRead(tod: CiaTodState, cCia: Uint8Array, addr: number): BYTE {
  if (!tod.todlatched) {
    tod.todlatch[0] = cCia[CIA_TOD_TEN]!;
    tod.todlatch[1] = cCia[CIA_TOD_SEC]!;
    tod.todlatch[2] = cCia[CIA_TOD_MIN]!;
    tod.todlatch[3] = cCia[CIA_TOD_HR]!;
  }
  if (addr === CIA_TOD_TEN) tod.todlatched = 0;
  if (addr === CIA_TOD_HR) tod.todlatched = 1;
  return u8(tod.todlatch[addr - CIA_TOD_TEN]!);
}
