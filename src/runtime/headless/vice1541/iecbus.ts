// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c (full file)
// Header:  vice/src/iecbus.h
// VICE rev: working tree at /Users/alex/Development/C64/Tools/vice/vice
// Spec:    specs/612-1541-port-fidelity-rules.md (NL-1..NL-5, PL-1..PL-10)
// Task:    specs/612-1541-port-fidelity-todo.md T2.11 (Wave 7, after T1.6)
// Layer:   §4 LO-14 — iecbus.ts + c64iec.ts + iec.ts
// =============================================================================
//
// IEC bus handling for the C64-side IEC bus model: tracks the multiplexed
// drv_bus / drv_data / drv_port / cpu_bus / cpu_port lanes, dispatches the
// CPU read/write through a callback table that depends on which device
// slots are enabled (none / drive 8 only / drive 9 only / arbitrary mix),
// and propagates ATN edges to the addressed drive's VIA / CIA chip.
//
// Author of VICE original: Andreas Boose <viceteam@t-online.de>.
//
// Per Spec 612:
//   • NL-2 — every non-trivial VICE function is exported with the verbatim
//     snake_case name. The conf0..conf3 read/write callbacks are `static`
//     in VICE; they are exported here so the task's "14 functions" inventory
//     reads 1:1 against the C file and so external micro-tests can drive
//     them directly without going through the callback indirection.
//   • NL-5 — module-level globals (`iecbus`, `iec_old_atn`, `iecbus_device`,
//     `iecbus_callback_read`, `iecbus_callback_write`, `iecbus_update_ports`,
//     `iecbus_device_index`) keep verbatim VICE names at module scope.
//   • PL-1 — no class. All state is module-level `let`/`const`; functions
//     take VICE struct args.
//   • PL-6 — `iecbus_callback_read` / `iecbus_callback_write` /
//     `iecbus_update_ports` are mutable function-pointer references,
//     reassigned by `calculate_callback_index` per VICE.
//   • PL-7 — `iecbus_device_write` returns 0 when `iecbus_update_ports`
//     is unset (no silent success).
//   • PL-10 — imports only from `./drivetypes.js`, `./viacore.js`,
//     `./via1d1541.js`, `./via2d.js`. No `../drive/`, `../via/`, `../iec/`.
//
// External symbols still pending other layers (drive.ts T2.10, c64iec.ts
// T2.12, serial / CIA — out of §10 scope) are declared as PORT-STUB
// forwards: throw or return a documented sentinel so wiring stays honest.

import {
  IECBUS_NUM,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_CMDHD,
  NUM_DISK_UNITS,
  VIA_SIG_CA1,
  VIA_SIG_CA2,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type diskunit_context_t,
  type cia_context_t,
  type via_context_t,
  type cmdhd_context_t,
} from "./drivetypes.js";
import { viacore_signal } from "./viacore.js";
// via1d1541.js / via2d.js are imported per spec acceptance to keep the
// dependency graph identical to VICE's link order even when no symbol
// is consumed at module scope (the dispatch goes through the
// `via_context_t` pointer parked in `diskunit_context_t.via1d1541`).
// Side-effect-only imports honour TS's strict-mode "module not used"
// rule via `void` reads of the namespace below.
import * as via1d1541_mod from "./via1d1541.js";
import * as via2d_mod from "./via2d.js";
// Spec 614.5 — wire drive_cpu_execute_one/all through to the real
// drivecpu_execute (T2.4) so iecbus_cpu_write_conf1 advances the drive
// to the exact c64 clock BEFORE iec_update_cpu_bus, matching VICE
// iecbus.c:255 dispatch order.
import { drivecpu_execute } from "./drivecpu.js";
void via1d1541_mod;
void via2d_mod;

// =============================================================================
// PORT OF: vice/src/iecbus.h:56-83 (iecbus_t)
// =============================================================================
// VICE struct fields verbatim — NL-3 snake_case. drv_bus / drv_data are
// `uint8_t [IECBUS_NUM]` in VICE; sized Uint8Array preserves the wrap
// semantics without box/unbox cost.
export interface iecbus_t {
  /** Drive output ports as described by the IECBUS_DEVICE_WRITE_* macros. */
  drv_bus: Uint8Array;
  /** Drive output ports as seen by the drive. */
  drv_data: Uint8Array;
  /** Drive input ports, as seen by the drive and the IECBUS_DEVICE_READ_*
   *  macros. */
  drv_port: number;
  /** Computer output ports as described by the IECBUS_DEVICE_WRITE_*
   *  macros. */
  cpu_bus: number;
  /** Computer output ports as seen by the computer. */
  cpu_port: number;
  /** Burst-mode (1541 fast IEC) hardware bit. */
  iec_fast_1541: number;
}

