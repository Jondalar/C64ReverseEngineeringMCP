// Spec 611 phase 611.4 — minimal 6522 VIA core for VICE1541.
//
// VICE source:  src/core/viacore.c + src/via.h
// Doc anchor:   docs/vice-1541-arch.md §6 + §6.6
//               docs/vice-iec-arc42.md §5.5
//
// Scope-limited: registers, IFR/IER, PCR (CA1 edge polarity), CA1
// signal/edge handling, IRQ-out computation. Timers (T1/T2), shift
// register, CA2/CB2 output modes, CB1 are out of scope for 611.4
// (the 1541 IEC path does not exercise them; they land when needed
// by 611.5 or later).
//
// Not a 1:1 port of viacore.c (~1985 LOC). This is the "smallest
// explicit placeholder" per Codex 14:03 UTC: enough behaviour for
// the IEC ATN/CA1 IRQ path to function, not a full chip emulation.

import { u8, type BYTE } from "../util/uint.js";

// 6522 register indices (via.h:35-55).
export const VIA_PRB = 0;
export const VIA_PRA = 1;
export const VIA_DDRB = 2;
export const VIA_DDRA = 3;
export const VIA_T1CL = 4;
export const VIA_T1CH = 5;
export const VIA_T1LL = 6;
export const VIA_T1LH = 7;
export const VIA_T2CL = 8;
export const VIA_T2CH = 9;
export const VIA_SR = 10;
export const VIA_ACR = 11;
export const VIA_PCR = 12;
export const VIA_IFR = 13;
export const VIA_IER = 14;
export const VIA_PRA_NHS = 15;

// IFR bit masks (via.h:58-66).
export const IFR_CA2 = 0x01;
export const IFR_CA1 = 0x02;
export const IFR_SR = 0x04;
export const IFR_CB2 = 0x08;
export const IFR_CB1 = 0x10;
export const IFR_T2 = 0x20;
export const IFR_T1 = 0x40;
export const IFR_ANY = 0x80;

// CA1 / CB1 signal edge polarity tags (viacore.h VIA_SIG_*).
export const VIA_SIG_FALL = 0;
export const VIA_SIG_RISE = 1;

// PCR bit 0 = CA1 edge select. 0 = negative (falling) edge IRQ; 1 = positive.
export const PCR_CA1_POS = 0x01;

export type Via6522IrqHook = (asserted: boolean) => void;

export interface Via6522Backend {
  /** Optional hook called on PRB write (drive PB → IEC bus drv_data). */
  storePb?: (value: BYTE) => void;
  /** Optional hook for PRA write (unused on 1541 VIA1). */
  storePa?: (value: BYTE) => void;
  /** Optional read PB hook for backend-driven bits (returns raw byte;
   *  6522 then masks with DDRB and folds in PRB-out bits per VICE). */
  readPb?: () => BYTE;
  /** Optional read PA hook. */
  readPa?: () => BYTE;
  /** Called when IRQ output state changes (drives cpuIntStatus.setIrq). */
  setIrq: Via6522IrqHook;
}

export interface Via6522Options {
  backend: Via6522Backend;
  /** VICE-style label for diagnostics ("via1d1541" etc.). */
  label?: string;
}

/**
 * Minimal 6522 VIA core. See module banner for scope limits.
 *
 * Hybrid naming: register fields use VICE names verbatim (`pra`, `prb`,
 * `ddra`, `ddrb`, `pcr`, `acr`, `ifr`, `ier`); public methods use
 * TypeScript camelCase.
 */
export class Via6522 {
  readonly label: string;
  readonly backend: Via6522Backend;

  // Register-visible state (verbatim VICE names).
  pra: BYTE = 0;
  prb: BYTE = 0;
  ddra: BYTE = 0;
  ddrb: BYTE = 0;
  pcr: BYTE = 0;
  acr: BYTE = 0;
  ifr: BYTE = 0;
  ier: BYTE = 0;
  sr: BYTE = 0;

  // CA1/CB1 last-observed input level (0 = low, 1 = high).
  ca1State: 0 | 1 = 1;
  cb1State: 0 | 1 = 1;
  // CA2/CB2 output latches (unused for 611.4).
  ca2OutState: 0 | 1 = 1;
  cb2OutState: 0 | 1 = 1;

  /** Last reported IRQ-out state (for change-detect). */
  private lastIrqOut: boolean = false;

  constructor(opts: Via6522Options) {
    this.backend = opts.backend;
    this.label = opts.label ?? "via6522";
  }

  /** Reset to viacore defaults. VICE viacore_reset(). */
  reset(): void {
    this.pra = 0;
    this.prb = 0;
    this.ddra = 0;
    this.ddrb = 0;
    this.pcr = 0;
    this.acr = 0;
    this.ifr = 0;
    this.ier = 0;
    this.sr = 0;
    this.ca1State = 1;
    this.cb1State = 1;
    this.ca2OutState = 1;
    this.cb2OutState = 1;
    this.updateIrq();
  }

