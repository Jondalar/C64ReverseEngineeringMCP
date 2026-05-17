// PORT OF: vice/src/drive/iec/via1d1541.c (full file)
// PORT OF: vice/src/drive/iec/via1d1541.h
// VICE rev: system-installed /Users/alex/Development/C64/Tools/vice/vice
//           (Spec 612 §11 open question 1 — pinning deferred)
//
// Spec 612 — 1541 Port Fidelity Rules (this file is §4 LO-4 — VIA1 backend):
//   §1 NL-1  one C file -> one TS file, same basename (via1d1541.c -> via1d1541.ts)
//   §1 NL-2  one C function -> one TS function, snake_case verbatim. The
//            via1d1541.c statics (store_pra, store_prb, undump_*, set_int,
//            restore_int, set_ca2, set_cb2, read_pra, read_prb, store_pcr,
//            store_acr, store_sr, store_t2l, reset) are ported as
//            module-private TS functions with the verbatim VICE names; only
//            the H-public entry points (via1d1541_*) are `export function`.
//   §1 NL-3  struct fields accessed snake_case (declared in ./drivetypes.ts).
//   §1 NL-4  #define -> exported TS const (constants in drivetypes.ts).
//   §1 NL-5  module-level C globals -> module-level TS let/const.
//   §2 PL-1  NO TS class wrapping diskunit_context_s / via_context_s —
//            functions take the struct as first arg.
//   §2 PL-3  NO factory / manager / helper invented inside vice1541/.
//   §2 PL-5  NO NOT-IN-VICE helpers (no createVia1d() factory invented).
//   §2 PL-6  rmw_flag pointer installed via setup_context per VICE wiring
//            (via1d1541.c:385 — `via->rmw_flag = &(ctxptr->cpu->rmw_flag);`).
//            cpu_last_data echo per VICE viacore.c:64,70 (= via1d1541.c:62-70).
//   §5 FM    PORT OF block on every export within 5 lines (FC-4 gate).
//
// This file consolidates two prior parallel ports (T1.6 in
// specs/612-1541-port-fidelity-todo.md):
//   - src/runtime/headless/_quarantine_vice1541_v4/via1d.ts (createVia1d
//     factory + Via6522 backend wiring — PL-5 violation, dropped)
//   - src/runtime/headless/via/via1d1541.ts (Via1d1541 class + IRQ-line
//     attach helper — PL-1 violation, dropped)
// The two predecessors stay on-disk per the audit constraint ("do NOT
// delete now; T2.x will"). This new file is the canonical port.
//
// External dependencies kept inside Spec 612 boundaries:
//   - ./drivetypes.js     — diskunit_context_t, drivecpu_context_t,
//                            via_context_t, drive_t, constants (NL-3, NL-4).
//   - ./viacore.js        — viacore_init, viacore_setup_context,
//                            viacore_store, viacore_read, viacore_peek,
//                            viacore_dump (LO-3 sibling — already GREEN).
//
// External-but-not-yet-ported (held as opaque stubs so the verbatim VICE
// structure stays intact; will resolve as later layers land per §4 LO):
//   - iecbus_drive_port() / iecbus_t fields (LO-14 iecbus.ts)
//   - iec_drive_write / iec_fast_drive_direction  (LO-14 iec.ts)
//   - drivesync_set_1571 / glue1571_side_set (1571 — out of scope per §10)
//   - parallel_cable_drive_read / parallel_cable_drive_write (parallel cable
//     extension — out of scope per §10)
//   - lib_calloc / lib_malloc / lib_msprintf (TS = native object / template
//     string)
//
// Interrupt module (interrupt_set_irq / interrupt_restore_irq) is reached
// via a structural cast on `drivecpu_context_t.int_status` (the interface
// is `interrupt_cpu_status_t` — opaque forward in drivetypes.ts). This
// matches the viacore.ts cast pattern and keeps FC-3 (no cross-imports
// into ../drive/, ../via/, ../iec/) clean. The structural shape
// `{ setIrq(intNum, value, clk): void }` is provided by the live
// InterruptCpuStatus instance owned by drivecpu.ts; calling it via a
// cast preserves verbatim VICE call sites without leaking a class import.

import {
  // Drive type IDs (drive.h).
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  // Parallel cable IDs (drive.h).
  DRIVE_PC_STANDARD,
  DRIVE_PC_21SEC_BACKUP,
  DRIVE_PC_FORMEL64,
  // VIA register indices (via.h).
  VIA_PRA,
  VIA_PRB,
  VIA_DDRA,
  VIA_DDRB,
  VIA_PCR,
  // IEC bus device count (iecbus.h).
  NUM_DISK_UNITS,
  // Struct forwards.
  type diskunit_context_t,
  type drive_t,
  type via_context_t,
  type alarm_context_t,
  type interrupt_cpu_status_t,
} from "./drivetypes.js";

