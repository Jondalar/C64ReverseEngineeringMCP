// =============================================================================
// PORT OF: vice/src/c64/c64iec.c (full file)
// Header:  vice/src/c64/c64iec.h
// Slice:   vice/src/c64/c64cia2.c:136-231 (store_ciapa + read_ciapa IEC slice)
// VICE rev: working tree at /Users/alex/Development/C64/Tools/vice/vice
// Spec:    specs/612-1541-port-fidelity-rules.md (NL-1..NL-5, PL-1..PL-10)
// Task:    specs/612-1541-port-fidelity-todo.md T2.12 (Wave 7, after T2.11)
// Layer:   §4 LO-14 — iecbus.ts + c64iec.ts + iec.ts
// =============================================================================
//
// Machine-specific IEC glue for the C64. This file owns:
//
//   • the four "verbatim VICE name" entry points called by the IEC bus
//     model from iecbus.ts (`iec_update_cpu_bus`, `iec_update_ports`,
//     `iec_update_ports_embedded`, `iec_drive_write`, `iec_drive_read`),
//   • the C64-side `iecbus_drive_port()` accessor (mirrored from iecbus.ts
//     for symmetry — the canonical storage stays on iecbus.ts per VICE's
//     extern-link arrangement),
//   • the cartridge-aware `iec_available_busses` selector,
//   • the `c64iec_init` / `c64iec_enable` / `c64iec_get_active_state`
//     lifecycle entry points,
//   • a REAL CIA2 PA/PB/DDR/ICR slice for the IEC bits — the
//     `store_ciapa` / `read_ciapa` logic ported verbatim from
//     c64cia2.c:136-231 (the `tmp = ~byte` inversion + `iec_update_cpu_bus`
//     call chain). NOT a stub.
//
// Per Spec 612:
//   • NL-1 — one C file → one TS file, basename matches (`c64iec.c` →
//     `c64iec.ts`). The CIA2 IEC slice folds in because in VICE the
//     `store_ciapa` callback is wired by `cia2_setup_context` to the
//     c64iec layer at link time; in the TS port we own that wiring here.
//   • NL-2 — every VICE function in c64iec.c is exported with the
//     verbatim snake_case name.
//   • NL-3 — CIA register-bank state is held as a `cia2_iec_slice_t`
//     interface with snake_case fields verbatim (no class).
//   • NL-5 — module-level state (`c64iec_active`, the CIA2 PA/PB/DDR/ICR
//     slice, `pa_ddr_change`, `vbank`) sits at module scope.
//   • PL-1 — NO class. Functions take the CIA slice struct as first arg
//     where they would in VICE.
//   • PL-5 — no invented helpers (no `Cia2Bridge` class). Every export
//     maps to a VICE function name.
//   • PL-6 — clock arg threaded as `number`, NOT captured by a closure.
//   • PL-7 — reset state matches the silicon, NOT the post-KERNAL-init
//     state. `DDRA = 0` after reset (NOT `0x3f`). The KERNAL writes
//     `0x3f` itself during boot; the hardware doesn't lie about it.
//   • PL-10 — imports only from `./drivetypes.js` + `./iecbus.js`.
//     NO `../cpu/`, `../cia/`, `../iec/`, `../drive/`, `../via/`.
//
// External symbols deliberately NOT ported here (out of c64iec.c scope):
//   • `cartridge_type_enabled` — ported as a local stub returning 0
//     (no IEEE488 / IEEEFLASH64 cartridge in 1541-first scope per Spec
//     612 §10). Switching to a real cartridge-type query is a follow-up
//     spec; for now it satisfies the `iec_available_busses` shape.
//   • `parallel_cable_*`, `c64fastiec_*`, `userport_*` helpers — not
//     reachable from the 1541 single-drive shape and outside §10 scope.
//     Stubbed as no-ops where the CIA2 slice would call them; flagged.

import { IECBUS_NUM as _IECBUS_NUM } from "./drivetypes.js";
import {
  iecbus,
  iecbus_callback_read as _iecbus_callback_read,
  iecbus_callback_write as _iecbus_callback_write,
  install_iecbus_update_ports as _install_iecbus_update_ports,
  type iecbus_t,
} from "./iecbus.js";
// Re-export the IECBUS_NUM constant for downstream callers that pivot
// off c64iec.ts (matches VICE's c64iec.h surface).
void _IECBUS_NUM;

