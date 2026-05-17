// Spec 611 phase 611.4 — 6522 VIA core for VICE1541.
//
// VICE source:  src/core/viacore.c + src/via.h
// Doc anchor:   docs/vice-1541-arch.md §6 + §6.6
//               docs/vice-iec-arc42.md §5.5
//
// PORT_NOTES (Spec 611 phase 611.7g.8 — slices 8, 8a, 10, 11; plus E + F).
// Newly ported (this turn) on top of pre-existing T1/T2 timer + CA1 +
// CA2/CB2 handshake-output infrastructure (slices 611.4..611.7g.7):
//
//   A. Shift register (SR) engine.
//      VICE viacore.c:567-632 setup_shifting / VIA_ACR_SR_CONTROL switch
//                    :727-737  store VIA_SR (clears IFR_SR, setup_shifting)
//                    :1181-1190 read  VIA_SR (clears IFR_SR, setup_shifting)
//                    :1603-1624 t2_underflow_alarm SR-T2 + SR-FREE branches
//                                (latch reload + t2_shift_alarm arming)
//                    :1654-1695 viacore_t2_shift_alarm callback
//                    :1697-1805 do_shiftregister even/odd shift body
//                    :1807-1827 viacore_phi2_sr_alarm
//                    :1428-1501 viacore_set_cb1 (input-side, with shift)
//                    :1387-1418 viacore_cache_cb12_io_status
//                    :1523-1535 viacore_set_sr (burst-mode SR-IN hack)
//   B. PB7 overlay on PRB read/write.
//      VICE viacore.c:720-722 store_prb branch ((ACR & T1_PB7_USED) overlay)
//                    :1152-1154 read VIA_PRB ((ACR & T1_PB7_USED) overlay)
//                    :857-862  ACR write rising-edge t1_pb7 = 0x80
//   C. ACR-write transition side effects.
//      VICE viacore.c:854-986  case VIA_ACR (T2 mode toggle, SR mode
//                              transition, t2_zero_alarm restart, phi2
//                              alarm arm/disarm).
//   D. viacore_init / viacore_reset / viacore_setup_context defaults.
//      VICE viacore.c:378-439 viacore_reset (ca2/cb1/cb2_out_state = true,
//                              shift_state = FINISHED_SHIFTING, t1_pb7 = 0x80,
//                              tal = 0xffff, t2cl/t2ch = 0xff, etc.)
//                    :1829-1859 viacore_setup_context (write_offset = 1,
//                              cb1_in_state/cb2_in_state = true,
//                              t2_irq_allowed = false, sr_underflow/set_cb1
//                              = NULL on the VICE side).
//   E. viacore_signal SIG_CB1 -> viacore_set_cb1 (CB1 input + SR clock).
//      VICE viacore.c:467-468 + 1428-1501.
//   F. viacore_signal SIG_CA2 / SIG_CB2 input edges.
//      VICE viacore.c:459-466 SIG_CA2 input + IRQ on edge.
//      VICE viacore.c:470-471 + 1503-1518 SIG_CB2 / viacore_set_cb2.
//
// Backend interface additions (justified per VICE source):
//   Via6522Backend.setCb1?(state: 0|1)
//     Mirrors VICE via_context->set_cb1 (via.h:221, viacore.c:1735-1736
//     1764-1765). Optional — VICE setup leaves set_cb1 = NULL on the VIA2
//     side when SR is unused. Drive integration (via1d.ts/via2d.ts) may
//     wire it in a follow-up turn; CB1 still works as input via signalCb1.
//   Via6522Backend.setSr?(value: BYTE)
//     Mirrors VICE via_context->store_sr (via.h:213, viacore.c:736). VICE
//     1541 drive stub is no-op but the hook must exist to satisfy the
//     viacore_store VIA_SR path (737). Optional in this port.
//
// Deferred branches that ARE strictly unreachable by the 1541 LOAD path
// (named, not "TODO"):
//   - MYVIA_NEED_LATCHING port (viacore.c:76 commented out globally) —
//     PA/PB input-latch logic. VICE does not compile this for 1541, so
//     omitting it is source-parity.
//   - viacore_snapshot_*, viacore_dump, viacore_peek — diagnostic-only
//     surfaces, not part of register-access semantics.
//   - viacore_shutdown (lib_free on heap-allocated VICE alarm names) —
//     TS GC owns lifetime; no analogue needed.