import {
  viacore_init,
  viacore_setup_context,
  viacore_store,
  viacore_read,
  viacore_peek,
  viacore_dump,
} from "./viacore.js";

// =============================================================================
// PARALLEL_WRITE constants — VICE: vice/src/drive/parallel-cable.h:35-36
// =============================================================================
// PORT OF: vice/src/drive/parallel-cable.h:35-36 (PARALLEL_WRITE_*)
// Parallel cable header is folded here because parallel-cable.c is NOT in
// the §3 file mapping (out of scope per §10). via1d1541.c needs the two
// write-mode constants only.
const PARALLEL_WRITE = 0;
const PARALLEL_WRITE_HS = 1;

// =============================================================================
// IK_IRQ — VICE: vice/src/interrupt.h:47
// =============================================================================
// PORT OF: vice/src/interrupt.h:47 (IK_IRQ enum value)
// Folded here (not in drivetypes.ts yet) so via->irq_line = IK_IRQ stays a
// literal numeric assignment per VICE. Will move to drivetypes.ts when the
// full interrupt.h fold lands with drivecpu.ts (T2.5).
const IK_IRQ = 1 << 1;

// =============================================================================
// drivevia1_context_s — VICE: vice/src/drive/iec/via1d1541.c:52-59
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:52-59 (drivevia1_context_s).
// Per-VIA private payload — stored in via_context_t.prv (unknown there).
// Field order + names verbatim from VICE.
interface drivevia1_context_t {
  number: number;
  /** TODO: remove when no longer needed (VICE source comment). */
  drive: drive_t | null;
  diskunit: diskunit_context_t | null;
  parallel_id: number;
  /** init to 1 (VICE comment). */
  v_parieee_is_out: number;
  /** Pointer to the IEC bus struct (iecbus_t). Held opaque until LO-14. */
  v_iecbus: iecbus_t | null;
}

// =============================================================================
// iecbus_t — VICE: vice/src/iecbus.h:56-83 (forward stub)
// =============================================================================
// LO-14 will fold this into iecbus.ts. Until then this minimal forward
// keeps the verbatim VICE field access intact (`iecbus->drv_bus[unit]` →
// `iecbus.drv_bus[unit]`) without a tagged-union / class wrapper.
interface iecbus_t {
  drv_bus: Uint8Array;
  drv_data: Uint8Array;
  drv_port: number;
  cpu_bus: number;
  cpu_port: number;
  iec_fast_1541: number;
}

// =============================================================================
// External-helper stubs (resolved when LO-14 iec.ts / iecbus.ts land)
// =============================================================================
// VICE source:
//   - vice/src/iecbus/iecbus.c:iecbus_drive_port() — returns active iecbus.
//   - vice/src/drive/iec/iecdrive.c:iec_drive_write() — single-drive fallback.
//   - vice/src/drive/iec/iecdrive.c:iec_fast_drive_direction() — burst.
// All three are PORT-STUB until the matching .ts file lands. PL-7 spirit:
// throw rather than silently returning — keeps wiring honest.

// T3.2-fix-M: iecbus.ts (Spec 612 T2.11) is now ported — replace stub
// with real import. Was returning null which routed store_prb through
// the iec_drive_write fallback (PORT-STUB throw).
import { iecbus_drive_port as _iecbus_drive_port } from "./iecbus.js";
function iecbus_drive_port(): iecbus_t | null {
  return _iecbus_drive_port() as unknown as iecbus_t;
}

// PORT OF: vice/src/drive/iec/iecdrive.h (iec_drive_write — extern)
function iec_drive_write(_data: number, _dnr: number): void {
  throw new Error(
    "PORT-STUB: iec_drive_write — pending Spec 612 T2.10 iec.ts (LO-14). " +
      "Called via via1d1541 store_prb / undump_prb when iecbus == null.",
  );
}

// PORT OF: vice/src/drive/iec/iecdrive.h (iec_drive_read — extern)
function iec_drive_read(_dnr: number): number {
  throw new Error(
    "PORT-STUB: iec_drive_read — pending Spec 612 T2.10 iec.ts (LO-14). " +
      "Called via via1d1541 read_prb when iecbus == null.",
  );
}

// PORT OF: vice/src/iecbus/iecbus.c (iec_fast_drive_direction)
function iec_fast_drive_direction(_direction: number, _dnr: number): void {
  // Burst-mode fast loader direction — 1571/1581 only. Stub per §10.
  // Called from store_pra 1571 branch — not reached for 1541 single-drive.
}

