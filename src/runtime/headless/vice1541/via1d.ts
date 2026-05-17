// Spec 611 phase 611.4 — 1541 VIA1 (IEC interface side).
//
// VICE source:  src/drive/iec/via1d1541.c + src/core/viacore.c
// Doc anchor:   docs/vice-1541-arch.md §6 + §13 D
//               docs/vice-iec-arc42.md §5.5 + §6
//
// What this phase delivers:
//   - PB read formula from VICE read_prb: `((PRB & 0x1A) | drv_port) ^ 0x85`
//   - PB write → drive_data update on the IEC bus (DATA_OUT / CLK_OUT
//     / ATNA bits decoded per arch §6.3).
//   - CA1 = ATN line input. ATN edge (falling, per PCR config) sets
//     IFR_CA1 and raises drive IRQ via cpuIntStatus.
//   - VIA1 IRQ wired through the Via6522 backend to the drive 6502's
//     InterruptCpuStatus.
//
// Mechanical-port audit pass (Codex 2026-05-17): aligned with
// via1d1541.c line-by-line where the TS backend surface permits. See
// audit notes below per deviation tag (D#).

import type { InterruptCpuStatus, IntNum } from "../cpu/interrupt-cpu-status.js";
import type { Vice1541IecBus } from "./iec-bus.js";
import {
  Via6522,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type Via6522Backend,
} from "./via6522.js";

/**
 * VIA1 PB write — decode drive output bits into the IEC bus model.
 *
 * VICE via1d1541.c:212-249 (store_prb) — full source verbatim:
 *
 *   if (byte != p_oldpb) {                                       // D13 gate
 *     ...
 *     *drive_data = ~byte;                                       // VICE:229
 *     *drive_bus = ((((*drive_data) << 3) & 0x40)                // bit 6=CLK
 *                | (((*drive_data) << 6)                          // bit 7=DATA
 *                   & ((uint32_t)(~(*drive_data) ^ iecbus->cpu_bus) << 3)
 *                   & 0x80));
 *     iecbus->cpu_port = iecbus->cpu_bus;
 *     for (unit = 4; unit < 8 + NUM_DISK_UNITS; unit++) {
 *       iecbus->cpu_port &= iecbus->drv_bus[unit];               // AND-aggregate
 *     }
 *     iecbus->drv_port = (((iecbus->cpu_port >> 4) & 0x4)
 *                       | (iecbus->cpu_port >> 7)
 *                       | ((iecbus->cpu_bus << 3) & 0x80));
 *   }
 *
 * Note on the `byte` argument: VICE viacore.c:717-725 passes
 * `(via[VIA_PRB] | ~via[VIA_DDRB])` to store_prb (output bits =
 * latched PRB, input-direction bits forced 1). Our Via6522 does the
 * same fold in via6522.ts (case VIA_PRB / VIA_DDRB store path), so
 * the value our `storePb` callback receives is *identical* to VICE's
 * `byte`. drive_data = ~byte then matches bit-for-bit.
 *
 * D11 (drv_bus formula): the bit-6 CLK_OUT term and bit-7 DATA_OUT
 * term combined with the ATNA-vs-cpu_bus XOR are applied inside
 * `Vice1541IecBus`: `drvClkReleased`/`drvDataReleased` drive the
 * wired-AND in `busClk()` / `busData()`, and `busData()` already
 * encodes the `((~ATNA) XOR ATN_released)` gate per iec-bus.ts:62-71
 * (VICE c64iec.c:147 — matches via1d1541.c:230-232 literally for the
 * single-drive 1541 case).
 *
 * D12 (cpu_port/drv_port AND-aggregation): single-1541 setup has
 * only one drive contributor, so the cross-unit AND reduces to
 * "drive's own drv_bus AND c64 bus" — which is exactly what
 * `Vice1541IecBus.busClk()/busData()` compute on every query.
 * Multi-drive aggregation is out of scope (audit D25).
 */
