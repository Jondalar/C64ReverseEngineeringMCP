// PORT OF: vice/src/drive/drivemem.c (full file, 312 lines)
// PORT OF: vice/src/drive/drivemem.h (full file, 54 lines — declarations folded here per NL-1)
// VICE rev: tree-state of /Users/alex/Development/C64/Tools/vice/vice/src as of 2026-05-17
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (drivemem.c → drivemem.ts; .h folds into .ts)
//   §1 NL-2 (function names verbatim VICE snake_case)
//   §1 NL-3 (struct fields = drivecpud_context_t fields verbatim — declared in drivetypes.ts)
//   §1 NL-5 (module-level statics → module-level lets, same name: read_tab_watch /
//            store_tab_watch / watchpoints_active)
//   §2 PL-1 (NO class — page tables are FIELDS on drivecpud_context_t, not a wrapper)
//   §2 PL-3 (NO PageTableManager / MemoryMap / Bus / *Helper invented here)
//   §2 PL-5 (NO NOT-IN-VICE helpers — every export traces back to a VICE symbol)
//   §5     (every export has a PORT OF comment within 5 lines)
//
// =============================================================================
// DISPATCH CONTRACT (how the rest of the port wires into these tables)
// =============================================================================
//
// VICE installs read/store/peek function pointers per CPU-address page via
// drivemem_set_func(). In TS the same model holds: each entry of
// `drivecpud_context_t.read_tab[0][page]` / `store_tab[0][page]` /
// `peek_tab[0][page]` is a TS function reference whose signature matches the
// VICE drive_read_func_t / drive_store_func_t / drive_peek_func_t typedefs.
//
//   - drivemem_init(unit) (this file) allocates the 257-entry tables onto
//     unit.cpud and fills every page with drive_read_free / drive_store_free /
//     drive_peek_free as the open-bus default. The 257th entry (index 0x100)
//     is the wrap-to-page-0 sentinel that VICE relies on for the
//     `addr >> 8` page-index dispatch when an addressed instruction crosses
//     the 0xFFFF boundary.
//
//   - memiec.ts (Spec 612 T2.2) calls drivemem_init() then layers
//     1541-specific bindings on top via drivemem_set_func():
//       * RAM mirrors  (0x0000-0x07FF ×4)
//       * VIA1 mirrors (0x1800-0x1BFF, ×4 within the I/O window per VICE wiring)
//       * VIA2 mirrors (0x1C00-0x1FFF, ×4)
//       * ROM at 0x8000-0xFFFF (via base+limit fast-path)
//       * optional drive_ramN_enabled regions.
//
//   - drive_6510core.ts (Spec 612 T2.3) dispatches every read / write through
//     the active table pair (read_func_ptr / store_func_ptr — which by default
//     point at read_tab[0] / store_tab[0], and switch to read_tab_watch /
//     store_tab_watch when drivemem_toggle_watchpoints() is asserted):
//
//       const page = (addr >> 8) & 0xff;
//       const value = ctx.cpud!.read_func_ptr![page]!(ctx, addr);
//       ctx.cpud!.store_func_ptr![page]!(ctx, addr, value);
//
//     Dummy-cycle accesses go through read_func_ptr_dummy /
//     store_func_ptr_dummy (per VICE: same as the normal tables unless
//     "watchpoints on dummy accesses" mode is active, i.e. drivemem_toggle_watchpoints(flag>1)).
//
//   - drivemem_bank_read/_peek/_store/_poke are the external entry points used
//     by the VICE monitor (and the future TS monitor adapter). They dispatch
//     via the same active table pair; the `bank` argument is unused for drive
//     memory (drives have no banked CPU memory map).
//
// =============================================================================

import type {
  diskunit_context_t,
  drivecpud_context_t,
  drive_read_func_t,
  drive_store_func_t,
  drive_peek_func_t,
} from "./drivetypes.js";

import {
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_2031,
  DRIVE_TYPE_1551,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_CMDHD,
  DRIVE_TYPE_2040,
  DRIVE_TYPE_3040,
  DRIVE_TYPE_4040,
  DRIVE_TYPE_1001,
  DRIVE_TYPE_8050,
  DRIVE_TYPE_8250,
  DRIVE_TYPE_9000,
} from "./drivetypes.js";