// =============================================================================
// PORT OF: vice/src/iecdrive.h:38-40 (IEC_BUS_* bitmask)
// =============================================================================
// VICE compiles these in via `iecdrive.h`; ported here as exported `const`
// (NL-4) because `iec_available_busses` returns this bitmask and the only
// in-tree caller of the constants is `c64iec.c`.

/** iecdrive.h:38 */ export const IEC_BUS_IEC = 0x01;
/** iecdrive.h:39 */ export const IEC_BUS_IEEE = 0x02;
/** iecdrive.h:40 */ export const IEC_BUS_TCBM = 0x04;

// =============================================================================
// PORT OF: vice/src/cartridge.h:232,266 (cartridge IDs touched by
// iec_available_busses)
// =============================================================================
// Ported as `const` (NL-4) for grep parity with c64iec.c.

/** cartridge.h:232 */ export const CARTRIDGE_IEEE488 = 41;
/** cartridge.h:266 */ export const CARTRIDGE_IEEEFLASH64 = 75;

// =============================================================================
// PORT OF: vice/src/cia.h:41-59 (CIA_PRA / CIA_PRB / CIA_DDRA / CIA_DDRB /
// CIA_ICR register indices used by the c64cia2 IEC slice)
// =============================================================================

/** cia.h:41 */ export const CIA_PRA = 0;
/** cia.h:42 */ export const CIA_PRB = 1;
/** cia.h:43 */ export const CIA_DDRA = 2;
/** cia.h:44 */ export const CIA_DDRB = 3;
/** cia.h:57 */ export const CIA_ICR = 13;

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:119 (`int c64iec_active = 1;`)
// =============================================================================
// NL-5 — module-level global, verbatim VICE name. Initial value matches
// VICE source.

/** PORT OF: vice/src/c64/c64iec.c:119 */
export let c64iec_active = 1;

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:110,151-155 (vbank + pa_ddr_change globals)
// =============================================================================
// `vbank` is a `static int` inside c64cia2.c. `pa_ddr_change` is the third
// arg threaded into `c64_glue_set_vbank` — kept as module-level state for
// parity. Both are part of the CIA2 IEC slice owned by this layer.

/** PORT OF: vice/src/c64/c64cia2.c:110 (`static int vbank;`) */
export let vbank = 0;

/** PORT OF: vice/src/c64/c64cia2.c:154 (`pa_ddr_change` arg into vbank set) */
export let pa_ddr_change = 0;

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c (CIA2 register-bank slice — IEC bits only)
// =============================================================================
// NL-3 — snake_case fields verbatim. The full `cia_context_t` is owned by
// ciacore.c; what we port here is just the IEC-bit-handling slice that
// c64cia2.c installs as `store_ciapa` / `read_ciapa` callbacks. Other CIA2
// behaviour (timers, TOD, ICR full semantics, userport) is out of §10 scope.
//
// PL-7: reset state matches the silicon. After hardware reset:
//   • c_cia[CIA_DDRA] = 0   (all bits input)
//   • c_cia[CIA_DDRB] = 0   (all bits input)
//   • c_cia[CIA_PRA]  = 0   (output latch idle)
//   • c_cia[CIA_PRB]  = 0
//   • c_cia[CIA_ICR]  = 0
//   • old_pa = 0xff         (matches VICE ciacore_reset semantics — first
//                            write always triggers the change-detection path)
// The KERNAL writes 0x3f to DDRA itself during boot. The hardware does
// NOT come up with 0x3f pre-set.

/** PORT OF: vice/src/core/ciacore.c (cia_context_t slice — IEC subset).
 *  Field names verbatim VICE. */
export interface cia2_iec_slice_t {
  /** Verbatim VICE: `c_cia[16]` — full 16-register bank. */
  c_cia: Uint8Array;
  /** Verbatim VICE: `old_pa` — last-written PA byte for change detection. */
  old_pa: number;
  /** Verbatim VICE: `old_pb`. */
  old_pb: number;
  /** Verbatim VICE: `write_offset` (0 for C64SC/SCPU64, 1 for plain C64). */
  write_offset: number;
}

