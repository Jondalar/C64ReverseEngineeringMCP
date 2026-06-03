// Spec 151 — SID 6581 register-state 1:1 VICE port (B-level, no audio).
//
// Source: VICE 3.7.1 src/sid/sid.c (register dispatch wrapper) +
// src/sid/fastsid.c (voice state, ADSR transitions, doosc wave-shape).
// Audio output, ring modulation, oscillator hard sync, filter audio,
// per-revision quirks (6581 vs 8580) and full voices 1+2 waveform
// generation are explicitly OUT OF SCOPE (V3 backlog).
//
// What this implements (B-level):
//   - All 29 SID register R/W ($D400-$D41C). $D41D-$D41F return 0
//     (open bus / unused, matching fastsid_read default branch when
//     laststorebit has decayed, plus our internal contract).
//   - Mirroring $D400-$D7FF handled by installSid() — 32-byte tile.
//   - Per-cycle voice-3 phase advance for $D41B osc3 readback.
//   - Wave-shape-aware $D41B (triangle/sawtooth/pulse/noise),
//     combined waveforms via AND of individual outputs (per spec 151,
//     close approximation; resid bit-fidelity deferred to V3).
//   - ADSR state machine per voice with PAL cycles-per-step rate
//     table (real-hardware values; equivalent to VICE adrtable scaled
//     by speed1).
//   - $D41C env3 readback = voice-3 envelope value (0..255).
//   - POT pin readback ($D419/$D41A) — preserved from Sprint 108
//     `potReader` callback hook.
//   - Filter register state preserved (no audio sim) — register R/W
//     of $D415-$D418 round-trip without altering audio output.
//   - writeTrace hook (Sprint 109 / Spec 131 M7.2) preserved.
//
// Hybrid naming: internal voice fields use VICE names verbatim
// (greppable against fastsid.c) — `f`, `fs`, `pw`, `noise`, `attack`,
// `decay`, `sustain`, `release`, `adsr`, `adsrm`, `gateflip`,
// `update`, `rv`, `wt_select`. Public class API uses camelCase TS
// conventions. uint helpers from `../util/uint.ts` enforce VICE
// width semantics at every register R/W boundary.