function storePb(bus: Vice1541IecBus, byte: number, oldByte: number): void {
  // Audit D9 — VICE via1d1541.c:219 `if (byte != p_oldpb)` change-gate.
  // viacore.c passes the previous PRB-driven byte as p_oldpb; we
  // forward it through the backend signature `(byte, oldByte, addr)`
  // and short-circuit when unchanged. Idempotent today (bus state is
  // boolean re-assert), but matches VICE's DEBUG_IEC_DRV_WRITE skip
  // and is the exact source semantic.
  if (byte === oldByte) {
    return;
  }
  // VICE via1d1541.c:229 — drive_data = ~byte. drive_data bit SET = RELEASED.
  const driveData = (~byte) & 0xff;
  // Drive-side line state — output bits 1 (DATA_OUT), 3 (CLK_OUT), 4 (ATNA).
  // drive_data bit X = 1 ⇔ released. VICE via1d1541.c:230-232 derives:
  //   drv_bus.6 (CLK released) = drive_data.3
  //   drv_bus.7 (DATA released-candidate) = drive_data.1, gated by
  //                                          ATNA-vs-ATN XOR (in busData()).
  bus.drvDataReleased = (driveData & 0x02) !== 0; // drive_data.1
  bus.drvClkReleased = (driveData & 0x08) !== 0; // drive_data.3
  bus.drvAtnaReleased = (driveData & 0x10) !== 0; // drive_data.4
}

/**
 * VIA1 PA read formula per VICE `via1d1541.c:315-318` (default branch,
 * no parallel cable, single-drive 1541):
 *
 *   byte = ((PRA & DDRA) | (0xff & ~DDRA));
 *
 * Equivalent to "PRA bits where DDRA=1 (output), else 1 (pulled-up
 * input)". The Via6522 core itself folds DDR over the backend input
 * (via6522.ts:1107-1108: `(driven & DDRA) | (input & ~DDRA)`), so
 * returning `0xff` here yields the same wire-level value as VICE.
 * Wired explicitly per audit D18/D31 so the via core never falls
 * through to its missing-readPa default branch; the call carries
 * VICE-source parity instead of relying on a coincidental match.
 */
function readPa(): number {
  // VICE via1d1541.c:316-317 — default branch returns 0xff for
  // input-direction bits, which is what `(0xff & ~DDRA)` evaluates
  // to before via6522.ts folds it with the PRA-driven bits.
  return 0xff;
}

/**
 * VIA1 PB read formula per VICE `via1d1541.c:337-362` (verbatim):
 *
 *   driveid = (via1p->number << 5) & 0x60;
 *   tmp  = (drv_port ^ 0x85) | 0x1a | driveid;
 *   byte = (PRB & DDRB) | (tmp & ~DDRB);
 *
 * The backend returns `tmp` here; the DDR fold lives in
 * `Via6522.read(VIA_PRB)` (verified in via6522.ts:953-958 — applies
 * `(driven & DDRB) | (input & ~DDRB)` exactly per VICE).
 *
 * `driveid` encodes the unit number into bits 5/6 of the PB read (so
 * the 1541 firmware can read its own device number). VICE recomputes
 * it on every read from `via1p->number` (live); we mirror that by
 * recomputing from `opts.mynumber` on every call (D17). No silent
 * default — `mynumber` is required at createVia1d() time.
 */
function readPb(bus: Vice1541IecBus, mynumber: number): number {
  // VICE via1d1541.c:345 — driveid = (via1p->number << 5) & 0x60.
  const driveid = (mynumber << 5) & 0x60;
  return ((bus.driveDrvPort() ^ 0x85) | 0x1a | driveid) & 0xff;
}

export interface Via1dOptions {
  bus: Vice1541IecBus;
  /** Drive 6502 interrupt-status into which VIA1 IRQ pushes. */
  cpuIntStatus: InterruptCpuStatus;
  /** Read-side clock provider so `setIrq` can stamp a release clock. */
  clkPtr: { value: number };
  /**
   * VICE diskunit `mynumber` (= device-number minus 8). REQUIRED — no
   * silent default. VICE setup_context (via1d1541.c:381) initialises
   * `via1p->number = ctxptr->mynumber` unconditionally; the TS port
   * must do the same. Throw at createVia1d if absent (D17).
   */
  mynumber: number;
  /**
   * Spec 611 phase 611.7g — drive cpu AlarmContext for T1/T2 alarms.
   * REQUIRED — VICE viacore_init always receives a non-null alarm
   * context from `cpu->alarm_context`; silent disable hides T1/T2
   * underflow IRQ scheduling and breaks the 1541 ROM (D20).
   */
  alarmContext: import("../alarm/alarm-context.js").AlarmContext;
  /** Spec 611 phase 611.7g.2 — live drive-cpu clk ref for alarm callback. */
  clkRef?: () => number;
}