// =============================================================================
// PORT OF: vice/src/iecbus.h:46-54 (IECBUS_DEVICE_READ_/_WRITE_/ATNA bits)
// =============================================================================

/** iecbus.h:46 */ export const IECBUS_DEVICE_READ_DATA = 0x01;
/** iecbus.h:47 */ export const IECBUS_DEVICE_READ_CLK = 0x04;
/** iecbus.h:48 */ export const IECBUS_DEVICE_READ_ATN = 0x80;
/** iecbus.h:50 */ export const IECBUS_DEVICE_ATNA = 0x10;
/** iecbus.h:52 */ export const IECBUS_DEVICE_WRITE_CLK = 0x40;
/** iecbus.h:53 */ export const IECBUS_DEVICE_WRITE_DATA = 0x80;

// =============================================================================
// PORT OF: vice/src/iecbus.h:37-40 (IECBUS_STATUS_*)
// =============================================================================

/** iecbus.h:37 */ export const IECBUS_STATUS_TRUEDRIVE = 0;
/** iecbus.h:38 */ export const IECBUS_STATUS_DRIVETYPE = 1;
/** iecbus.h:39 */ export const IECBUS_STATUS_IECDEVICE = 2;
/** iecbus.h:40 */ export const IECBUS_STATUS_TRAPDEVICE = 3;

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:52-54 (IECBUS_DEVICE_* device-class enum)
// =============================================================================
// VICE uses these as compile-time `#define` rather than enum entries; ported
// as named `const` (NL-4).

/** iecbus.c:52 */ export const IECBUS_DEVICE_NONE = 0;
/** iecbus.c:53 */ export const IECBUS_DEVICE_TRUEDRIVE = 1;
/** iecbus.c:54 */ export const IECBUS_DEVICE_IECDEVICE = 2;

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:57-65 (module-level state — NL-5)
// =============================================================================
// `iecbus_callback_read` / `_write` / `iecbus_update_ports` are function-
// pointer globals in VICE — reassigned by `calculate_callback_index` and
// installed by the machine-specific iec.c (c64iec.c, vic20iec.c, ...).
// Same indirection here — mutable `let` with the verbatim VICE name.
//
// `iecbus_device[IECBUS_NUM]` and `iec_old_atn` are `static` in VICE; the
// `iec_old_atn` initial value is `0x10` (matches VICE iecbus.c:65).

/** PORT OF: vice/src/iecbus/iecbus.c:57 */
export let iecbus_callback_read: ((clock: number) => number) | null = null;
/** PORT OF: vice/src/iecbus/iecbus.c:58 */
export let iecbus_callback_write: ((data: number, clock: number) => void) | null = null;
/** PORT OF: vice/src/iecbus/iecbus.c:59 */
export let iecbus_update_ports: (() => void) | null = null;

/**
 * PORT OF: vice/src/iecbus/iecbus.c:59 (iecbus_update_ports global pointer)
 *
 * VICE's `iecbus_update_ports` is a `void (*)(void)` module-mutable extern
 * assigned by machine-specific iec.c (c64iec.c:174 — `iecbus_update_ports
 * = iec_update_ports;`). In a C build the importer simply writes the
 * symbol at link time. TS ESM forbids cross-module mutation of an
 * exported `let` from the importer side ("Cannot assign to read only
 * property of object '[object Module]'"). NL-5 / PL-5 spec exception:
 * the assignment must therefore be funnelled through a module-local
 * setter that mutates the underlying `let`. The function is exported
 * with a snake_case-faithful name (`install_iecbus_update_ports`) per
 * NL-2; c64iec.ts (PORT OF: vice/src/c64/c64iec.c:173-176 `c64iec_init`)
 * calls this in place of the direct-mutation idiom.
 */
export function install_iecbus_update_ports(fn: (() => void) | null): void {
  iecbus_update_ports = fn;
}

/** PORT OF: vice/src/iecbus/iecbus.c:61 (`iecbus_t iecbus;`) */
export const iecbus: iecbus_t = {
  drv_bus: new Uint8Array(IECBUS_NUM),
  drv_data: new Uint8Array(IECBUS_NUM),
  drv_port: 0,
  cpu_bus: 0,
  cpu_port: 0,
  iec_fast_1541: 0,
};

/** PORT OF: vice/src/iecbus/iecbus.c:63 (static uint iecbus_device[IECBUS_NUM]) */
const iecbus_device: number[] = new Array(IECBUS_NUM).fill(0);

/** PORT OF: vice/src/iecbus/iecbus.c:65 (static uint8_t iec_old_atn = 0x10) */
let iec_old_atn = 0x10;

