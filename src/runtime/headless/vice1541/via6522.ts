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
import {
  alarmNew,
  alarmSet,
  alarmUnset,
  type Alarm,
  type AlarmContext,
} from "../alarm/alarm-context.js";

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
  /** Optional hook for PRA write. */
  storePa?: (value: BYTE) => void;
  /** Optional read PB hook for backend-driven bits (returns raw byte;
   *  6522 then masks with DDRB and folds in PRB-out bits per VICE). */
  readPb?: () => BYTE;
  /** Optional read PA hook. */
  readPa?: () => BYTE;
  /** Called when IRQ output state changes (drives cpuIntStatus.setIrq). */
  setIrq: Via6522IrqHook;
  /** Optional hook fired when CA2 output state changes per PCR config.
   *  VIA2 1541 uses this to drive BYTE_READY-active. */
  setCa2?: (state: 0 | 1) => void;
  /** Optional hook fired when CB2 output state changes per PCR config.
   *  VIA2 1541 uses this to drive read/write mode. */
  setCb2?: (state: 0 | 1) => void;
}

export interface Via6522Options {
  backend: Via6522Backend;
  /** VICE-style label for diagnostics ("via1d1541" etc.). */
  label?: string;
  /** Spec 611 phase 611.7f.9 — required for T1 timer schedule references. */
  clkPtr?: { value: number };
  /** Spec 611 phase 611.7g (Codex 12:25) — drive cpu's AlarmContext for
   * VICE-canonical alarm-based T1 scheduling. Optional for test
   * harnesses that don't need cycle-exact alarm firing. */
  alarmContext?: AlarmContext;
  /** Spec 611 phase 611.7g.2 (Codex 12:37) — live drive-cpu clock
   * reference. Used by t1ZeroAlarmCallback to compute rclk from the
   * CURRENT cpu.clk during alarm dispatch (which happens INSIDE
   * Cpu65xxVice's per-cycle loop, BEFORE clkPtr.value is synced).
   * Falls back to clkPtr.value if not provided. */
  clkRef?: () => number;
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

  // === Spec 611 phase 611.7f.9 — VIA1 T1 timer state ===
  // VICE viacore.c lines 224-263 + 740-769 (store T1CL/T1CH/T1LH).
  //
  // Per-VICE model in viacore.c:
  //   T1CH write: tal = (T1LL | T1LH<<8); t1zero = rclk+1+tal;
  //               t1reload = rclk+1+tal+FULL_CYCLE_2 (=+2); clear IFR_T1.
  //   counter at rclk = (t1zero - rclk) & 0xffff (1:1 derivation from
  //     viacore_t1: rclk < t1reload returns t1reload - rclk - 2 =
  //     t1zero - rclk).
  //   IRQ fires when rclk >= t1zero + 1 (= when counter first shows FFFF).
  //   One-shot mode: IRQ fires once until T1CH rewritten.
  //   Free-run (ACR & 0x40): on each underflow, reload from latch +
  //     reschedule t1zero forward by (tal + 2).
  //
  // Lazy evaluation: T1 state is updated on demand at IFR/T1CL/T1CH read.
  // No per-drive-cycle tick required. Drive ROM polls $180D explicitly
  // (e.g. $E9E2 LDA $180D / AND #$40 / BNE $E9F2 EOI-ack path).
  private t1Latch: number = 0;    // tal: 16-bit latch (T1LL | T1LH<<8)
  private t1ZeroClk: number = 0;  // absolute drive clk when T1 reads 0
  private t1ReloadClk: number = 0; // t1reload = t1zero + FULL_CYCLE_2 per VICE
  private t1Active: boolean = false;
  private t1OneShotFired: boolean = false;
  // Spec 611 phase 611.7g — t1_pb7 internal state per VICE viacore.c.
  // Toggles 0x00 ↔ 0x80 on each t1_zero_alarm fire (viacore.c:1337).
  // Used by PRB read when ACR_T1_PB7_USED bit set. PRB-output side of
  // PB7 IS in-scope per Codex 12:25 ("can't hand-wave"); PRB-side
  // emission is the actual VICE source semantic. 1541 LOAD doesn't
  // read PB7 from T1 (verified via 7f.21: drive ROM reads $1800 PB7
  // = ATN_IN, never gates by ACR_T1_PB7_USED) — confirmed PB7 toggle
  // is internal-only for current 1541 LOAD path; full PRB-side PB7
  // gating deferred as named follow-up.
  private t1Pb7: number = 0;
  private clkPtr: { value: number } | undefined;
  private clkRef: (() => number) | undefined;
  private alarmContext: AlarmContext | undefined;
  private t1ZeroAlarm: Alarm | null = null;