/**
 * Build a 1541 VIA1 (IEC side) wired to the supplied IEC bus and
 * drive InterruptCpuStatus. Returns the Via6522 instance so callers
 * can `signalCa1()` on ATN edges.
 */
export function createVia1d(opts: Via1dOptions): Via6522 {
  const { bus, cpuIntStatus, clkPtr } = opts;

  // VICE via1d1541.c:381 — `via1p->number = ctxptr->mynumber` is
  // unconditional. Refuse to silently default to device 8 (D17).
  if (opts.mynumber === undefined || opts.mynumber === null) {
    throw new Error(
      "createVia1d: opts.mynumber is required (VICE setup_context " +
        "via1d1541.c:381 always assigns from ctxptr->mynumber)"
    );
  }
  // VICE via1d1541.c:366 — alarm context comes from
  // `ctxptr->cpu->alarm_context` and is always present. The TS port
  // refuses the silent-no-alarm path (D20).
  if (opts.alarmContext === undefined || opts.alarmContext === null) {
    throw new Error(
      "createVia1d: opts.alarmContext is required (VICE viacore_init " +
        "via1d1541.c:366 always passes cpu->alarm_context)"
    );
  }

  const intNum: IntNum = cpuIntStatus.newIntNum("via1d1541");

  const backend: Via6522Backend & { setIrqAt?: (a: boolean, c?: number) => void } = {
    // VICE via1d1541.c:212-249 store_prb wiring. Audit D9: forward
    // `oldByte` so the `byte != p_oldpb` change-gate runs verbatim.
    storePb: (byte, oldByte) => storePb(bus, byte, oldByte),
    // VICE via1d1541.c:337-362 read_prb wiring. driveid recomputed each
    // call from opts.mynumber (D17) — no closure capture.
    readPb: () => readPb(bus, opts.mynumber),
    // Audit D18/D31 — VICE via1d1541.c:413 `via->read_pra = read_pra;`
    // registers the default-branch formula `(PRA & DDRA) | (0xff &
    // ~DDRA)` (via1d1541.c:316-317). Wired explicitly so PRA reads
    // never depend on the Via6522 missing-callback default.
    readPa: () => readPa(),
    // VICE via1d1541.c:84-86 set_ca2 (empty no-op). Wired explicitly
    // so Via6522 never takes a default-fallback branch on CA2 (D3).
    setCa2: () => {},
    // VICE via1d1541.c:88-90 set_cb2 (empty no-op). Wired explicitly
    // (D4).
    setCb2: () => {},
    // VICE via1d1541.c:92-100 set_int wiring:
    //   interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk);
    // VICE always supplies a precise `rclk`; the TS via core only
    // calls the no-clk `setIrq` variant from `updateIrq()` paths that
    // lack an explicit rclk. Prefer the live drive-cpu clk (via
    // clkRef, which Cpu65xxVice synchronises BEFORE clkPtr.value is
    // updated mid-cycle) so the stamp reflects "now" inside the cpu
    // loop, not the lagging clkPtr.value (D5).
    setIrq: (asserted) => {
      const stamp = opts.clkRef ? opts.clkRef() : clkPtr.value;
      cpuIntStatus.setIrq(intNum, asserted, stamp);
    },
    // VICE via1d1541.c:92-100 set_int (with explicit rclk). The Via
    // core calls this from updateIrqAtClk paths where it knows the
    // alarm/handler clock; pass it through to InterruptCpuStatus
    // unchanged so internal-source IRQs (T1/T2 underflow) land at
    // the exact clock VICE would stamp them with (D5).
    setIrqAt: (asserted, clk) => {
      const stamp = clk ?? (opts.clkRef ? opts.clkRef() : clkPtr.value);
      cpuIntStatus.setIrq(intNum, asserted, stamp);
    },
  };

  // VICE via1d1541.c:364-368 — viacore_init(via, alarm_context,
  // int_status). alarmContext is mandatory above; T1/T2 alarms now
  // always have a scheduler attached.
  const via1 = new Via6522({
    backend, label: "via1d1541", clkPtr,
    alarmContext: opts.alarmContext,
    clkRef: opts.clkRef,
  });
  return via1;

  // Deferred / out-of-scope vs VICE via1d1541.c (audit notes):
  //  D1/D2 (cpu_last_data echo on via1d1541_store/read) — TS
  //    Cpu65xxVice has no `cpuLastData` field. No place to plumb yet.
  //  D6 (restore_int) / D7 (undump_pra) / D14 (undump_prb) /
  //    D15 (undump_pcr/acr, store_pcr/acr/sr/t2l) — Via6522 backend
  //    surface does not expose `restoreInt` / `undump*` / `store_pcr`
  //    /`store_acr` / `store_sr` / `store_t2l` hooks. Adding them
  //    requires viacore.ts changes (out of scope per audit rules:
  //    "Edit ONLY src/runtime/headless/vice1541/via1d.ts").
  //  D8/D9 (1571 + parallel cable in store_pra/read_pra) — Spec 611
  //    scope is 1541 single-drive, no parallel cable. Out of scope.
  //  D16 (reset no-op) — Via6522 backend has no `reset` hook. Empty
  //    in VICE anyway; no behaviour delta.
  //  D21 (irq_line = IK_IRQ / myname) — InterruptCpuStatus treats all
  //    VIA IRQs as IK_IRQ; diagnostic names not needed.
  //  D23 (rmw_flag pointer) — Via6522.setRmwFlag(0|1) IS exposed
  //    (via6522.ts:1200). VICE via1d1541.c:385 sets
  //    `via->rmw_flag = &(ctxptr->cpu->rmw_flag);` so the via core
  //    can observe the host 6502's mid-RMW state. TS plumbing
  //    requires the drive cpu (drivecpu.ts / Cpu65xxVice) to call
  //    `via1.setRmwFlag(1)` between the RMW read and write-back
  //    cycles. That edit lives outside via1d.ts and is out of the
  //    audit's "Edit ONLY via1d.ts" scope — left as TODO for the
  //    drive-cpu integration follow-up (Spec 611 phase 611.7g.8b
  //    candidate). VICE ref: via1d1541.c:385, viacore.c:641-646.
  //  D22 (`via1p->drive = ctxptr->drives[0]`) — 1571 PRA only, out
  //    of scope.
  //  D25 (multi-drive aggregation) — single-drive 1541 only.
  //  D26 (parallel cable) — out of scope.
  //  D27 (`iecbus == NULL` fallback `iec_drive_write`) — `bus` is
  //    constructor-required in TS; null-bus path unreachable.
  //  D28 (dump/peek) — diagnostic only.
}