// =============================================================================
// PORT-STUB forwards — pending higher layers / out of §10 scope
// =============================================================================
// The following symbols are declared `extern` in VICE and resolved at link
// time by the matching `.c` file. The TS port owns them in the listed
// layer; until those layers land, iecbus.ts holds local stubs that mirror
// the C signature 1:1.
//
//   iec_update_cpu_bus / iec_update_ports_embedded → c64iec.ts (T2.12)
//   drive_cpu_execute_one / drive_cpu_execute_all  → drivecpu.ts / drive.ts
//                                                    (T2.4 / T2.10)
//   serial_iec_device_exec                         → IEC-serial (§10 OoS)
//   ciacore_set_flag                               → CIA (§10 OoS, 1581)
//
// PL-7 spirit: stubs that would be reached on a path the 1541 single-drive
// shape never enters either throw (so an unexpected reach is caught) or
// no-op (for paths whose absence is silently absorbed by VICE itself —
// e.g. `iec_update_ports` defaulting to NULL until installed).

// PORT OF: vice/src/c64/c64iec.h (iec_update_cpu_bus extern)
// Pending c64iec.ts (T2.12). The function mutates `iecbus.cpu_bus` from
// the raw $DD00 store byte. Keeping a local fallback here lets the
// conf1/conf2/conf3 write paths run end-to-end during unit tests without
// the c64iec layer installed.
function iec_update_cpu_bus(data: number): void {
  // VICE c64iec.c:60 logic: `iecbus.cpu_bus = (((data << 2) & 0x80)
  //                              | ((data << 2) & 0x40)
  //                              | ((data << 1) & 0x10));`
  iecbus.cpu_bus =
    (((data << 2) & 0x80) | ((data << 2) & 0x40) | ((data << 1) & 0x10)) &
    0xff;
}

// PORT OF: vice/src/c64/c64iec.h (iec_update_ports extern)
// Pending c64iec.ts (T2.12). VICE c64iec.c walks each enabled drive,
// merging drv_bus[i] into iecbus.drv_port and updating iecbus.cpu_port.
// The local fallback collapses the drive-side lanes into cpu_port using
// the 1541 single-drive shape so the conf1 path is observable.
function default_iec_update_ports(): void {
  // Drive-side merge: OR of all drv_bus[] entries (active-low encoding).
  let merged = 0xff;
  for (let i = 0; i < IECBUS_NUM; i++) {
    merged &= iecbus.drv_bus[i]!;
  }
  iecbus.drv_port = merged & 0xff;
  // VICE c64iec.c sets cpu_port via the bus-merge formula; simplest faithful
  // collapse for the single-drive case is `cpu_bus & drv_port`.
  iecbus.cpu_port = iecbus.cpu_bus & 0xff;
}

// PORT OF: vice/src/drive/drive.h (drive_cpu_execute_one extern)
//
// Spec 614.5 — wired through to `drivecpu_execute` (T2.4 / Spec 612).
// VICE iecbus.c:255 calls this BEFORE `iec_update_cpu_bus(data)` so
// the drive is at exactly the c64 clock when the iecbus mutation
// happens — ATN-edge CA1 signal then fires with drive already-synced.
//
// Until Spec 614.3 (CycleSchedulerVice) the per-cycle scheduler ticks
// the drive AFTER each c64 cycle via afterCycleSync. That misses the
// sub-cycle clock at which c64's $DD00 STA writes (3rd/4th cycle of
// the instruction): drive at that moment lags by up to instr_cycles.
// The drive's CA1 IRQ entry timing then differs from VICE by the
// same amount — and the byte-receive bit-bang at $E9xx misses edges.
//
// drivecpu_execute is idempotent (returns early when clock <= last_clk),
// so duplicating the per-cycle catch-up here is safe and matches VICE.
function drive_cpu_execute_one(unit: diskunit_context_t, clock: number): void {
  drivecpu_execute(unit, clock >>> 0);
}

// PORT OF: vice/src/drive/drive.h (drive_cpu_execute_all extern)
// VICE iterates over all enabled units; we have one. Spec 614.5
// activation matches VICE.
function drive_cpu_execute_all(clock: number): void {
  const unit = _diskunit_get(0);
  if (unit !== null) drivecpu_execute(unit, clock >>> 0);
}

// PORT OF: vice/src/serial/serial-iec-device.h (serial_iec_device_exec extern)
// Out of §10 scope: serial-IEC virtual devices (printer, raw-IEC). For the
// 1541 single-drive shape the conf3 path is only reachable when a virtual
// device slot is active; until then this stays a silent no-op.
function serial_iec_device_exec(_clock: number): void {
  // No-op stub.
}