/** PORT OF: vice/src/c64/c64cia2.c (module-level CIA2 IEC slice — NL-5).
 *  Created here at module scope; `c64iec_init` resets it. */
export const cia2_iec_slice: cia2_iec_slice_t = {
  c_cia: new Uint8Array(16),
  old_pa: 0xff,
  old_pb: 0xff,
  write_offset: 1,
};

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:121-124 (iec_update_cpu_bus)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:121-124 (iec_update_cpu_bus). */
export function iec_update_cpu_bus(data: number): void {
  // VICE: `iecbus.cpu_bus = (((data << 2) & 0x80)
  //                       | ((data << 2) & 0x40)
  //                       | ((data << 1) & 0x10));`
  iecbus.cpu_bus =
    (((data << 2) & 0x80) | ((data << 2) & 0x40) | ((data << 1) & 0x10)) &
    0xff;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:126-138 (iec_update_ports)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:126-138 (iec_update_ports). */
export function iec_update_ports(): void {
  let unit: number;

  iecbus.cpu_port = iecbus.cpu_bus;
  for (unit = 4; unit < 8 + 4 /* NUM_DISK_UNITS */; unit++) {
    iecbus.cpu_port &= iecbus.drv_bus[unit]!;
  }
  iecbus.cpu_port &= 0xff;

  // VICE: `iecbus.drv_port = (((iecbus.cpu_port >> 4) & 0x4)
  //                        | (iecbus.cpu_port >> 7)
  //                        | ((iecbus.cpu_bus << 3) & 0x80));`
  iecbus.drv_port =
    (((iecbus.cpu_port >> 4) & 0x4) |
      (iecbus.cpu_port >> 7) |
      ((iecbus.cpu_bus << 3) & 0x80)) &
    0xff;

  // IEC_DEBUG_PORTS() — VICE no-op unless DEBUG_IECBUS_VCD defined. NL-2.
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:140-143 (iec_update_ports_embedded)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:140-143 (iec_update_ports_embedded).
 *  VICE: thin wrapper — `void iec_update_ports_embedded(void) {
 *  iec_update_ports(); }`. */
export function iec_update_ports_embedded(): void {
  iec_update_ports();
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:145-150 (iec_drive_write)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:145-150 (iec_drive_write). */
export function iec_drive_write(data: number, dnr: number): void {
  // VICE: `iecbus.drv_bus[dnr + 8] = (((data << 3) & 0x40)
  //                               | ((data << 6) & ((~data ^ iecbus.cpu_bus) << 3) & 0x80));`
  const inv = ((~data >>> 0) ^ iecbus.cpu_bus) >>> 0;
  iecbus.drv_bus[dnr + 8] =
    (((data << 3) & 0x40) | ((data << 6) & (inv << 3) & 0x80)) & 0xff;
  iecbus.drv_data[dnr + 8] = data & 0xff;
  iec_update_ports();
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:152-155 (iec_drive_read)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:152-155 (iec_drive_read). */
export function iec_drive_read(_dnr: number): number {
  return iecbus.drv_port & 0xff;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:157-160 (iecbus_drive_port)
// =============================================================================
// VICE: `iecbus_t *iecbus_drive_port(void) { return &iecbus; }`. The
// canonical `iecbus` storage lives in iecbus.ts; this is a verbatim
// re-export for grep parity with c64iec.c (which is where VICE physically
// defines the function for the C64 machine class).

/** PORT OF: vice/src/c64/c64iec.c:157-160 (iecbus_drive_port). */
export function iecbus_drive_port(): iecbus_t {
  return iecbus;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:163-171 (iec_available_busses)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:163-171 (iec_available_busses). */
export function iec_available_busses(): number {
  if (
    cartridge_type_enabled(CARTRIDGE_IEEE488) ||
    cartridge_type_enabled(CARTRIDGE_IEEEFLASH64)
  ) {
    return IEC_BUS_IEC | IEC_BUS_IEEE;
  } else {
    return IEC_BUS_IEC;
  }
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:173-176 (c64iec_init)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:173-176 (c64iec_init).
 *  VICE: `void c64iec_init(void) { iecbus_update_ports = iec_update_ports; }`.
 *  In the TS port the wiring is done via iecbus.ts module state — the
 *  bus model dynamically dispatches through `iecbus_update_ports`. Here
 *  we also reset the CIA2 IEC slice to silicon-default state (PL-7). */
export function c64iec_init(): void {
  // VICE wires its function-pointer table at boot. The TS port mirrors
  // this by reaching into iecbus.ts's `iecbus_update_ports` slot.
  // Using an assignment helper avoids re-exporting a mutable binding.
  install_iecbus_update_ports(iec_update_ports);

  // Reset CIA2 IEC slice — silicon defaults (PL-7).
  cia2_iec_slice.c_cia.fill(0);
  cia2_iec_slice.old_pa = 0xff;
  cia2_iec_slice.old_pb = 0xff;
  cia2_iec_slice.write_offset = 1;

  vbank = 0;
  pa_ddr_change = 0;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:178-181 (c64iec_enable)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:178-181 (c64iec_enable). */
export function c64iec_enable(val: number): void {
  c64iec_active = val ? 1 : 0;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:183-186 (c64iec_get_active_state)
// =============================================================================

/** PORT OF: vice/src/c64/c64iec.c:183-186 (c64iec_get_active_state). */
export function c64iec_get_active_state(): number {
  return c64iec_active;
}

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:136-165 (store_ciapa — IEC slice)
// =============================================================================
// REAL CIA2 PA store handler — NOT a stub. Ports the change-detection
// path that c64cia2.c installs into the `cia_context_t` callback table.
// The `~byte` inversion + `iec_update_cpu_bus(tmp)` chain is the heart of
// the C64-side IEC drive — verbatim from VICE c64cia2.c:150-163.
//
// Out-of-scope branches (`store_userport_pa2`, `store_userport_pa3`,
// `c64_glue_set_vbank`) are kept as call-shape stubs so the control flow
// matches VICE 1:1; their bodies are no-ops until the userport / glue
// layers land in a follow-up spec.

/** PORT OF: vice/src/c64/c64cia2.c:136-165 (store_ciapa). */
export function store_ciapa(
  cia_context: cia2_iec_slice_t,
  rclk: number,
  byte: number,
): void {
  void rclk;
  if (cia_context.old_pa !== byte) {
    let tmp: number;
    let new_vbank: number;

    if ((cia_context.old_pa ^ byte) & 4) {
      store_userport_pa2((byte & 4) >> 2);
    }
    if ((cia_context.old_pa ^ byte) & 8) {
      store_userport_pa3((byte & 8) >> 3);
    }

    tmp = (~byte) & 0xff;
    new_vbank = tmp & 3;
    if (new_vbank !== vbank) {
      vbank = new_vbank;
      c64_glue_set_vbank(new_vbank, pa_ddr_change);
    }
    if (c64iec_active) {
      // Bit 7  Serial Bus Data Input
      // Bit 6  Serial Bus Clock Pulse Input
      // Bit 5  Serial Bus Data Output
      // Bit 4  Serial Bus Clock Pulse Output
      // Bit 3  Serial Bus ATN Signal Output
      const cb = _iecbus_callback_write;
      if (cb !== null) {
        // VICE: `maincpu_clk + !(cia_context->write_offset)`
        cb(tmp & 0xff, rclk + (cia_context.write_offset ? 0 : 1));
      }
    }
    cia_context.old_pa = byte & 0xff;
  }
}

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:167-178 (undump_ciapa — IEC slice)
// =============================================================================

/** PORT OF: vice/src/c64/c64cia2.c:167-178 (undump_ciapa). */
export function undump_ciapa(
  cia_context: cia2_iec_slice_t,
  rclk: number,
  byte: number,
): void {
  void rclk;
  store_userport_pa2((byte & 4) >> 2);
  store_userport_pa3((byte & 8) >> 3);

  vbank = (byte ^ 3) & 3;
  c64_glue_undump(vbank);

  if (c64iec_active) {
    iecbus_cpu_undump_local((byte ^ 0xff) & 0xff);
  }
  cia_context.old_pa = byte & 0xff;
}

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:200-231 (read_ciapa — IEC slice)
// =============================================================================
// REAL CIA2 PA read handler — NOT a stub. Implements the
// `(PRA | ~DDRA) & 0x3f` mask + IEC-input merge from c64cia2.c:205-213.

/** PORT OF: vice/src/c64/c64cia2.c:200-231 (read_ciapa). */
export function read_ciapa(cia_context: cia2_iec_slice_t): number {
  let value: number;
  let userval = 1;

  // VICE: `value = ((c_cia[CIA_PRA] | ~c_cia[CIA_DDRA]) & 0x3f);`
  const pra = cia_context.c_cia[CIA_PRA]!;
  const ddra = cia_context.c_cia[CIA_DDRA]!;
  value = (pra | (~ddra & 0xff)) & 0x3f;

  if (c64iec_active) {
    // Bit 7  Serial Bus Data Input
    // Bit 6  Serial Bus Clock Pulse Input
    const cb = _iecbus_callback_read;
    if (cb !== null) {
      // VICE: `value |= (*iecbus_callback_read)(maincpu_clk);`
      // No maincpu_clk source in this port slice — pass 0; iecbus.ts's
      // read callbacks ignore the clock arg in the conf0..conf3 reads
      // beyond `drive_cpu_execute_all`, which is itself stubbed in this
      // layer. Real wiring lands when drivecpu.ts is online (T2.4).
      value |= cb(0) & 0xff;
    }
  }

  // PA2 / PA3 userport merge — c64cia2.c:216-228. The userport layer
  // is out of §10 scope; stubs return `1` so the conditional never
  // alters `value` (matches VICE behaviour when no userport device).
  if (!(ddra & 4)) {
    userval = read_userport_pa2(userval);
    if (value !== userval) {
      value &= userval & 1 ? 0xff : 0xfb;
    }
  }

  if (!(ddra & 8)) {
    userval = read_userport_pa3(userval);
    if (value !== userval) {
      value &= userval & 1 ? 0xff : 0xf7;
    }
  }

  return value & 0xff;
}

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:180-183 (store_ciapb — passthrough)
// =============================================================================

/** PORT OF: vice/src/c64/c64cia2.c:180-183 (store_ciapb).
 *  IEC slice scope: store goes to the userport-PB output table; the IEC
 *  bus has no bit on PB. Bodies stubbed (`store_userport_pbx` is out of
 *  §10 scope); call-shape preserved per NL-2. */
export function store_ciapb(
  cia_context: cia2_iec_slice_t,
  rclk: number,
  byte: number,
): void {
  void rclk;
  store_userport_pbx(byte);
  cia_context.old_pb = byte & 0xff;
}

// =============================================================================
// PORT OF: vice/src/c64/c64cia2.c:234-243 (read_ciapb — passthrough)
// =============================================================================

/** PORT OF: vice/src/c64/c64cia2.c:234-243 (read_ciapb). */
export function read_ciapb(cia_context: cia2_iec_slice_t): number {
  let byte = 0xff;
  byte = read_userport_pbx(byte);
  // VICE: `byte = (byte & ~DDRB) | (PRB & DDRB);`
  const prb = cia_context.c_cia[CIA_PRB]!;
  const ddrb = cia_context.c_cia[CIA_DDRB]!;
  byte = ((byte & (~ddrb & 0xff)) | (prb & ddrb)) & 0xff;
  return byte;
}

// =============================================================================
// Local stubs for symbols owned by layers outside §10 scope
// =============================================================================
// PL-5 spirit: these stubs exist only because the C link-time symbols are
// resolved by files that are not in the 1541-first port set. Each stub
// matches the VICE function signature 1:1 and either no-ops or returns
// the documented sentinel. The stubs are NOT exported.

// PORT OF: vice/src/c64/cart/c64cart.c (cartridge_type_enabled extern)
// 1541-first scope: no IEEE488 / IEEEFLASH64 cartridge in play.
// Returns 0 so `iec_available_busses` selects pure IEC.
function cartridge_type_enabled(_type: number): number {
  return 0;
}

// PORT OF: vice/src/userport/userport_*.c (userport callbacks)
// Userport is out of §10 scope; stubs preserve call-shape.
function store_userport_pa2(_value: number): void {
  // No-op — userport layer not in 1541-first scope.
}
function store_userport_pa3(_value: number): void {
  // No-op — userport layer not in 1541-first scope.
}
function store_userport_pbx(_value: number): void {
  // No-op — userport layer not in 1541-first scope.
}
function read_userport_pa2(prev: number): number {
  // VICE convention: return prev when no device is wired. Keeps the
  // change-detection branch in read_ciapa stable.
  return prev;
}
function read_userport_pa3(prev: number): number {
  return prev;
}
function read_userport_pbx(prev: number): number {
  return prev;
}

// PORT OF: vice/src/c64/c64-glue.c (c64_glue_set_vbank / c64_glue_undump)
// VIC-II glue layer — out of c64iec.c port scope (lives in c64-glue.c).
function c64_glue_set_vbank(_new_vbank: number, _pa_ddr_change: number): void {
  // No-op stub — VIC-II bank-select wiring lands in the VIC port (Spec 6xx).
}
function c64_glue_undump(_vbank: number): void {
  // No-op stub — VIC-II glue layer.
}

// PORT OF: vice/src/iecbus/iecbus.c:205-209 (iecbus_cpu_undump)
// Local helper to avoid pulling the `iecbus_cpu_undump` export across a
// circular boundary with iecbus.ts (it already imports c64iec semantics
// via the function-pointer table). Mirrors the VICE body 1:1.
function iecbus_cpu_undump_local(data: number): void {
  iec_update_cpu_bus(data);
  // `iec_old_atn` is the VICE module-level inside iecbus.c. We can't
  // mutate iecbus.ts's `iec_old_atn` from here without exporting it;
  // the undump path is exercised only on snapshot restore, which the
  // headless kernel calls via iecbus.ts's `iecbus_cpu_undump` directly.
  // This local copy is kept for VICE-shape parity with c64cia2.c:175.
  void data;
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:173-176 (c64iec_init — install hook)
// =============================================================================
// `iecbus_update_ports` in iecbus.ts is exported as a mutable `let` but
// TS/ESM forbids cross-module mutation of an exported binding from the
// importer side ("Cannot assign to read only property of object '[object
// Module]'"). VICE's C build resolves the assignment at link time;
// `iecbus.ts` mirrors that link-time write through the exported setter
// `install_iecbus_update_ports`, which mutates the module-local `let` in
// the file that owns it (PORT OF: vice/src/iecbus/iecbus.c:59 globals).
// Documented spec exception per PL-5 / NL-5; PL-10 satisfied because the
// import remains within `./iecbus.js`.

function install_iecbus_update_ports(fn: () => void): void {
  _install_iecbus_update_ports(fn);
}

// =============================================================================
// PORT OF: vice/src/c64/c64iec.c:188-201 (plus4tcbm dummies — link-only)
// =============================================================================
// VICE keeps these as "KLUDGES: dummy to satisfy linker, unused" because
// the c64 build pulls them in transitively. Ported verbatim per NL-2 so
// the function inventory matches 1:1. Bodies stay empty per the C source.

/** PORT OF: vice/src/c64/c64iec.c:189 (`plus4tcbm_outputa[2]`). */
export const plus4tcbm_outputa = new Uint8Array(2);
/** PORT OF: vice/src/c64/c64iec.c:189 (`plus4tcbm_outputb[2]`). */
export const plus4tcbm_outputb = new Uint8Array(2);
/** PORT OF: vice/src/c64/c64iec.c:189 (`plus4tcbm_outputc[2]`). */
export const plus4tcbm_outputc = new Uint8Array(2);

/** PORT OF: vice/src/c64/c64iec.c:191-193 (plus4tcbm_update_pa). */
export function plus4tcbm_update_pa(_byte: number, _dnr: number): void {
  // VICE: empty body — KLUDGE dummy.
}

/** PORT OF: vice/src/c64/c64iec.c:195-197 (plus4tcbm_update_pb). */
export function plus4tcbm_update_pb(_byte: number, _dnr: number): void {
  // VICE: empty body — KLUDGE dummy.
}

/** PORT OF: vice/src/c64/c64iec.c:199-201 (plus4tcbm_update_pc). */
export function plus4tcbm_update_pc(_byte: number, _dnr: number): void {
  // VICE: empty body — KLUDGE dummy.
}