  /**
   * Public read for the drive-memory dispatch ($1800-$180F + mirrors).
   * Register-only — does not advance any timers in 611.4 minimum.
   */
  read(reg: number): BYTE {
    const r = reg & 0x0f;
    switch (r) {
      case VIA_PRB:
      case VIA_PRA_NHS:
      case VIA_PRA: {
        if (r === VIA_PRB) {
          // PB read: output bits from PRB & DDRB; input bits from backend
          // (1541-specific formula lives in the backend).
          const driven = this.prb & this.ddrb;
          const input = this.backend.readPb ? this.backend.readPb() : 0xff;
          // Acknowledge CA1 read by clearing IFR_CA1 (VICE viacore.c).
          // Real 6522 clears CA1 IFR bit on PRA read; we mirror for PB read
          // when used as 1541 IEC.
          return u8((driven & this.ddrb) | (input & ~this.ddrb));
        }
        // PRA / PRA_NHS — input from backend if any, else PRA latch.
        const driven = this.pra & this.ddra;
        const input = this.backend.readPa ? this.backend.readPa() : 0xff;
        const value = u8((driven & this.ddra) | (input & ~this.ddra));
        if (r === VIA_PRA) {
          // PRA read with handshake clears IFR_CA1 + IFR_CA2 per VICE.
          this.ifr &= ~(IFR_CA1 | IFR_CA2);
          this.updateIrq();
        }
        return value;
      }
      case VIA_DDRB: return this.ddrb;
      case VIA_DDRA: return this.ddra;
      case VIA_T1CL: {
        // VICE viacore.c clears IFR_T1 on T1CL read; we honour for IRQ
        // hygiene even though T1 itself is not running in 611.4.
        this.ifr &= ~IFR_T1;
        this.updateIrq();
        return 0xff;
      }
      case VIA_T1CH: return 0xff;
      case VIA_T1LL: return 0xff;
      case VIA_T1LH: return 0xff;
      case VIA_T2CL: {
        this.ifr &= ~IFR_T2;
        this.updateIrq();
        return 0xff;
      }
      case VIA_T2CH: return 0xff;
      case VIA_SR: return this.sr;
      case VIA_ACR: return this.acr;
      case VIA_PCR: return this.pcr;
      case VIA_IFR: return this.ifr;
      case VIA_IER: return this.ier | 0x80;
      default: return 0;
    }
  }

  write(reg: number, value: number): void {
    const r = reg & 0x0f;
    const v = u8(value);
    switch (r) {
      case VIA_PRB: {
        this.prb = v;
        const driven = this.prb & this.ddrb;
        this.backend.storePb?.(driven);
        return;
      }
      case VIA_PRA: {
        this.pra = v;
        const driven = this.pra & this.ddra;
        this.backend.storePa?.(driven);
        this.ifr &= ~(IFR_CA1 | IFR_CA2);
        this.updateIrq();
        return;
      }
      case VIA_PRA_NHS: { this.pra = v; return; }
      case VIA_DDRB: {
        this.ddrb = v;
        const driven = this.prb & this.ddrb;
        this.backend.storePb?.(driven);
        return;
      }
      case VIA_DDRA: {
        this.ddra = v;
        const driven = this.pra & this.ddra;
        this.backend.storePa?.(driven);
        return;
      }
      case VIA_ACR: { this.acr = v; return; }
      case VIA_PCR: { this.pcr = v; return; }
      case VIA_IFR: {
        // Writing 1 clears the bit per VICE viacore.c.
        this.ifr &= ~(v & 0x7f);
        this.updateIrq();
        return;
      }
      case VIA_IER: {
        // Bit 7 = set/clear flag; bits 0-6 = mask of bits to set or clear.
        if (v & 0x80) this.ier |= v & 0x7f;
        else this.ier &= ~(v & 0x7f);
        this.updateIrq();
        return;
      }
      // T1/T2/SR: stored only; no timer behavior in 611.4 minimum.
      case VIA_T1CL: case VIA_T1LL: return;
      case VIA_T1CH: case VIA_T1LH: { this.ifr &= ~IFR_T1; this.updateIrq(); return; }
      case VIA_T2CL: return;
      case VIA_T2CH: { this.ifr &= ~IFR_T2; this.updateIrq(); return; }
      case VIA_SR: { this.sr = v; return; }
      default: return;
    }
  }

  /**
   * VICE `viacore_signal(via, line, edge)` for CA1.
   * `edge` = VIA_SIG_FALL or VIA_SIG_RISE (last observed edge, not direction).
   * Sets IFR_CA1 only if the edge matches PCR & 0x01 polarity config.
   */
  signalCa1(edge: 0 | 1): void {
    this.ca1State = edge;
    const wantedPolarity = (this.pcr & PCR_CA1_POS) ? VIA_SIG_RISE : VIA_SIG_FALL;
    if (edge === wantedPolarity) {
      this.ifr |= IFR_CA1;
      this.updateIrq();
    }
  }

  /**
   * Recompute IFR_ANY summary bit + push IRQ-out edge to backend.
   * VICE update_myviairq_rclk().
   */
  private updateIrq(): void {
    const pending = (this.ifr & this.ier & 0x7f) !== 0;
    if (pending) this.ifr |= IFR_ANY;
    else this.ifr &= ~IFR_ANY;
    if (pending !== this.lastIrqOut) {
      this.lastIrqOut = pending;
      this.backend.setIrq(pending);
    }
  }

  /** Test helper — current IRQ-out state. */
  irqAsserted(): boolean { return this.lastIrqOut; }
}