// PORT OF: vice/src/drive/drivesync.h (drivesync_set_1571)
function drivesync_set_1571(_dc: diskunit_context_t, _byte: number): void {
  // 1571 dual-frequency mode toggle — out of scope per §10. Reachable only
  // from the 1571/1571CR branches below; 1541 path never enters here.
  throw new Error(
    "PORT-STUB: drivesync_set_1571 — out of scope per Spec 612 §10 (1571).",
  );
}

// PORT OF: vice/src/drive/iec1571/glue1571.h (glue1571_side_set)
function glue1571_side_set(_side: number, _drive: drive_t | null): void {
  // 1571 dual-sided disk side select — out of scope per §10.
  throw new Error(
    "PORT-STUB: glue1571_side_set — out of scope per Spec 612 §10 (1571).",
  );
}

// PORT OF: vice/src/drive/parallel-cable.h (parallel_cable_drive_read)
function parallel_cable_drive_read(_pc: number, _hs: number): number {
  // Parallel cable IO — out of scope per §10. Single-drive 1541 with no
  // parallel cable installed never enters this branch.
  throw new Error(
    "PORT-STUB: parallel_cable_drive_read — out of scope per Spec 612 §10.",
  );
}

// PORT OF: vice/src/drive/parallel-cable.h (parallel_cable_drive_write)
function parallel_cable_drive_write(
  _pc: number,
  _byte: number,
  _mode: number,
  _dnr: number,
): void {
  throw new Error(
    "PORT-STUB: parallel_cable_drive_write — out of scope per Spec 612 §10.",
  );
}

// =============================================================================
// DEBUG_IEC_* macros — VICE: vice/src/debug.h
// =============================================================================
// VICE compiles to no-ops unless DEBUG_IEC_DRV / DEBUG_IEC_BUS is defined.
// Ported as no-op functions so the call-site shape matches verbatim.

// PORT OF: vice/src/debug.h (DEBUG_IEC_DRV_WRITE — DEBUG no-op by default)
function DEBUG_IEC_DRV_WRITE(_byte: number): void {}
// PORT OF: vice/src/debug.h (DEBUG_IEC_DRV_READ — DEBUG no-op by default)
function DEBUG_IEC_DRV_READ(_byte: number): void {}
// PORT OF: vice/src/debug.h (DEBUG_IEC_BUS_WRITE — DEBUG no-op by default)
function DEBUG_IEC_BUS_WRITE(_byte: number): void {}
// PORT OF: vice/src/debug.h (DEBUG_IEC_BUS_READ — DEBUG no-op by default)
function DEBUG_IEC_BUS_READ(_byte: number): void {}

// =============================================================================
// interrupt_set_irq / interrupt_restore_irq — VICE: interrupt.h:141, 200
// =============================================================================
// Reached via a structural cast on the opaque `interrupt_cpu_status_t`
// forward. The live drivecpu.ts InterruptCpuStatus instance has these
// methods; the cast keeps via1d1541.ts free of cross-module class imports
// (FC-3 only blocks ../drive/ / ../via/ / ../iec/ — ../cpu/ would be
// allowed, but we follow the viacore.ts convention of routing through
// the opaque forward so all interrupt access lives on one path).

interface IntStatusLike {
  // Mirrors interrupt-cpu-status.ts:108-140 (1:1 with interrupt.h:141-196).
  setIrq(intNum: { id: number; name: string }, value: boolean, clk: number): void;
  // Mirrors interrupt-cpu-status.ts (interrupt_restore_irq).
  restoreIrq?(intNum: { id: number; name: string }, value: boolean): void;
  // For viacore_init int_num allocation when drivecpu.ts wires it.
  newIntNum?(name: string): { id: number; name: string };
}

// PORT OF: vice/src/interrupt.h:141 (interrupt_set_irq).
// Wraps `cs->setIrq(int_num, value, rclk)` to keep the VICE C call shape.
function interrupt_set_irq(
  cs: interrupt_cpu_status_t | null,
  int_num: number,
  value: number,
  rclk: number,
): void {
  if (!cs) return;
  // The numeric int_num in VICE indexes cs->pending_int[]. The TS port has
  // IntNum {id, name}; viacore_init in this file allocates the IntNum via
  // newIntNum and stores its id into ctx.int_num — so re-wrap here.
  const c = cs as unknown as IntStatusLike;
  c.setIrq({ id: int_num, name: "" }, value !== 0, rclk);
}

// PORT OF: vice/src/interrupt.h:200 (interrupt_restore_irq).
function interrupt_restore_irq(
  cs: interrupt_cpu_status_t | null,
  int_num: number,
  value: number,
): void {
  if (!cs) return;
  const c = cs as unknown as IntStatusLike;
  if (c.restoreIrq) {
    c.restoreIrq({ id: int_num, name: "" }, value !== 0);
  } else {
    // Fallback to setIrq with a synthetic clk=0 (matches viacore.ts
    // via_restore_int when restore_int hook is unset).
    c.setIrq({ id: int_num, name: "" }, value !== 0, 0);
  }
}