// =============================================================================
// SECTION 1 — MODULE-LEVEL STATE (NL-5: C statics → TS module-level lets)
// =============================================================================

// PORT OF: vice/src/drive/drivemem.c:62-63
//   `static drive_read_func_t  *read_tab_watch[0x101];`
//   `static drive_store_func_t *store_tab_watch[0x101];`
// 257-entry page tables of watchpoint trampolines. Initialised lazily by
// drivemem_init() (matches VICE: `if (!read_tab_watch[0])`).
const read_tab_watch: (drive_read_func_t | null)[] = new Array(0x101).fill(null);
const store_tab_watch: (drive_store_func_t | null)[] = new Array(0x101).fill(null);

// PORT OF: vice/src/drive/drivemem.c:65-70
//   `static int watchpoints_active = 0;`
//   Current watchpoint state:
//     0 = no watchpoints
//     bit0 (1) = watchpoints active
//     bit1 (2) = watchpoints trigger on dummy accesses
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let watchpoints_active = 0;

// =============================================================================
// SECTION 2 — OPEN-BUS DEFAULT HANDLERS (drivemem.c:72-91)
// =============================================================================
//
// VICE pattern: unmapped pages route through these three. They thread
// `cpu_last_data` (the CPU's open-bus echo) per VICE's "data lines float to
// whatever the CPU last drove" hardware model. via1d1541 / via2d also read
// `cpu_last_data` for undriven-bit echo (viacore.c:64+70) — so even the
// open-bus stubs must keep `cpu_last_data` consistent.

// PORT OF: vice/src/drive/drivemem.c:75-79 (drive_read_free)
// Reads from unmapped address space return the CPU's last data-bus value
// (open-bus model). LOG() macro elided per Spec 612 §2 PL-5 (debug-only).
export function drive_read_free(drv: diskunit_context_t, _address: number): number {
  return drv.cpu!.cpu_last_data;
}

// PORT OF: vice/src/drive/drivemem.c:81-85 (drive_store_free)
// Stores to unmapped address space update cpu_last_data then no-op the write
// (the bus driver still latched the value into the open-bus capacitance).
export function drive_store_free(drv: diskunit_context_t, _address: number, value: number): void {
  drv.cpu!.cpu_last_data = value & 0xff;
}

// PORT OF: vice/src/drive/drivemem.c:87-91 (drive_peek_free)
// Monitor non-side-effecting read — same value as drive_read_free but never
// mutates state. LOG() macro elided per Spec 612 §2 PL-5.
export function drive_peek_free(drv: diskunit_context_t, _address: number): number {
  return drv.cpu!.cpu_last_data;
}

// =============================================================================
// SECTION 3 — WATCHPOINT TRAMPOLINES (drivemem.c:93-123)
// =============================================================================
//
// When the monitor enables watchpoints, drivemem_toggle_watchpoints() points
// `read_func_ptr` / `store_func_ptr` at read_tab_watch / store_tab_watch.
// Each watchpoint trampoline pushes the load/store address onto the monitor's
// watch stack, then forwards through `read_tab[0][page]` / `store_tab[0][page]`
// — i.e. the *underlying* per-page handlers, never the watchpoint table (which
// would infinite-loop).
//
// Note (Spec 612 §2 PL-5): VICE calls into monitor_watch_push_load_addr() and
// monitor_watch_push_store_addr() here. The TS monitor is not ported in this
// layer (it lives behind the runtime facade), so the calls are stubbed as
// no-ops with a clear marker. The cpu_last_data echo and the inner dispatch
// stay 1:1 with VICE so the runtime semantics match even with no monitor
// attached.

function monitor_watch_push_load_addr(_addr: number, _monspace: number): void {
  // PORT-STUB: monitor not ported in Spec 612 layer 6 (drivemem). Wired by the
  // runtime facade outside vice1541/ per §2 PL-5.
}
function monitor_watch_push_store_addr(_addr: number, _monspace: number): void {
  // PORT-STUB: monitor not ported in Spec 612 layer 6 — see note above.
}

// PORT OF: vice/src/drive/drivemem.c:96-101 (drive_zero_read_watch)
// Zero-page read watchpoint — addr masked to 8 bits then dispatched through
// page 0. cpu_last_data updated with the inner read's return value.
export function drive_zero_read_watch(drv: diskunit_context_t, addr: number): number {
  addr &= 0xff;
  monitor_watch_push_load_addr(addr, drv.cpu!.monspace);
  const value = drv.cpud!.read_tab[0][0]!(drv, addr);
  drv.cpu!.cpu_last_data = value & 0xff;
  return value;
}