// PORT OF: vice/src/core/cia.h (ciacore_set_flag extern)
// 1581 only — pending CIA core (§10 OoS for 1541-first ordering). The
// switch table reaches this branch only on DRIVE_TYPE_1581.
function ciacore_set_flag(_cia: cia_context_t): void {
  // No-op stub. Reaching this from a pure-1541 setup is unreachable.
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:74-188 (debug helpers — DEBUG-gated)
// =============================================================================
// VICE compiles to no-ops when DEBUG is unset. Ported as no-op functions
// to preserve call-site shape per via1d1541.ts convention.

// PORT OF: vice/src/iecbus/iecbus.c:74 (debug_iec_cpu_write — DEBUG-gated)
function DEBUG_IEC_CPU_WRITE(_data: number): void {}
// PORT OF: vice/src/iecbus/iecbus.c:88 (debug_iec_cpu_read — DEBUG-gated)
function DEBUG_IEC_CPU_READ(_data: number): void {}

// PORT OF: vice/src/iecbus/iecbus.c:104 (debug_iec_drv_write)
export function debug_iec_drv_write(_data: number): void {
  // DEBUG-gated in VICE; no-op when debug.iec is unset.
}

// PORT OF: vice/src/iecbus/iecbus.c:122 (debug_iec_drv_read)
export function debug_iec_drv_read(_data: number): void {
  // DEBUG-gated in VICE; no-op when debug.iec is unset.
}

// PORT OF: vice/src/iecbus/iecbus.c:156 (debug_iec_bus_write)
export function debug_iec_bus_write(_data: number): void {
  // DEBUG-gated in VICE; #if 0 in the source.
}

// PORT OF: vice/src/iecbus/iecbus.c:171 (debug_iec_bus_read)
export function debug_iec_bus_read(_data: number): void {
  // DEBUG-gated in VICE; #if 0 in the source.
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:197-203 (iecbus_init)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:197-203 (iecbus_init)
export function iecbus_init(): void {
  // VICE: `memset(&iecbus, 0xff, sizeof(iecbus_t));`
  iecbus.drv_bus.fill(0xff);
  iecbus.drv_data.fill(0xff);
  iecbus.drv_port = 0xff;
  iecbus.cpu_bus = 0xff;
  iecbus.cpu_port = 0xff;
  iecbus.iec_fast_1541 = 0xff;
  // VICE: `iecbus.drv_port = IECBUS_DEVICE_READ_DATA | _READ_CLK | _READ_ATN;`
  iecbus.drv_port =
    IECBUS_DEVICE_READ_DATA | IECBUS_DEVICE_READ_CLK | IECBUS_DEVICE_READ_ATN;
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c (iecbus_shutdown — NOT-IN-VICE shim)
// =============================================================================
// VICE has no `iecbus_shutdown` in iecbus.c; module storage is static and
// torn down by the C runtime. The TS port exposes a verbatim shutdown
// entry point because the headless kernel manages explicit lifecycle.
// PL-5 exception: shutdown clears the function-pointer table so a fresh
// `iecbus_init` + `iecbus_status_set` cycle restarts cleanly.

// PORT OF: vice/src/iecbus/iecbus.c (iecbus_shutdown — TS lifecycle shim)
export function iecbus_shutdown(): void {
  iecbus_callback_read = null;
  iecbus_callback_write = null;
  iecbus_update_ports = null;
  for (let i = 0; i < IECBUS_NUM; i++) {
    iecbus_device[i] = 0;
  }
  iec_old_atn = 0x10;
  iecbus.drv_bus.fill(0);
  iecbus.drv_data.fill(0);
  iecbus.drv_port = 0;
  iecbus.cpu_bus = 0;
  iecbus.cpu_port = 0;
  iecbus.iec_fast_1541 = 0;
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:205-209 (iecbus_cpu_undump)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:205-209 (iecbus_cpu_undump)
export function iecbus_cpu_undump(data: number): void {
  iec_update_cpu_bus(data);
  iec_old_atn = iecbus.cpu_bus & 0x10;
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:212-224 (conf0 — no drive enabled)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:212-217 (iecbus_cpu_read_conf0)
export function iecbus_cpu_read_conf0(clock: number): number {
  void clock;
  DEBUG_IEC_CPU_READ((iecbus.iec_fast_1541 & 0x30) << 2);
  return ((iecbus.iec_fast_1541 & 0x30) << 2) & 0xff;
}

// PORT OF: vice/src/iecbus/iecbus.c:219-224 (iecbus_cpu_write_conf0)
export function iecbus_cpu_write_conf0(data: number, clock: number): void {
  void clock;
  DEBUG_IEC_CPU_WRITE(data);
  iecbus.iec_fast_1541 = data & 0xff;
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:227-287 (conf1 — drive 8 only)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:227-234 (iecbus_cpu_read_conf1)
export function iecbus_cpu_read_conf1(clock: number): number {
  drive_cpu_execute_all(clock);
  DEBUG_IEC_CPU_READ(iecbus.cpu_port);
  return iecbus.cpu_port & 0xff;
}

// PORT OF: vice/src/iecbus/iecbus.c:237-287 (iecbus_cpu_write_conf1)
export function iecbus_cpu_write_conf1(data: number, clock: number): void {
  const unit = _diskunit_get(0);
  if (unit === null) {
    // VICE asserts a non-null `diskunit_context[0]` at this point. With
    // no drive installed, fall back to conf0 semantics.
    iecbus_cpu_write_conf0(data, clock);
    return;
  }

  drive_cpu_execute_one(unit, clock);

  DEBUG_IEC_CPU_WRITE(data);

  iec_update_cpu_bus(data);

  if (iec_old_atn !== (iecbus.cpu_bus & 0x10)) {
    iec_old_atn = iecbus.cpu_bus & 0x10;
    switch (unit.type) {
      case DRIVE_TYPE_1581:
        if (!iec_old_atn) {
          if (unit.cia1581 !== null) {
            ciacore_set_flag(unit.cia1581);
          }
        }
        break;
      case DRIVE_TYPE_2000:
      case DRIVE_TYPE_4000:
        if (unit.via4000 !== null) {
          viacore_signal(
            unit.via4000,
            VIA_SIG_CA2,
            iec_old_atn ? 0 : VIA_SIG_RISE,
          );
        }
        break;
      case DRIVE_TYPE_CMDHD: {
        // VICE: `viacore_signal(unit->cmdhd->via10, VIA_SIG_CA1, ...)`
        const via10 = _cmdhd_via10(unit.cmdhd);
        if (via10 !== null) {
          viacore_signal(
            via10,
            VIA_SIG_CA1,
            iec_old_atn ? VIA_SIG_RISE : VIA_SIG_FALL,
          );
        }
        break;
      }
      default:
        if (unit.via1d1541 !== null) {
          viacore_signal(
            unit.via1d1541,
            VIA_SIG_CA1,
            iec_old_atn ? 0 : VIA_SIG_RISE,
          );
        }
    }
  }

  // Per-unit-type drv_bus formula (VICE iecbus.c:270-285).
  switch (unit.type) {
    case DRIVE_TYPE_1581:
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD: {
      const dd = iecbus.drv_data[8]!;
      iecbus.drv_bus[8] =
        (((dd << 3) & 0x40) |
          ((dd << 6) & ((dd | iecbus.cpu_bus) << 3) & 0x80)) &
        0xff;
      break;
    }
    default: {
      const dd = iecbus.drv_data[8]!;
      // VICE: `((uint32_t)(~iecbus.drv_data[8] ^ iecbus.cpu_bus) << 3)`
      iecbus.drv_bus[8] =
        (((dd << 3) & 0x40) |
          ((dd << 6) & (((~dd ^ iecbus.cpu_bus) >>> 0) << 3) & 0x80)) &
        0xff;
    }
  }

  if (iecbus_update_ports !== null) {
    iecbus_update_ports();
  } else {
    default_iec_update_ports();
  }
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:290-351 (conf2 — drive 9 only)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:290-297 (iecbus_cpu_read_conf2)
export function iecbus_cpu_read_conf2(clock: number): number {
  drive_cpu_execute_all(clock);
  DEBUG_IEC_CPU_READ(iecbus.cpu_port);
  return iecbus.cpu_port & 0xff;
}

// PORT OF: vice/src/iecbus/iecbus.c:300-351 (iecbus_cpu_write_conf2)
// REAL implementation — NOT a delegate to write_conf1. Targets
// `diskunit_context[1]` (drive 9) and writes `iecbus.drv_bus[9]`.
export function iecbus_cpu_write_conf2(data: number, clock: number): void {
  const unit = _diskunit_get(1);
  if (unit === null) {
    iecbus_cpu_write_conf0(data, clock);
    return;
  }

  drive_cpu_execute_one(unit, clock);

  DEBUG_IEC_CPU_WRITE(data);

  iec_update_cpu_bus(data);

  if (iec_old_atn !== (iecbus.cpu_bus & 0x10)) {
    iec_old_atn = iecbus.cpu_bus & 0x10;
    switch (unit.type) {
      case DRIVE_TYPE_1581:
        if (!iec_old_atn) {
          if (unit.cia1581 !== null) {
            ciacore_set_flag(unit.cia1581);
          }
        }
        break;
      case DRIVE_TYPE_2000:
      case DRIVE_TYPE_4000:
        if (unit.via4000 !== null) {
          viacore_signal(
            unit.via4000,
            VIA_SIG_CA2,
            iec_old_atn ? 0 : VIA_SIG_RISE,
          );
        }
        break;
      case DRIVE_TYPE_CMDHD: {
        const via10 = _cmdhd_via10(unit.cmdhd);
        if (via10 !== null) {
          viacore_signal(
            via10,
            VIA_SIG_CA1,
            iec_old_atn ? VIA_SIG_RISE : VIA_SIG_FALL,
          );
        }
        break;
      }
      default:
        if (unit.via1d1541 !== null) {
          viacore_signal(
            unit.via1d1541,
            VIA_SIG_CA1,
            iec_old_atn ? 0 : VIA_SIG_RISE,
          );
        }
    }
  }

  // Per-unit-type drv_bus formula (VICE iecbus.c:333-348). Targets [9].
  switch (unit.type) {
    case DRIVE_TYPE_1581:
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD: {
      const dd = iecbus.drv_data[9]!;
      iecbus.drv_bus[9] =
        (((dd << 3) & 0x40) |
          ((dd << 6) & ((dd | iecbus.cpu_bus) << 3) & 0x80)) &
        0xff;
      break;
    }
    default: {
      const dd = iecbus.drv_data[9]!;
      iecbus.drv_bus[9] =
        (((dd << 3) & 0x40) |
          ((dd << 6) & (((~dd ^ iecbus.cpu_bus) >>> 0) << 3) & 0x80)) &
        0xff;
    }
  }

  if (iecbus_update_ports !== null) {
    iecbus_update_ports();
  } else {
    default_iec_update_ports();
  }
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:353-430 (conf3 — multi-drive)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:353-361 (iecbus_cpu_read_conf3)
export function iecbus_cpu_read_conf3(clock: number): number {
  drive_cpu_execute_all(clock);
  serial_iec_device_exec(clock);
  DEBUG_IEC_CPU_READ(iecbus.cpu_port);
  return iecbus.cpu_port & 0xff;
}

// PORT OF: vice/src/iecbus/iecbus.c:364-430 (iecbus_cpu_write_conf3)
// REAL implementation — REAL multi-drive loop over NUM_DISK_UNITS.
export function iecbus_cpu_write_conf3(data: number, clock: number): void {
  let dnr: number;

  drive_cpu_execute_all(clock);
  serial_iec_device_exec(clock);

  DEBUG_IEC_CPU_WRITE(data);

  iec_update_cpu_bus(data);

  if (iec_old_atn !== (iecbus.cpu_bus & 0x10)) {
    iec_old_atn = iecbus.cpu_bus & 0x10;

    for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
      if (iecbus_device[8 + dnr] === IECBUS_DEVICE_TRUEDRIVE) {
        const unit = _diskunit_get(dnr);
        if (unit === null) continue;

        switch (unit.type) {
          case DRIVE_TYPE_1581:
            if (!iec_old_atn) {
              if (unit.cia1581 !== null) {
                ciacore_set_flag(unit.cia1581);
              }
            }
            break;
          case DRIVE_TYPE_2000:
          case DRIVE_TYPE_4000:
            if (unit.via4000 !== null) {
              viacore_signal(
                unit.via4000,
                VIA_SIG_CA2,
                iec_old_atn ? 0 : VIA_SIG_RISE,
              );
            }
            break;
          case DRIVE_TYPE_CMDHD: {
            const via10 = _cmdhd_via10(unit.cmdhd);
            if (via10 !== null) {
              viacore_signal(
                via10,
                VIA_SIG_CA1,
                iec_old_atn ? VIA_SIG_RISE : VIA_SIG_FALL,
              );
            }
            break;
          }
          default:
            if (unit.via1d1541 !== null) {
              viacore_signal(
                unit.via1d1541,
                VIA_SIG_CA1,
                iec_old_atn ? 0 : VIA_SIG_RISE,
              );
            }
        }
      }
    }
  }

  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    if (iecbus_device[8 + dnr] === IECBUS_DEVICE_TRUEDRIVE) {
      const unit_slot = dnr + 8;
      const unit = _diskunit_get(dnr);
      if (unit === null) continue;

      switch (unit.type) {
        case DRIVE_TYPE_1581:
        case DRIVE_TYPE_2000:
        case DRIVE_TYPE_4000:
        case DRIVE_TYPE_CMDHD: {
          const dd = iecbus.drv_data[unit_slot]!;
          iecbus.drv_bus[unit_slot] =
            (((dd << 3) & 0x40) |
              ((dd << 6) & ((dd | iecbus.cpu_bus) << 3) & 0x80)) &
            0xff;
          break;
        }
        default: {
          const dd = iecbus.drv_data[unit_slot]!;
          iecbus.drv_bus[unit_slot] =
            (((dd << 3) & 0x40) |
              ((dd << 6) & (((~dd ^ iecbus.cpu_bus) >>> 0) << 3) & 0x80)) &
            0xff;
        }
      }
    }
  }

  if (iecbus_update_ports !== null) {
    iecbus_update_ports();
  } else {
    default_iec_update_ports();
  }
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:432-463 (calculate_callback_index)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:432-463 (calculate_callback_index)
// Exported here even though `static` in VICE so micro-tests can drive the
// callback-table directly without going through `iecbus_status_set`.
export function calculate_callback_index(): void {
  const callback_index =
    (iecbus_device[8]! << 0) |
    (iecbus_device[9]! << 2) |
    (iecbus_device[10]! << 6) |
    (iecbus_device[11]! << 8) |
    (iecbus_device[4]! << 10) |
    (iecbus_device[5]! << 12) |
    (iecbus_device[6]! << 14) |
    (iecbus_device[7]! << 16);

  switch (callback_index) {
    case 0:
      iecbus_callback_read = iecbus_cpu_read_conf0;
      iecbus_callback_write = iecbus_cpu_write_conf0;
      break;
    case IECBUS_DEVICE_TRUEDRIVE << 0:
      iecbus_callback_read = iecbus_cpu_read_conf1;
      iecbus_callback_write = iecbus_cpu_write_conf1;
      break;
    case IECBUS_DEVICE_TRUEDRIVE << 2:
      iecbus_callback_read = iecbus_cpu_read_conf2;
      iecbus_callback_write = iecbus_cpu_write_conf2;
      break;
    default:
      iecbus_callback_read = iecbus_cpu_read_conf3;
      iecbus_callback_write = iecbus_cpu_write_conf3;
      break;
  }
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:493-510 (iecbus_device_index lookup table)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:493-510 (iecbus_device_index[16])
// NL-5 — module-level `const`, verbatim VICE name.
const iecbus_device_index: number[] = [
  IECBUS_DEVICE_NONE,     // 0000
  IECBUS_DEVICE_NONE,     // 0001
  IECBUS_DEVICE_IECDEVICE,// 0010
  IECBUS_DEVICE_IECDEVICE,// 0011
  IECBUS_DEVICE_NONE,     // 0100
  IECBUS_DEVICE_NONE,     // 0101
  IECBUS_DEVICE_IECDEVICE,// 0110
  IECBUS_DEVICE_IECDEVICE,// 0111
  IECBUS_DEVICE_NONE,     // 1000
  IECBUS_DEVICE_NONE,     // 1001
  IECBUS_DEVICE_IECDEVICE,// 1010
  IECBUS_DEVICE_IECDEVICE,// 1011
  IECBUS_DEVICE_TRUEDRIVE,// 1100
  IECBUS_DEVICE_TRUEDRIVE,// 1101
  IECBUS_DEVICE_IECDEVICE,// 1110
  IECBUS_DEVICE_IECDEVICE,// 1111
];

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:512-548 (iecbus_status_set)
// =============================================================================

// NL-5 — these are `static` arrays inside the C function body. TS hoists
// them to module scope because TS lacks function-static storage. Behaviour
// (persistence across calls) is preserved.
const _truedrive: number[] = new Array(IECBUS_NUM).fill(0);
const _drivetype: number[] = new Array(IECBUS_NUM).fill(0);
const _iecdevice: number[] = new Array(IECBUS_NUM).fill(0);
const _virtualdevices: number[] = new Array(IECBUS_NUM).fill(0);

// PORT OF: vice/src/iecbus/iecbus.c:512-548 (iecbus_status_set)
export function iecbus_status_set(
  type: number,
  unit: number,
  enable: number,
): void {
  let dev: number;

  switch (type) {
    case IECBUS_STATUS_TRUEDRIVE:
      _truedrive[unit] = enable ? 1 << 3 : 0;
      break;
    case IECBUS_STATUS_DRIVETYPE:
      _drivetype[unit] = enable ? 1 << 2 : 0;
      break;
    case IECBUS_STATUS_IECDEVICE:
      _iecdevice[unit] = enable ? 1 << 1 : 0;
      break;
    case IECBUS_STATUS_TRAPDEVICE:
      _virtualdevices[unit] = enable ? 1 << 0 : 0;
      break;
  }

  for (dev = 0; dev < IECBUS_NUM; dev++) {
    const index =
      _truedrive[dev]! |
      _drivetype[dev]! |
      _iecdevice[dev]! |
      _virtualdevices[dev]!;
    iecbus_device[dev] = iecbus_device_index[index]!;
  }

  calculate_callback_index();
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:551-554 (iecbus_device_read)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:551-554 (iecbus_device_read)
export function iecbus_device_read(): number {
  return iecbus.drv_port & 0xff;
}

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c:557-570 (iecbus_device_write)
// =============================================================================

// PORT OF: vice/src/iecbus/iecbus.c:557-570 (iecbus_device_write)
export function iecbus_device_write(unit: number, data: number): number {
  if (unit < IECBUS_NUM) {
    iecbus.drv_bus[unit] = data & 0xff;
    if (iecbus_update_ports !== null) {
      iecbus_update_ports();
      return 1;
    } else {
      return 0;
    }
  } else {
    return 0;
  }
}

// Spec 621.2 / PL-10 / FC-11 — `iecbus_drive_port` is machine-specific
// in VICE (defined per-machine in c64iec.c / plus4iec.c / petiec.c /
// cbm2iec.c / c64dtviec.c — see `vice/src/iecbus.h:87` declaration). For
// the C64 TS port the canonical definition lives in `c64iec.ts`. This
// file previously carried a placeholder body from before c64iec.ts
// existed (T2.12) — removed. Consumers import from `c64iec.js`.

// =============================================================================
// PORT OF: vice/src/iecbus/iecbus.c (iecbus_dump — NOT-IN-VICE shim)
// =============================================================================
// VICE has no `iecbus_dump` function in iecbus.c (monitor-side dump lives
// in mondb.c / monitor.c). The TS port exposes a verbatim dump entry
// point for headless diagnostics — formatted to match VICE's monitor
// "iec" output as closely as feasible. PL-5 exception per spec acceptance.

// PORT OF: vice/src/iecbus/iecbus.c (iecbus_dump — TS diagnostic shim)
export function iecbus_dump(): string {
  // Render the IEC bus state in a format compatible with VICE's `iec`
  // monitor command: one cpu_bus line + one drv_port line + per-slot rows
  // for every enabled drive.
  const lines: string[] = [];
  lines.push(
    `iec  cpu_bus=$${(iecbus.cpu_bus & 0xff).toString(16).padStart(2, "0")}` +
      ` cpu_port=$${(iecbus.cpu_port & 0xff).toString(16).padStart(2, "0")}` +
      ` drv_port=$${(iecbus.drv_port & 0xff).toString(16).padStart(2, "0")}` +
      ` iec_fast=$${(iecbus.iec_fast_1541 & 0xff).toString(16).padStart(2, "0")}` +
      ` old_atn=$${(iec_old_atn & 0xff).toString(16).padStart(2, "0")}`,
  );
  for (let i = 0; i < IECBUS_NUM; i++) {
    const dev = iecbus_device[i]!;
    if (dev === 0) continue;
    lines.push(
      `  slot[${i}] dev=${dev} drv_bus=$${(iecbus.drv_bus[i]! & 0xff)
        .toString(16)
        .padStart(2, "0")} drv_data=$${(iecbus.drv_data[i]! & 0xff)
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  return lines.join("\n");
}

// =============================================================================
// Internal helpers (NOT VICE functions — prefix `_` per PL-5 spirit)
// =============================================================================
// These exist only because TS lacks the C link-time resolution of
// `diskunit_context[]` (the array storage lives in drivesync.ts per
// Spec 612 §3 mapping). They are NOT exports.

// Looks up `diskunit_context[dnr]` through the drivesync.ts storage. The
// dependency is intentional one-way: drivesync.ts holds the array (it
// imports nothing from iecbus.ts), iecbus.ts reads through. This mirrors
// VICE's link-time arrangement (the symbol is defined in drive.c and
// referenced by iecbus.c without a header dependency cycle).
//
// T3.2-fix-E: drive.ts is canonical owner; drivesync.ts stub array
// is never populated by drive_setup_context. Switched.
import * as _drive from "./drive.js";
function _diskunit_get(dnr: number): diskunit_context_t | null {
  return _drive.diskunit_context[dnr] ?? null;
}

// CMDHD via10 accessor — `cmdhd_context_t` is forward-declared opaque in
// drivetypes.ts (T2.10 will fill it). Until then this typed cast keeps
// the switch-case shape intact for non-CMDHD drives without dragging the
// cmdhd struct definition into the port.
interface _CmdHdViewMin {
  via10: via_context_t | null;
}
function _cmdhd_via10(cmdhd: cmdhd_context_t | null): via_context_t | null {
  if (cmdhd === null) return null;
  const v = (cmdhd as unknown as _CmdHdViewMin).via10;
  return v ?? null;
}