  constructor(opts: Via6522Options) {
    this.backend = opts.backend;
    this.label = opts.label ?? "via6522";
    this.clkPtr = opts.clkPtr;
    this.clkRef = opts.clkRef;
    this.alarmContext = opts.alarmContext;
    // Register T1 zero alarm in the drive cpu's AlarmContext per VICE
    // viacore_setup (alarm_new + alarm_set on demand) — viacore.c:1306
    // viacore_t1_zero_alarm is the callback.
    if (this.alarmContext) {
      this.t1ZeroAlarm = alarmNew(
        this.alarmContext,
        `${this.label}-t1-zero`,
        (offset: number) => this.t1ZeroAlarmCallback(offset),
        null,
      );
    }
  }

  /**
   * VICE viacore_t1_zero_alarm (viacore.c:1306-1342). Fires when
   * drive cpu clk reaches t1zero. Sets IFR_T1, toggles t1_pb7,
   * either unsets alarm (one-shot) or re-schedules (free-run).
   * IRQ pin updated via update_myviairq_rclk(rclk+1) per VICE
   * comment "extra cycle after the flag before the interrupt happens".
   */
  private t1ZeroAlarmCallback(offset: number): void {
    // VICE: rclk = clk_ptr - offset. Use LIVE cpu.clk (Codex 12:37):
    // alarm fires inside Cpu65xxVice per-cycle loop; clkPtr lags.
    const rclk = (this.getLiveClk() - offset) & 0xffffffff;
    const continuous = (this.acr & 0x40) !== 0; // VIA_ACR_T1_FREE_RUN
    if (!continuous) {
      // viacore.c:1316-1318 one-shot mode: alarm_unset + t1zero = 0.
      // Counter still continues counting down from FFFF per VICE.
      alarmUnset(this.t1ZeroAlarm!);
      this.t1ZeroClk = 0; // (Codex 12:37 fix) VICE: via_context->t1zero = 0
      this.t1OneShotFired = true;
    } else {
      // viacore.c:1319-1334 continuous mode: reschedule by full_cycle
      // (= tal + FULL_CYCLE_2). t1reload tracking deferred per VICE
      // comment (bug 2203) — not required for 1541 LOAD.
      const fullCycle = this.t1Latch + 2;
      this.t1ZeroClk = (this.t1ZeroClk + fullCycle) & 0xffffffff;
      alarmSet(this.t1ZeroAlarm!, this.t1ZeroClk);
    }
    // viacore.c:1337 t1_pb7 toggle.
    this.t1Pb7 ^= 0x80;
    // viacore.c:1338-1339 set IFR_T1.
    this.ifr |= IFR_T1;
    // viacore.c:1341 update_myviairq_rclk(rclk + 1) — 1-cycle delay
    // for IRQ propagation after flag set ("extra cycle after the flag
    // before the interrupt happens").
    this.updateIrqAtClk((rclk + 1) & 0xffffffff);
  }

  /** Current drive clock cycle for register reads / writes (T1CH t1zero
   *  computation, counter read, etc.). Uses clkPtr.value because
   *  register access happens AT instruction boundary, where clkPtr is
   *  in sync with cpu.clk. */
  private getClk(): number {
    return this.clkPtr?.value ?? 0;
  }

  /** Live drive-cpu clock for ALARM dispatch only. Per Codex 12:37:
   *  alarm callbacks fire INSIDE Cpu65xxVice's per-cycle loop, where
   *  cpu.clk has advanced but clkPtr.value has NOT yet been synced.
   *  Reading clkPtr there would re-introduce the IRQ timestamp skew. */
  private getLiveClk(): number {
    return this.clkRef ? this.clkRef() : (this.clkPtr?.value ?? 0);
  }

  /**
   * Spec 611 phase 611.7g (Codex 12:25): retain lazy-eval ONLY as
   * fallback for harnesses without alarmContext (= legacy smoke
   * scripts that drive clk manually without dispatching alarms).
   * Production via1d/via2d both have alarmContext attached, so
   * alarm-based path is canonical.
   */
  private maybeFireT1AtClk(rclk: number): void {
    if (this.alarmContext) return; // alarm path is canonical; lazy disabled
    if (!this.t1Active) return;
    if (rclk < this.t1ZeroClk + 1) return;
    const continuous = (this.acr & 0x40) !== 0;
    if (continuous || !this.t1OneShotFired) {
      const wasSet = (this.ifr & IFR_T1) !== 0;
      this.ifr |= IFR_T1;
      if (!continuous) this.t1OneShotFired = true;
      if (!wasSet) this.updateIrq();
    }
    if (continuous) {
      const fullCycle = this.t1Latch + 2;
      if (fullCycle > 0) {
        while (rclk >= this.t1ZeroClk + 1) {
          this.t1ZeroClk += fullCycle;
        }
      }
    }
  }