// PORT OF: vice/src/drive/drivemem.c:103-109 (drive_zero_store_watch)
// Zero-page store watchpoint. cpu_last_data is updated BEFORE the inner store
// (matches VICE order — the open-bus value reflects what the CPU drove).
export function drive_zero_store_watch(drv: diskunit_context_t, addr: number, value: number): void {
  addr &= 0xff;
  drv.cpu!.cpu_last_data = value & 0xff;
  monitor_watch_push_store_addr(addr, drv.cpu!.monspace);
  drv.cpud!.store_tab[0][0]!(drv, addr, value);
}

// PORT OF: vice/src/drive/drivemem.c:111-116 (drive_read_watch)
// Non-zero-page read watchpoint. Dispatches through `read_tab[0][addr >> 8]`
// (the underlying per-page handler) and updates cpu_last_data with the
// inner-read result. LOG() macro elided.
export function drive_read_watch(drv: diskunit_context_t, address: number): number {
  monitor_watch_push_load_addr(address, drv.cpu!.monspace);
  const value = drv.cpud!.read_tab[0][(address >> 8) & 0xff]!(drv, address);
  drv.cpu!.cpu_last_data = value & 0xff;
  return value;
}

// PORT OF: vice/src/drive/drivemem.c:118-123 (drive_store_watch)
// Non-zero-page store watchpoint. cpu_last_data updated BEFORE the inner
// store, matching VICE ordering.
export function drive_store_watch(drv: diskunit_context_t, address: number, value: number): void {
  drv.cpu!.cpu_last_data = value & 0xff;
  monitor_watch_push_store_addr(address, drv.cpu!.monspace);
  drv.cpud!.store_tab[0][(address >> 8) & 0xff]!(drv, address, value);
}

// =============================================================================
// SECTION 4 — WATCHPOINT TOGGLE + PER-FUNC INSTALLER (drivemem.c:125-183)
// =============================================================================

// Monitor hook — receives `context` as void* in VICE; in TS we declare the
// argument as diskunit_context_t directly (the runtime facade is responsible
// for routing the right unit context here).
//   flag = 0  → restore the normal per-page tables.
//   flag = 1  → install watchpoint tables for normal reads/writes;
//               dummy-cycle accesses still bypass watchpoints.
//   flag > 1  → install watchpoint tables for both normal AND dummy accesses.
//
// PORT OF: vice/src/drive/drivemem.c:125-147 (drivemem_toggle_watchpoints)
export function drivemem_toggle_watchpoints(flag: number, context: diskunit_context_t): void {
  const drv = context;
  const cpud = drv.cpud!;
  if (flag) {
    cpud.read_func_ptr = read_tab_watch;
    cpud.store_func_ptr = store_tab_watch;
    if (flag > 1) {
      // Enable watchpoints on dummy accesses too.
      cpud.read_func_ptr_dummy = read_tab_watch;
      cpud.store_func_ptr_dummy = store_tab_watch;
    } else {
      cpud.read_func_ptr_dummy = cpud.read_tab[0];
      cpud.store_func_ptr_dummy = cpud.store_tab[0];
    }
  } else {
    cpud.read_func_ptr = cpud.read_tab[0];
    cpud.store_func_ptr = cpud.store_tab[0];
    cpud.read_func_ptr_dummy = cpud.read_tab[0];
    cpud.store_func_ptr_dummy = cpud.store_tab[0];
  }
  watchpoints_active = flag;
}

