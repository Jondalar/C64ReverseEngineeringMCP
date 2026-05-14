// Spec 147 — VIA 6522 1:1 VICE port (Phase 1).
//
// Source: VICE 3.7.1 src/core/viacore.c (~1985 LOC) + src/via.h.
//
// This is a faithful port of the VICE generic VIA core. It uses the
// alarm system from src/runtime/headless/alarm/alarm-context.ts as the
// scheduling primitive — every alarm in VICE viacore.c (t1_zero,
// t2_zero, t2_underflow, t2_shift, phi2_sr) is registered here with
// alarmNew and (re)scheduled via alarmSet / alarmUnset directly from
// register handlers, matching VICE 1:1.
//
// Hybrid naming: internal struct fields use VICE names verbatim
// (`tal`, `t2cl`, `t2ch`, `t1reload`, `t2zero`, `t1zero`, `t2xx00`,
// `t1_pb7`, `oldpa`, `oldpb`, `ila`, `ilb`, `shift_state`, `ifr`,
// `ier`, `via[]`). Public API is camelCase TypeScript convention.
//
// Backend interface: VICE function-pointer pattern (viacore.h).
// VIA → backend: storePa, storePb, storeSr, storeT2L, readPa, readPb,
//   setInt, setCa2, setCb2, reset.
// Backend → VIA: direct `signal(line, edge)` call (viacore_signal()).
//
// Phase 1 scope: complete chip core, VIA1 IEC instance, VIA2 idle
// stub instance, unit tests, build green. Drive callers stay on the
// pre-existing `drive/via6522.ts` until Phase 2.