// =============================================================================
// PORT OF: vice/src/drive/iec/via1d1541.c:50 — #define iecbus (via1p->v_iecbus)
// =============================================================================
// VICE uses a preprocessor alias `iecbus` for `via1p->v_iecbus` so every
// reference reads `iecbus->drv_bus[...]`. In TS we expand the alias inline
// at each call site (the `iecbus` local in store_prb / undump_prb / read_prb
// below). Same effect, zero abstraction layer.

// =============================================================================
// via1d1541_store — VICE: via1d1541.c:62-66
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:62-66 (via1d1541_store)
// PL-6 cpu_last_data echo: `ctxptr->cpu->cpu_last_data = data;` then
// `viacore_store(ctxptr->via1d1541, addr, data);` — verbatim VICE.
export function via1d1541_store(
  ctxptr: diskunit_context_t,
  addr: number,
  data: number,
): void {
  if (ctxptr.cpu) {
    ctxptr.cpu.cpu_last_data = data & 0xff;
  }
  if (ctxptr.via1d1541) {
    viacore_store(ctxptr.via1d1541, addr, data);
  }
}

// =============================================================================
// via1d1541_read — VICE: via1d1541.c:68-71
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:68-71 (via1d1541_read)
// PL-6 cpu_last_data echo: `return ctxptr->cpu->cpu_last_data =
// viacore_read(ctxptr->via1d1541, addr);` — verbatim VICE assignment form.
export function via1d1541_read(
  ctxptr: diskunit_context_t,
  addr: number,
): number {
  if (!ctxptr.via1d1541) return 0;
  const v = viacore_read(ctxptr.via1d1541, addr) & 0xff;
  if (ctxptr.cpu) {
    ctxptr.cpu.cpu_last_data = v;
  }
  return v;
}

// =============================================================================
// via1d1541_peek — VICE: via1d1541.c:73-76
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:73-76 (via1d1541_peek)
export function via1d1541_peek(
  ctxptr: diskunit_context_t,
  addr: number,
): number {
  if (!ctxptr.via1d1541) return 0;
  return viacore_peek(ctxptr.via1d1541, addr) & 0xff;
}

// =============================================================================
// via1d1541_dump — VICE: via1d1541.c:78-82
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:78-82 (via1d1541_dump)
export function via1d1541_dump(
  ctxptr: diskunit_context_t,
  _addr: number,
): number {
  if (!ctxptr.via1d1541) return 0;
  viacore_dump(ctxptr.via1d1541);
  return 0;
}

// =============================================================================
// set_ca2 — VICE: via1d1541.c:84-86 (static, empty)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:84-86 (set_ca2 — static)
function set_ca2(_via_context: via_context_t, _state: number): void {
  // VICE: empty body. CA2 not wired on 1541 VIA1.
}

// =============================================================================
// set_cb2 — VICE: via1d1541.c:88-90 (static, empty)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:88-90 (set_cb2 — static)
function set_cb2(_via_context: via_context_t, _state: number, _offset: number): void {
  // VICE: empty body. CB2 not wired on 1541 VIA1.
}

// =============================================================================
// set_int — VICE: via1d1541.c:92-100 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:92-100 (set_int — static)
function set_int(
  via_context: via_context_t,
  int_num: number,
  value: number,
  rclk: number,
): void {
  // VICE:97 — dc = (diskunit_context_t *) via_context->context;
  const dc = via_context.context as diskunit_context_t | null;
  if (!dc || !dc.cpu) return;
  // VICE:99 — interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk).
  interrupt_set_irq(dc.cpu.int_status, int_num, value, rclk);
}

// =============================================================================
// restore_int — VICE: via1d1541.c:102-110 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:102-110 (restore_int — static)
function restore_int(
  via_context: via_context_t,
  int_num: number,
  value: number,
): void {
  // VICE:107 — dc = (diskunit_context_t *) via_context->context;
  const dc = via_context.context as diskunit_context_t | null;
  if (!dc || !dc.cpu) return;
  // VICE:109 — interrupt_restore_irq(dc->cpu->int_status, int_num, value).
  interrupt_restore_irq(dc.cpu.int_status, int_num, value);
}