/**
 * Drive a CA1 (= ATN line) edge into the VIA1 from the IEC bus side.
 * Caller is responsible for tracking ATN polarity changes and only
 * invoking this when an edge actually occurs.
 *
 * VICE-style polarity TAG (NOT physical edge direction). Per VICE
 * src/iecbus/iecbus.c:247-268 (write_conf1):
 *   `viacore_signal(via1d1541, VIA_SIG_CA1,
 *                   iec_old_atn ? 0 : VIA_SIG_RISE)`
 * with `iec_old_atn = 0x10` → ATN released (HIGH) → tag 0 = VIA_SIG_FALL,
 *      `iec_old_atn = 0`    → ATN asserted (LOW)  → tag 1 = VIA_SIG_RISE.
 *
 * So `signalCa1(VIA_SIG_RISE)` means "ATN just went LOW (asserted)"
 * and `signalCa1(VIA_SIG_FALL)` means "ATN just went HIGH (released)".
 *
 * The 1541 ROM at $EB2F writes PCR=$01 ⇒ CA1 latches on tag=1 = RISE
 * = ATN-ASSERT. Pre-fix this code mapped `atnReleased=true → RISE`,
 * which sent FALL on assert, mismatching PCR=$01 → IFR_CA1 never
 * latched → drive ROM never entered ATN service routine →
 * C64 stuck at $ED5A serial RX wait.
 *
 * Spec 611 phase 611.7f.4 fix: align with VICE source — assert maps
 * to RISE, release maps to FALL (the VICE TAG semantics).
 */
export function signalVia1Ca1(via1: Via6522, atnReleased: boolean, clk?: number): void {
  // Spec 611 phase 611.7f.24 — propagate optional clk through to
  // backend.setIrq for canonical write-time stamp (matches legacy
  // pulseCa1's `stamp` argument).
  via1.signalCa1(atnReleased ? VIA_SIG_FALL : VIA_SIG_RISE, clk);
}