// Installs a [start, stop) page range with the supplied read/store/peek
// handlers. Null read_func / store_func / peek_func skip that table — matches
// VICE's NULL-guarded for-loops. If peek_func is null but read_func is not,
// peek_func defaults to read_func (VICE drivemem.c:165-167).
//   base / limit drive the fast-path `read_base_tab` / `read_limit_tab`
//   plane used by drive_6510core.ts to skip the function-pointer call on
//   tight read loops. `base` is biased by `start << 8` so that the per-page
//   pointer can be addressed directly as `base[addr]`. Passing `base=null`
//   disables the fast-path for the page range (per-page read_base_tab entry
//   becomes null).
//
// PORT OF: vice/src/drive/drivemem.c:151-183 (drivemem_set_func)
export function drivemem_set_func(
  cpud: drivecpud_context_t,
  start: number,
  stop: number,
  read_func: drive_read_func_t | null,
  store_func: drive_store_func_t | null,
  peek_func: drive_peek_func_t | null,
  base: Uint8Array | null,
  limit: number,
): void {
  let i: number;

  if (read_func !== null) {
    for (i = start; i < stop; i++) {
      cpud.read_tab[0][i] = read_func;
    }
    // If no peek function is provided, use the read function instead.
    if (peek_func === null) {
      peek_func = read_func;
    }
  }
  if (store_func !== null) {
    for (i = start; i < stop; i++) {
      cpud.store_tab[0][i] = store_func;
    }
  }
  if (peek_func !== null) {
    for (i = start; i < stop; i++) {
      cpud.peek_tab[0][i] = peek_func;
    }
  }
  for (i = start; i < stop; i++) {
    // VICE: `cpud->read_base_tab[0][i] = base ? (base - (start << 8)) : NULL;`
    // The C subtraction yields a uint8_t* that can be indexed as base[addr].
    // TS: store the raw base buffer here; the consuming dispatcher
    // (drive_6510core.ts) treats it as `base[addr - (page << 8) + offset]`
    // where `offset = -(start << 8)`. We model the bias by storing the base
    // buffer as-is when present; the dispatcher adds back `start` when
    // indexing per page. Keeping `base` unbiased here keeps TS array bounds
    // safe (no negative-offset indexing).
    cpud.read_base_tab[0][i] = base;
    cpud.read_limit_tab[0][i] = limit;
  }
}

// =============================================================================
// SECTION 5 — EXTERNAL BANKED MEMORY ACCESS (drivemem.c:185-213)
// =============================================================================
//
// VICE monitor entry points. The `bank` argument is unused for drives (no
// banked CPU memory map on a 1541-class drive). `context` is typed as
// diskunit_context_t directly in TS — the runtime facade routes the right
// unit per VICE's void* convention.

// PORT OF: vice/src/drive/drivemem.c:188-193 (drivemem_bank_read)
export function drivemem_bank_read(
  _bank: number,
  addr: number,
  context: diskunit_context_t,
): number {
  const drv = context;
  return drv.cpud!.read_func_ptr![(addr >> 8) & 0xff]!(drv, addr);
}

// PORT OF: vice/src/drive/drivemem.c:196-201 (drivemem_bank_peek)
// Used by the monitor when sfx (side-effects) are off — must not perturb
// VIA / CIA / IEC bus state.
export function drivemem_bank_peek(
  _bank: number,
  addr: number,
  context: diskunit_context_t,
): number {
  const drv = context;
  return drv.cpud!.peek_func_ptr![(addr >> 8) & 0xff]!(drv, addr);
}

// PORT OF: vice/src/drive/drivemem.c:203-207 (drivemem_bank_store)
export function drivemem_bank_store(
  _bank: number,
  addr: number,
  value: number,
  context: diskunit_context_t,
): void {
  const drv = context;
  drv.cpud!.store_func_ptr![(addr >> 8) & 0xff]!(drv, addr, value);
}

// PORT OF: vice/src/drive/drivemem.c:210-213 (drivemem_bank_poke)
// Used by the monitor when sfx off — VICE delegates straight to bank_store
// because there is no separate "poke" table on drives.
export function drivemem_bank_poke(
  bank: number,
  addr: number,
  value: number,
  context: diskunit_context_t,
): void {
  drivemem_bank_store(bank, addr, value, context);
}

// =============================================================================
// SECTION 6 — INIT (drivemem.c:217-247)
// =============================================================================