import {
  alarmContextDispatch,
  alarmNew,
  alarmSet,
  alarmUnset,
  type Alarm,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import { u8, u16, type BYTE, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Register addresses (via.h lines 35-55).
// ---------------------------------------------------------------------------
export const VIA_PRB = 0;
export const VIA_PRA = 1;
export const VIA_DDRB = 2;
export const VIA_DDRA = 3;
export const VIA_T1CL = 4;
export const VIA_T1CH = 5;
export const VIA_T1LL = 6;
export const VIA_T1LH = 7;
export const VIA_T2CL = 8;
export const VIA_T2LL = 8; // write-only alias for T2CL
export const VIA_T2CH = 9;
export const VIA_T2LH = 9; // write-only alias for T2CH (counter+latch hi)
export const VIA_SR = 10;
export const VIA_ACR = 11;
export const VIA_PCR = 12;
export const VIA_IFR = 13;
export const VIA_IER = 14;
export const VIA_PRA_NHS = 15;

// ---------------------------------------------------------------------------
// IFR bit masks (via.h lines 58-66).
// ---------------------------------------------------------------------------
export const VIA_IM_IRQ = 0x80;
export const VIA_IM_T1 = 0x40;
export const VIA_IM_T2 = 0x20;
export const VIA_IM_CB1 = 0x10;
export const VIA_IM_CB2 = 0x08;
export const VIA_IM_SR = 0x04;
export const VIA_IM_CA1 = 0x02;
export const VIA_IM_CA2 = 0x01;

// ---------------------------------------------------------------------------
// ACR bit masks (via.h lines 68-93).
// ---------------------------------------------------------------------------
export const VIA_ACR_T1_CONTROL = 0xc0;
export const VIA_ACR_T1_PB7_USED = 0x80;
export const VIA_ACR_T1_FREE_RUN = 0x40;

export const VIA_ACR_T2_CONTROL = 0x20;
export const VIA_ACR_T2_TIMER = 0x00;
export const VIA_ACR_T2_COUNTPB6 = 0x20;

export const VIA_ACR_SR_CONTROL = 0x1c;
export const VIA_ACR_SR_OUT = 0x10;
export const VIA_ACR_SR_DISABLED = 0x00;
export const VIA_ACR_SR_IN_T2 = 0x04;
export const VIA_ACR_SR_IN_PHI2 = 0x08;
export const VIA_ACR_SR_IN_CB1 = 0x0c;
export const VIA_ACR_SR_OUT_FREE_T2 = 0x10;
export const VIA_ACR_SR_OUT_T2 = 0x14;
export const VIA_ACR_SR_OUT_PHI2 = 0x18;
export const VIA_ACR_SR_OUT_CB1 = 0x1c;

export const VIA_ACR_PB_LATCH = 0x02;
export const VIA_ACR_PA_LATCH = 0x01;

// ---------------------------------------------------------------------------
// PCR bit masks (via.h lines 95-130).
// ---------------------------------------------------------------------------
export const VIA_PCR_CB2_CONTROL = 0xe0;
export const VIA_PCR_CB2_I_OR_O = 0x80;
export const VIA_PCR_CB2_INPUT = 0x00;
export const VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE = 0x40;
export const VIA_PCR_CB2_INDEPENDENT_INTERRUPT = 0x20;
export const VIA_PCR_CB2_HANDSHAKE_OUTPUT = 0x80;
export const VIA_PCR_CB2_PULSE_OUTPUT = 0xa0;
export const VIA_PCR_CB2_LOW_OUTPUT = 0xc0;
export const VIA_PCR_CB2_HIGH_OUTPUT = 0xe0;
export const VIA_PCR_CB1_CONTROL = 0x10;
export const VIA_PCR_CB1_POS_ACTIVE_EDGE = 0x10;

export const VIA_PCR_CA2_CONTROL = 0x0e;
export const VIA_PCR_CA2_I_OR_O = 0x08;
export const VIA_PCR_CA2_INPUT = 0x00;
export const VIA_PCR_CA2_INPUT_POS_ACTIVE_EDGE = 0x04;
export const VIA_PCR_CA2_INDEPENDENT_INTERRUPT = 0x02;
export const VIA_PCR_CA2_HANDSHAKE_OUTPUT = 0x08;
export const VIA_PCR_CA2_PULSE_OUTPUT = 0x0a;
export const VIA_PCR_CA2_LOW_OUTPUT = 0x0c;
export const VIA_PCR_CA2_HIGH_OUTPUT = 0x0e;

export const VIA_PCR_CA1_CONTROL = 0x01;
export const VIA_PCR_CA1_POS_ACTIVE_EDGE = 0x01;

// ---------------------------------------------------------------------------
// Signal arg constants (via.h lines 134-140) — for backend → VIA edge.
// ---------------------------------------------------------------------------
export type ViaSignalLine = "ca1" | "ca2" | "cb1" | "cb2";
export type ViaSignalEdge = "rise" | "fall";

// ---------------------------------------------------------------------------
// Shift register state markers (via.h lines 172-173).
// ---------------------------------------------------------------------------
export const START_SHIFTING = 0;
export const FINISHED_SHIFTING = 16;

const FULL_CYCLE_2 = 2;
const SR_PHI2_FIRST_OFFSET = 3;
const SR_PHI2_NEXT_OFFSET = 1;

// ---------------------------------------------------------------------------
// Backend interface — VICE viacore.h function-pointer pattern.
// ---------------------------------------------------------------------------

/**
 * VICE function pointers for backend integration. Mirror viacore.h
 * lines 209-223 verbatim where possible. The TS interface flips C
 * struct callbacks to method-style closures; semantics identical.
 */
export interface ViaBackend {
  /** VICE: store_pra(via, byte, oldpa, addr) */
  storePa(clk: CLOCK, val: BYTE, oldpa: BYTE, addr: number): void;
  /** VICE: store_prb(via, byte, oldpb, addr) */
  storePb(clk: CLOCK, val: BYTE, oldpb: BYTE, addr: number): void;
  /** VICE: store_sr(via, byte) */
  storeSr(val: BYTE): void;
  /** VICE: store_t2l(via, byte) */
  storeT2L(val: BYTE): void;
  /** VICE: store_acr(via, byte) — optional, called on ACR write. */
  storeAcr?(val: BYTE): void;
  /** VICE: store_pcr(via, byte, addr) — returns possibly modified byte. */
  storePcr?(val: BYTE, addr: number): BYTE;
  /** VICE: read_pra(via, addr) — returns live pin level for PA. */
  readPa(addr: number): BYTE;
  /** VICE: read_prb(via) — returns live pin level for PB. */
  readPb(): BYTE;
  /** VICE: set_int(via, int_num, value, rclk) — drive IRQ propagation. */
  setInt(value: number, clk: CLOCK): void;
  /** VICE: set_ca2(via, state) */
  setCa2(state: number): void;
  /** VICE: set_cb1(via, state) — optional. */
  setCb1?(state: number): void;
  /** VICE: set_cb2(via, state, offset) */
  setCb2(state: number, offset: number): void;
  /** VICE: sr_underflow(via) — optional, fires after 8 bits shifted. */
  srUnderflow?(): void;
  /** VICE: reset(via) — backend reset hook. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Helper bit-decoders mirroring VICE viacore.c macros (lines 105-127).
// ---------------------------------------------------------------------------
const isCa2Output = (pcr: number): boolean => (pcr & 0x0c) === 0x0c;
const isCa2IndInput = (pcr: number): boolean => (pcr & 0x0a) === 0x02;
const isCa2Handshake = (pcr: number): boolean => (pcr & 0x0c) === 0x08;
const isCa2PulseMode = (pcr: number): boolean => (pcr & 0x0e) === 0x0a;
const isCa2ToggleMode = (pcr: number): boolean => (pcr & 0x0e) === 0x08;

const isCb2Output = (pcr: number): boolean => (pcr & 0xc0) === 0xc0;
const isCb2IndInput = (pcr: number): boolean => (pcr & 0xa0) === 0x20;
const isCb2Handshake = (pcr: number): boolean => (pcr & 0xc0) === 0x80;
const isCb2PulseMode = (pcr: number): boolean => (pcr & 0xe0) === 0xa0;
const isCb2ToggleMode = (pcr: number): boolean => (pcr & 0xe0) === 0x80;

const isPaInputLatch = (acr: number): boolean => (acr & VIA_ACR_PA_LATCH) !== 0;
const isPbInputLatch = (acr: number): boolean => (acr & VIA_ACR_PB_LATCH) !== 0;

// Spec 442 — VICE viacore.c:76 has `/* #define MYVIA_NEED_LATCHING */`
// commented out by default for drive VIAs. All 9 PA/PB-latch sites
// (viacore.c:452,865,1050,1074,1102,1106,1125,1140,1231,1494) are
// inactive in the canonical VICE drive build. TS mirrors that exactly:
// flag = false → latch code dead, ila/ilb stay 0, reads always go to
// backend.readPa/readPb. Per Epic 440 "MACH es GENAU so wie VICE".
const MYVIA_NEED_LATCHING = false;

const isSrShiftingOut = (acr: number): boolean => (acr & VIA_ACR_SR_OUT) !== 0;
const isSrShiftOutByT2 = (acr: number): boolean => (acr & 0x1c) === 0x14;
const isSrFreeRunning = (acr: number): boolean => (acr & 0x1c) === 0x10;
const isSrShiftInByExt = (acr: number): boolean => (acr & 0x1c) === 0x0c;
const isSrT2Controlled = (acr: number): boolean =>
  (acr & 0x0c) === 0x04 || (acr & 0x1c) === 0x10;
const isT2PulseCounting = (acr: number): boolean =>
  (acr & VIA_ACR_T2_CONTROL) === VIA_ACR_T2_COUNTPB6;
const isT2Timer = (acr: number): boolean =>
  (acr & VIA_ACR_T2_CONTROL) === VIA_ACR_T2_TIMER;

// Avoid unused warnings — these helpers are referenced for clarity.
void isSrShiftingOut;
void isSrShiftOutByT2;
void isSrShiftInByExt;
void isCa2Output;
void isCb2Output;

// ---------------------------------------------------------------------------
// Construction options.
// ---------------------------------------------------------------------------
export interface Via6522ViceOptions {
  /** Owning alarm context. Used for all VIA alarms (T1, T2, SR). */
  alarmContext: AlarmContext;
  /** Backend supplying port I/O + IRQ propagation. */
  backend: ViaBackend;
  /** Live drive/main CPU clock pointer (function so caller can re-read). */
  clkRef: () => CLOCK;
  /** Descriptive name for alarm labels. */
  myname: string;
  /** VICE: write_offset — 1 if CPU does CLK++ before store. Default 1. */
  writeOffset?: number;
  /** VICE: rmw_flag pointer — host-CPU read-modify-write pre-decrement. */
  rmwFlagRef?: () => boolean;
  rmwFlagSet?: (v: boolean) => void;
  /** VICE: clk increment/decrement for RMW handling. */
  clkBump?: (delta: number) => void;
}

/**
 * VIA 6522 — full 1:1 VICE port. One instance per chip (drive VIA1, VIA2).
 */
export class Via6522Vice {
  // ---- VICE struct fields (verbatim names from via.h via_context_t) ----

  /** Register file [0..15] mirroring VICE `via[16]`. */
  public readonly via = new Uint8Array(16);

  public ifr: number = 0;
  public ier: number = 0;

  /** T1 latch (16-bit). */
  public tal: number = 0xffff;
  /** T2 counter low. */
  public t2cl: BYTE = 0xff;
  /** T2 counter high. */
  public t2ch: BYTE = 0xff;
  /** Time at which T1 last/next reloads from latch (CLOCK). */
  public t1reload: CLOCK = 0;
  /** Time at which T2 reaches/last reached 0000 (CLOCK). */
  public t2zero: CLOCK = 0;
  /** Time at which T1 zero alarm fires (CLOCK). 0 = no further IRQ. */
  public t1zero: CLOCK = 0;
  /** True if T2 should give IRQ at first 0000 (or in 8-bit mode). */
  public t2xx00: boolean = false;
  /** PB7 toggle output state (0x00 or 0x80). */
  public t1_pb7: BYTE = 0x80;
  public oldpa: BYTE = 0;
  public oldpb: BYTE = 0;
  /** ILA / ILB latched input registers (when ACR latch enabled). */
  public ila: BYTE = 0;
  public ilb: BYTE = 0;

  public ca2_out_state: boolean = true;
  public cb1_in_state: boolean = true;
  public cb1_out_state: boolean = true;
  public cb2_in_state: boolean = true;
  public cb2_out_state: boolean = true;
  public cb1_is_input: boolean = true;
  public cb2_is_input: boolean = true;

  /** Shift register progress — start_shifting (0) ... finished_shifting (16). */
  public shift_state: number = FINISHED_SHIFTING;

  /** Each write to T2H allows one IRQ. */
  public t2_irq_allowed: boolean = false;

  /** Last byte returned by viacore_read (used by RMW path). */
  public last_read: BYTE = 0;

  // ---- Alarms (VICE viacore_init lines 1873-1889) -----------------------
  private readonly t1_zero_alarm: Alarm;
  private readonly t2_zero_alarm: Alarm;
  private readonly t2_underflow_alarm: Alarm;
  private readonly t2_shift_alarm: Alarm;
  private readonly phi2_sr_alarm: Alarm;

  // ---- Construction context --------------------------------------------
  private readonly backend: ViaBackend;
  private readonly clkRef: () => CLOCK;
  private readonly alarmContext: AlarmContext;
  private readonly writeOffset: number;
  private readonly rmwFlagRef: () => boolean;
  private readonly rmwFlagSet: (v: boolean) => void;
  private readonly clkBump: (delta: number) => void;

  constructor(opts: Via6522ViceOptions) {
    this.backend = opts.backend;
    this.clkRef = opts.clkRef;
    this.alarmContext = opts.alarmContext;
    this.writeOffset = opts.writeOffset ?? 1;
    this.rmwFlagRef = opts.rmwFlagRef ?? (() => false);
    this.rmwFlagSet = opts.rmwFlagSet ?? (() => undefined);
    this.clkBump = opts.clkBump ?? (() => undefined);

    // VICE viacore_init lines 1873-1889 — alarm registration.
    this.t1_zero_alarm = alarmNew(
      this.alarmContext,
      `${opts.myname}T1zero`,
      (offset) => this.onT1ZeroAlarm(offset),
      this,
    );
    this.t2_zero_alarm = alarmNew(
      this.alarmContext,
      `${opts.myname}T2zero`,
      (offset) => this.onT2ZeroAlarm(offset),
      this,
    );
    this.t2_underflow_alarm = alarmNew(
      this.alarmContext,
      `${opts.myname}T2uflow`,
      (offset) => this.onT2UnderflowAlarm(offset),
      this,
    );
    this.t2_shift_alarm = alarmNew(
      this.alarmContext,
      `${opts.myname}T2SR`,
      (offset) => this.onT2ShiftAlarm(offset),
      this,
    );
    this.phi2_sr_alarm = alarmNew(
      this.alarmContext,
      `${opts.myname}SR`,
      (offset) => this.onPhi2SrAlarm(offset),
      this,
    );

    // VICE viacore_setup_context lines 1841-1850 — power-up state.
    this.via[VIA_T1CL] = 0xff;
    this.via[VIA_T1CH] = 0xff;
    this.via[VIA_T1LL] = 0xff;
    this.via[VIA_T1LH] = 0xff;
    this.via[VIA_T2CL] = 0xff;
    this.via[VIA_T2CH] = 0xff;
  }

  // ---- Reset (viacore.c lines 378-439) ---------------------------------
  reset(): void {
    // Port data/ddr cleared.
    for (let i = 0; i < 4; i++) this.via[i] = 0;
    // Shift register (10) preserved.
    for (let i = 11; i < 16; i++) this.via[i] = 0;

    this.tal = 0xffff;
    this.t2cl = 0xff;
    this.t2ch = 0xff;
    const clk = this.clkRef();
    this.t1reload = clk;
    this.t2zero = clk;

    this.ier = 0;
    this.ifr = 0;
    this.t1_pb7 = 0x80;

    this.shift_state = FINISHED_SHIFTING;
    this.t2_irq_allowed = false;
    this.t1zero = 0;
    this.t2xx00 = false;

    alarmUnset(this.t1_zero_alarm);
    alarmUnset(this.t2_zero_alarm);
    alarmUnset(this.t2_underflow_alarm);
    alarmUnset(this.t2_shift_alarm);
    alarmUnset(this.phi2_sr_alarm);

    this.updateIrq(clk);

    this.oldpa = 0;
    this.oldpb = 0;

    this.ca2_out_state = true;
    this.cb1_out_state = true;
    this.cb2_out_state = true;
    this.backend.setCa2(this.ca2_out_state ? 1 : 0);
    this.backend.setCb2(this.cb2_out_state ? 1 : 0, 0);

    this.backend.reset();
    this.cacheCb12IoStatus();
  }

  // ---- IRQ propagation (viacore.c update_myviairq, lines 203-214) ------
  private updateIrq(rclk: CLOCK): void {
    const value = (this.ifr & this.ier & 0x7f) !== 0 ? 1 : 0;
    this.backend.setInt(value, rclk);
  }

  // ---- viacore_signal (lines 441-474) — backend → VIA edge -------------
  // Spec 419 — Phase D pin (= §15 step 11 + §5.5 + §17.4 OQ-419-2).
  // VICE constants: src/via.h:134 `#define VIA_SIG_CA1 0`,
  //   src/via.h:139 `#define VIA_SIG_FALL 0`, :140 `VIA_SIG_RISE 1`.
  // VICE viacore_signal CA1 case at src/core/viacore.c:441-461 gates
  // IFR_CA1 set on `(edge ? 1 : 0) == (PCR & VIA_PCR_CA1_CONTROL)`,
  // i.e. the polarity tag must equal PCR bit 0. After the gate it
  // calls `update_myviairq` (= update_myviairq_rclk(via, *clk_ptr),
  // src/core/viacore.c:203-213) which forwards `set_int(num, value,
  // rclk = *clk_ptr)` to the backend (= §15 step 12 rclk stamping).
  signal(line: ViaSignalLine, edge: ViaSignalEdge): void {
    const edgeBit = edge === "rise" ? 1 : 0;
    switch (line) {
      case "ca1": {
        // VICE: edge bit must match PCR CA1 polarity to fire IFR.
        if (edgeBit === (this.via[VIA_PCR]! & VIA_PCR_CA1_CONTROL)) {
          if (isCa2ToggleMode(this.via[VIA_PCR]!) && !this.ca2_out_state) {
            this.ca2_out_state = true;
            this.backend.setCa2(1);
          }
          this.ifr |= VIA_IM_CA1;
          this.updateIrq(this.clkRef());
          if (MYVIA_NEED_LATCHING && isPaInputLatch(this.via[VIA_ACR]!)) {
            this.ila = u8(this.backend.readPa(VIA_PRA));
          }
        }
        break;
      }
      case "ca2": {
        if (
          (this.via[VIA_PCR]! & VIA_PCR_CA2_I_OR_O) === VIA_PCR_CA2_INPUT
        ) {
          // VICE: ifr |= (((edge<<2) ^ pcr) & 0x04) ? 0 : VIA_IM_CA2.
          // Fires only when edge polarity matches pcr bit 2.
          this.ifr |=
            (((edgeBit << 2) ^ this.via[VIA_PCR]!) & 0x04) !== 0
              ? 0
              : VIA_IM_CA2;
          this.updateIrq(this.clkRef());
        }
        break;
      }
      case "cb1":
        this.setCb1(edgeBit !== 0);
        break;
      case "cb2":
        this.setCb2(edgeBit !== 0);
        break;
    }
  }

  // ---- viacore_set_cb1 / set_cb2 (lines 1428-1518) ---------------------
  setCb1(data: boolean): void {
    if (data !== this.cb1_in_state) {
      if (this.cb1_is_input) {
        if (!data && this.shift_state === FINISHED_SHIFTING) {
          this.shift_state = START_SHIFTING;
        }
        this.shift_state++;
        if (data) {
          this.via[VIA_SR] = u8(
            ((this.via[VIA_SR]! << 1) | (this.cb2_in_state ? 1 : 0)) & 0xff,
          );
          if (this.shift_state === FINISHED_SHIFTING) {
            this.viacoreSetSr(this.via[VIA_SR]!);
            this.shift_state = START_SHIFTING;
          }
        }
      }
      this.cb1_in_state = data;
    }

    const pcr = this.via[VIA_PCR]!;
    const edge = (pcr & VIA_PCR_CB1_CONTROL) === VIA_PCR_CB1_POS_ACTIVE_EDGE;
    if (data === edge) {
      if (isCb2ToggleMode(pcr) && !this.cb2_out_state) {
        this.cb2_out_state = true;
        this.backend.setCb2(1, 0);
      }
      this.ifr |= VIA_IM_CB1;
      this.updateIrq(this.clkRef());
      if (MYVIA_NEED_LATCHING && isPbInputLatch(this.via[VIA_ACR]!)) {
        this.ilb = u8(this.backend.readPb());
      }
    }
  }

  setCb2(data: boolean): void {
    if (this.cb2_is_input && data !== this.cb2_in_state) {
      this.cb2_in_state = data;
      const pcr = this.via[VIA_PCR]!;
      const edge = (pcr & VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE) !== 0;
      if (data === edge) {
        this.ifr |= VIA_IM_CB2;
        this.updateIrq(this.clkRef());
      }
    }
  }

  // viacore_set_sr (lines 1523-1534) — burst mode hack from c64fastiec.
  viacoreSetSr(data: BYTE): void {
    const acr = this.via[VIA_ACR]!;
    if (!(acr & VIA_ACR_SR_OUT) && (acr & 0x0c)) {
      this.via[VIA_SR] = u8(data);
      this.ifr |= VIA_IM_SR;
      this.updateIrq(this.clkRef());
      this.shift_state = FINISHED_SHIFTING;
    }
  }

  // ---- T1 / T2 read helpers (lines 265-331) ----------------------------
  private viacoreT1(rclk: CLOCK): number {
    if (rclk < this.t1reload) {
      const res = this.t1reload - rclk - FULL_CYCLE_2;
      return res & 0xffff;
    }
    const fullCycle = this.tal + FULL_CYCLE_2;
    const elapsed = rclk - this.t1reload;
    const partial = elapsed % fullCycle;
    return (this.tal - partial) & 0xffff;
  }

  private viacoreT2(rclk: CLOCK): number {
    const acr = this.via[VIA_ACR]!;
    if (acr & VIA_ACR_T2_COUNTPB6) {
      return ((this.t2ch << 8) | this.t2cl) & 0xffff;
    }
    let t2 = (this.t2zero - rclk) & 0xffff;
    if (this.t2xx00) {
      t2 = ((this.t2ch << 8) | (t2 & 0xff)) & 0xffff;
    }
    return t2;
  }

  // ---- update_via_t1_latch (lines 340-361) -----------------------------
  private updateT1Latch(rclk: CLOCK): void {
    if (rclk >= this.t1reload) {
      const fullCycle = this.tal + FULL_CYCLE_2;
      const elapsed = rclk - this.t1reload;
      const nuf = 1 + Math.floor(elapsed / fullCycle);
      this.t1reload += nuf * fullCycle;
    }
    this.tal = (this.via[VIA_T1LL]! | (this.via[VIA_T1LH]! << 8)) & 0xffff;
  }

  // ---- schedule_t2_zero_alarm (lines 557-566) --------------------------
  private scheduleT2ZeroAlarm(rclk: CLOCK): void {
    this.t2zero = (rclk + this.t2cl) >>> 0;
    this.t2xx00 = true;
    alarmUnset(this.t2_underflow_alarm);
    alarmSet(this.t2_zero_alarm, this.t2zero);
  }

  // ---- setup_shifting (lines 575-632) ----------------------------------
  private setupShifting(rclk: CLOCK): void {
    const acr = this.via[VIA_ACR]!;
    switch (acr & VIA_ACR_SR_CONTROL) {
      case VIA_ACR_SR_DISABLED:
        // Don't change shift_state.
        break;
      case VIA_ACR_SR_IN_T2:
      case VIA_ACR_SR_OUT_T2:
      case VIA_ACR_SR_IN_CB1:
      case VIA_ACR_SR_OUT_CB1:
        if (this.shift_state === FINISHED_SHIFTING) {
          this.shift_state = START_SHIFTING;
        }
        break;
      case VIA_ACR_SR_IN_PHI2:
      case VIA_ACR_SR_OUT_PHI2:
        if (this.shift_state === FINISHED_SHIFTING) {
          this.shift_state = START_SHIFTING;
          alarmSet(this.phi2_sr_alarm, (rclk + 1) >>> 0);
        }
        break;
      case VIA_ACR_SR_OUT_FREE_T2:
        this.shift_state &= 0x0f;
        break;
    }
  }

  // ---- run_pending_alarms (lines 517-530) ------------------------------
  private runPendingAlarms(clk: CLOCK, offset: number): void {
    const ctx = this.alarmContext;
    while (clk > ctx.next_pending_alarm_clk) {
      alarmContextDispatch(ctx, (clk + offset) >>> 0);
    }
  }

  // ---- Bus-side store (viacore_store lines 637-1024) -------------------
  store(addr: number, byte: BYTE): void {
    if (this.rmwFlagRef()) {
      this.clkBump(-1);
      this.rmwFlagSet(false);
      this.store(addr, this.last_read);
      this.clkBump(1);
    }

    const rclk = (this.clkRef() - this.writeOffset) >>> 0;
    let a = addr & 0xf;

    if (a === VIA_PRB || (a >= VIA_T1CL && a <= VIA_IER)) {
      this.runPendingAlarms(rclk, this.writeOffset);
    }

    let v = u8(byte);

    switch (a) {
      case VIA_PRA: {
        this.ifr &= ~VIA_IM_CA1;
        if (!isCa2IndInput(this.via[VIA_PCR]!)) {
          this.ifr &= ~VIA_IM_CA2;
        }
        if (isCa2Handshake(this.via[VIA_PCR]!)) {
          this.ca2_out_state = false;
          this.backend.setCa2(0);
          if (isCa2PulseMode(this.via[VIA_PCR]!)) {
            this.ca2_out_state = true;
            this.backend.setCa2(1);
          }
        }
        if (this.ier & (VIA_IM_CA1 | VIA_IM_CA2)) {
          this.updateIrq(rclk);
        }
        // fall-through into VIA_PRA_NHS path
        this.via[VIA_PRA_NHS] = v;
        a = VIA_PRA;
        // fall-through into DDRA path...
        this.via[a] = v;
        const baOut = u8(this.via[VIA_PRA]! | ~this.via[VIA_DDRA]!);
        this.backend.storePa(rclk, baOut, this.oldpa, a);
        this.oldpa = baOut;
        return;
      }
      case VIA_PRA_NHS: {
        this.via[VIA_PRA_NHS] = v;
        a = VIA_PRA;
        this.via[a] = v;
        const baOut = u8(this.via[VIA_PRA]! | ~this.via[VIA_DDRA]!);
        this.backend.storePa(rclk, baOut, this.oldpa, a);
        this.oldpa = baOut;
        return;
      }
      case VIA_DDRA: {
        this.via[a] = v;
        const baOut = u8(this.via[VIA_PRA]! | ~this.via[VIA_DDRA]!);
        this.backend.storePa(rclk, baOut, this.oldpa, a);
        this.oldpa = baOut;
        return;
      }

      case VIA_PRB: {
        this.ifr &= ~VIA_IM_CB1;
        if ((this.via[VIA_PCR]! & 0xa0) !== 0x20) {
          this.ifr &= ~VIA_IM_CB2;
        }
        if (isCb2Handshake(this.via[VIA_PCR]!)) {
          this.cb2_out_state = false;
          this.backend.setCb2(0, this.writeOffset);
          if (isCb2PulseMode(this.via[VIA_PCR]!)) {
            this.cb2_out_state = true;
            this.backend.setCb2(1, 0);
          }
        }
        if (this.ier & (VIA_IM_CB1 | VIA_IM_CB2)) {
          this.updateIrq(rclk);
        }
        this.via[a] = v;
        let bbOut = u8(this.via[VIA_PRB]! | ~this.via[VIA_DDRB]!);
        if (this.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
          bbOut = u8((bbOut & 0x7f) | this.t1_pb7);
        }
        this.backend.storePb(rclk, bbOut, this.oldpb, a);
        this.oldpb = bbOut;
        return;
      }
      case VIA_DDRB: {
        this.via[a] = v;
        let bbOut = u8(this.via[VIA_PRB]! | ~this.via[VIA_DDRB]!);
        if (this.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
          bbOut = u8((bbOut & 0x7f) | this.t1_pb7);
        }
        this.backend.storePb(rclk, bbOut, this.oldpb, a);
        this.oldpb = bbOut;
        return;
      }

      case VIA_SR: {
        this.via[a] = v;
        this.setupShifting(rclk);
        if (this.ifr & VIA_IM_SR) {
          this.ifr &= ~VIA_IM_SR;
          this.updateIrq(rclk);
        }
        this.backend.storeSr(v);
        return;
      }

      case VIA_T1CL:
      case VIA_T1LL: {
        this.via[VIA_T1LL] = v;
        this.updateT1Latch(rclk);
        return;
      }

      case VIA_T1CH: {
        this.via[VIA_T1LH] = v;
        this.updateT1Latch(rclk);
        // Load counter with latch value (next cycle observes it).
        this.t1reload = (rclk + 1 + this.tal + FULL_CYCLE_2) >>> 0;
        this.t1zero = (rclk + 1 + this.tal) >>> 0;
        alarmSet(this.t1_zero_alarm, this.t1zero);
        this.t1_pb7 = 0;
        this.ifr &= ~VIA_IM_T1;
        this.updateIrq(rclk);
        return;
      }

      case VIA_T1LH: {
        this.via[a] = v;
        this.updateT1Latch(rclk);
        this.ifr &= ~VIA_IM_T1;
        this.updateIrq(rclk);
        return;
      }

      case VIA_T2LL: {
        this.via[VIA_T2LL] = v;
        this.backend.storeT2L(v);
        return;
      }

      case VIA_T2CH: {
        this.via[VIA_T2LH] = v;
        this.t2cl = u8(this.via[VIA_T2LL]!);
        this.t2ch = u8(v);
        if (!(this.via[VIA_ACR]! & VIA_ACR_T2_COUNTPB6)) {
          this.scheduleT2ZeroAlarm((rclk + 1) >>> 0);
        }
        this.ifr &= ~VIA_IM_T2;
        this.updateIrq(rclk);
        this.t2_irq_allowed = true;
        return;
      }

      case VIA_IFR: {
        this.ifr &= ~v;
        this.updateIrq(rclk);
        return;
      }

      case VIA_IER: {
        if (v & VIA_IM_IRQ) {
          this.ier |= v & 0x7f;
        } else {
          this.ier &= ~v;
        }
        this.updateIrq(rclk);
        return;
      }

      case VIA_ACR: {
        const oldAcr = this.via[VIA_ACR]!;
        // PB7 toggle bit rising edge: set t1_pb7 high (line 859-862).
        if ((oldAcr ^ v) & VIA_ACR_T1_PB7_USED) {
          if (v & VIA_ACR_T1_PB7_USED) this.t1_pb7 = 0x80;
        }

        let t2StartupDelay = 0;
        let restartT2Alarms = false;

        // T2 mode change (lines 889-925).
        if ((oldAcr ^ v) & VIA_ACR_T2_CONTROL) {
          if (v & VIA_ACR_T2_COUNTPB6) {
            const stop = (this.viacoreT2(rclk) - 1) & 0xffff;
            this.t2cl = u8(stop & 0xff);
            this.t2ch = u8((stop >>> 8) & 0xff);
            alarmUnset(this.t2_zero_alarm);
            this.t2xx00 = false;
          } else {
            restartT2Alarms = true;
            t2StartupDelay = 1;
          }
        }

        // SR mode change (lines 928-966).
        switch (v & VIA_ACR_SR_CONTROL) {
          case VIA_ACR_SR_DISABLED:
            alarmUnset(this.phi2_sr_alarm);
            if (this.ifr & VIA_IM_SR) {
              this.ifr &= ~VIA_IM_SR;
              this.updateIrq(rclk);
            }
            this.setCb2OutputState(this.via[VIA_PCR]!, this.writeOffset);
            break;
          case VIA_ACR_SR_IN_T2:
          case VIA_ACR_SR_OUT_T2:
          case VIA_ACR_SR_OUT_FREE_T2:
            alarmUnset(this.phi2_sr_alarm);
            if (
              !isSrT2Controlled(oldAcr) &&
              isT2Timer(v)
            ) {
              restartT2Alarms = true;
            }
            break;
          case VIA_ACR_SR_IN_PHI2:
          case VIA_ACR_SR_OUT_PHI2:
            if (this.phi2_sr_alarm.pending_idx < 0) {
              alarmSet(this.phi2_sr_alarm, (rclk + SR_PHI2_FIRST_OFFSET) >>> 0);
            }
            break;
          case VIA_ACR_SR_IN_CB1:
          case VIA_ACR_SR_OUT_CB1:
            alarmUnset(this.phi2_sr_alarm);
            break;
        }

        if (
          restartT2Alarms &&
          this.t2_zero_alarm.pending_idx < 0 &&
          this.t2_underflow_alarm.pending_idx < 0
        ) {
          const current = this.viacoreT2(rclk);
          this.t2cl = u8(current & 0xff);
          this.t2ch = u8((current >>> 8) & 0xff);
          this.scheduleT2ZeroAlarm((rclk + t2StartupDelay) >>> 0);
        }

        this.via[a] = v;
        this.cacheCb12IoStatus();
        this.backend.storeAcr?.(v);
        return;
      }

      case VIA_PCR: {
        if ((v & VIA_PCR_CA2_CONTROL) === VIA_PCR_CA2_LOW_OUTPUT) {
          this.ca2_out_state = false;
        } else if ((v & VIA_PCR_CA2_CONTROL) === VIA_PCR_CA2_HIGH_OUTPUT) {
          this.ca2_out_state = true;
        } else {
          this.ca2_out_state = true;
        }
        this.backend.setCa2(this.ca2_out_state ? 1 : 0);

        if ((this.via[VIA_ACR]! & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED) {
          this.setCb2OutputState(v, this.writeOffset);
        }

        const fixed = this.backend.storePcr?.(v, a) ?? v;
        v = fixed;
        this.via[a] = v;
        this.cacheCb12IoStatus();
        return;
      }

      default:
        this.via[a] = v;
    }
  }

  // ---- Bus-side read (viacore_read lines 1032-1214) --------------------
  read(addr: number): BYTE {
    let a = addr & 0xf;
    const rclk = this.clkRef();

    if (a === VIA_PRB || (a >= VIA_T1CL && a <= VIA_IER)) {
      this.runPendingAlarms(rclk, 0);
    }

    switch (a) {
      case VIA_PRA: {
        const tmpifr = this.ifr;
        this.ifr &= ~VIA_IM_CA1;
        if ((this.via[VIA_PCR]! & 0x0a) !== 0x02) {
          this.ifr &= ~VIA_IM_CA2;
        }
        if (isCa2Handshake(this.via[VIA_PCR]!)) {
          this.ca2_out_state = false;
          this.backend.setCa2(0);
          if (isCa2PulseMode(this.via[VIA_PCR]!)) {
            this.ca2_out_state = true;
            this.backend.setCa2(1);
          }
        }
        if (this.ier & (VIA_IM_CA1 | VIA_IM_CA2)) {
          this.updateIrq(rclk);
        }
        let byte: BYTE;
        if (MYVIA_NEED_LATCHING && isPaInputLatch(this.via[VIA_ACR]!) && (tmpifr & VIA_IM_CA1)) {
          byte = this.ila;
        } else {
          byte = u8(this.backend.readPa(a));
        }
        this.last_read = byte;
        return byte;
      }
      case VIA_PRA_NHS: {
        const tmpifr = this.ifr;
        let byte: BYTE;
        if (MYVIA_NEED_LATCHING && isPaInputLatch(this.via[VIA_ACR]!) && (tmpifr & VIA_IM_CA1)) {
          byte = this.ila;
        } else {
          byte = u8(this.backend.readPa(a));
        }
        this.last_read = byte;
        return byte;
      }

      case VIA_PRB: {
        const tmpifr = this.ifr;
        this.ifr &= ~VIA_IM_CB1;
        if ((this.via[VIA_PCR]! & 0xa0) !== 0x20) {
          this.ifr &= ~VIA_IM_CB2;
        }
        if (this.ier & (VIA_IM_CB1 | VIA_IM_CB2)) {
          this.updateIrq(rclk);
        }
        let pin: BYTE;
        if (MYVIA_NEED_LATCHING && isPbInputLatch(this.via[VIA_ACR]!) && (tmpifr & VIA_IM_CB1)) {
          pin = this.ilb;
        } else {
          pin = u8(this.backend.readPb());
        }
        let byte = u8(
          (pin & ~this.via[VIA_DDRB]!) |
            (this.via[VIA_PRB]! & this.via[VIA_DDRB]!),
        );
        if (this.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
          byte = u8((byte & 0x7f) | this.t1_pb7);
        }
        this.last_read = byte;
        return byte;
      }

      case VIA_T1CL:
        this.ifr &= ~VIA_IM_T1;
        this.updateIrq(rclk);
        this.last_read = u8(this.viacoreT1(rclk) & 0xff);
        return this.last_read;
      case VIA_T1CH:
        this.last_read = u8((this.viacoreT1(rclk) >>> 8) & 0xff);
        return this.last_read;
      case VIA_T1LL:
        this.last_read = u8(this.via[VIA_T1LL]!);
        return this.last_read;
      case VIA_T1LH:
        this.last_read = u8(this.via[VIA_T1LH]!);
        return this.last_read;

      case VIA_T2CL:
        this.ifr &= ~VIA_IM_T2;
        this.updateIrq(rclk);
        this.last_read = u8(this.viacoreT2(rclk) & 0xff);
        return this.last_read;
      case VIA_T2CH:
        this.last_read = u8((this.viacoreT2(rclk) >>> 8) & 0xff);
        return this.last_read;

      case VIA_SR: {
        this.setupShifting(rclk);
        if (this.ifr & VIA_IM_SR) {
          this.ifr &= ~VIA_IM_SR;
          this.updateIrq(rclk);
        }
        this.last_read = u8(this.via[a]!);
        return this.last_read;
      }

      case VIA_IFR: {
        let t = this.ifr & 0x7f;
        if ((this.ifr & this.ier) !== 0) t |= 0x80;
        this.last_read = u8(t);
        return this.last_read;
      }
      case VIA_IER: {
        this.last_read = u8(this.ier | 0x80);
        return this.last_read;
      }

      default: {
        // ACR / PCR / DDRA / DDRB.
        this.last_read = u8(this.via[a]!);
        return this.last_read;
      }
    }
  }

  // ---- Peek (viacore_peek lines 1218-1297) — no side effects -----------
  peek(addr: number): BYTE {
    const a = addr & 0xf;
    const clk = this.clkRef();
    switch (a) {
      case VIA_PRA:
      case VIA_PRA_NHS: {
        if (MYVIA_NEED_LATCHING && isPaInputLatch(this.via[VIA_ACR]!) && this.ifr & VIA_IM_CA1) {
          return this.ila;
        }
        return u8(this.backend.readPa(a));
      }
      case VIA_PRB: {
        let pin: BYTE;
        if (MYVIA_NEED_LATCHING && isPbInputLatch(this.via[VIA_ACR]!) && this.ifr & VIA_IM_CB1) {
          pin = this.ilb;
        } else {
          pin = u8(this.backend.readPb());
        }
        let byte = u8(
          (pin & ~this.via[VIA_DDRB]!) |
            (this.via[VIA_PRB]! & this.via[VIA_DDRB]!),
        );
        if (this.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
          byte = u8((byte & 0x7f) | this.t1_pb7);
        }
        return byte;
      }
      case VIA_T1CL:
        return u8(this.viacoreT1(clk) & 0xff);
      case VIA_T1CH:
        return u8((this.viacoreT1(clk) >>> 8) & 0xff);
      case VIA_T2CL:
        return u8(this.viacoreT2(clk) & 0xff);
      case VIA_T2CH:
        return u8((this.viacoreT2(clk) >>> 8) & 0xff);
      case VIA_IFR: {
        // Spec 442 — viacore.c:1284-1285 viacore_peek returns raw ifr
        // (no bit-7 synthesis). Synthesis happens only in viacore_read.
        // Peek is debug/monitor-only; raw register state preferred.
        return u8(this.ifr);
      }
      case VIA_IER:
        return u8(this.ier | 0x80);
      default:
        return u8(this.via[a]!);
    }
  }

  // ---- Alarm callbacks --------------------------------------------------

  /** viacore_t1_zero_alarm (lines 1306-1342). */
  private onT1ZeroAlarm(offset: CLOCK): void {
    const rclk = (this.clkRef() - offset) >>> 0;
    if (!(this.via[VIA_ACR]! & VIA_ACR_T1_FREE_RUN)) {
      // One-shot: cancel further alarms.
      alarmUnset(this.t1_zero_alarm);
      this.t1zero = 0;
    } else {
      const fullCycle = this.tal + FULL_CYCLE_2;
      this.t1zero = (this.t1zero + fullCycle) >>> 0;
      alarmSet(this.t1_zero_alarm, this.t1zero);
    }
    this.t1_pb7 ^= 0x80;
    this.ifr |= VIA_IM_T1;
    this.updateIrq((rclk + 1) >>> 0);
  }

  /** viacore_t2_zero_alarm (lines 1554-1586). */
  private onT2ZeroAlarm(offset: CLOCK): void {
    const rclk = (this.clkRef() - offset) >>> 0;
    this.t2ch = u8((this.t2ch - 1) & 0xff);
    if (this.t2ch === 0xff && this.t2_irq_allowed) {
      this.ifr |= VIA_IM_T2;
      this.updateIrq(rclk);
      this.t2_irq_allowed = false;
    }
    alarmUnset(this.t2_zero_alarm);
    alarmSet(this.t2_underflow_alarm, (rclk + 1) >>> 0);
  }

  /** viacore_t2_underflow_alarm (lines 1593-1652). */
  private onT2UnderflowAlarm(offset: CLOCK): void {
    const rclk = (this.clkRef() - offset) >>> 0;
    let nextAlarm = 0;

    const acr = this.via[VIA_ACR]!;
    if ((acr & 0x0c) === 0x04) {
      // 8-bit timer mode (SR controlled).
      this.t2cl = u8(this.via[VIA_T2LL]!);
      nextAlarm = this.via[VIA_T2LL]! + FULL_CYCLE_2;
      alarmSet(this.t2_shift_alarm, (rclk + 1) >>> 0);
    } else if (isSrFreeRunning(acr)) {
      this.t2cl = u8(this.via[VIA_T2LL]!);
      nextAlarm = this.via[VIA_T2LL]! + FULL_CYCLE_2;
      alarmSet(this.t2_shift_alarm, (rclk + 1) >>> 0);
    } else {
      this.t2cl = 0xff;
      nextAlarm = this.t2ch !== 0xff ? 256 : 0;
    }

    if (nextAlarm) {
      this.t2zero = (this.t2zero + nextAlarm) >>> 0;
      this.t2xx00 = true;
      alarmSet(this.t2_zero_alarm, this.t2zero);
    } else {
      alarmUnset(this.t2_zero_alarm);
      this.t2xx00 = false;
    }
    alarmUnset(this.t2_underflow_alarm);
  }

  /** viacore_t2_shift_alarm (lines 1680-1695). */
  private onT2ShiftAlarm(offset: CLOCK): void {
    this.doShiftRegister(offset);
    alarmUnset(this.t2_shift_alarm);
  }

  /** viacore_phi2_sr_alarm (lines 1808-1827). */
  private onPhi2SrAlarm(offset: CLOCK): void {
    const rclk = (this.clkRef() - offset) >>> 0;
    this.doShiftRegister(offset);
    alarmSet(this.phi2_sr_alarm, (rclk + SR_PHI2_NEXT_OFFSET) >>> 0);
  }

  /** do_shiftregister (lines 1697-1805). */
  private doShiftRegister(offset: CLOCK): void {
    const rclk = (this.clkRef() - offset) >>> 0;
    if (this.shift_state >= FINISHED_SHIFTING) return;
    const acr = this.via[VIA_ACR]!;
    const shiftOut = (acr & VIA_ACR_SR_OUT) !== 0;

    if ((this.shift_state & 1) === 0) {
      // Even state: CB1 low (in shift-out modes).
      if (!this.cb1_is_input) {
        this.backend.setCb1?.(0);
      }
      if (shiftOut) {
        const cb2 = (this.via[VIA_SR]! >>> 7) & 1;
        this.via[VIA_SR] = u8((this.via[VIA_SR]! << 1) | cb2);
        this.cb2_out_state = cb2 !== 0;
        this.backend.setCb2(cb2, offset & 0xff);
      }
    } else {
      // Odd state: CB1 high.
      if (!this.cb1_is_input) {
        this.backend.setCb1?.(1);
      }
      if (!shiftOut) {
        this.via[VIA_SR] = u8(
          (this.via[VIA_SR]! << 1) | (this.cb2_in_state ? 1 : 0),
        );
      }
    }

    this.shift_state += 1;
    if (this.shift_state === FINISHED_SHIFTING) {
      if (isSrFreeRunning(acr)) {
        this.shift_state = START_SHIFTING;
      } else {
        this.ifr |= VIA_IM_SR;
        this.updateIrq(rclk);
        this.backend.srUnderflow?.();
      }
    }
  }

  // ---- set_cb2_output_state (lines 1350-1377) --------------------------
  private setCb2OutputState(pcr: BYTE, offset: number): void {
    const mode = pcr & VIA_PCR_CB2_CONTROL;
    if ((mode & VIA_PCR_CB2_I_OR_O) === VIA_PCR_CB2_INPUT) {
      this.cb2_out_state = true;
      this.backend.setCb2(1, offset);
    } else {
      switch (mode) {
        case VIA_PCR_CB2_LOW_OUTPUT:
          this.cb2_out_state = false;
          break;
        case VIA_PCR_CB2_HIGH_OUTPUT:
        case VIA_PCR_CB2_PULSE_OUTPUT:
        case VIA_PCR_CB2_HANDSHAKE_OUTPUT:
        default:
          this.cb2_out_state = true;
          break;
      }
      this.backend.setCb2(this.cb2_out_state ? 1 : 0, offset);
    }
  }

  // ---- viacore_cache_cb12_io_status (lines 1387-1418) ------------------
  private cacheCb12IoStatus(): void {
    const acr = this.via[VIA_ACR]!;
    const pcr = this.via[VIA_PCR]!;
    const cb1DrivesShifting =
      (acr & VIA_ACR_SR_CONTROL & 0x0c) === VIA_ACR_SR_IN_CB1 ||
      (acr & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED;
    const srIsInput =
      (acr & VIA_ACR_SR_OUT) === 0 &&
      (acr & VIA_ACR_SR_CONTROL) !== VIA_ACR_SR_DISABLED;
    const cb2IsInput = (pcr & VIA_PCR_CB2_I_OR_O) === VIA_PCR_CB2_INPUT;

    this.cb1_is_input = cb1DrivesShifting;
    this.cb2_is_input = srIsInput || cb2IsInput;

    if (
      this.backend.setCb1 &&
      !this.cb1_is_input &&
      this.shift_state === FINISHED_SHIFTING
    ) {
      this.backend.setCb1(1);
    }
  }

  // ---- Legacy compatibility surface — Spec 147 Phase 2 (Sprint 113) ----
  //
  // Drive callers (drive-cpu.ts, drive-session.ts, drive-cpu-equiv-tests.ts,
  // snapshot.ts, headless.ts) were written against the old `Via6522` field
  // shape. These getters + `irqAsserted()` bridge the gap so caller
  // migration is purely mechanical (swap import + constructor).
  //
  // Register file aliases (via[0..15] — VICE names, VIA_PRB=0 etc.).
  // ---------------------------------------------------------------------------

  /** Legacy: ORA latch. Maps to via[VIA_PRA] = via[1]. */
  public get ora(): number { return this.via[VIA_PRA]!; }
  public set ora(v: number) { this.via[VIA_PRA] = v & 0xff; }
  /** Legacy: ORB latch. Maps to via[VIA_PRB] = via[0]. */
  public get orb(): number { return this.via[VIA_PRB]!; }
  public set orb(v: number) { this.via[VIA_PRB] = v & 0xff; }
  /** Legacy: DDRA. Maps to via[VIA_DDRA] = via[3]. */
  public get ddra(): number { return this.via[VIA_DDRA]!; }
  public set ddra(v: number) { this.via[VIA_DDRA] = v & 0xff; }
  /** Legacy: DDRB. Maps to via[VIA_DDRB] = via[2]. */
  public get ddrb(): number { return this.via[VIA_DDRB]!; }
  public set ddrb(v: number) { this.via[VIA_DDRB] = v & 0xff; }
  /** Legacy: ACR. Maps to via[VIA_ACR] = via[11]. */
  public get acr(): number { return this.via[VIA_ACR]!; }
  public set acr(v: number) { this.via[VIA_ACR] = v & 0xff; }
  /** Legacy: PCR. Maps to via[VIA_PCR] = via[12]. */
  public get pcr(): number { return this.via[VIA_PCR]!; }
  public set pcr(v: number) { this.via[VIA_PCR] = v & 0xff; }
  /** Legacy: SR. Maps to via[VIA_SR] = via[10]. */
  public get sr(): number { return this.via[VIA_SR]!; }
  public set sr(v: number) { this.via[VIA_SR] = v & 0xff; }
  /** Legacy: T1 counter (16-bit). Computed from VICE alarm math. */
  public get t1Counter(): number { return this.viacoreT1(this.clkRef()) & 0xffff; }
  /** Legacy: T1 latch (16-bit). Maps to via[T1LL]|via[T1LH]. */
  public get t1Latch(): number {
    return (this.via[VIA_T1LL]! | (this.via[VIA_T1LH]! << 8)) & 0xffff;
  }
  /** Legacy: T2 counter (16-bit). Computed from VICE alarm math. */
  public get t2Counter(): number { return this.viacoreT2(this.clkRef()) & 0xffff; }

  /**
   * Legacy: returns true iff an enabled IRQ source has its flag set.
   * In the VICE-faithful core the IRQ line is pin-driven via backend.setInt;
   * we expose the gate function directly so existing `irqAsserted()` users
   * keep working without change.
   *
   * @param _currentClock ignored — VICE alarm-driven core has no per-call
   *   clock-delay check (delay is baked into alarm scheduling).
   */
  irqAsserted(_currentClock?: number): boolean {
    return (this.ifr & this.ier & 0x7f) !== 0;
  }

  // ---- Snapshot (Phase 1: minimal — internal register-state only) ------
  snapshotState(): {
    via: number[];
    ifr: number; ier: number; tal: number;
    t2cl: number; t2ch: number;
    t1reload: number; t2zero: number; t1zero: number;
    t2xx00: boolean; t1_pb7: number; oldpa: number; oldpb: number;
    ila: number; ilb: number;
    ca2_out_state: boolean; cb1_in_state: boolean; cb1_out_state: boolean;
    cb2_in_state: boolean; cb2_out_state: boolean;
    cb1_is_input: boolean; cb2_is_input: boolean;
    shift_state: number; t2_irq_allowed: boolean;
  } {
    return {
      via: Array.from(this.via),
      ifr: this.ifr, ier: this.ier, tal: u16(this.tal),
      t2cl: this.t2cl, t2ch: this.t2ch,
      t1reload: this.t1reload >>> 0,
      t2zero: this.t2zero >>> 0,
      t1zero: this.t1zero >>> 0,
      t2xx00: this.t2xx00, t1_pb7: this.t1_pb7,
      oldpa: this.oldpa, oldpb: this.oldpb,
      ila: this.ila, ilb: this.ilb,
      ca2_out_state: this.ca2_out_state,
      cb1_in_state: this.cb1_in_state,
      cb1_out_state: this.cb1_out_state,
      cb2_in_state: this.cb2_in_state,
      cb2_out_state: this.cb2_out_state,
      cb1_is_input: this.cb1_is_input,
      cb2_is_input: this.cb2_is_input,
      shift_state: this.shift_state,
      t2_irq_allowed: this.t2_irq_allowed,
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy constant aliases — Sprint 113 Phase 2 caller migration.
// The old `drive/via6522.ts` exported IFR_CA1 etc.; we re-export them
// here under the same names so consumers can switch imports without
// touching every constant reference.
// ---------------------------------------------------------------------------

/** Legacy alias: IFR_CA2 = VIA_IM_CA2. */
export const IFR_CA2 = VIA_IM_CA2;
/** Legacy alias: IFR_CA1 = VIA_IM_CA1. */
export const IFR_CA1 = VIA_IM_CA1;
/** Legacy alias: IFR_SR = VIA_IM_SR. */
export const IFR_SR = VIA_IM_SR;
/** Legacy alias: IFR_CB2 = VIA_IM_CB2. */
export const IFR_CB2 = VIA_IM_CB2;
/** Legacy alias: IFR_CB1 = VIA_IM_CB1. */
export const IFR_CB1 = VIA_IM_CB1;
/** Legacy alias: IFR_T2 = VIA_IM_T2. */
export const IFR_T2 = VIA_IM_T2;
/** Legacy alias: IFR_T1 = VIA_IM_T1. */
export const IFR_T1 = VIA_IM_T1;
/** Legacy alias: IFR_IRQ_SUMMARY = VIA_IM_IRQ. */
export const IFR_IRQ_SUMMARY = VIA_IM_IRQ;

// Legacy register offset aliases matching drive/via6522.ts.
// (VIA_PRB, VIA_PRA, VIA_DDRB, VIA_DDRA, VIA_T1CL, VIA_T1CH,
//  VIA_T1LL, VIA_T1LH, VIA_T2CL, VIA_T2CH, VIA_SR, VIA_ACR,
//  VIA_PCR, VIA_IFR, VIA_IER, VIA_PRA_NHS already exported above
//  — re-export under the old names too.)
/**
 * Bus-access trace hook for VIA register reads/writes.
 * Spec 142: optional callback invoked AFTER the read/write completes.
 * Originally defined in drive/via6522.ts; moved here for Sprint 113 Phase 2.
 */
export interface ViaBusAccessHook {
  emitDriveAccess(p: { op: "read" | "write"; addr: number; value: number }): void;
}

/** Legacy: VIA_ORB = VIA_PRB (0). */
export const VIA_ORB = VIA_PRB;
/** Legacy: VIA_ORA = VIA_PRA (1). */
export const VIA_ORA = VIA_PRA;
/** Legacy: VIA_ORA_NOHS = VIA_PRA_NHS (15). */
export const VIA_ORA_NOHS = VIA_PRA_NHS;
/** Legacy: VIA_REG_COUNT = 16. */
export const VIA_REG_COUNT = 16;