  /** VICE viacore_t1: counter value at given clk. */
  private viacoreT1(rclk: number): number {
    return (this.t1ZeroClk - rclk) & 0xffff;
  }

  /**
   * Public timer service entry-point. Per Codex 10:10 / 10:16: T1
   * underflow must set IFR_T1 and update IRQ state at drive-clock time
   * independent of any register read. Lazy-on-read evaluation alone is
   * insufficient — drive ROM may set IER bit 6 + run code that doesn't
   * read $180D for many cycles, and IRQ should still raise.
   *
   * Called by the drive CPU execution loop after each instruction
   * (drivecpu.ts driveCpuExecute) for BOTH VIA1 and VIA2 (shared chip
   * core; either may use T1 in future drive ROM paths).
   *
   * Idempotent: calling multiple times at the same clk only fires IRQ
   * once per underflow (one-shot or per-cycle in free-run).
   */
  serviceTimers(clk?: number): void {
    this.maybeFireT1AtClk(clk ?? this.getClk());
  }

  /**
   * Test helper for Codex 10:16 smoke contract: peek raw IFR without
   * triggering any side-effect path. Public for diagnostic / smoke use.
   */
  get rawIfr(): number {
    return this.ifr & 0xff;
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
    // Spec 611 phase 611.7f.9 + 611.7g.2 (Codex 12:37 fix) — T1 reset.
    // Unset pending alarm + clear all T1 internal state.
    this.t1Latch = 0;
    this.t1ZeroClk = 0;
    this.t1ReloadClk = 0;
    this.t1Active = false;
    this.t1OneShotFired = false;
    this.t1Pb7 = 0;
    if (this.t1ZeroAlarm) alarmUnset(this.t1ZeroAlarm);
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
        // Spec 611 phase 611.7f.9 — return live counter LOW + clear IFR_T1.
        // VICE viacore.c read_via path: T1CL read returns viacore_t1 low byte.
        const rclk = this.getClk();
        this.maybeFireT1AtClk(rclk);
        const counter = this.viacoreT1(rclk);
        this.ifr &= ~IFR_T1;
        this.updateIrq();
        return counter & 0xff;
      }
      case VIA_T1CH: {
        // VICE: T1CH read returns viacore_t1 HIGH byte. Does NOT clear IFR_T1.
        const rclk = this.getClk();
        this.maybeFireT1AtClk(rclk);
        return (this.viacoreT1(rclk) >> 8) & 0xff;
      }
      case VIA_T1LL: return this.t1Latch & 0xff;
      case VIA_T1LH: return (this.t1Latch >> 8) & 0xff;
      case VIA_T2CL: {
        this.ifr &= ~IFR_T2;
        this.updateIrq();
        return 0xff;
      }
      case VIA_T2CH: return 0xff;
      case VIA_SR: return this.sr;
      case VIA_ACR: return this.acr;
      case VIA_PCR: return this.pcr;
      case VIA_IFR: {
        // Spec 611 phase 611.7f.9 — lazy-evaluate T1 underflow at this clk
        // so drive ROM IFR poll (e.g. $E9E2 LDA $180D / AND #$40) sees
        // IFR_T1 set as soon as the timer has underflowed.
        this.maybeFireT1AtClk(this.getClk());
        // VICE viacore.c viacore_read VIA_IFR: returns ifr | 0x80 if any
        // (ifr & ier & 0x7f) bit is set. Honor that "IFR_ANY summary" bit.
        const pending = (this.ifr & this.ier & 0x7f) !== 0;
        return (this.ifr & 0x7f) | (pending ? 0x80 : 0);
      }
      case VIA_IER: return this.ier | 0x80;
      default: return 0;
    }
  }

  write(reg: number, value: number): void {
    const r = reg & 0x0f;
    const v = u8(value);
    switch (r) {
      case VIA_PRB: {
        // Spec 611 phase 611.7f.16 — match VICE viacore.c:716-723:
        //   byte = (via[VIA_PRB] | ~via[VIA_DDRB])
        //   store_prb(byte, oldpb, addr)
        // Output bits = PRB latch; input bits = 1 (float-high pullup).
        // Pre-7f.16 used `PRB & DDRB` which sent 0 for input bits, causing
        // drive-state divergence vs legacy/VICE at $FA78 stepper routine.
        this.prb = v;
        const driven = (this.prb | ~this.ddrb) & 0xff;
        this.backend.storePb?.(driven);
        return;
      }
      case VIA_PRA: {
        // Symmetric VICE shape for PA: byte = PRA | ~DDRA.
        this.pra = v;
        const driven = (this.pra | ~this.ddra) & 0xff;
        this.backend.storePa?.(driven);
        this.ifr &= ~(IFR_CA1 | IFR_CA2);
        this.updateIrq();
        return;
      }
      case VIA_PRA_NHS: { this.pra = v; return; }
      case VIA_DDRB: {
        this.ddrb = v;
        const driven = (this.prb | ~this.ddrb) & 0xff;
        this.backend.storePb?.(driven);
        return;
      }
      case VIA_DDRA: {
        this.ddra = v;
        const driven = (this.pra | ~this.ddra) & 0xff;
        this.backend.storePa?.(driven);
        return;
      }
      case VIA_ACR: { this.acr = v; return; }
      case VIA_PCR: {
        this.pcr = v;
        // VICE viacore.c via_update_ca2_output() / cb2 — when PCR is
        // configured for "manual" output mode the CA2/CB2 output state
        // tracks PCR bits directly. Modes:
        //   PCR bits 1-3 = CA2 control:
        //     110 (= 0x0c) = manual output low
        //     111 (= 0x0e) = manual output high
        //     others       = handshake / pulse modes (not exercised by
        //                    VIA2 1541; left as no-op for 611.5).
        //   PCR bits 5-7 = CB2 control (same encoding, shifted).
        const ca2Mode = (v & 0x0e);
        if (ca2Mode === 0x0c) this.ca2OutState = 0;
        else if (ca2Mode === 0x0e) this.ca2OutState = 1;
        this.backend.setCa2?.(this.ca2OutState);
        const cb2Mode = (v & 0xe0) >> 4;
        if (cb2Mode === 0x0c) this.cb2OutState = 0;
        else if (cb2Mode === 0x0e) this.cb2OutState = 1;
        this.backend.setCb2?.(this.cb2OutState);
        return;
      }
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
      // === Spec 611 phase 611.7f.9 — VIA1 T1 timer writes ===
      // Per VICE viacore.c lines 741-783.
      case VIA_T1CL:
      case VIA_T1LL: {
        // Update latch LOW. Does not affect counter or IFR.
        this.t1Latch = (this.t1Latch & 0xff00) | (v & 0xff);
        return;
      }
      case VIA_T1CH: {
        // VICE viacore.c:747-768 store T1CH:
        //   T1LH = byte; update_via_t1_latch; t1reload = rclk+1+tal+FULL_CYCLE_2;
        //   t1zero = rclk+1+tal; alarm_set(t1_zero_alarm, t1zero);
        //   t1_pb7 = 0; clear IFR_T1; update_myviairq_rclk.
        this.t1Latch = (this.t1Latch & 0x00ff) | ((v & 0xff) << 8);
        const rclk = this.getClk();
        this.t1ZeroClk = rclk + 1 + this.t1Latch;
        this.t1ReloadClk = this.t1ZeroClk + 2; // FULL_CYCLE_2
        this.t1Active = true;
        this.t1OneShotFired = false;
        this.t1Pb7 = 0; // viacore.c:763
        if (this.t1ZeroAlarm) {
          alarmSet(this.t1ZeroAlarm, this.t1ZeroClk);
        }
        this.ifr &= ~IFR_T1;
        this.updateIrq();
        return;
      }
      case VIA_T1LH: {
        // Update latch HIGH only; do NOT reload counter. Clears IFR_T1
        // per VICE viacore.c lines 770-783 (Synertek behavior confirmed).
        this.t1Latch = (this.t1Latch & 0x00ff) | ((v & 0xff) << 8);
        this.ifr &= ~IFR_T1;
        this.updateIrq();
        return;
      }
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
   *
   * Spec 611 phase 611.7f.24 — optional `clk` for backend.setIrq
   * timestamp. Defaults to clkPtr.value (polled drive clk) when not
   * provided. Used to pin IRQ stamp to write-time host clk so drive
   * cpu sees the IRQ "already pending" rather than future-stamped.
   */
  signalCa1(edge: 0 | 1, clk?: number): void {
    this.ca1State = edge;
    const wantedPolarity = (this.pcr & PCR_CA1_POS) ? VIA_SIG_RISE : VIA_SIG_FALL;
    if (edge === wantedPolarity) {
      this.ifr |= IFR_CA1;
      this.updateIrqAtClk(clk);
    }
  }

  private updateIrqAtClk(clk?: number): void {
    const pending = (this.ifr & this.ier & 0x7f) !== 0;
    if (pending) this.ifr |= IFR_ANY;
    else this.ifr &= ~IFR_ANY;
    if (pending !== this.lastIrqOut) {
      this.lastIrqOut = pending;
      const b = this.backend as Via6522Backend & { setIrqAt?: (a: boolean, c?: number) => void };
      if (typeof b.setIrqAt === "function") b.setIrqAt(pending, clk);
      else this.backend.setIrq(pending);
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