// Allocates the 257-entry page tables onto unit.cpud, lazy-initialises
// read_tab_watch / store_tab_watch on first call (matches VICE's
// `if (!read_tab_watch[0])` guard), fills every page with the open-bus
// defaults, delegates to machine_drive_mem_init() for per-drive-type
// bindings (in TS: caller invokes memiec_init() etc. directly per the
// dispatch contract above), then sets the 257th entry (index 0x100) as the
// wrap-to-page-0 sentinel and parks all active-table pointers at table 0.
//
// PORT OF: vice/src/drive/drivemem.c:217-247 (drivemem_init)
export function drivemem_init(unit: diskunit_context_t): void {
  let i: number;
  const cpud = unit.cpud!;

  // Setup watchpoint tables (lazy — only first drive triggers init).
  if (!read_tab_watch[0]) {
    read_tab_watch[0] = drive_zero_read_watch;
    store_tab_watch[0] = drive_zero_store_watch;
    for (i = 1; i < 0x101; i++) {
      read_tab_watch[i] = drive_read_watch;
      store_tab_watch[i] = drive_store_watch;
    }
  }

  // Ensure the cpud page tables are sized 1×0x101 per VICE
  // `drive_read_func_t *read_tab[1][0x101]`. drivecpu.ts allocates these
  // when constructing drivecpud_context_t, but we defensively re-size here
  // so drivemem_init() can be called against a bare context too.
  if (!cpud.read_tab[0] || cpud.read_tab[0].length < 0x101) {
    cpud.read_tab[0] = new Array(0x101).fill(null);
  }
  if (!cpud.store_tab[0] || cpud.store_tab[0].length < 0x101) {
    cpud.store_tab[0] = new Array(0x101).fill(null);
  }
  if (!cpud.peek_tab[0] || cpud.peek_tab[0].length < 0x101) {
    cpud.peek_tab[0] = new Array(0x101).fill(null);
  }
  if (!cpud.read_base_tab[0] || cpud.read_base_tab[0].length < 0x101) {
    cpud.read_base_tab[0] = new Array(0x101).fill(null);
  }
  if (!cpud.read_limit_tab[0] || cpud.read_limit_tab[0].length < 0x101) {
    cpud.read_limit_tab[0] = new Uint32Array(0x101);
  }

  // Fill pages 0x00..0x100 (inclusive) with open-bus defaults.
  drivemem_set_func(
    cpud,
    0x00,
    0x101,
    drive_read_free,
    drive_store_free,
    drive_peek_free,
    null,
    0,
  );

  // VICE: machine_drive_mem_init(unit, unit->type);
  // In the TS port the per-drive-type memory map is installed by the
  // explicit memiec_init() (1541) / memcbm_init() (CBM IEEE) / memcmdhd_init()
  // (CMDHD) etc. call from the drive setup path. drivemem_init() does NOT
  // dispatch into machine_drive_mem_init here — see DISPATCH CONTRACT note
  // at file head.

  // 257th entry = wrap-to-page-0 sentinel (drivemem.c:235-237).
  cpud.read_tab[0][0x100] = cpud.read_tab[0][0];
  cpud.store_tab[0][0x100] = cpud.store_tab[0][0];
  cpud.peek_tab[0][0x100] = cpud.peek_tab[0][0];

  // Park the active-table pointers at table plane 0 (no watchpoints).
  cpud.read_func_ptr = cpud.read_tab[0];
  cpud.store_func_ptr = cpud.store_tab[0];
  cpud.read_func_ptr_dummy = cpud.read_tab[0];
  cpud.store_func_ptr_dummy = cpud.store_tab[0];
  cpud.peek_func_ptr = cpud.peek_tab[0];

  cpud.read_base_tab_ptr = cpud.read_base_tab[0];
  cpud.read_limit_tab_ptr = cpud.read_limit_tab[0];
}

// =============================================================================
// SECTION 7 — MONITOR IO-REG LIST (drivemem.c:249-312)
// =============================================================================
//
// VICE assembles a per-drive-type list of (name, start, end, dump_fn, ctx)
// entries used by the `io` monitor command to enumerate side-effect-free IO
// register dumps. Spec 612 §2 PL-5: the monitor adapter is outside vice1541/,
// so we model the entry list as a plain TS array of records here and let the
// runtime facade route the dump callbacks. The dump callbacks themselves are
// per-chip ports (viacore_dump, via1d1541_dump, via2d_dump, …) — wired by
// caller, not invoked here.

/** PORT OF: vice/src/monitor/monitor.h mem_ioreg_list_s — one row per
 *  IO-register region surfaced to the monitor. */