import { u8, u16, u32, type BYTE, type WORD, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Register addresses ($D400 + offset). VICE sid.c uses `addr & 0x1f`.
// ---------------------------------------------------------------------------
export const SID_NUM_REGS = 32;
export const SID_NUM_VOICES = 3;

// Voice-relative offsets (VICE fastsid.c voice_t->d[0..6] mapping).
const V_FREQ_LO = 0;   // $D400/$D407/$D40E
const V_FREQ_HI = 1;   // $D401/$D408/$D40F
const V_PW_LO   = 2;   // $D402/$D409/$D410
const V_PW_HI   = 3;   // $D403/$D40A/$D411 (low nibble)
const V_CTRL    = 4;   // $D404/$D40B/$D412
const V_AD      = 5;   // $D405/$D40C/$D413
const V_SR      = 6;   // $D406/$D40D/$D414

// Filter / volume register offsets.
const SR_FC_LO   = 0x15; // filter cutoff lo (3 bits)
const SR_FC_HI   = 0x16; // filter cutoff hi (8 bits)
const SR_RES_FT  = 0x17; // resonance + filter routing
const SR_MODE_VOL = 0x18; // filter mode + volume

// Read-only registers.
const SR_POT_X = 0x19;
const SR_POT_Y = 0x1a;
const SR_OSC3  = 0x1b;
const SR_ENV3  = 0x1c;

// ---------------------------------------------------------------------------
// ADSR state machine (VICE fastsid.c lines 65-69).
// ---------------------------------------------------------------------------
//   #define ATTACK   0
//   #define DECAY    1
//   #define SUSTAIN  2
//   #define RELEASE  3
//   #define IDLE     4
export const ADSR_ATTACK = 0;
export const ADSR_DECAY = 1;
export const ADSR_SUSTAIN = 2;
export const ADSR_RELEASE = 3;
export const ADSR_IDLE = 4;

// ---------------------------------------------------------------------------
// ADSR rate table — cycles-per-envelope-step at PAL clock (985248 Hz).
// These are the real-hardware (Yannes datasheet) periods. Equivalent to
// VICE fastsid.c adrtable[] (line 236) scaled by speed1 — VICE works in
// per-sample fixed-point but lands on the same effective cycles-per-step
// when integrated to PAL clock cycles. Spec 151 mandates this table.
// Index = 4-bit value from $Dx05 high-nibble (attack) / low-nibble (decay)
// or $Dx06 low-nibble (release).
export const ADSR_ATTACK_CYCLES = [
  9, 32, 63, 95, 149, 220, 267, 313,
  392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
] as const;
// Decay/release are 3× attack per VICE/Yannes model (exptable scale 1).
export const ADSR_DECAY_RELEASE_CYCLES = ADSR_ATTACK_CYCLES.map((c) => c * 3);

// ---------------------------------------------------------------------------
// Noise LFSR seed (VICE fastsid.c #define NSEED 0x7ffff8).
// Voice-3 LFSR `rv` is the 23-bit shift register; reset to NSEED on TEST
// bit (control bit 3) set.
const NSEED = 0x7ffff8;

// ---------------------------------------------------------------------------
// Voice state — VICE field names verbatim where applicable.
// ---------------------------------------------------------------------------
interface Voice {
  // VICE: uint32_t f — counter / phase. Spec 151 uses 24-bit phase
  // advanced per cycle by `freq` (raw 16-bit). We store as full 32-bit
  // CLOCK and mask to 24 bits on readback math.
  f: CLOCK;
  // VICE: uint32_t fs — counter step / sample. Spec 151: per-cycle freq.
  fs: CLOCK;
  // VICE: uint32_t pw — pulse threshold (12-bit, $Dx02 + low-nibble $Dx03).
  pw: WORD;
  // VICE: uint8_t noise — 1 if NOISE wave selected ($Dx04 bit 7).
  noise: 0 | 1;
  // VICE: uint8_t — bitmap of selected wave forms (control bits 4..7
  // shifted to 0..3).
  wt_select: BYTE;
  // VICE: uint8_t attack/decay/sustain/release (4-bit each, derived from
  // $Dx05 / $Dx06).
  attack: BYTE;
  decay: BYTE;
  sustain: BYTE;
  release: BYTE;
  // VICE: uint8_t sync — hard-sync enable (control bit 1). Stored for
  // V3 future use; not acted on at B-level.
  sync: 0 | 1;
  // VICE: uint8_t adsrm — current ADSR state.
  adsrm: number;
  // VICE: uint32_t adsr — internal envelope counter. We use a simpler
  // 0..255 envelope value for B-level $D41C readback; matches the
  // datasheet semantics ((adsr >> 23) & 0xff) at the surface.
  adsr_value: BYTE;
  // Sub-cycle accumulator per current rate. Resets when state changes.
  cycle_accum: number;
  // VICE: uint8_t gateflip — set when GATE bit toggled mid-state to
  // force ADSR re-evaluation. We act on it immediately at the write.
  gateflip: 0 | 1;
  // Previous GATE bit value, for edge detection on $Dx04 bit 0.
  prev_gate: 0 | 1;
  // VICE: uint32_t rv — noise shift register (23 bits, advanced when
  // bit f>>28 transitions).
  rv: number;
}

function makeVoice(): Voice {
  return {
    f: 0,
    fs: 0,
    pw: 0,
    noise: 0,
    wt_select: 0,
    attack: 0,
    decay: 0,
    sustain: 0,
    release: 0,
    sync: 0,
    adsrm: ADSR_IDLE,
    adsr_value: 0,
    cycle_accum: 0,
    gateflip: 0,
    prev_gate: 0,
    rv: NSEED,
  };
}

// ---------------------------------------------------------------------------
// Snapshot type — v2 schema (Spec 145 family).
// ---------------------------------------------------------------------------
export interface SidSnapshot {
  v: 2;
  regs: number[];
  voices: Array<{
    f: number; fs: number; pw: number; noise: number;
    wt_select: number; attack: number; decay: number;
    sustain: number; release: number; sync: number;
    adsrm: number; adsr_value: number; cycle_accum: number;
    gateflip: number; prev_gate: number; rv: number;
  }>;
}

// ---------------------------------------------------------------------------
// Sid6581 — B-level VICE port.
// ---------------------------------------------------------------------------
export class Sid6581 {
  /** SID register file ($D400-$D41F mirror tile). */
  public readonly regs = new Uint8Array(SID_NUM_REGS);

  /**
   * Sprint 108 / Spec 151 — POT pin readback bridge. Caller (session)
   * sets a getter returning paddle values 0..3 (POTAX/AY/BX/BY). Real
   * HW: $D419 = port A, $D41A = port B; one paddle per port routes
   * through internally. Default exposes paddle 0 → $D419 and paddle 2
   * → $D41A.
   */
  public potReader?: (idx: 0 | 1) => number;

  /**
   * Sprint 109 / Spec 131 M7.2 — write-trace sink. Caller installs a
   * callback to receive `(addr, value)` per write so analysis tools
   * can extract init/play structure without audio synthesis.
   */
  public writeTrace?: (addr: number, value: number) => void;

  private readonly voices: Voice[] = [makeVoice(), makeVoice(), makeVoice()];

  // ---- public API ----------------------------------------------------------

  /**
   * VICE: fastsid_reset() — clears all 32 registers via fastsid_store(0).
   * Per ciacore.c reset pattern, plus voice state to power-on defaults.
   */
  reset(): void {
    this.regs.fill(0);
    for (let i = 0; i < SID_NUM_VOICES; i++) {
      this.voices[i] = makeVoice();
    }
  }

  /**
   * VICE: sid_read_chip() + fastsid_read(). 1:1 dispatch.
   * `addr` is the absolute bus address; we mask `& 0x1f` per VICE.
   */
  read(addr: number): BYTE {
    const a = addr & 0x1f;
    switch (a) {
      case SR_POT_X:
        // Spec 429: unconnected POT default = $80 (VICE), not 0.
        return u8(this.potReader?.(0) ?? 0x80);
      case SR_POT_Y:
        return u8(this.potReader?.(1) ?? 0x80);
      case SR_OSC3:
        return this.readOsc3();
      case SR_ENV3:
        // VICE fastsid.c line 1119: `ret = (uint8_t)(psid->v[2].adsr >> 23);`
        // Our adsr_value is already 0..255 normalized.
        return u8(this.voices[2]!.adsr_value);
      case 0x1d: case 0x1e: case 0x1f:
        // Unused / open bus — VICE returns laststore decayed; B-level
        // returns 0 (matches existing test expectation).
        return 0;
      default:
        // Writable registers are write-only on real hardware (returns
        // laststore decayed in VICE). For B-level + existing tests we
        // round-trip the latched value (Sprint 109 M7.1 contract).
        return u8(this.regs[a]!);
    }
  }

  /**
   * Spec 754 §3.4 / BUG-038 — side-effect-free register peek (VICE sid
   * peek analog). Returns the latched register-file value WITHOUT the
   * osc3/env readback advance or the POT-reader callback. SID has no
   * read-to-clear latch, but osc3 ($D41B) / env3 ($D41C) reads observe
   * live voice-3 phase/envelope — a peek returns the last stored register
   * byte instead (best-effort, documented), never advancing voice state.
   */
  peek(addr: number): BYTE {
    return u8(this.regs[addr & 0x1f]!);
  }

  /**
   * VICE: sid_store_chip() + fastsid_store(). 1:1 dispatch.
   * Side effects:
   *   - Update voice state for affected voice (regs 0-6 = V0,
   *     7-13 = V1, 14-20 = V2).
   *   - GATE-edge detection on $Dx04 bit 0 → ADSR transitions.
   *   - TEST bit ($Dx04 bit 3) → reset phase + LFSR seed.
   */
  write(addr: number, value: number): void {
    const a = addr & 0x1f;
    const v = u8(value);
    const prev = this.regs[a]!;
    this.regs[a] = v;
    this.writeTrace?.(a, v);

    // VICE fastsid.c fastsid_store() — case dispatch by register.
    if (a <= 0x06) {
      this.applyVoiceWrite(0, a, v, prev);
    } else if (a <= 0x0d) {
      this.applyVoiceWrite(1, a - 7, v, prev);
    } else if (a <= 0x14) {
      this.applyVoiceWrite(2, a - 14, v, prev);
    }
    // Filter regs $D415-$D418: register state only (no audio).
    // $D419-$D41F: writes are accepted but read paths special-case.
  }

  /**
   * Advance SID by N cycles. B-level: only voice-3 phase advances
   * (needed for $D41B osc3 readback) plus all-voices ADSR.
   */
  tick(cycles: number): void {
    if (cycles <= 0) return;
    // Voice 3 phase + LFSR advance for osc3 readback.
    this.advanceVoice3(cycles);
    // ADSR per voice.
    for (let i = 0; i < SID_NUM_VOICES; i++) {
      this.advanceAdsr(i, cycles);
    }
  }

  // ---- snapshot ------------------------------------------------------------

  snapshot(): SidSnapshot {
    return {
      v: 2,
      regs: Array.from(this.regs),
      voices: this.voices.map((vc) => ({ ...vc })),
    };
  }

  restore(snap: SidSnapshot): void {
    if (snap.v !== 2) throw new Error(`SidSnapshot: unsupported version ${snap.v}`);
    for (let i = 0; i < SID_NUM_REGS; i++) this.regs[i] = u8(snap.regs[i] ?? 0);
    for (let i = 0; i < SID_NUM_VOICES; i++) {
      const s = snap.voices[i]!;
      this.voices[i] = {
        f: u32(s.f), fs: u32(s.fs), pw: u16(s.pw),
        noise: (s.noise ? 1 : 0) as 0 | 1,
        wt_select: u8(s.wt_select),
        attack: u8(s.attack), decay: u8(s.decay),
        sustain: u8(s.sustain), release: u8(s.release),
        sync: (s.sync ? 1 : 0) as 0 | 1,
        adsrm: s.adsrm,
        adsr_value: u8(s.adsr_value),
        cycle_accum: s.cycle_accum,
        gateflip: (s.gateflip ? 1 : 0) as 0 | 1,
        prev_gate: (s.prev_gate ? 1 : 0) as 0 | 1,
        rv: u32(s.rv),
      };
    }
  }

  // ---- internal: voice register writes ------------------------------------

  /**
   * VICE: fastsid_store() per-voice handling — fastsid.c lines 1133-1183.
   * `relAddr` is 0..6 (voice-local).
   */
  private applyVoiceWrite(idx: number, relAddr: number, value: BYTE, prev: BYTE): void {
    const vc = this.voices[idx]!;
    switch (relAddr) {
      case V_FREQ_LO:
      case V_FREQ_HI:
        // VICE setup_voice line 552: pv->fs = speed1 * (d[0] + d[1]*256).
        // Per-cycle B-level: fs = freq16.
        vc.fs = u32(this.voiceReg(idx, V_FREQ_LO) | (this.voiceReg(idx, V_FREQ_HI) << 8));
        break;
      case V_PW_LO:
      case V_PW_HI:
        // VICE setup_voice line 549: pw = (d[2] + (d[3] & 0x0f) * 256).
        vc.pw = u16(this.voiceReg(idx, V_PW_LO) | ((this.voiceReg(idx, V_PW_HI) & 0x0f) << 8));
        break;
      case V_CTRL: {
        // VICE fastsid.c case 4/11/18 — gateflip tracking + voice update.
        if ((prev ^ value) & 0x01) vc.gateflip = 1;
        // VICE setup_voice line 551: sync = d[4] & 0x02.
        vc.sync = ((value & 0x02) ? 1 : 0) as 0 | 1;
        // VICE: noise = (d[4] & 0xf0) == 0x80. We track wt_select as
        // the high nibble of d[4] (waveform select bits).
        vc.wt_select = u8((value >> 4) & 0x0f);
        vc.noise = ((value & 0x80) ? 1 : 0) as 0 | 1;
        // TEST bit (d[4] & 0x08): VICE setup_voice line 554-557 —
        // f = fs = 0, rv = NSEED.
        if (value & 0x08) {
          vc.f = 0; vc.fs = 0; vc.rv = NSEED;
        } else {
          // Restore fs from current freq registers in case TEST clears.
          vc.fs = u32(this.voiceReg(idx, V_FREQ_LO) | (this.voiceReg(idx, V_FREQ_HI) << 8));
        }
        // GATE-edge ADSR transitions — VICE setup_voice 660-678.
        const newGate = (value & 0x01) as 0 | 1;
        if (newGate && !vc.prev_gate) {
          // Rising edge → ATTACK.
          vc.adsrm = ADSR_ATTACK;
          vc.cycle_accum = 0;
        } else if (!newGate && vc.prev_gate) {
          // Falling edge → RELEASE.
          vc.adsrm = ADSR_RELEASE;
          vc.cycle_accum = 0;
        }
        vc.prev_gate = newGate;
        vc.gateflip = 0;
        break;
      }
      case V_AD:
        // VICE setup_voice line 544-545: attack = d[5] >> 4, decay = d[5] & 0x0f.
        vc.attack = u8((value >> 4) & 0x0f);
        vc.decay  = u8(value & 0x0f);
        break;
      case V_SR:
        // VICE setup_voice line 546-547: sustain = d[6] >> 4, release = d[6] & 0x0f.
        vc.sustain = u8((value >> 4) & 0x0f);
        vc.release = u8(value & 0x0f);
        break;
    }
  }

  /** Read per-voice register (0..6) by absolute index into regs. */
  private voiceReg(idx: number, rel: number): BYTE {
    return this.regs[idx * 7 + rel]!;
  }

  // ---- internal: voice 3 phase + LFSR --------------------------------------

  /**
   * VICE: per-sample phase advance pattern (fastsid_calculate_single_sample
   * lines 794+). Spec 151 says u24 phase advanced per cycle by raw freq16.
   * LFSR (`rv`) NSHIFT-advances when phase MSB transitions (VICE pattern
   * line 794: `if ((v->f += v->fs) < v->fs) NSHIFT(rv, 16)`).
   */
  private advanceVoice3(cycles: number): void {
    const vc = this.voices[2]!;
    // TEST bit holds phase at 0.
    const ctrl = this.regs[14 + V_CTRL]!;
    if (ctrl & 0x08) return;
    // Bulk-step the 24-bit phase. Detect each wrap to advance the LFSR.
    // For typical freq values this loops 1 wrap per ~16-256 cycles, so
    // we iterate per-cycle for correctness (B-level: cheap enough).
    const fs = vc.fs;
    if (fs === 0) {
      // Still advance LFSR via cycle clock for non-zero entropy on
      // $D41B reads (matches existing osc3-changes-over-time test).
      // VICE noise output requires phase advance to NSHIFT; with fs=0
      // it stays put. Existing test expects change, but only when
      // freq != 0 in real HW. Keep static here — test will set freq.
      return;
    }
    for (let i = 0; i < cycles; i++) {
      const before = vc.f;
      vc.f = u32((before + fs) & 0xffffff);
      // 24-bit wrap detection: if new < old, we wrapped past 2^24.
      // VICE pattern uses 32-bit wrap; we use 24-bit per Spec 151.
      if (vc.f < before) {
        // NSHIFT(rv, 16) — VICE fastsid.c line 87.
        vc.rv = nshift(vc.rv, 16);
      }
    }
  }

  /**
   * VICE: doosc() (fastsid.c line 341 wavetables / line 349 non-wavetable)
   * adapted to Spec 151 wave-shape arithmetic. 8-bit value for $D41B.
   * Combined waveforms returned as AND of individual outputs.
   */
  private readOsc3(): BYTE {
    const vc = this.voices[2]!;
    const ctrl = this.regs[14 + V_CTRL]!;
    const wave = (ctrl >> 4) & 0x0f;
    if (wave === 0) return 0;
    // Compute per-shape output, AND together.
    let out = 0xff;
    let any = false;
    if (ctrl & 0x10) { // triangle
      // Spec 151 line 58: tri_out = (phase >> 11) ^ ((phase & 0x800000) ? 0xfff : 0)
      // take high 8 bits.
      const tri12 = ((vc.f >>> 11) ^ ((vc.f & 0x800000) ? 0xfff : 0)) & 0xfff;
      out &= (tri12 >> 4) & 0xff;
      any = true;
    }
    if (ctrl & 0x20) { // sawtooth
      // Spec 151 line 59: (phase >> 16) & 0xff.
      out &= (vc.f >>> 16) & 0xff;
      any = true;
    }
    if (ctrl & 0x40) { // pulse
      // Spec 151 line 60: phase < (pulsewidth << 12) ? 0xff : 0
      // (pw is 12-bit; shifted into 24-bit phase domain).
      const pwShifted = (vc.pw << 12) >>> 0;
      out &= (vc.f < pwShifted) ? 0x00 : 0xff;
      any = true;
    }
    if (ctrl & 0x80) { // noise
      // Spec 151 line 62: LFSR derived. VICE NVALUE() picks bits from
      // rv to form 8-bit noise output. Match VICE pattern.
      out &= nvalue(vc.rv);
      any = true;
    }
    return any ? u8(out) : 0;
  }

  // ---- internal: ADSR ------------------------------------------------------

  /**
   * VICE: trigger_adsr() / set_adsr() (fastsid.c 387-450) collapsed to
   * cycles-per-step rate-table walk. Spec 151 mandates real-HW PAL
   * cycles-per-step values; effective behavior matches VICE adrtable
   * scaled by speed1.
   */
  private advanceAdsr(idx: number, cycles: number): void {
    const vc = this.voices[idx]!;
    if (vc.adsrm === ADSR_IDLE) {
      vc.adsr_value = 0;
      return;
    }
    if (vc.adsrm === ADSR_SUSTAIN) {
      // VICE set_adsr SUSTAIN line 410: adsrs = 0; envelope holds at
      // sustain level. Recompute in case sustain nibble changed.
      vc.adsr_value = u8(vc.sustain * 17);
      return;
    }
    let left = cycles;
    while (left > 0) {
      let rate: number;
      switch (vc.adsrm) {
        case ADSR_ATTACK:
          rate = ADSR_ATTACK_CYCLES[vc.attack]!;
          break;
        case ADSR_DECAY:
          rate = ADSR_DECAY_RELEASE_CYCLES[vc.decay]!;
          break;
        case ADSR_RELEASE:
          rate = ADSR_DECAY_RELEASE_CYCLES[vc.release]!;
          break;
        default:
          return;
      }
      const need = rate - vc.cycle_accum;
      if (left < need) {
        vc.cycle_accum += left;
        return;
      }
      left -= need;
      vc.cycle_accum = 0;
      // Step envelope by ±1 per VICE trigger_adsr semantics.
      switch (vc.adsrm) {
        case ADSR_ATTACK:
          if (vc.adsr_value < 0xff) vc.adsr_value = u8(vc.adsr_value + 1);
          if (vc.adsr_value >= 0xff) {
            // VICE trigger_adsr ATTACK→DECAY (line 438).
            vc.adsrm = ADSR_DECAY;
            vc.cycle_accum = 0;
          }
          break;
        case ADSR_DECAY: {
          const sustainLevel = u8(vc.sustain * 17);
          if (vc.adsr_value <= sustainLevel) {
            vc.adsrm = ADSR_SUSTAIN;
            vc.adsr_value = sustainLevel;
            return;
          }
          vc.adsr_value = u8(vc.adsr_value - 1);
          break;
        }
        case ADSR_RELEASE:
          if (vc.adsr_value === 0) {
            vc.adsrm = ADSR_IDLE;
            return;
          }
          vc.adsr_value = u8(vc.adsr_value - 1);
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VICE noise helpers — fastsid.c lines 85-91 verbatim ports.
// ---------------------------------------------------------------------------
// VICE NSHIFT(v, n):
//   ((v << n) | ((((v >> (23-n)) ^ (v >> (18-n))) & ((1<<n)-1))))
function nshift(v: number, n: number): number {
  const a = (v << n) >>> 0;
  const b = ((v >>> (23 - n)) ^ (v >>> (18 - n))) & ((1 << n) - 1);
  return (a | b) >>> 0;
}

// VICE NVALUE(v) packs noise bits using LSB/MID/MSB tables. Equivalent
// scalar formula (per fastsid.c init_filter lines 1057-1064 reverse):
//   bit 7: v[22]   bit 6: v[20]   bit 5: v[16]   bit 4: v[13]
//   bit 3: v[11]   bit 2: v[7]    bit 1: v[4]    bit 0: v[2]
function nvalue(v: number): number {
  return (
    (((v >>> 22) & 1) << 7) |
    (((v >>> 20) & 1) << 6) |
    (((v >>> 16) & 1) << 5) |
    (((v >>> 13) & 1) << 4) |
    (((v >>> 11) & 1) << 3) |
    (((v >>> 7)  & 1) << 2) |
    (((v >>> 4)  & 1) << 1) |
    (((v >>> 2)  & 1) << 0)
  ) & 0xff;
}

// ---------------------------------------------------------------------------
// Bus install — $D400-$D7FF mirror tile (32-byte stride).
// ---------------------------------------------------------------------------
export function installSid(bus: {
  registerIoHandler(addr: number, h: { read: (a: number) => number; write: (a: number, v: number) => void; peek?: (a: number) => number }): void;
}): Sid6581 {
  const sid = new Sid6581();
  for (let a = 0xD400; a < 0xD800; a++) {
    bus.registerIoHandler(a, {
      read: () => sid.read(a),
      write: (_addr, value) => sid.write(a, value),
      // Spec 754 §3.4 / BUG-038 — side-effect-free peek for the bank lens.
      peek: () => sid.peek(a),
    });
  }
  return sid;
}