// =============================================================================
// undump_pra — VICE: via1d1541.c:112-139 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:112-139 (undump_pra — static)
function undump_pra(via_context: via_context_t, byte: number): void {
  // VICE:117 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;
  // VICE:118 — dc = (diskunit_context_t *) via_context->context;
  const dc = via_context.context as diskunit_context_t | null;
  if (!dc) return;

  if (
    dc.type === DRIVE_TYPE_1570 ||
    dc.type === DRIVE_TYPE_1571 ||
    dc.type === DRIVE_TYPE_1571CR
  ) {
    // VICE:123 — drivesync_set_1571(dc, byte & 0x20);
    drivesync_set_1571(dc, byte & 0x20);
    // VICE:124 — glue1571_side_set((byte >> 2) & 1, via1p->drive);
    glue1571_side_set((byte >> 2) & 1, via1p.drive);
  } else {
    switch (via1p.diskunit?.parallel_cable) {
      case DRIVE_PC_STANDARD:
      case DRIVE_PC_21SEC_BACKUP:
      case DRIVE_PC_FORMEL64:
        if (
          dc.type === DRIVE_TYPE_1540 ||
          dc.type === DRIVE_TYPE_1541 ||
          dc.type === DRIVE_TYPE_1541II
        ) {
          // VICE:133-134 — parallel_cable_drive_write(...).
          parallel_cable_drive_write(
            dc.parallel_cable,
            byte,
            PARALLEL_WRITE,
            via1p.number,
          );
        }
        break;
    }
  }
}

// =============================================================================
// store_pra — VICE: via1d1541.c:141-179 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:141-179 (store_pra — static)
function store_pra(
  via_context: via_context_t,
  byte: number,
  oldpa_value: number,
  addr: number,
): void {
  // VICE:147 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;
  // VICE:148-149 — `dc = via1p->diskunit` (the commented-out form uses
  // via_context->context; verbatim VICE prefers via1p->diskunit).
  const dc = via1p.diskunit;
  if (!dc) return;

  if (
    dc.type === DRIVE_TYPE_1570 ||
    dc.type === DRIVE_TYPE_1571 ||
    dc.type === DRIVE_TYPE_1571CR
  ) {
    if ((oldpa_value ^ byte) & 0x20) {
      drivesync_set_1571(dc, byte & 0x20);
    }
    if ((oldpa_value ^ byte) & 0x04) {
      glue1571_side_set((byte >> 2) & 1, via1p.drive);
    }
    if ((oldpa_value ^ byte) & 0x02) {
      iec_fast_drive_direction(byte & 2, via1p.number);
    }
  } else {
    switch (dc.parallel_cable) {
      case DRIVE_PC_STANDARD:
      case DRIVE_PC_21SEC_BACKUP:
      case DRIVE_PC_FORMEL64:
        if (
          dc.type === DRIVE_TYPE_1540 ||
          dc.type === DRIVE_TYPE_1541 ||
          dc.type === DRIVE_TYPE_1541II
        ) {
          // VICE:171-174 — PARALLEL_WRITE_HS iff addr == VIA_PRA AND
          // PCR & 0x0e == 0x0a (CA2 pulse-output mode).
          const hs =
            addr === VIA_PRA && (via_context.via[VIA_PCR]! & 0xe) === 0xa
              ? PARALLEL_WRITE_HS
              : PARALLEL_WRITE;
          parallel_cable_drive_write(dc.parallel_cable, byte, hs, via1p.number);
        }
        break;
    }
  }
}

// =============================================================================
// undump_prb — VICE: via1d1541.c:181-210 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:181-210 (undump_prb — static)
function undump_prb(via_context: via_context_t, byte: number): void {
  // VICE:185 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;
  // VICE:50 — `#define iecbus (via1p->v_iecbus)` expanded inline.
  const iecbus = via1p.v_iecbus;

  if (iecbus !== null) {
    // VICE:191-192 — drive_bus / drive_data slots within iecbus arrays.
    const slot = via1p.number + 8;

    // VICE:194 — *drive_data = ~byte;
    iecbus.drv_data[slot] = (~byte) & 0xff;

    // VICE:195-197 — drv_bus[slot] = ...
    const dd = iecbus.drv_data[slot]!;
    iecbus.drv_bus[slot] =
      (((dd << 3) & 0x40) |
        (((dd << 6) & ((~dd ^ iecbus.cpu_bus) << 3) & 0x80))) & 0xff;

    // VICE:199 — iecbus->cpu_port = iecbus->cpu_bus;
    iecbus.cpu_port = iecbus.cpu_bus & 0xff;
    // VICE:200-202 — for unit 4..(8+NUM_DISK_UNITS-1) AND-reduce drv_bus.
    for (let unit = 4; unit < 8 + NUM_DISK_UNITS; unit++) {
      iecbus.cpu_port = (iecbus.cpu_port & iecbus.drv_bus[unit]!) & 0xff;
    }

    // VICE:204-206 — drv_port composite.
    iecbus.drv_port =
      (((iecbus.cpu_port >> 4) & 0x4) |
        (iecbus.cpu_port >> 7) |
        ((iecbus.cpu_bus << 3) & 0x80)) & 0xff;
  } else {
    // VICE:208 — iec_drive_write((uint8_t)(~byte), via1p->number).
    iec_drive_write((~byte) & 0xff, via1p.number);
  }
}