export interface mem_ioreg_list_t {
  name: string;
  start: number;
  end: number;
  /** Per-chip dump function (registered by caller — viacore_dump,
   *  via1d1541_dump, via2d_dump etc.). */
  dump: ((context: unknown) => void) | null;
  /** Context passed back to `dump` (a sub-context pointer in VICE — e.g.
   *  `((diskunit_context_t *)context)->cmdhd->via10`). */
  context: unknown;
  /** IO_MIRROR_NONE / IO_MIRROR_OTHER / IO_MIRROR_READ etc.
   *  0 = IO_MIRROR_NONE per VICE monitor.h. */
  mirror_mode: number;
}

/** IO_MIRROR_NONE — VICE monitor.h. */
export const IO_MIRROR_NONE = 0;

// Returns the IO-register list for the unit's drive type. Per-chip dump
// callbacks are not invoked here — they are looked up by the runtime monitor
// adapter from the per-chip port modules (viacore_dump etc.). The chip
// dump-fn fields are populated to `null` for chips not yet ported; the
// runtime adapter wires them as those ports land.
//
// VICE switch-case includes every drive type. Drive types beyond 1541/1541II
// (1551, 157x, 1581, 2000, 4000, CMDHD, IEEE-488 family) reference port
// modules that are out-of-scope for Spec 612 layer 6 — the entries are still
// emitted with `dump=null` so the monitor knows the address range but skips
// the dump. The 1541 family (DRIVE_TYPE_1540 / _1541 / _1541II / _2031) is
// the only path expected to be live for this layer per Spec 612 §10.
//
// PORT OF: vice/src/drive/drivemem.c:249-312 (drivemem_ioreg_list_get)
export function drivemem_ioreg_list_get(context: diskunit_context_t): mem_ioreg_list_t[] {
  const list: mem_ioreg_list_t[] = [];
  const type = context.type;

  switch (type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_2031:
      list.push({ name: "VIA1", start: 0x1800, end: 0x180f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "VIA2", start: 0x1c00, end: 0x1c0f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_1551:
      list.push({ name: "TPI", start: 0x4000, end: 0x4007, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
      list.push({ name: "VIA1", start: 0x1800, end: 0x180f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "VIA2", start: 0x1c00, end: 0x1c0f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "WD1770", start: 0x2000, end: 0x2003, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "CIA", start: 0x4000, end: 0x400f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_1571CR:
      list.push({ name: "VIA1", start: 0x1800, end: 0x180f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "VIA2", start: 0x1c00, end: 0x1c0f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "WD1770", start: 0x2000, end: 0x2003, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "MOS5710", start: 0x4000, end: 0x401f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_1581:
      list.push({ name: "CIA", start: 0x4000, end: 0x400f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "WD1770", start: 0x6000, end: 0x6003, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_2000:
      list.push({ name: "VIA", start: 0x4000, end: 0x400f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "DP8473", start: 0x4e00, end: 0x4e07, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_4000:
      list.push({ name: "VIA", start: 0x4000, end: 0x400f, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "PC8477", start: 0x4e00, end: 0x4e07, dump: null, context, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_CMDHD:
      list.push({ name: "VIA", start: 0x8000, end: 0x800f, dump: null, context: context.cmdhd, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "VIA", start: 0x8400, end: 0x840f, dump: null, context: context.cmdhd, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "I8255A", start: 0x8800, end: 0x8803, dump: null, context: context.cmdhd, mirror_mode: IO_MIRROR_NONE });
      break;
    case DRIVE_TYPE_2040:
    case DRIVE_TYPE_3040:
    case DRIVE_TYPE_4040:
    case DRIVE_TYPE_1001:
    case DRIVE_TYPE_8050:
    case DRIVE_TYPE_8250:
    case DRIVE_TYPE_9000:
      list.push({ name: "RIOT1", start: 0x0200, end: 0x021f, dump: null, context: context.riot1, mirror_mode: IO_MIRROR_NONE });
      list.push({ name: "RIOT2", start: 0x0280, end: 0x029f, dump: null, context: context.riot2, mirror_mode: IO_MIRROR_NONE });
      break;
    default:
      // VICE: log_error("DRIVEMEM: Unknown drive type `%u'.", type);
      // TS port elides the log call per Spec 612 §2 PL-5 (logger not wired
      // in this layer). Returning an empty list matches VICE's behaviour of
      // returning a NULL head pointer when no entries were added.
      break;
  }

  return list;
}