import { u8, type BYTE } from "../util/uint.js";
import {
  alarmNew,
  alarmSet,
  alarmUnset,
  alarmContextDispatch,
  alarmContextNextPendingClk,
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

// Spec 611 phase 611.7g.4 — VICE viacore.c CA2-mode macros (via.h + viacore.c):
//   VIA_PCR_CA2_CONTROL = 0x0E (PCR bits 1-3)
//   VIA_PCR_CA2_HANDSHAKE_OUTPUT = 0x08
// VICE viacore.c:107-109:
//   IS_CA2_HANDSHAKE()    = (PCR & 0x0c) == 0x08
//   IS_CA2_TOGGLE_MODE()  = (PCR & 0x0e) == 0x08
export const VIA_PCR_CA2_HANDSHAKE_OUTPUT = 0x08;

// Spec 611 phase 611.7g.8/8a/10/11 — VICE via.h:68-93 ACR sub-fields.
export const VIA_ACR_T1_CONTROL = 0xc0;
export const VIA_ACR_T1_PB7_USED = 0x80;
export const VIA_ACR_T1_FREE_RUN = 0x40;
export const VIA_ACR_T2_CONTROL = 0x20;
export const VIA_ACR_T2_COUNTPB6 = 0x20;
export const VIA_ACR_T2_TIMER = 0x00;
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

// VICE via.h:127-130 / 109-112 PCR CA1/CB1 edge select.
export const VIA_PCR_CB1_CONTROL = 0x10;
export const VIA_PCR_CB1_POS_ACTIVE_EDGE = 0x10;

// VICE viacore.c:286-287 — phi2 shift-alarm scheduling offsets.
const SR_PHI2_FIRST_OFFSET = 3;
const SR_PHI2_NEXT_OFFSET = 1;

// VICE viacore.c:172-173 / via.h:172-173 (struct via_context_s) —
// shift-state sentinel constants.
const START_SHIFTING = 0;
const FINISHED_SHIFTING = 16;

export type Via6522IrqHook = (asserted: boolean) => void;

export interface Via6522Backend {
  /** Optional hook called on PRB write (drive PB → IEC bus drv_data).
   *  VICE viacore.c:723 store_prb(ctx, byte, oldpb, addr) — extended
   *  signature (audit D26): `(byte, oldByte, addr)`. Downstream callers
   *  in via1d.ts / via2d.ts must accept the new signature. */
  storePb?: (value: BYTE, oldValue: BYTE, addr: number) => void;
  /** Optional hook for PRA write. VICE viacore.c:694 store_pra(ctx,
   *  byte, oldpa, addr) — extended signature (audit D25/D24):
   *  `(byte, oldByte, addr)`. */
  storePa?: (value: BYTE, oldValue: BYTE, addr: number) => void;
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
   *  VIA2 1541 uses this to drive read/write mode. VICE viacore.c:430
   *  set_cb2(ctx, state, offset) — extended signature (audit
   *  D7/D11/D20/D28/D44/D50/D73): `(state, offset)`. */
  setCb2?: (state: 0 | 1, offset: number) => void;
  /** Optional hook fired when CB1 output state changes (SR clock-out).
   *  Mirrors VICE via_context->set_cb1 (via.h:221). VICE 1541 setup
   *  leaves this NULL unless the drive ROM exercises SR-out-CB1 modes
   *  — wire from drive backend in a follow-up turn if needed. */
  setCb1?: (state: 0 | 1) => void;
  /** Optional hook fired on SR store (viacore.c:736 store_sr). VICE
   *  1541 drive stub is a no-op; included for completeness. */
  setSr?: (value: BYTE) => void;
  /** Optional hook invoked from do_shiftregister on SR underflow (8
   *  bits complete). VICE: via_context->sr_underflow (via.h:214 +
   *  viacore.c:1799-1801). 1541 leaves this NULL. */
  srUnderflow?: () => void;
  /** Optional hook fired from viacore_store T2LL path. VICE
   *  viacore.c:796 store_t2l(ctx, byte) (audit D34). 1541 drive
   *  stub is a no-op; included for source-parity. */
  storeT2l?: (value: BYTE) => void;
  /** Optional hook fired from viacore_store ACR commit path. VICE
   *  viacore.c:984 store_acr(ctx, byte) (audit D47). 1541 drive
   *  stub is a no-op; included for source-parity. */
  storeAcr?: (value: BYTE) => void;
  /** Optional hook fired from viacore_store PCR commit path. VICE
   *  viacore.c:1015 store_pcr(ctx, byte, addr) (audit D48). 1541
   *  drive stub is a no-op; included for source-parity. */
  storePcr?: (value: BYTE, addr: number) => void;
  /** Optional external-device reset hook. VICE viacore.c:432-434
   *  if (reset) reset(ctx) (audit D8). NULL for 1541 VIA1/VIA2 in
   *  VICE; included for source-parity. */
  reset?: () => void;
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
  // CA2/CB2 output latches.
  ca2OutState: 0 | 1 = 1;
  cb2OutState: 0 | 1 = 1;

  // Spec 611 phase 611.7g.8/8a/10/11 — CB1/CB2 input edge tracking.
  // VICE via.h:165-168 cb1_in_state / cb2_in_state. Sampled by
  // viacore_set_cb1/cb2 to detect edges.
  cb1InState: 0 | 1 = 1;
  cb2InState: 0 | 1 = 1;
  // VICE via.h:166 cb1_out_state (SR clock output state).
  cb1OutState: 0 | 1 = 1;

  // VICE via.h:169-170 cb1_is_input / cb2_is_input cache fields.
  // Computed by viacore_cache_cb12_io_status (viacore.c:1387-1418).
  cb1IsInput: boolean = true;
  cb2IsInput: boolean = true;

  // VICE via.h:171 shift_state (0..16, FINISHED_SHIFTING sentinel).
  shiftState: number = FINISHED_SHIFTING;

  /** Last reported IRQ-out state (for change-detect). */
  private lastIrqOut: boolean = false;

  /**
   * VICE via_context->last_read (via.h:152) — last byte returned from any
   * register read. Stamped on every read arm; used by the RMW replay path
   * (audit D21 / VICE viacore.c:641-646). Also stamped on default-arm
   * reads (audit D53-D62). Init 0xff to match VICE power-on bus float.
   */
  private lastRead: BYTE = 0xff;

  /**
   * VICE via_context->oldpa / oldpb (via.h:153-154) — last byte passed to
   * store_pra / store_prb backend hooks. Tracked here so the extended
   * backend signature `(byte, oldByte, addr)` (audit D24/D25/D26) can
   * carry source-correct values. VICE viacore.c:694-695 / 723-724.
   */
  private oldpa: BYTE = 0;
  private oldpb: BYTE = 0;

  /**
   * VICE via_context->rmw_flag (via.h:233) — pointer to host CPU rmw
   * flag. On the second cycle of a 6502 read-modify-write (INC/DEC/ASL
   * etc.) the CPU stores `last_read` back before the new value. VICE
   * viacore.c:641-646. In TS the host CPU sets this via `setRmwFlag(1)`
   * immediately before the second (write-back) store; viacore_store
   * recursively replays the store with last_read at clk-1 then proceeds.
   */
  private rmwFlag: 0 | 1 = 0;

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
  // Audit D116 — VICE keeps via[VIA_T1LL]+via[VIA_T1LH] (latch register
  // bytes) SEPARATE from tal (the active "active timer latch" value used
  // for chase + reload). update_via_t1_latch uses OLD tal to chase
  // t1reload, THEN refreshes tal from the via[] latch bytes (viacore.c:
  // 340-360). Mirroring that here requires distinct fields.
  //
  //   t1Latch = via[VIA_T1LL] | (via[VIA_T1LH] << 8)  — register bytes
  //                                                     (set by store)
  //   tal     = via_context->tal                       — used for chase
  //                                                     + alarm scheduling
  private t1Latch: number = 0;    // via[VIA_T1LL] | via[VIA_T1LH]<<8
  private tal: number = 0;        // VICE via_context->tal (chase/reload)
  private t1ZeroClk: number = 0;  // absolute drive clk when T1 reads 0 (VICE t1zero)
  private t1ReloadClk: number = 0; // t1reload = t1zero + FULL_CYCLE_2 (VICE t1reload)
  // Audit D112: VICE has no `t1Active` / `t1OneShotFired` fields. T1 firing
  // is gated by alarm scheduling alone in VICE. The lazy-fallback path
  // (maybeFireT1AtClk, used only when alarmContext is absent for test
  // harnesses) now uses `t1ZeroClk` + `lazyT1FiredFor` as in-band markers
  // instead of an invented active boolean.
  private lazyT1FiredFor: number = 0; // last t1ZeroClk for which lazy fired
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

  // Spec 611 phase 611.7g.7 — T2 state.
  // Source: VICE viacore.c:311-331 (viacore_t2 helper),
  //         557-566 (schedule_t2_zero_alarm),
  //         785-827 (T2LL/T2CH writes),
  //         1170-1179 (T2CL/CH reads),
  //         1554-1652 (t2_zero / t2_underflow alarm callbacks).
  // State field meaning (1:1 with VICE struct):
  //   t2cl       = active T2 low counter byte (VICE: via_context->t2cl)
  //   t2ch       = active T2 high counter byte (VICE: via_context->t2ch)
  //   t2lLatch   = TS substitute for VICE's `via[VIA_T2LL]` register byte
  //                (this class has no VICE-style `via[]` register array,
  //                so the addr-0x8 latch register lives here as a named
  //                field). Written by store(addr=0x8); read NOT exposed
  //                (latch invisible to register reads — those sample the
  //                live counter). NOT a new VICE state field, strictly
  //                the addr-0x8 latch register VICE keeps in via[VIA_T2LL].
  //   t2zero     = absolute drive clk when T2 next reaches xx00
  //                (VICE: via_context->t2zero)
  //   t2xx00     = true if t2zero is the next xx00 boundary
  //                (VICE: via_context->t2xx00)
  //   t2IrqAllowed = one-shot IRQ gate; cleared after each T2 IRQ until
  //                next T2CH write re-arms (VICE: via_context->t2_irq_allowed)
  private t2cl: number = 0;
  private t2ch: number = 0;
  private t2lLatch: number = 0;
  private t2zero: number = 0;
  private t2xx00: boolean = false;
  private t2IrqAllowed: boolean = false;
  private t2ZeroAlarm: Alarm | null = null;
  private t2UnderflowAlarm: Alarm | null = null;
  // Spec 611 phase 611.7g.10 — SR-supporting alarms.
  // VICE via.h:177-178 t2_shift_alarm + phi2_sr_alarm.
  private t2ShiftAlarm: Alarm | null = null;
  private phi2SrAlarm: Alarm | null = null;

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
      // Spec 611 phase 611.7g.7 — register T2 alarms per
      // viacore.c:1306-1307 viacore_setup pattern.
      this.t2ZeroAlarm = alarmNew(
        this.alarmContext,
        `${this.label}-t2-zero`,
        (offset: number) => this.t2ZeroAlarmCallback(offset),
        null,
      );
      this.t2UnderflowAlarm = alarmNew(
        this.alarmContext,
        `${this.label}-t2-underflow`,
        (offset: number) => this.t2UnderflowAlarmCallback(offset),
        null,
      );
      // Spec 611 phase 611.7g.10 — SR-related alarms per
      // viacore.c:1885-1890 viacore_init pattern.
      this.t2ShiftAlarm = alarmNew(
        this.alarmContext,
        `${this.label}-t2-sr`,
        (offset: number) => this.t2ShiftAlarmCallback(offset),
        null,
      );
      this.phi2SrAlarm = alarmNew(
        this.alarmContext,
        `${this.label}-sr`,
        (offset: number) => this.phi2SrAlarmCallback(offset),
        null,
      );
    }
    // Spec 611 phase 611.7g.11 — viacore_setup_context defaults
    // (viacore.c:1829-1859). VICE state on power-up before reset:
    //   cb1_in_state = true; cb2_in_state = true;
    //   t2_irq_allowed = false;
    //   sr_underflow = NULL; set_cb1 = NULL;  (handled at backend layer)
    // Audit D81 — VICE viacore.c:1832-1845 viacore_setup_context also
    // pre-loads the register-array slots before viacore_reset is called:
    //   via[VIA_T1CL=4] = via[VIA_T1LL=6] = 0xff;
    //   via[VIA_T1CH=5] = via[VIA_T1LH=7] = 223;
    //   via[VIA_T2CL=8] = via[VIA_T2CH=9] = 0xff;
    // TS has no via[] register array — store equivalent state: t1Latch
    // composed of (T1LL=0xff | T1LH=223<<8) = 0xdfff, t2lLatch = 0xff,
    // t2cl/t2ch = 0xff. write_offset = 1 in VICE; TS uses 0 per
    // runPendingAlarmsAt owner-block (Cpu65xxVice tick ordering).
    this.t1Latch = 0xff | (223 << 8); // = 0xdfff per VICE defaults
    this.tal = this.t1Latch; // VICE setup_context implicit (via.h via[])
    this.t2lLatch = 0xff;
    this.t2cl = 0xff;
    this.t2ch = 0xff;
    this.cb1InState = 1;
    this.cb2InState = 1;
    this.t2IrqAllowed = false;
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
    } else {
      // viacore.c:1319-1334 continuous mode: reschedule by full_cycle
      // (= tal + FULL_CYCLE_2). t1reload tracking deferred per VICE
      // comment (bug 2203) — not required for 1541 LOAD.
      // Audit D116 — VICE uses via_context->tal (active timer latch),
      // NOT the new via[VIA_T1L*] register bytes.
      const fullCycle = this.tal + 2;
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

  /**
   * Spec 611 phase 611.7g.7 — viacore_t2_zero_alarm port.
   *
   * VICE source: src/core/viacore.c:1554-1586.
   *   rclk = *clk_ptr - offset;
   *   t2ch--;
   *   if (t2ch == 0xff && t2_irq_allowed) {
   *     ifr |= VIA_IM_T2; update_myviairq_rclk(rclk);
   *     t2_irq_allowed = false;
   *   }
   *   alarm_unset(t2_zero_alarm);
   *   alarm_set(t2_underflow_alarm, rclk + 1);
   */
  private t2ZeroAlarmCallback(offset: number): void {
    const rclk = (this.getLiveClk() - offset) & 0xffffffff;
    this.t2ch = (this.t2ch - 1) & 0xff;
    if (this.t2ch === 0xff && this.t2IrqAllowed) {
      this.ifr |= IFR_T2;
      this.updateIrqAtClk(rclk);
      this.t2IrqAllowed = false;
    }
    if (this.t2ZeroAlarm) alarmUnset(this.t2ZeroAlarm);
    if (this.t2UnderflowAlarm) alarmSet(this.t2UnderflowAlarm, (rclk + 1) >>> 0);
  }

  /**
   * Spec 611 phase 611.7g.7 — viacore_t2_underflow_alarm port (16-bit
   * timer-mode branch only). VICE source: src/core/viacore.c:1593-1652.
   *
   * Deferred upper branches (slice 7g.10):
   *   - VIA_ACR_SR_IN_T2 / OUT_T2 (`(ACR & 0x0c) == 0x04`):
   *     viacore.c:1603-1613 — reloads t2cl from latch + arms t2_shift_alarm.
   *   - IS_SR_FREE_RUNNING (`(ACR & 0x1c) == 0x10`, VIA_ACR_SR_OUT_FREE_T2):
   *     viacore.c:1614-1624 — same plus free-running shift.
   * Both SR-T2 paths are explicit non-scope. They are NEVER reached
   * by this callback because scheduleT2ZeroAlarm refuses to arm the
   * timer-mode T2 alarms when either SR-T2 mode is active (gate at
   * the scheduling boundary, not in the callback).
   *
   * 16-bit timer-mode (the else branch, viacore.c:1625-1648):
   *   t2cl = 0xff;
   *   next_alarm = (t2ch != 0xff) ? 256 : 0;
   *   if (next_alarm) {
   *     t2zero += next_alarm; t2xx00 = true;
   *     alarm_set(t2_zero_alarm, t2zero);
   *   } else {
   *     alarm_unset(t2_zero_alarm);
   *     t2xx00 = false;
   *   }
   *   alarm_unset(t2_underflow_alarm);
   */
  private t2UnderflowAlarmCallback(offset: number): void {
    // Spec 611 phase 611.7g.10 — full port now that SR engine is in scope.
    // VICE source: src/core/viacore.c:1593-1652.
    const rclk = (this.getLiveClk() - offset) & 0xffffffff;
    let nextAlarm = 0;
    if ((this.acr & 0x0c) === 0x04) {
      // viacore.c:1603-1613 — SR-T2 mode: reload t2cl from latch, schedule
      // t2_shift_alarm + 1 cycle, next zero alarm at t2 low period.
      this.t2cl = this.t2lLatch;
      nextAlarm = (this.t2lLatch + 2) & 0xffff; // FULL_CYCLE_2
      if (this.t2ShiftAlarm) {
        alarmSet(this.t2ShiftAlarm, (rclk + 1) >>> 0);
      }
    } else if ((this.acr & 0x1c) === VIA_ACR_SR_OUT_FREE_T2) {
      // viacore.c:1614-1624 — SR-free-running: same as SR-T2 but never
      // stops shifting.
      this.t2cl = this.t2lLatch;
      nextAlarm = (this.t2lLatch + 2) & 0xffff;
      if (this.t2ShiftAlarm) {
        alarmSet(this.t2ShiftAlarm, (rclk + 1) >>> 0);
      }
    } else {
      // viacore.c:1625-1634 — 16-bit timer-mode else-branch.
      this.t2cl = 0xff;
      nextAlarm = (this.t2ch !== 0xff) ? 256 : 0;
    }
    // viacore.c:1637-1649 — set next zero alarm OR turn off.
    if (nextAlarm) {
      this.t2zero = (this.t2zero + nextAlarm) >>> 0;
      this.t2xx00 = true;
      if (this.t2ZeroAlarm) alarmSet(this.t2ZeroAlarm, this.t2zero);
    } else {
      if (this.t2ZeroAlarm) alarmUnset(this.t2ZeroAlarm);
      this.t2xx00 = false;
    }
    if (this.t2UnderflowAlarm) alarmUnset(this.t2UnderflowAlarm);
  }

  /**
   * Spec 611 phase 611.7g.7 / 7g.10 — schedule_t2_zero_alarm port.
   * VICE source: src/core/viacore.c:557-566.
   *
   * As of slice 7g.10 the SR-T2 / SR-free-T2 branches in the underflow
   * callback are ported — so the gate previously here (refusing to arm
   * timer-mode T2 alarms while SR-T2 was active) is no longer needed.
   * VICE schedules unconditionally; we now match.
   */
  private scheduleT2ZeroAlarm(rclk: number): void {
    this.t2zero = (rclk + this.t2cl) >>> 0;
    this.t2xx00 = true;
    if (this.t2UnderflowAlarm) alarmUnset(this.t2UnderflowAlarm);
    if (this.t2ZeroAlarm) alarmSet(this.t2ZeroAlarm, this.t2zero);
  }

  /**
   * Spec 611 phase 611.7g.7 — viacore_t2 live-counter helper.
   * VICE source: src/core/viacore.c:311-331.
   */
  private viacoreT2(rclk: number): number {
    // ACR.5 = VIA_ACR_T2_COUNTPB6 (pulse-counted PB6 mode).
    if (this.acr & 0x20) {
      return ((this.t2ch << 8) | this.t2cl) & 0xffff;
    }
    let t2 = (this.t2zero - rclk) & 0xffff;
    if (this.t2xx00) {
      t2 = ((this.t2ch << 8) | (t2 & 0xff)) & 0xffff;
    }
    return t2;
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
    // Audit D112 — `t1Active` removed. VICE uses alarm scheduling; the
    // lazy fallback now gates on t1ZeroClk being non-zero (which only
    // happens after a T1CH write or while continuous). lazyT1FiredFor
    // tracks the last t1ZeroClk we fired for so one-shot mode doesn't
    // re-fire on subsequent polls.
    if (this.t1ZeroClk === 0) return;
    if (rclk < this.t1ZeroClk + 1) return;
    const continuous = (this.acr & 0x40) !== 0;
    if (continuous || this.lazyT1FiredFor !== this.t1ZeroClk) {
      const wasSet = (this.ifr & IFR_T1) !== 0;
      this.ifr |= IFR_T1;
      if (!continuous) this.lazyT1FiredFor = this.t1ZeroClk;
      if (!wasSet) this.updateIrqAtClk(rclk);
    }
    if (continuous) {
      // Audit D116 — VICE uses via_context->tal here, not the latch bytes.
      const fullCycle = this.tal + 2;
      if (fullCycle > 0) {
        while (rclk >= this.t1ZeroClk + 1) {
          this.t1ZeroClk += fullCycle;
        }
      }
    }
  }

  /**
   * VICE viacore_t1: counter value at given clk.
   * VICE source: src/core/viacore.c:265-284 (audit D89/D113).
   *
   *   if (rclk < t1reload) {
   *       res = t1reload - rclk - FULL_CYCLE_2;        // == t1zero - rclk
   *   } else {
   *       full_cycle = tal + FULL_CYCLE_2;
   *       partial_cycle = (rclk - t1reload) % full_cycle;
   *       return tal - partial_cycle;
   *   }
   *
   * The else branch handles the case where the alarm has fired but
   * t1ZeroClk has not yet been advanced (free-run or one-shot post-zero).
   */
  private viacoreT1(rclk: number): number {
    if (rclk < this.t1ReloadClk) {
      return (this.t1ReloadClk - rclk - 2) & 0xffff;
    }
    // Audit D116 — VICE uses via_context->tal here (viacore.c:278-282).
    const fullCycle = this.tal + 2;
    if (fullCycle <= 0) return 0;
    const partial = (rclk - this.t1ReloadClk) % fullCycle;
    return (this.tal - partial) & 0xffff;
  }

  /**
   * VICE update_via_t1_latch (viacore.c:340-361) — audit D88.
   *
   * Two responsibilities:
   *   1) If rclk has overrun t1reload (CPU went past at least one T1
   *      cycle without the alarm firing), advance t1reload forward by
   *      `nuf * full_cycle` so the next read/alarm computation is
   *      anchored to the current cycle frame.
   *   2) Refresh `tal` from the T1LL/T1LH latch register.
   *
   * Called from store T1CL/T1LL/T1CH/T1LH so a latch write while the
   * timer is running re-anchors t1reload to the right frame.
   */
  private updateViaT1Latch(rclk: number): void {
    // Audit D116 — VICE viacore.c:340-360. Chase t1reload using OLD `tal`
    // (the active timer latch value), THEN refresh tal from the via[]
    // latch register bytes (= this.t1Latch in TS). Critical: callers
    // mutate this.t1Latch BEFORE calling this (mirroring VICE's `via[
    // VIA_T1L*] = byte; update_via_t1_latch(rclk);` order), so chase
    // MUST use the cached `this.tal` field, not the new t1Latch.
    if (rclk >= this.t1ReloadClk) {
      const fullCycle = this.tal + 2;
      if (fullCycle > 0) {
        const timePastLastReload = rclk - this.t1ReloadClk;
        // VICE viacore.c:349: nuf = 1 + (time_past_last_reload / full_cycle)
        const nuf = 1 + Math.floor(timePastLastReload / fullCycle);
        this.t1ReloadClk = (this.t1ReloadClk + nuf * fullCycle) >>> 0;
      }
    }
    // VICE viacore.c:358-359: tal = via[VIA_T1LL] | (via[VIA_T1LH] << 8).
    this.tal = this.t1Latch & 0xffff;
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

  /** Reset to viacore defaults. VICE viacore_reset() (viacore.c:378-439). */
  reset(): void {
    // VICE viacore.c:383-385 — port data/ddr cleared (via[0..3] = 0).
    this.pra = 0;
    this.prb = 0;
    this.ddra = 0;
    this.ddrb = 0;
    // VICE viacore.c:393-395 — via[11..15] cleared (ACR, PCR, IFR, IER,
    // PRA_NHS = 0). Shift register (via[10]) intentionally NOT cleared
    // per Rockwell ("omit shift register" comment viacore.c:392).
    this.pcr = 0;
    this.acr = 0;
    this.ifr = 0;
    this.ier = 0;
    // Spec 611 phase 611.7f.9 + 611.7g.2 (Codex 12:37 fix) — T1 reset.
    // Unset pending alarm + clear all T1 internal state.
    this.t1Latch = 0xffff; // VICE viacore.c:397 tal = 0xffff.
    this.tal = 0xffff;     // VICE viacore.c:397 via_context->tal = 0xffff.
    this.t1ZeroClk = 0;
    // VICE viacore.c:400 t1reload = *clk_ptr (current drive clk).
    this.t1ReloadClk = this.getClk();
    // Audit D112: lazy-fire tracking reset (no t1Active boolean to clear).
    this.lazyT1FiredFor = 0;
    // Spec 611 phase 611.7g.11 / VICE viacore.c:408 — t1_pb7 = 0x80 on reset
    // (NOT 0x00). This is the PB7 idle-high default.
    this.t1Pb7 = 0x80;
    if (this.t1ZeroAlarm) alarmUnset(this.t1ZeroAlarm);
    // Spec 611 phase 611.7g.11 — VICE viacore.c:398-401, 410-411 T2 reset
    // field defaults: t2cl = t2ch = 0xff; t2zero = *clk_ptr;
    // shift_state = FINISHED_SHIFTING; t2_irq_allowed = false.
    this.t2cl = 0xff;
    this.t2ch = 0xff;
    this.t2zero = this.getClk();
    this.t2xx00 = false;   // VICE viacore.c:415
    this.t2IrqAllowed = false;
    this.shiftState = FINISHED_SHIFTING;
    // VICE viacore.c:416-420 — unset all five timer/SR alarms.
    if (this.t2ZeroAlarm) alarmUnset(this.t2ZeroAlarm);
    if (this.t2UnderflowAlarm) alarmUnset(this.t2UnderflowAlarm);
    if (this.t2ShiftAlarm) alarmUnset(this.t2ShiftAlarm);
    if (this.phi2SrAlarm) alarmUnset(this.phi2SrAlarm);
    // VICE viacore.c:423-424 — oldpa/oldpb = 0.
    this.oldpa = 0;
    this.oldpb = 0;
    // Audit D10 — VICE viacore_reset does NOT touch cb1_in_state /
    // ca1_in_state equivalents (those are only set in viacore_setup_context
    // viacore.c:1853-1854). TS previously wrote ca1State=1/cb1State=1 here;
    // removed for source-parity.
    // VICE viacore.c:426-430 — ca2/cb1/cb2_out_state = true (idle high).
    this.ca2OutState = 1;
    this.cb1OutState = 1;
    this.cb2OutState = 1;
    this.backend.setCa2?.(this.ca2OutState);
    // Audit D11 — VICE viacore.c:430 passes offset=0 explicitly to
    // set_cb2 from reset. Extended TS signature now carries it.
    this.backend.setCb2?.(this.cb2OutState, 0);
    // Audit D8 — VICE viacore.c:432-434 invokes external reset callback
    // when registered. NULL for 1541 VIA1/VIA2 in VICE but the hook
    // exists; included for source-parity.
    this.backend.reset?.();
    // VICE viacore.c:436 — viacore_cache_cb12_io_status.
    this.cacheCb12IoStatus();
    this.updateIrqAtClk(this.getClk());
  }

  /**
   * Public read for the drive-memory dispatch ($1800-$180F + mirrors).
   * Register-only — does not advance any timers in 611.4 minimum.
   */
  /**
   * Spec 611 phase 611.7g.6r — viacore run_pending_alarms at register access.
   *
   * VICE source:
   *   src/core/viacore.c:517-530 run_pending_alarms (inline static)
   *     while (clk > alarm_context_next_pending_clk(alarm_context)) {
   *         alarm_context_dispatch(alarm_context, clk + offset);
   *     }
   *   src/core/viacore.c:660-662 viacore_store head (gated dispatch)
   *   src/core/viacore.c:1068-1070 viacore_read head (gated dispatch)
   *
   * Boundary semantics: VICE uses strict `>` (NOT `>=`). An alarm
   * scheduled for cycle N fires AFTER all CPU accesses for cycle N
   * (= during cycle N+1). Differs from CPU end-of-step drain which
   * uses `>=` because that runs at end-of-tick / start-of-next-tick.
   *
   * Gated registers: VIA_PRB, VIA_T1CL..VIA_IER. NOT VIA_PRA,
   * VIA_PRA_NHS, VIA_DDRA, VIA_DDRB (per VICE source — those have
   * no T1/T2/IRQ alarm coupling).
   *
   * Clock-owner: rclk = this.getClk() = polled drive cpu.clk at
   * the precise register-access moment. write_offset=0 is the
   * active source-correct mapping for TS (see owner block below).
   *
   * write_offset owner (Codex 17:20 #2 — active owner, not interim):
   *   VICE viacore.c:1841 sets `via_context->write_offset = 1` for
   *   the 1541 6502 because VICE stores happen AFTER `*clk_ptr++`
   *   (line 645 + 649). In TS, Cpu65xxVice tick() does `drainAlarms
   *   → bumpDelays → clk++` BEFORE the instruction body runs, so
   *   this.clk IS the register-access cycle when via.write is
   *   called. No `-1` compensation needed. Source-correct mapping
   *   for TS = write_offset=0. THIS IS THE ACTIVE write_offset
   *   OWNER for VICE1541 register-access alarm catch-up.
   *
   * Deferred callback-offset owners (NOT this helper's
   * responsibility — named per Codex 17:20 #3):
   *   - viacore.c:705 (via_context->set_cb2)(ctx, state, write_offset)
   *     → TS backend.setCb2 currently takes (state: 0|1) only.
   *     When set_cb2 callbacks begin consuming the cycle-relative
   *     offset for downstream edge timing, that's a separate slice
   *     in the via*d backend (slice 7g.9 CB2 input edge + CB2
   *     callback offset propagation).
   *   - viacore.c:939 set_ca2_output_state(... write_offset) —
   *     slice 7g.8 CA2 output state with offset.
   *   - viacore.c:1012 set_cb2_output_state(byte, write_offset) —
   *     slice 7g.8 PCR write CB2 output mode with offset.
   * These callbacks pass write_offset through; the run_pending
   * helper is fully source-shaped here.
   */
  private runPendingAlarmsAt(rclk: number, offset: number = 0): void {
    const ctx = this.alarmContext;
    if (!ctx) return;
    // VICE viacore.c:517-530 run_pending_alarms verbatim:
    //   while (clk > alarm_context_next_pending_clk(ctx)) {
    //       alarm_context_dispatch(ctx, clk + offset);
    //   }
    while (rclk > alarmContextNextPendingClk(ctx)) {
      alarmContextDispatch(ctx, (rclk + offset) >>> 0);
    }
  }

  /**
   * Register-set gate from VICE viacore.c:660 + 1068:
   *   addr == VIA_PRB || (addr >= VIA_T1CL && addr <= VIA_IER)
   */
  private static needsAlarmCatchUp(reg: number): boolean {
    return reg === VIA_PRB || (reg >= VIA_T1CL && reg <= VIA_IER);
  }

  /**
   * Spec 611 phase 611.7g.10 — viacore_cache_cb12_io_status port.
   * VICE source: src/core/viacore.c:1387-1418.
   *
   * Re-computes cb1_is_input / cb2_is_input from current ACR + PCR, and
   * if shifting is idle and CB1 is output, drives CB1 idle-high (1).
   * Must be called on every ACR or PCR write per VICE comment.
   */
  private cacheCb12IoStatus(): void {
    const acr = this.acr;
    const pcr = this.pcr;
    // viacore.c:1392-1394 cb1_drives_shifting.
    const cb1DrivesShifting =
      ((acr & VIA_ACR_SR_CONTROL & 0x0c) === VIA_ACR_SR_IN_CB1) ||
      ((acr & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED);
    // viacore.c:1396-1398 sr_is_input.
    const srIsInput =
      ((acr & VIA_ACR_SR_OUT) === 0) &&
      ((acr & VIA_ACR_SR_CONTROL) !== VIA_ACR_SR_DISABLED);
    // viacore.c:1400-1401 cb2_is_input (PCR view).
    const cb2IsInputPcr = (pcr & 0x80) === 0; // VIA_PCR_CB2_I_OR_O = 0x80
    this.cb1IsInput = cb1DrivesShifting;
    this.cb2IsInput = srIsInput || cb2IsInputPcr;
    // viacore.c:1412-1417 — when shifting idle + CB1 output, drive 1.
    if (
      this.backend.setCb1 &&
      !this.cb1IsInput &&
      this.shiftState === FINISHED_SHIFTING
    ) {
      this.cb1OutState = 1;
      this.backend.setCb1(1);
    }
  }

  /**
   * Spec 611 phase 611.7g.10 — setup_shifting port.
   * VICE source: src/core/viacore.c:575-632.
   *
   * Called on SR register read/write to potentially arm the shift
   * pipeline based on the current ACR.SR mode.
   */
  private setupShifting(rclk: number): void {
    switch (this.acr & VIA_ACR_SR_CONTROL) {
      case VIA_ACR_SR_DISABLED:
        // viacore.c:580-589 — disabled: do not change state.
        break;
      case VIA_ACR_SR_IN_T2:
      case VIA_ACR_SR_OUT_T2:
      case VIA_ACR_SR_IN_CB1:
      case VIA_ACR_SR_OUT_CB1: {
        // viacore.c:590-612 — wait for T2 / CB1 to drive shifting.
        if (this.shiftState === FINISHED_SHIFTING) {
          this.shiftState = START_SHIFTING;
        }
        break;
      }
      case VIA_ACR_SR_IN_PHI2:
      case VIA_ACR_SR_OUT_PHI2: {
        // viacore.c:613-624 — phi2 alarm-driven shifting.
        if (this.shiftState === FINISHED_SHIFTING) {
          this.shiftState = START_SHIFTING;
          if (this.phi2SrAlarm) {
            alarmSet(this.phi2SrAlarm, (rclk + 1) >>> 0);
          }
        }
        break;
      }
      case VIA_ACR_SR_OUT_FREE_T2: {
        // viacore.c:626-630 — free-running output: keep state & 0x0F.
        this.shiftState &= 0x0f;
        break;
      }
    }
  }

  /**
   * Spec 611 phase 611.7g.10 — do_shiftregister port.
   * VICE source: src/core/viacore.c:1697-1805.
   *
   * Even step: drive CB1 low (when CB1 is an output) + shift out (if
   * shifting out) by rotating SR left through CB2 bit 7.
   * Odd step: drive CB1 high + shift in (if shifting in) by sampling
   * cb2_in_state.
   * When 8 bits are complete: set IFR_SR (unless free-running mode),
   * invoke sr_underflow callback.
   */
  private doShiftRegister(offset: number): void {
    const rclk = (this.getLiveClk() - offset) & 0xffffffff;
    if (this.shiftState >= FINISHED_SHIFTING) return;
    const acr = this.acr;
    const shiftOut = (acr & VIA_ACR_SR_OUT) !== 0;
    if ((this.shiftState & 1) === 0) {
      // viacore.c:1732-1760 — even state.
      if (!this.cb1IsInput) {
        this.cb1OutState = 0;
        this.backend.setCb1?.(0);
      }
      if (shiftOut) {
        // viacore.c:1745-1759 — shift out (rotate left).
        const cb2 = (this.sr >> 7) & 1;
        this.sr = ((this.sr << 1) | cb2) & 0xff;
        this.cb2OutState = cb2 as 0 | 1;
        // Audit D73 — VICE viacore.c:1758 passes (int)offset.
        this.backend.setCb2?.(this.cb2OutState, offset | 0);
      }
    } else {
      // viacore.c:1761-1776 — odd state.
      if (!this.cb1IsInput) {
        this.cb1OutState = 1;
        this.backend.setCb1?.(1);
      }
      if (!shiftOut) {
        // viacore.c:1771-1775 — shift in (left shift, sample cb2_in_state).
        this.sr = ((this.sr << 1) | (this.cb2InState & 1)) & 0xff;
      }
    }
    this.shiftState += 1;
    // viacore.c:1786-1803 — finished?
    if (this.shiftState === FINISHED_SHIFTING) {
      if ((acr & 0x1c) === VIA_ACR_SR_OUT_FREE_T2) {
        // IS_SR_FREE_RUNNING — restart, no IRQ.
        this.shiftState = START_SHIFTING;
      } else {
        this.ifr |= IFR_SR;
        this.updateIrqAtClk(rclk);
        this.backend.srUnderflow?.();
      }
    }
  }

  /**
   * Spec 611 phase 611.7g.10 — viacore_t2_shift_alarm callback.
   * VICE source: src/core/viacore.c:1680-1695.
   */
  private t2ShiftAlarmCallback(offset: number): void {
    this.doShiftRegister(offset);
    if (this.t2ShiftAlarm) alarmUnset(this.t2ShiftAlarm);
  }

  /**
   * Spec 611 phase 611.7g.10 — viacore_phi2_sr_alarm callback.
   * VICE source: src/core/viacore.c:1808-1827.
   */
  private phi2SrAlarmCallback(offset: number): void {
    const rclk = (this.getLiveClk() - offset) & 0xffffffff;
    this.doShiftRegister(offset);
    // viacore.c:1826 — re-arm 1 cycle later.
    if (this.phi2SrAlarm) {
      alarmSet(this.phi2SrAlarm, (rclk + SR_PHI2_NEXT_OFFSET) >>> 0);
    }
  }

  /**
   * Spec 611 phase 611.7g.8 — set_cb2_output_state port.
   * VICE source: src/core/viacore.c:1350-1377.
   *
   * Called from ACR-write SR-disabled branch and PCR write (when SR
   * doesn't override CB2). Drives CB2 from PCR mode bits.
   *
   * Audit D44 / D50 — VICE set_cb2_output_state(ctx, mode, offset) takes
   * an offset parameter and forwards it to set_cb2. Extended signature
   * for source-parity.
   */
  private applyPcrCb2OutputState(offset: number = 0, pcrOverride?: number): void {
    // Audit D56 — VICE viacore.c:1012 calls set_cb2_output_state(byte,
    // write_offset) with the NEW PCR byte directly as the `pcr`
    // parameter, while via[VIA_PCR] still holds the OLD value
    // (assignment at line 1017 happens AFTER store_pcr). Accept an
    // override so PCR-write path can pass the new byte without first
    // mutating this.pcr.
    const src = (typeof pcrOverride === 'number') ? pcrOverride : this.pcr;
    const mode = src & 0xe0; // VIA_PCR_CB2_CONTROL
    // viacore.c:1354-1360 — input mode: keep input, drive 1.
    if ((mode & 0x80) === 0) {
      this.cb2OutState = 1;
      this.backend.setCb2?.(1, offset | 0);
      return;
    }
    // viacore.c:1362-1375 — output modes.
    switch (mode) {
      case 0xc0: // VIA_PCR_CB2_LOW_OUTPUT
        this.cb2OutState = 0;
        break;
      case 0xe0: // VIA_PCR_CB2_HIGH_OUTPUT
      case 0xa0: // VIA_PCR_CB2_PULSE_OUTPUT
      case 0x80: // VIA_PCR_CB2_HANDSHAKE_OUTPUT
      default:
        this.cb2OutState = 1;
        break;
    }
    this.backend.setCb2?.(this.cb2OutState, offset | 0);
  }

  /**
   * Spec 611 phase 611.7g.8a — PB7 overlay for PRB output byte.
   * VICE source: src/core/viacore.c:720-722 (store_prb), :1152-1154
   * (read VIA_PRB). When ACR & T1_PB7_USED is set, the PB7 bit of the
   * driven/read PRB byte is taken from t1_pb7 instead of PRB[7].
   */
  private overlayPb7(byte: number): number {
    if (this.acr & VIA_ACR_T1_PB7_USED) {
      return ((byte & 0x7f) | (this.t1Pb7 & 0x80)) & 0xff;
    }
    return byte & 0xff;
  }

  read(reg: number): BYTE {
    const r = reg & 0x0f;
    // VICE viacore_read head (viacore.c:1068-1070).
    if (Via6522.needsAlarmCatchUp(r)) {
      this.runPendingAlarmsAt(this.getClk(), 0);
    }
    switch (r) {
      case VIA_PRB:
      case VIA_PRA_NHS:
      case VIA_PRA: {
        if (r === VIA_PRB) {
          // VICE viacore_read case VIA_PRB (viacore.c:1124-1160) applies
          // CB1/CB2 IFR clear + IRQ re-eval FIRST, then samples PB:
          //   byte = read_prb(via)
          //   byte = (byte & ~DDRB) | (PRB & DDRB)
          //   if ACR & T1_PB7_USED: byte = (byte & 0x7f) | t1_pb7  (7g.8a)
          // Asymmetric vs PRA: NO CB2 handshake side effect on read
          // (VICE comment lines 1138-1139: "this port reads the ORB
          // for output pins, not the voltage on the pins").
          this.applyPrbReadSideEffects();
          const driven = this.prb & this.ddrb;
          const input = this.backend.readPb ? this.backend.readPb() : 0xff;
          let value = (driven & this.ddrb) | (input & ~this.ddrb);
          // Spec 611 phase 611.7g.8a — VICE viacore.c:1152-1154 PB7 overlay.
          value = this.overlayPb7(value);
          // Audit D54 — VICE viacore.c:1155 last_read = byte.
          this.lastRead = u8(value);
          return this.lastRead;
        }
        // VICE viacore_read case VIA_PRA (viacore.c:1073-1095) applies
        // handshake/IFR/IRQ block FIRST, then `goto via_pra_nhs` falls
        // through to read the actual PA voltage. Run side effects before
        // sampling the backend so CA2/IRQ edges propagate ahead of the
        // sample (matters when backend.readPa reads bus state composed
        // with CA2).
        if (r === VIA_PRA) {
          this.applyPraSideEffects();
        }
        // VIA_PRA_NHS: no side effects (per VICE viacore.c:1098-1101
        // VIA_PRA_NHS read path comment "WARNING: this pin reads voltage
        // of output pins, not the ORA value" — no handshake, no IFR clear).
        // Audit D63 — VICE viacore.c:1114 returns the RAW read_pra
        // callback byte. Composition of (pra & ddra) | (input & ~ddra)
        // is the BACKEND's responsibility (drivevia*.c read_pra does it
        // itself). Do not double-compose here.
        const value = u8(this.backend.readPa ? this.backend.readPa() : 0xff);
        // Audit D53 — VICE viacore.c:1121 last_read = byte.
        this.lastRead = value;
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
        // Audit D55 — VICE viacore.c:1162 uses update_myviairq_rclk(rclk).
        this.updateIrqAtClk(rclk);
        // Audit D56 — VICE viacore.c:1163 last_read = (uint8_t)(...) & 0xff.
        this.lastRead = counter & 0xff;
        return this.lastRead;
      }
      case VIA_T1CH: {
        // VICE: T1CH read returns viacore_t1 HIGH byte. Does NOT clear IFR_T1.
        const rclk = this.getClk();
        this.maybeFireT1AtClk(rclk);
        // Audit D57 — VICE viacore.c:1167 last_read = (viacore_t1 >> 8) & 0xff.
        this.lastRead = (this.viacoreT1(rclk) >> 8) & 0xff;
        return this.lastRead;
      }
      case VIA_T1LL: return this.t1Latch & 0xff;
      case VIA_T1LH: return (this.t1Latch >> 8) & 0xff;
      case VIA_T2CL: {
        // VICE viacore.c:1170-1176 — clear IFR_T2 + return live counter low.
        const rclk = this.getClk();
        this.ifr &= ~IFR_T2;
        this.updateIrqAtClk(rclk);
        this.lastRead = this.viacoreT2(rclk) & 0xff;
        return this.lastRead;
      }
      case VIA_T2CH: {
        // VICE viacore.c:1177-1179 — return live counter high. NO IFR clear.
        const rclk = this.getClk();
        this.lastRead = (this.viacoreT2(rclk) >> 8) & 0xff;
        return this.lastRead;
      }
      case VIA_SR: {
        // Spec 611 phase 611.7g.10 — viacore_read VIA_SR.
        // VICE source: src/core/viacore.c:1181-1190.
        const rclk = this.getClk();
        this.setupShifting(rclk);
        if (this.ifr & IFR_SR) {
          this.ifr &= ~IFR_SR;
          this.updateIrqAtClk(rclk);
        }
        // Audit D59 — VICE viacore.c:1189-1190 last_read = via[VIA_SR].
        this.lastRead = this.sr;
        return this.sr;
      }
      case VIA_ACR: return this.acr;
      case VIA_PCR: return this.pcr;
      case VIA_IFR: {
        // Spec 611 phase 611.7f.9 — lazy-evaluate T1 underflow at this clk
        // so drive ROM IFR poll (e.g. $E9E2 LDA $180D / AND #$40) sees
        // IFR_T1 set as soon as the timer has underflowed.
        this.maybeFireT1AtClk(this.getClk());
        // Audit D73 — VICE viacore.c:1194-1203 verbatim:
        //   t = ifr;
        //   if (ifr & ier) t |= 0x80;
        //   return t;
        // VICE NEVER stores bit 7 in via_context->ifr (Audit D123); the
        // summary is composed only here. TS this.ifr now mirrors that
        // (only bits 0-6 ever set), so no mask needed on the low side.
        let value = this.ifr & 0xff;
        if ((this.ifr & this.ier) !== 0) value |= 0x80;
        // Audit D61 — VICE viacore.c:1200 last_read = t.
        this.lastRead = value & 0xff;
        return value;
      }
      case VIA_IER: {
        // Audit D62 — VICE viacore.c:1207 last_read = ier | 0x80.
        this.lastRead = (this.ier | 0x80) & 0xff;
        return this.lastRead;
      }
      // Audit D63 — VICE viacore.c:1211-1213 default returns via[addr]
      // and stamps last_read. The switch covers all 16 register
      // addresses, so this arm is unreachable, but mirror VICE shape:
      // return last_read (the closest TS analogue of via[addr]).
      default: return this.lastRead;
    }
  }

  /**
   * VICE via_context->rmw_flag setter (via.h:233 + viacore.c:641-646
   * audit D21). The host 6502 sets this to 1 just before the second
   * (write-back) store cycle of an INC/DEC/ASL/LSR/ROL/ROR/TRB/TSB
   * instruction. viacore_store consumes the flag, replays the store
   * with `last_read` at clk-1, then proceeds with the new value.
   */
  setRmwFlag(value: 0 | 1): void {
    this.rmwFlag = value;
  }

  write(reg: number, value: number): void {
    const r = reg & 0x0f;
    const v = u8(value);
    // Audit D21 — VICE viacore.c:641-646 RMW replay:
    //   if (rmw_flag) {
    //       (*clk_ptr)--;
    //       rmw_flag = 0;
    //       viacore_store(ctx, addr, last_read);
    //       (*clk_ptr)++;
    //   }
    // TS clkPtr is owned by Cpu65xxVice; decrement/increment manually
    // around the recursive store so the inner call sees rclk-1.
    if (this.rmwFlag) {
      this.rmwFlag = 0;
      if (this.clkPtr) {
        this.clkPtr.value = (this.clkPtr.value - 1) >>> 0;
        this.write(reg, this.lastRead);
        this.clkPtr.value = (this.clkPtr.value + 1) >>> 0;
      } else {
        this.write(reg, this.lastRead);
      }
    }
    // VICE viacore_store head (viacore.c:660-662). write_offset=0
    // for TS — see runPendingAlarmsAt jsdoc for derivation.
    if (Via6522.needsAlarmCatchUp(r)) {
      this.runPendingAlarmsAt(this.getClk(), 0);
    }
    switch (r) {
      case VIA_PRB: {
        // VICE viacore_store case VIA_PRB (viacore.c:698-715) applies
        // CB1/CB2 handshake + IFR/IRQ block FIRST, then falls through
        // to PRB latch+store path (viacore.c:717-725):
        //   byte = (via[VIA_PRB] | ~via[VIA_DDRB])
        //   if ACR & T1_PB7_USED: byte = (byte & 0x7f) | t1_pb7  (7g.8a)
        //   store_prb(byte, oldpb, addr)
        this.applyPrbWriteSideEffects();
        this.prb = v;
        // Spec 611 phase 611.7g.8a — VICE viacore.c:720-722 PB7 overlay
        // on store_prb driven byte.
        const driven = this.overlayPb7((this.prb | ~this.ddrb) & 0xff) & 0xff;
        // Audit D26 — VICE viacore.c:723-724 store_prb(byte, oldpb, addr)
        // + oldpb = byte. Extended signature now carries oldpb + addr.
        // TODO(downstream): via1d.ts / via2d.ts storePb callers must
        // accept the new `(byte, oldByte, addr)` signature.
        this.backend.storePb?.(driven, this.oldpb, VIA_PRB);
        this.oldpb = driven;
        return;
      }
      case VIA_PRA: {
        // VICE viacore_store case VIA_PRA (viacore.c:666-694) applies
        // handshake/IFR/IRQ block FIRST, then falls through to PRA_NHS
        // store path which writes the latch + calls store_pra(byte).
        // Order matters on IEC: CA2 toggle (via setCa2) + IRQ edge MUST
        // be observable before downstream sees the new PA byte.
        this.applyPraSideEffects();
        this.pra = v;
        const driven = (this.pra | ~this.ddra) & 0xff;
        // Audit D25 — VICE viacore.c:694-695 store_pra(byte, oldpa, addr)
        // + oldpa = byte. VICE viacore.c:688 reassigns addr=VIA_PRA on the
        // fall-through from PRA_NHS, so the callback always sees VIA_PRA
        // here.
        // TODO(downstream): via1d.ts / via2d.ts storePa callers must
        // accept the new `(byte, oldByte, addr)` signature.
        this.backend.storePa?.(driven, this.oldpa, VIA_PRA);
        this.oldpa = driven;
        return;
      }
      case VIA_PRA_NHS: {
        // VICE viacore.c:686-689 store path: PRA_NHS only updates the PRA_NHS
        // latch + (via fall-through) drives PA output. No IFR clear, no CA2
        // handshake. Audit D24 — VICE viacore.c:688 forces addr = VIA_PRA
        // BEFORE calling store_pra, so the callback sees VIA_PRA even on
        // PRA_NHS writes. Mirror that here.
        this.pra = v;
        const driven = (this.pra | ~this.ddra) & 0xff;
        this.backend.storePa?.(driven, this.oldpa, VIA_PRA);
        this.oldpa = driven;
        return;
      }
      case VIA_DDRB: {
        // VICE viacore.c:717-725 store path (DDRB falls into same store_prb).
        this.ddrb = v;
        const driven = this.overlayPb7((this.prb | ~this.ddrb) & 0xff) & 0xff;
        // VICE viacore.c:723 passes addr=VIA_DDRB on DDRB store.
        this.backend.storePb?.(driven, this.oldpb, VIA_DDRB);
        this.oldpb = driven;
        return;
      }
      case VIA_DDRA: {
        this.ddra = v;
        const driven = (this.pra | ~this.ddra) & 0xff;
        this.backend.storePa?.(driven, this.oldpa, VIA_DDRA);
        this.oldpa = driven;
        return;
      }
      case VIA_ACR: {
        // Spec 611 phase 611.7g.8 — viacore_store case VIA_ACR.
        // VICE source: src/core/viacore.c:854-986.
        const rclk = this.getClk();
        const oldAcr = this.acr;
        // viacore.c:856-862 — PB7 enable rising edge: t1_pb7 = 0x80.
        if (((oldAcr ^ v) & VIA_ACR_T1_PB7_USED) !== 0) {
          if (v & VIA_ACR_T1_PB7_USED) {
            this.t1Pb7 = 0x80;
          }
        }
        // viacore.c:885-986 — T2 mode toggle + SR mode transitions.
        let t2StartupDelay = 0;
        let restartT2Alarms = false;
        // viacore.c:889-925 — T2 timer/pulse-count toggle (bit 5).
        if (((oldAcr ^ v) & VIA_ACR_T2_CONTROL) !== 0) {
          if (v & VIA_ACR_T2_COUNTPB6) {
            // viacore.c:890-909 — enter pulse-counting mode.
            const stop = (this.viacoreT2(rclk) - 1) & 0xffff;
            this.t2cl = stop & 0xff;
            this.t2ch = (stop >> 8) & 0xff;
            if (this.t2ZeroAlarm) alarmUnset(this.t2ZeroAlarm);
            this.t2xx00 = false;
          } else {
            // viacore.c:910-924 — leave pulse-counting (re-enter timer mode).
            restartT2Alarms = true;
            t2StartupDelay = 1;
          }
        }
        // viacore.c:927-966 — SR mode (bits 4-2) transitions.
        switch (v & VIA_ACR_SR_CONTROL) {
          case VIA_ACR_SR_DISABLED: {
            // viacore.c:929-940 — disable: drop phi2 alarm, clear IFR_SR,
            // restore CB2 PCR-driven output.
            if (this.phi2SrAlarm) alarmUnset(this.phi2SrAlarm);
            if (this.ifr & IFR_SR) {
              this.ifr &= ~IFR_SR;
              this.updateIrqAtClk(rclk);
            }
            // viacore.c:938-939 set_cb2_output_state(pcr, write_offset)
            // — restore CB2 from PCR mode (subset used by 1541: handshake
            // / low / high / input; SR no longer steers it).
            this.applyPcrCb2OutputState();
            break;
          }
          case VIA_ACR_SR_IN_T2:
          case VIA_ACR_SR_OUT_T2:
          case VIA_ACR_SR_OUT_FREE_T2: {
            // viacore.c:941-956 — SR-T2 / SR-free-T2: drop phi2 alarm;
            // may need to re-arm t2_zero_alarm if old SR was not
            // T2-controlled and new T2 is timer mode (not PB6 count).
            if (this.phi2SrAlarm) alarmUnset(this.phi2SrAlarm);
            const oldIsSrT2 =
              ((oldAcr & 0x0c) === 0x04) || ((oldAcr & 0x1c) === 0x10);
            const newIsT2Timer = (v & VIA_ACR_T2_CONTROL) === VIA_ACR_T2_TIMER;
            if (!oldIsSrT2 && newIsT2Timer) {
              restartT2Alarms = true;
            }
            break;
          }
          case VIA_ACR_SR_IN_PHI2:
          case VIA_ACR_SR_OUT_PHI2: {
            // viacore.c:957-961 — phi2 mode: arm phi2_sr_alarm if not pending.
            if (this.phi2SrAlarm && this.phi2SrAlarm.pending_idx < 0) {
              alarmSet(this.phi2SrAlarm, (rclk + SR_PHI2_FIRST_OFFSET) >>> 0);
            }
            break;
          }
          case VIA_ACR_SR_IN_CB1:
          case VIA_ACR_SR_OUT_CB1: {
            // viacore.c:962-965 — CB1-driven: drop phi2 alarm; shifting
            // happens via viacore_set_cb1.
            if (this.phi2SrAlarm) alarmUnset(this.phi2SrAlarm);
            break;
          }
        }
        // viacore.c:968-980 — if restart_t2_alarms and neither T2 alarm
        // pending, re-load t2cl/t2ch from live counter + schedule.
        // Audit D46 — VICE commits via[VIA_ACR]=byte ONCE at line 982
        // (AFTER schedule_t2_zero_alarm). The TS "Apply ACR FIRST" was
        // a source-divergence: it caused viacoreT2 inside scheduleT2ZeroAlarm
        // to see the new ACR.5 bit instead of the old one. Now we commit
        // ACR after the schedule call, matching VICE.
        const t2ZeroPending = !!(this.t2ZeroAlarm && this.t2ZeroAlarm.pending_idx >= 0);
        const t2UnderflowPending = !!(this.t2UnderflowAlarm && this.t2UnderflowAlarm.pending_idx >= 0);
        if (restartT2Alarms && !t2ZeroPending && !t2UnderflowPending) {
          const current = this.viacoreT2(rclk);
          this.t2cl = current & 0xff;
          this.t2ch = (current >> 8) & 0xff;
          this.scheduleT2ZeroAlarm((rclk + t2StartupDelay) >>> 0);
        }
        // viacore.c:982-984 — commit ACR + refresh CB1/CB2 IO cache + store_acr.
        this.acr = v;
        this.cacheCb12IoStatus();
        // Audit D47 — VICE viacore.c:984 store_acr(ctx, byte). 1541 stub
        // is a no-op but the hook must exist.
        this.backend.storeAcr?.(v);
        return;
      }
      case VIA_PCR: {
        // VICE source: src/core/viacore.c:988-1019 case VIA_PCR.
        // viacore.c:996-1006 — CA2 output state from PCR bits 1-3.
        if ((v & 0x0e) === 0x0c) {
          // VIA_PCR_CA2_LOW_OUTPUT
          this.ca2OutState = 0;
        } else if ((v & 0x0e) === 0x0e) {
          // VIA_PCR_CA2_HIGH_OUTPUT
          this.ca2OutState = 1;
        } else {
          // toggle / pulse / input — VICE comment: "FIXME: is this
          // correct if handshake is already active?" Drives 1.
          this.ca2OutState = 1;
        }
        this.backend.setCa2?.(this.ca2OutState);
        // Audit D56 — VICE order (viacore.c:1010-1018):
        //   set_cb2_output_state(byte, write_offset)  // new pcr arg
        //   store_pcr(byte, addr)                     // via[PCR] OLD
        //   via[VIA_PCR] = byte                       // commit
        //   viacore_cache_cb12_io_status()
        // viacore.c:1010-1013 — when SR is disabled, PCR drives CB2.
        // Pass the new byte through pcrOverride so applyPcrCb2OutputState
        // sees the NEW PCR while this.pcr still holds OLD.
        if ((this.acr & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED) {
          this.applyPcrCb2OutputState(0, v);
        }
        // Audit D48 — VICE viacore.c:1015 store_pcr(ctx, byte, addr).
        // Called BEFORE the via[VIA_PCR] = byte commit (line 1017), so
        // the backend hook in VICE sees via[VIA_PCR] holding OLD.
        this.backend.storePcr?.(v, VIA_PCR);
        // Audit D56 — commit pcr AFTER store_pcr (VICE viacore.c:1017).
        this.pcr = v;
        // viacore.c:1018 — refresh CB1/CB2 IO cache after PCR change.
        this.cacheCb12IoStatus();
        return;
      }
      case VIA_IFR: {
        // Writing 1 clears the bit per VICE viacore.c.
        this.ifr &= ~(v & 0x7f);
        // Audit D38 — VICE viacore.c:833 update_myviairq_rclk(rclk).
        this.updateIrqAtClk(this.getClk());
        return;
      }
      case VIA_IER: {
        // Bit 7 = set/clear flag; bits 0-6 = mask of bits to set or clear.
        if (v & 0x80) this.ier |= v & 0x7f;
        else this.ier &= ~(v & 0x7f);
        // Audit D40 — VICE viacore.c:849 update_myviairq_rclk(rclk).
        this.updateIrqAtClk(this.getClk());
        return;
      }
      // T1/T2/SR: stored only; no timer behavior in 611.4 minimum.
      // === Spec 611 phase 611.7f.9 — VIA1 T1 timer writes ===
      // Per VICE viacore.c lines 741-783.
      case VIA_T1CL:
      case VIA_T1LL: {
        // Audit D30 / D111 — VICE viacore.c:741-745:
        //   via[VIA_T1LL] = byte;
        //   update_via_t1_latch(rclk);
        // The latch update chases t1reload forward when CPU has overrun.
        this.t1Latch = (this.t1Latch & 0xff00) | (v & 0xff);
        this.updateViaT1Latch(this.getClk());
        return;
      }
      case VIA_T1CH: {
        // VICE viacore.c:747-768 store T1CH:
        //   via[VIA_T1LH] = byte;
        //   update_via_t1_latch(rclk);              <-- audit D31
        //   t1reload = rclk+1 + tal + FULL_CYCLE_2;
        //   t1zero   = rclk+1 + tal;
        //   alarm_set(t1_zero_alarm, t1zero);
        //   t1_pb7 = 0;
        //   ifr &= ~IFR_T1;
        //   update_myviairq_rclk(rclk);
        this.t1Latch = (this.t1Latch & 0x00ff) | ((v & 0xff) << 8);
        const rclk = this.getClk();
        // Audit D31 — must call update_via_t1_latch BEFORE computing
        // t1zero/t1reload so that `tal` used below reflects any forward
        // chase of t1reload from a stale frame.
        this.updateViaT1Latch(rclk);
        // Audit D116 — VICE viacore.c:757-758 uses via_context->tal
        // (refreshed inside update_via_t1_latch).
        this.t1ZeroClk = (rclk + 1 + this.tal) >>> 0;
        this.t1ReloadClk = (this.t1ZeroClk + 2) >>> 0; // FULL_CYCLE_2
        // Audit D112: no t1Active/t1OneShotFired writes; reset lazy mark.
        this.lazyT1FiredFor = 0;
        this.t1Pb7 = 0; // viacore.c:763
        if (this.t1ZeroAlarm) {
          alarmSet(this.t1ZeroAlarm, this.t1ZeroClk);
        }
        this.ifr &= ~IFR_T1;
        // Audit D33-symmetric — VICE viacore.c:767 update_myviairq_rclk(rclk).
        this.updateIrqAtClk(rclk);
        return;
      }
      case VIA_T1LH: {
        // Update latch HIGH only; do NOT reload counter. Clears IFR_T1
        // per VICE viacore.c lines 770-783 (Synertek behavior confirmed).
        // Audit D30 / D88 — VICE also calls update_via_t1_latch here.
        this.t1Latch = (this.t1Latch & 0x00ff) | ((v & 0xff) << 8);
        const rclk = this.getClk();
        this.updateViaT1Latch(rclk);
        this.ifr &= ~IFR_T1;
        // Audit D33 — VICE viacore.c:782 update_myviairq_rclk(rclk).
        this.updateIrqAtClk(rclk);
        return;
      }
      case VIA_T2CL: {
        // VICE viacore.c:785-797 — addr 0x8 write = T2 LOW LATCH (VIA_T2LL).
        // Stores into latch only; no counter, no IFR, no alarm action.
        // (Shift-register SR-out-T2 reload triggered separately by SR
        // write — deferred to 7g.10.)
        this.t2lLatch = v;
        // Audit D34 — VICE viacore.c:796 store_t2l(ctx, byte). 1541 stub
        // is a no-op but the hook must exist.
        this.backend.storeT2l?.(v);
        return;
      }
      case VIA_T2CH: {
        // VICE viacore.c:799-827 — T2 HIGH counter/latch write arms T2.
        const rclk = this.getClk();
        this.t2cl = this.t2lLatch;
        this.t2ch = v;
        // viacore.c:806-820 — schedule only in timer mode (NOT pulse-counted PB6).
        if (!(this.acr & 0x20)) {
          this.scheduleT2ZeroAlarm((rclk + 1) >>> 0);
        }
        this.ifr &= ~IFR_T2;
        this.updateIrqAtClk(rclk);
        // viacore.c:826 — each write to T2H allows one interrupt.
        this.t2IrqAllowed = true;
        return;
      }
      case VIA_SR: {
        // Spec 611 phase 611.7g.10 — viacore_store VIA_SR.
        // VICE source: src/core/viacore.c:727-737.
        this.sr = v;
        const rclk = this.getClk();
        this.setupShifting(rclk);
        if (this.ifr & IFR_SR) {
          this.ifr &= ~IFR_SR;
          this.updateIrqAtClk(rclk);
        }
        this.backend.setSr?.(v);
        return;
      }
      default: return;
    }
  }

  /**
   * VICE viacore_signal SIG_CA1 verbatim (viacore.c:441-457):
   *   if ((edge ? 1 : 0) == (PCR & VIA_PCR_CA1_CONTROL)) {
   *     if (IS_CA2_TOGGLE_MODE() && !ca2_out_state) {
   *       ca2_out_state = true; set_ca2(ca2_out_state);
   *     }
   *     ifr |= VIA_IM_CA1;
   *     update_myviairq();
   *     // [MYVIA_NEED_LATCHING block — undefined for 1541 per
   *     //  viacore.c:76 `#define MYVIA_NEED_LATCHING` commented out]
   *   }
   *
   * Spec 611 phase 611.7g.4 (Codex 13:10): port CA2-toggle handshake
   * side effect. PA input latch deferred per MYVIA_NEED_LATCHING
   * resolution (undefined globally in VICE, including 1541 build).
   *
   * Clock-owner note (Codex 13:10 #2): `clk?` param retained as
   * bridge-interim. VICE update_myviairq() uses `*clk_ptr` which in
   * VICE = live host cpu clock at write moment. In our bridge,
   * polled clkPtr.value LEADS the write moment by 1-7 cycles after
   * catchUpTo overrun. Explicit clk = write-time effClk matches VICE
   * semantics exactly; polled = "future" stamp. Bridge effClk plumbing
   * = source-parity-current; marked bridge-interim until the bridge
   * itself is replaced by canonical VICE IEC bus port.
   */
  signalCa1(edge: 0 | 1, clk?: number): void {
    this.ca1State = edge;
    const wantedPolarity = (this.pcr & PCR_CA1_POS) ? VIA_SIG_RISE : VIA_SIG_FALL;
    if (edge === wantedPolarity) {
      // viacore.c:446-449 — CA2 toggle-mode auto-handshake on CA1 edge.
      if ((this.pcr & 0x0e) === VIA_PCR_CA2_HANDSHAKE_OUTPUT
          && this.ca2OutState === 0) {
        this.ca2OutState = 1;
        this.backend.setCa2?.(this.ca2OutState);
      }
      this.ifr |= IFR_CA1;
      this.updateIrqAtClk(clk);
    }
  }

  /**
   * Spec 611 phase 611.7g.8 (slice F) — viacore_signal SIG_CA2 port.
   * VICE source: src/core/viacore.c:459-466.
   *   if ((PCR & VIA_PCR_CA2_I_OR_O) == VIA_PCR_CA2_INPUT) {
   *     ifr |= (((edge << 2) ^ PCR) & 0x04) ? 0 : VIA_IM_CA2;
   *     update_myviairq();
   *   }
   *
   * VICE_PCR_CA2_I_OR_O = 0x08, VIA_PCR_CA2_INPUT = 0x00.
   * Polarity bit (0x04): 0 = neg active edge, 1 = pos active edge.
   */
  signalCa2(edge: 0 | 1, clk?: number): void {
    // viacore.c:460 — only when CA2 is in input mode.
    if ((this.pcr & 0x08) === 0) {
      // viacore.c:461-463 — IRQ when ((edge<<2) XOR PCR) & 0x04 == 0,
      // i.e. when edge matches PCR's CA2 polarity bit.
      const polarity = (this.pcr & 0x04) >> 2;
      if ((edge & 1) === polarity) {
        this.ifr |= IFR_CA2;
        this.updateIrqAtClk(clk);
      }
    }
  }

  /**
   * Spec 611 phase 611.7g.8 (slice E) — viacore_signal SIG_CB1 wrapper.
   * VICE source: src/core/viacore.c:467-468 (SIG_CB1 -> viacore_set_cb1).
   * Body lives in `setCb1Input` below (ported from viacore_set_cb1
   * viacore.c:1428-1501).
   */
  signalCb1(edge: 0 | 1, clk?: number): void {
    this.setCb1Input(edge !== 0, clk);
  }

  /**
   * Spec 611 phase 611.7g.8 (slice F) — viacore_signal SIG_CB2 wrapper.
   * VICE source: src/core/viacore.c:470-471 (SIG_CB2 -> viacore_set_cb2).
   * Body lives in `setCb2Input` below (ported from viacore_set_cb2
   * viacore.c:1503-1518).
   */
  signalCb2(edge: 0 | 1, clk?: number): void {
    this.setCb2Input(edge !== 0, clk);
  }

  /**
   * Spec 611 phase 611.7g.8 (slice E) — viacore_set_cb1 port.
   * VICE source: src/core/viacore.c:1428-1501.
   *
   * Handles CB1 as input: when CB1 is configured as the SR shift clock
   * (cb1_is_input + non-disabled SR mode), shifts SR on the active edge.
   * Always also evaluates CB1 IRQ + CB2-toggle handshake per PCR.
   */
  private setCb1Input(data: boolean, clk?: number): void {
    if (data !== !!this.cb1InState) {
      // viacore.c:1434-1474 — edge happened; if CB1 drives shifting, do shift.
      if (this.cb1IsInput) {
        // viacore.c:1436-1438 — first falling edge resets shift_state to start.
        if (!data && this.shiftState === FINISHED_SHIFTING) {
          this.shiftState = START_SHIFTING;
        }
        this.shiftState += 1;
        if (data) {
          // viacore.c:1443-1451 — rising edge: shift SR in.
          this.sr = ((this.sr << 1) | (this.cb2InState & 1)) & 0xff;
          if (this.shiftState === FINISHED_SHIFTING) {
            // viacore.c:1449 — set IFR_SR via viacore_set_sr.
            this.setSrBurst(this.sr, clk);
            this.shiftState = START_SHIFTING;
          }
        } else {
          // Audit D116 — VICE viacore.c:1452-1471 comment block restored
          // verbatim for source-parity / future-port guidance:
          //
          //   TODO: the case of
          //   VIA_ACR_SR_OUT_CB1      0x1C
          //   mode 7 Shift out under control of an External Pulse
          //   which happens on the falling edge of CB1.
          //   (maybe keep separate cb1_drives_shifting flag?)
          //   From http://forum.6502.org/viewtopic.php?f=4&t=7241&start=15#p94001
          //   The CB1 pad also works as the shift clock from/to the outerworld
          //   when enabling "10) shift register", and that's why we have _another_
          //   (conceptually different) edge detector sensing the CB1 pad,
          //   gated with PHI0=1 AND PHI2=1.
          //
          //   If ACR4=0, the shift register shifts in, and the detector scans
          //     for CB1 rising edge.
          //   If ACR4=1, the shift register shifts out, and the detector scans
          //     for CB1 falling edge.
          //
          //   Low_active signal SR_CB1_DET# generated by the detector tells
          //   "22) shift register control" to shift/count the next Bit.
          //
          // If shifting OUT, do it here.
        }
      }
      this.cb1InState = data ? 1 : 0;
    }
    // viacore.c:1482-1500 — unconditional CB1 IRQ + CB2-toggle handshake
    // per PCR (comment notes "doing unconditionally seems wrong, but
    // breaks SpeedDOS+").
    const pcr = this.pcr;
    const edge = (pcr & VIA_PCR_CB1_CONTROL) === VIA_PCR_CB1_POS_ACTIVE_EDGE;
    if (data === edge) {
      // viacore.c:1487-1490 — CB2 toggle-mode handshake on CB1 edge.
      if ((pcr & 0xe0) === 0x80 && this.cb2OutState === 0) {
        // IS_CB2_TOGGLE_MODE() == ((PCR & 0xe0) == 0x80)
        this.cb2OutState = 1;
        // Audit D11 — VICE viacore.c:1489 passes offset=0 explicitly.
        this.backend.setCb2?.(1, 0);
      }
      this.ifr |= IFR_CB1;
      this.updateIrqAtClk(clk);
    }
    this.cb1State = data ? 1 : 0;
  }

  /**
   * Spec 611 phase 611.7g.8 (slice F) — viacore_set_cb2 port.
   * VICE source: src/core/viacore.c:1503-1518.
   *
   * Handles CB2 as input: tracks edges, raises IFR_CB2 on the active
   * edge per PCR. NOT to be confused with CB2 OUTPUT-side (driven from
   * SR / handshake / PCR mode bits) — that is separate.
   */
  private setCb2Input(data: boolean, clk?: number): void {
    if (this.cb2IsInput && data !== !!this.cb2InState) {
      this.cb2InState = data ? 1 : 0;
      // viacore.c:1510 — VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE = 0x40.
      const edge = (this.pcr & 0x40) !== 0;
      if (data === edge) {
        this.ifr |= IFR_CB2;
        this.updateIrqAtClk(clk);
      }
    }
  }

  /**
   * Spec 611 phase 611.7g.10 — viacore_set_sr burst-mode hack.
   * VICE source: src/core/viacore.c:1523-1535.
   *
   * Used by external fastloader code paths (c64fastiec etc.) to inject
   * a byte into the SR while in SR-IN mode (any non-disabled SR-in
   * mode satisfies the guard). On 1541 this is unused but the path is
   * kept source-faithful for completeness.
   */
  private setSrBurst(value: BYTE, clk?: number): void {
    // viacore.c:1525-1526 — guard: SR is shift-in (ACR.SR_OUT bit 0)
    // AND SR mode is not DISABLED (ACR & 0x0c != 0).
    if ((this.acr & VIA_ACR_SR_OUT) === 0 && (this.acr & 0x0c) !== 0) {
      this.sr = value & 0xff;
      this.ifr |= IFR_SR;
      this.updateIrqAtClk(clk);
      this.shiftState = FINISHED_SHIFTING;
    }
  }

  /**
   * Spec 611 phase 611.7g.5 — viacore_store/read VIA_PRA CA2 handshake.
   *
   * VICE source:
   *   src/core/viacore.c:666-683 viacore_store case VIA_PRA
   *   src/core/viacore.c:1073-1095 viacore_read case VIA_PRA
   *   macros viacore.c:106-109
   *     IS_CA2_INDINPUT()   = (PCR & 0x0a) == 0x02
   *     IS_CA2_HANDSHAKE()  = (PCR & 0x0c) == 0x08
   *     IS_CA2_PULSE_MODE() = (PCR & 0x0e) == 0x0a
   *
   * Clock-owner note (Codex 13:34 constraint):
   * Drive CPU VIA register dispatch (drivecpu.ts read6502/write6502)
   * does NOT carry a per-access clock. The polled clkPtr / getClk()
   * is the live drive cpu.clk at register-access time → correct stamp
   * source for update_myviairq_rclk equivalent. No Via6522.read/write
   * API churn in this unit. updateIrqAtClk(undefined) falls back to
   * polled clk per 7g.4.
   *
   * Pulse-mode timing matches current VICE (back-to-back setCa2(0)
   * then setCa2(1)); VICE comment "should be a clock later" is left
   * for a future timing fix (out of scope).
   */
  private applyPraSideEffects(): void {
    // viacore.c:667 / 1077 — unconditional IFR_CA1 clear.
    this.ifr &= ~IFR_CA1;
    // viacore.c:668-670 / 1078-1082 — clear IFR_CA2 unless IS_CA2_INDINPUT.
    if ((this.pcr & 0x0a) !== 0x02) {
      this.ifr &= ~IFR_CA2;
    }
    // viacore.c:671-680 / 1083-1091 — IS_CA2_HANDSHAKE side effect.
    if ((this.pcr & 0x0c) === VIA_PCR_CA2_HANDSHAKE_OUTPUT) {
      this.ca2OutState = 0;
      this.backend.setCa2?.(this.ca2OutState);
      if ((this.pcr & 0x0e) === 0x0a) {
        // IS_CA2_PULSE_MODE: immediate raise back to 1.
        this.ca2OutState = 1;
        this.backend.setCa2?.(this.ca2OutState);
      }
    }
    // viacore.c:681-683 / 1092-1094 — IRQ re-eval ONLY if CA1/CA2
    // interrupts enabled. Audit D27/D62 — VICE gates this strictly on
    // `ier & (VIA_IM_CA1 | VIA_IM_CA2)`; the else branch was a TS-only
    // "recompute summary" that issued spurious setIrq edges.
    if (this.ier & (IFR_CA1 | IFR_CA2)) {
      this.updateIrqAtClk(this.getClk());
    }
  }

  /**
   * Spec 611 phase 611.7g.6 — viacore_store VIA_PRB CB2 handshake.
   *
   * VICE source: src/core/viacore.c:698-715
   *   ifr &= ~VIA_IM_CB1;
   *   if ((PCR & 0xa0) != 0x20) ifr &= ~VIA_IM_CB2;
   *   if (IS_CB2_HANDSHAKE())   { cb2_out_state = 0; set_cb2(0, write_offset);
   *                               if (IS_CB2_PULSE_MODE()) {
   *                                 cb2_out_state = 1; set_cb2(1, 0);
   *                               } }
   *   if (ier & (VIA_IM_CB1 | VIA_IM_CB2)) update_myviairq_rclk(rclk);
   *
   * Macros viacore.c:111-115:
   *   IS_CB2_OUTPUT()     = (PCR & 0xc0) == 0xc0
   *   IS_CB2_HANDSHAKE()  = (PCR & 0xc0) == 0x80
   *   IS_CB2_PULSE_MODE() = (PCR & 0xe0) == 0xa0
   *   IS_CB2_TOGGLE_MODE()= (PCR & 0xe0) == 0x80
   *
   * Clock-owner: polled clkPtr / getClk() per 7g.4/7g.5 — no
   * Via6522.write API churn. updateIrqAtClk(undefined) falls back to
   * polled clk.
   *
   * Pulse-mode: matches current VICE (back-to-back setCb2(0,offset)
   * then setCb2(1,0)). T1/PB7 PRB-output overlay deferred to 7g.8a.
   */
  private applyPrbWriteSideEffects(): void {
    // viacore.c:699 — unconditional IFR_CB1 clear.
    this.ifr &= ~IFR_CB1;
    // viacore.c:700-702 — clear IFR_CB2 unless CB2-input-independent IRQ
    // ((PCR & 0xa0) != 0x20).
    if ((this.pcr & 0xa0) !== 0x20) {
      this.ifr &= ~IFR_CB2;
    }
    // viacore.c:703-711 — IS_CB2_HANDSHAKE side effect.
    // Audit D28 — VICE viacore.c:705 set_cb2(state, write_offset),
    // viacore.c:709 set_cb2(state, 0). TS write_offset=0 per the
    // runPendingAlarmsAt owner-block; pass 0 in both calls.
    if ((this.pcr & 0xc0) === 0x80) {
      this.cb2OutState = 0;
      this.backend.setCb2?.(this.cb2OutState, 0);
      if ((this.pcr & 0xe0) === 0xa0) {
        // IS_CB2_PULSE_MODE: immediate raise back to 1.
        this.cb2OutState = 1;
        this.backend.setCb2?.(this.cb2OutState, 0);
      }
    }
    // viacore.c:712-714 — IRQ re-eval ONLY if CB1/CB2 IRQs enabled.
    // Audit D33/D67 — VICE gates strictly; remove the TS-only else
    // branch that called updateIrqAtClk unconditionally (spurious edge).
    if (this.ier & (IFR_CB1 | IFR_CB2)) {
      this.updateIrqAtClk(this.getClk());
    }
  }

  /**
   * Spec 611 phase 611.7g.6 — viacore_read VIA_PRB CB1/CB2 side effects.
   *
   * VICE source: src/core/viacore.c:1124-1136
   *   ifr &= ~VIA_IM_CB1;
   *   if ((PCR & 0xa0) != 0x20) ifr &= ~VIA_IM_CB2;
   *   if (ier & (VIA_IM_CB1 | VIA_IM_CB2)) update_myviairq_rclk(rclk);
   *
   * ASYMMETRIC vs PRA read: NO set_cb2() call here. VICE comment
   * line 1138-1139: PRB read returns ORB latch for output pins
   * (not pin voltage), and the CB2 handshake-low only fires on write.
   */
  private applyPrbReadSideEffects(): void {
    this.ifr &= ~IFR_CB1;
    if ((this.pcr & 0xa0) !== 0x20) {
      this.ifr &= ~IFR_CB2;
    }
    // Audit D33/D67 — VICE gates strictly on `ier & (CB1|CB2)`; remove
    // the TS-only else branch.
    if (this.ier & (IFR_CB1 | IFR_CB2)) {
      this.updateIrqAtClk(this.getClk());
    }
  }

  /**
   * VICE update_myviairq_rclk (viacore.c:203-209) + update_myviairq
   * (viacore.c:211-214). Folded into a single method here — when `clk`
   * is omitted, fall back to polled clkPtr (= VICE's `*clk_ptr` path).
   *
   * Audit D73/D123 — VICE NEVER stores the IFR_ANY summary bit (bit 7)
   * into via_context->ifr. The summary is composed only at IFR-read
   * time (viacore.c:1194-1203 `t = ifr; if (ifr & ier) t |= 0x80;`).
   * Previously TS stored bit 7 into this.ifr and masked it on read;
   * removed for source-parity so this.ifr always reflects only the
   * seven flag bits.
   *
   * Audit D124 — VICE has two inline variants but the second is a
   * trivial wrapper around the first (uses *clk_ptr). TS dead-code
   * `updateIrq()` removed; this single method serves both.
   */
  private updateIrqAtClk(clk?: number): void {
    const pending = (this.ifr & this.ier & 0x7f) !== 0;
    if (pending !== this.lastIrqOut) {
      this.lastIrqOut = pending;
      const b = this.backend as Via6522Backend & { setIrqAt?: (a: boolean, c?: number) => void };
      // VICE viacore.c:203-213 update_myviairq() uses *clk_ptr when no
      // rclk passed. Fall back to polled clkPtr when caller omits clk so
      // the backend always receives a real stamp.
      const stamp = (typeof clk === 'number') ? clk : this.getClk();
      if (typeof b.setIrqAt === "function") b.setIrqAt(pending, stamp);
      else this.backend.setIrq(pending);
    }
  }

  /** Test helper — current IRQ-out state. */
  irqAsserted(): boolean { return this.lastIrqOut; }
}