// =============================================================================
// store_prb — VICE: via1d1541.c:212-249 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:212-249 (store_prb — static)
function store_prb(
  via_context: via_context_t,
  byte: number,
  p_oldpb: number,
  _addr: number,
): void {
  // VICE:217 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;

  // VICE:219 — gate on change.
  if (byte !== p_oldpb) {
    DEBUG_IEC_DRV_WRITE(byte);

    // VICE:50 — `#define iecbus (via1p->v_iecbus)` expanded inline.
    const iecbus = via1p.v_iecbus;

    if (iecbus !== null) {
      const slot = via1p.number + 8;

      // VICE:229 — *drive_data = ~byte;
      iecbus.drv_data[slot] = (~byte) & 0xff;

      // VICE:230-232 — drv_bus[slot] composite.
      const dd = iecbus.drv_data[slot]!;
      iecbus.drv_bus[slot] =
        (((dd << 3) & 0x40) |
          (((dd << 6) & (((~dd ^ iecbus.cpu_bus) >>> 0) << 3) & 0x80))) & 0xff;

      // VICE:234 — iecbus->cpu_port = iecbus->cpu_bus;
      iecbus.cpu_port = iecbus.cpu_bus & 0xff;
      // VICE:235-237 — AND-reduce drv_bus over units 4..(8+NUM_DISK_UNITS-1).
      for (let unit = 4; unit < 8 + NUM_DISK_UNITS; unit++) {
        iecbus.cpu_port = (iecbus.cpu_port & iecbus.drv_bus[unit]!) & 0xff;
      }

      // VICE:239-241 — drv_port composite.
      iecbus.drv_port =
        (((iecbus.cpu_port >> 4) & 0x4) |
          (iecbus.cpu_port >> 7) |
          ((iecbus.cpu_bus << 3) & 0x80)) & 0xff;

      DEBUG_IEC_BUS_WRITE(iecbus.drv_port);
    } else {
      // VICE:245-246 — single-drive iec_drive_write fallback.
      iec_drive_write((~byte) & 0xff, via1p.number);
      DEBUG_IEC_BUS_WRITE((~byte) & 0xff);
    }
  }
}

// =============================================================================
// undump_pcr — VICE: via1d1541.c:251-263 (static, body inside #if 0)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:251-263 (undump_pcr — static)
function undump_pcr(_via_context: via_context_t, _byte: number): void {
  // VICE body is inside `#if 0` (line 253) — disabled in the C source.
  // Empty TS port matches.
}

// =============================================================================
// store_pcr — VICE: via1d1541.c:265-268 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:265-268 (store_pcr — static)
function store_pcr(_via_context: via_context_t, byte: number, _addr: number): number {
  // VICE:267 — `return byte;` (pass-through).
  return byte & 0xff;
}

// =============================================================================
// undump_acr / store_acr / store_sr / store_t2l — VICE: via1d1541.c:270-284
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:270-272 (undump_acr — static)
function undump_acr(_via_context: via_context_t, _byte: number): void {
  // VICE: empty body.
}

// PORT OF: vice/src/drive/iec/via1d1541.c:274-276 (store_acr — static)
function store_acr(_via_context: via_context_t, _byte: number): void {
  // VICE: empty body.
}

// PORT OF: vice/src/drive/iec/via1d1541.c:278-280 (store_sr — static)
function store_sr(_via_context: via_context_t, _byte: number): void {
  // VICE: empty body.
}

// PORT OF: vice/src/drive/iec/via1d1541.c:282-284 (store_t2l — static)
function store_t2l(_via_context: via_context_t, _byte: number): void {
  // VICE: empty body.
}

// =============================================================================
// reset — VICE: via1d1541.c:286-288 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:286-288 (reset — static)
function reset(_via_context: via_context_t): void {
  // VICE: empty body. Chip-level reset handled by viacore_reset.
}

// =============================================================================
// read_pra — VICE: via1d1541.c:290-322 (static)
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:290-322 (read_pra — static)
function read_pra(via_context: via_context_t, addr: number): number {
  let byte: number;
  // VICE:295 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;
  const du = via1p.diskunit;
  if (!du) return 0xff;

  if (
    du.type === DRIVE_TYPE_1570 ||
    du.type === DRIVE_TYPE_1571 ||
    du.type === DRIVE_TYPE_1571CR
  ) {
    // VICE:301 — rotation_rotate_disk(via1p->drive). Out of scope for
    // 1541 path; reachable only on 1571/1571CR — keep call literal even
    // though rotation_rotate_disk would land in rotation.ts (LO-5,
    // already GREEN). The 1571 branch is dead code on 1541 so importing
    // it here is unnecessary; the comment preserves provenance.
    //   rotation_rotate_disk(via1p.drive);
    const drv = via1p.drive;
    const tmp =
      ((drv && drv.byte_ready_level) ? 0 : 0x80) |
      ((drv && drv.current_half_track === 2) ? 0 : 1);
    return (
      ((tmp & ~via_context.via[VIA_DDRA]!) |
        (via_context.via[VIA_PRA]! & via_context.via[VIA_DDRA]!)) & 0xff
    );
  }

  switch (du.parallel_cable) {
    case DRIVE_PC_STANDARD:
    case DRIVE_PC_21SEC_BACKUP:
    case DRIVE_PC_FORMEL64: {
      // VICE:312-313 — parallel_cable_drive_read(...).
      const hs =
        addr === VIA_PRA && (via_context.via[VIA_PCR]! & 0xe) === 0xa ? 1 : 0;
      byte = parallel_cable_drive_read(du.parallel_cable, hs) & 0xff;
      break;
    }
    default: {
      // VICE:316-317 — (PRA & DDRA) | (0xff & ~DDRA).
      byte =
        ((via_context.via[VIA_PRA]! & via_context.via[VIA_DDRA]!) |
          (0xff & ~via_context.via[VIA_DDRA]!)) & 0xff;
      break;
    }
  }

  return byte;
}

// =============================================================================
// read_prb — VICE: via1d1541.c:337-362 (static)
// =============================================================================
// VICE source comment (verbatim):
//   Bit  7   |   ATN IN
//   Bits 6-5 |   Device address preset switches IN
//            |     00 = #8, 01 = #9, 10 = #10, 11 = #11
//   Bit  4   |   ATN acknowledge OUT
//   Bit  3   |   CLOCK OUT
//   Bit  2   |   CLOCK IN
//   Bit  1   |   DATA OUT
//   Bit  0   |   DATA IN
//   IN mask:     1110 0101   0xe5
//   OUT mask:    0001 1010   0x1a

// PORT OF: vice/src/drive/iec/via1d1541.c:337-362 (read_prb — static)
function read_prb(via_context: via_context_t): number {
  let byte: number;
  let driveid: number;
  // VICE:343 — via1p = (drivevia1_context_t *)(via_context->prv);
  const via1p = via_context.prv as drivevia1_context_t;

  // VICE:345 — driveid = (via1p->number << 5) & 0x60;
  driveid = (via1p.number << 5) & 0x60;

  // VICE:50 — `#define iecbus (via1p->v_iecbus)` expanded inline.
  const iecbus = via1p.v_iecbus;

  if (iecbus !== null) {
    // VICE:348-350.
    const tmp = ((iecbus.drv_port ^ 0x85) | 0x1a | driveid) & 0xff;
    byte =
      ((via_context.via[VIA_PRB]! & via_context.via[VIA_DDRB]!) |
        (tmp & ~via_context.via[VIA_DDRB]!)) & 0xff;
  } else {
    // VICE:352-354 — single-drive fallback.
    const tmp = ((iec_drive_read(via1p.number) ^ 0x85) | 0x1a | driveid) & 0xff;
    byte =
      ((via_context.via[VIA_PRB]! & via_context.via[VIA_DDRB]!) |
        (tmp & ~via_context.via[VIA_DDRB]!)) & 0xff;
  }

  DEBUG_IEC_DRV_READ(byte);
  DEBUG_IEC_BUS_READ(byte);

  return byte;
}

// =============================================================================
// via1d1541_init — VICE: via1d1541.c:364-368
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:364-368 (via1d1541_init)
export function via1d1541_init(ctxptr: diskunit_context_t): void {
  if (!ctxptr.via1d1541 || !ctxptr.cpu) return;
  // VICE:366-367 — viacore_init(ctxptr->via1d1541, cpu->alarm_context, cpu->int_status).
  viacore_init(
    ctxptr.via1d1541,
    ctxptr.cpu.alarm_context as alarm_context_t,
    ctxptr.cpu.int_status as interrupt_cpu_status_t,
  );
}

// =============================================================================
// via1d1541_setup_context — VICE: via1d1541.c:370-420
// =============================================================================

// PORT OF: vice/src/drive/iec/via1d1541.c:370-420 (via1d1541_setup_context)
export function via1d1541_setup_context(ctxptr: diskunit_context_t): void {
  // VICE:376 — lib_calloc(1, sizeof(via_context_t)). TS: native zero-init
  // object literal matching the via_context_t shape from drivetypes.ts.
  // Field defaults mirror VICE calloc semantics (numbers→0, refs→null,
  // bools→false). clk_ptr/rmw_flag get installed from ctxptr->cpu below.
  const via: via_context_t = {
    via: new Uint8Array(16),
    ifr: 0,
    ier: 0,
    tal: 0,
    t2cl: 0,
    t2ch: 0,
    t1reload: 0,
    t2zero: 0,
    t1zero: 0,
    t2xx00: false,
    t1_pb7: 0,
    oldpa: 0,
    oldpb: 0,
    ila: 0,
    ilb: 0,
    ca2_out_state: false,
    cb1_in_state: false,
    cb1_out_state: false,
    cb2_in_state: false,
    cb2_out_state: false,
    cb1_is_input: false,
    cb2_is_input: false,
    shift_state: 0,
    t1_zero_alarm: null,
    t2_zero_alarm: null,
    t2_underflow_alarm: null,
    t2_shift_alarm: null,
    phi2_sr_alarm: null,
    log: 0,
    read_clk: 0,
    read_offset: 0,
    last_read: 0,
    t2_irq_allowed: false,
    irq_line: 0,
    int_num: 0,
    myname: null,
    my_module_name: null,
    my_module_name_alt1: null,
    my_module_name_alt2: null,
    // PL-6 — clk_ptr installed from diskunit, NOT a closure.
    clk_ptr: ctxptr.clk_ptr,
    // PL-6 — rmw_flag installed below from ctxptr.cpu.rmw_flag.
    rmw_flag: { value: 0 },
    write_offset: 0,
    enabled: false,
    prv: null,
    context: null,
    alarm_context: null,
    undump_pra: null,
    undump_prb: null,
    undump_pcr: null,
    undump_acr: null,
    store_pra: null,
    store_prb: null,
    store_pcr: null,
    store_acr: null,
    store_sr: null,
    sr_underflow: null,
    store_t2l: null,
    read_pra: null,
    read_prb: null,
    set_int: null,
    restore_int: null,
    set_ca2: null,
    set_cb1: null,
    set_cb2: null,
    reset: null,
  };
  // VICE:377 — ctxptr->via1d1541 = ctxptr->via1d1541; (assign back).
  ctxptr.via1d1541 = via;

  // VICE:379 — via->prv = lib_malloc(sizeof(drivevia1_context_t));
  const via1p: drivevia1_context_t = {
    number: ctxptr.mynumber,
    drive: null,
    diskunit: null,
    parallel_id: 0,
    v_parieee_is_out: 1,
    v_iecbus: null,
  };
  via.prv = via1p;

  // VICE:383 — via->context = (void *)ctxptr;
  via.context = ctxptr;

  // VICE:385 — via->rmw_flag = &(ctxptr->cpu->rmw_flag);  (PL-6).
  if (ctxptr.cpu) {
    via.rmw_flag = ctxptr.cpu.rmw_flag;
  }
  // VICE:386 — via->clk_ptr = ctxptr->clk_ptr;
  via.clk_ptr = ctxptr.clk_ptr;

  // VICE:388-389 — lib_msprintf module names.
  via.myname = `1541Drive${ctxptr.mynumber}Via1`;
  via.my_module_name = `1541VIA1D${ctxptr.mynumber}`;

  // VICE:391 — viacore_setup_context(via);
  viacore_setup_context(via);

  // VICE:393-394 — legacy snapshot module names.
  via.my_module_name_alt1 = `VIA1D${ctxptr.mynumber}`;
  via.my_module_name_alt2 = `VIA1D1541`;

  // VICE:396 — via->irq_line = IK_IRQ;
  via.irq_line = IK_IRQ;

  // VICE:398-399 — drive + diskunit back-refs into the prv payload.
  via1p.drive = ctxptr.drives[0] ?? null;
  via1p.diskunit = ctxptr;

  // VICE:401 — iecbus = iecbus_drive_port();
  // PORT-STUB until LO-14: returns null today.
  via1p.v_iecbus = iecbus_drive_port();

  // VICE:403-419 — install callback table (verbatim ordering).
  via.undump_pra = undump_pra;
  via.undump_prb = undump_prb;
  via.undump_pcr = undump_pcr;
  via.undump_acr = undump_acr;
  via.store_pra = store_pra;
  via.store_prb = store_prb;
  via.store_pcr = store_pcr;
  via.store_acr = store_acr;
  via.store_sr = store_sr;
  via.store_t2l = store_t2l;
  via.read_pra = read_pra;
  via.read_prb = read_prb;
  via.set_int = set_int;
  via.restore_int = restore_int;
  via.set_ca2 = set_ca2;
  via.set_cb2 = set_cb2;
  via.reset = reset;
}
