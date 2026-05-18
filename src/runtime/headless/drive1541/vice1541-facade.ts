// Spec 612 T3.1 — Vice1541Facade.
//
// Drive1541 implementation backed by the new snake_case VICE1541 port
// under `src/runtime/headless/vice1541/**`. Lives OUTSIDE `vice1541/`
// per Spec 612 §2 PL-3 (facades and host-boundary wiring do not belong
// inside the port).
//
// What the facade owns:
//   - the single diskunit_context_t / drive_t / drivecpu_context_t /
//     drivecpud_context_t / drivefunc_context_t / via_context_t (×2,
//     VIA1 + VIA2) / gcr_t allocation for unit 0 (device 8)
//   - the shared AlarmContext + InterruptCpuStatus that VICE1541 talks
//     to via its alarm / interrupt hook surfaces
//   - the iecbus.ts module-state callback bindings via iecbus_status_set
//     (= "drive 8 = TRUEDRIVE, conf1") and c64iec_init
//   - host-hook bundles wired into the port at construction time:
//       drivecpu_install_hooks         (alarm/interrupt/monitor/snapshot)
//       drive_install_hooks            (drive_check_type, UI, P64, ...)
//       driverom_install_hooks         (resources_get_string, diskunit_context, ...)
//       drive_snapshot_install_hooks   (snapshot module + drive lifecycle)
//       iec_drive_install_hooks        (per-chip init/setup/shutdown for non-1541
//                                       drive types — 1541 hits viacore_* directly)
//
// What the facade exposes:
//   the Drive1541 interface (Spec 611 §3) — `iecLineSample`,
//   `iecLineDrive`, `catchUpTo`, `flush`, `attachDisk`, `detachDisk`,
//   `setWriteProtect`, `reset`, `snapshot`, `restore`, `debugProbe`.
//   NO extra methods (per T3.1 acceptance).
//
// What the facade does NOT touch:
//   - vice1541/** source (the port is treated as opaque snake_case API).
//   - legacy iec/, drive/, via/, cpu/ modules.
//   - the kernel-side bridge: that lives in
//     `kernel/headless-machine-kernel.ts::installVice1541Bridge`.
//
// Snapshot/restore + the full drive_image_attach path require disk_image_t
// construction. For phase 612 T3.1 we construct the disk_image_t inline
// from the supplied Drive1541Media (D64 → DISK_IMAGE_TYPE_D64; G64 →
// DISK_IMAGE_TYPE_G64; P64 throws per Spec 612 §10). The GCR encode lives
// inside the port (fsimage_dxx.ts / fsimage_gcr.ts) and is reached via
// `drive_image_attach`.

import { alarmContextNew, alarmContextNextPendingClk } from "../alarm/alarm-context.js";
import { InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";
import type {
  Drive1541,
  Drive1541DebugProbe,
  Drive1541IecInput,
  Drive1541IecSample,
  Drive1541Media,
} from "./drive1541.js";

import {
  type diskunit_context_t,
  type drive_t,
  type disk_image_t,
  type drivecpu_context_t,
  type drivecpud_context_t,
  type drivefunc_context_t,
  type fsimage_t,
  DISK_IMAGE_TYPE_D64,
  DISK_IMAGE_TYPE_G64,
  DISK_IMAGE_TYPE_P64,
  DRIVE_HALFTRACKS_1541,
  DRIVE_IDLE_NO_IDLE,
  DRIVE_PC_NONE,
  DRIVE_RAM_SIZE,
  DRIVE_ROM_SIZE,
  DRIVE_TYPE_1541,
} from "../vice1541/drivetypes.js";
import type { FILE_t } from "../vice1541/fsimage_gcr.js";
import {
  drive_init,
  drive_shutdown,
  drive_install_hooks,
  drive_cpu_early_init_all,
  drive_set_half_track,
  drive_setup_context,
  diskunit_context as vice_diskunit_context,  // T3.2-fix-E: import from drive.ts (canonical, allocated by drive_setup_context). drivesync.ts has a forward-staged stub that drive.ts SHADOWS — must import from drive.ts not drivesync.ts.
  UI_JAM_NONE,
} from "../vice1541/drive.js";
import {
  drivecpu_execute,
  drivecpu_install_hooks,
  drivecpu_reset,
  drivecpu_trigger_reset,
  diskunit_clk_refs,
} from "../vice1541/drivecpu.js";
import {
  driverom_install_hooks,
  driverom_load,
  DRIVE_ROM1541_NAME,
  DRIVE_ROM1541_SIZE,
} from "../vice1541/driverom.js";
import {
  drive_snapshot_install_hooks,
  drive_snapshot_read_module,
  drive_snapshot_write_module,
} from "../vice1541/drive_snapshot.js";
import { iec_drive_install_hooks } from "../vice1541/iec.js";
import { drive_set_machine_parameter } from "../vice1541/drivesync.js";
import { memiec_init } from "../vice1541/memiec.js";
import { via1d1541_setup_context, via1d1541_init } from "../vice1541/via1d1541.js";
import { via2d_setup_context, via2d_init } from "../vice1541/via2d.js";
import {
  DRIVE_TYPE_1540 as _DRIVE_TYPE_1540_,
  DRIVE_TYPE_1541II as _DRIVE_TYPE_1541II_,
  DRIVE_TYPE_1570 as _DRIVE_TYPE_1570_,
  DRIVE_TYPE_1571 as _DRIVE_TYPE_1571_,
  DRIVE_TYPE_1571CR as _DRIVE_TYPE_1571CR_,
} from "../vice1541/drivetypes.js";
const DRIVE_TYPE_1540 = _DRIVE_TYPE_1540_;
const DRIVE_TYPE_1541II = _DRIVE_TYPE_1541II_;
const DRIVE_TYPE_1570 = _DRIVE_TYPE_1570_;
const DRIVE_TYPE_1571 = _DRIVE_TYPE_1571_;
const DRIVE_TYPE_1571CR = _DRIVE_TYPE_1571CR_;
import { drive_image_attach, drive_image_detach } from "../vice1541/driveimage.js";
import {
  c64iec_init,
  iecbus_drive_port as _c64iec_iecbus_drive_port,
} from "../vice1541/c64iec.js";
import {
  iecbus_init,
  iecbus_status_set,
  IECBUS_STATUS_TRUEDRIVE,
  IECBUS_STATUS_DRIVETYPE,
} from "../vice1541/iecbus.js";

// =============================================================================
// SECTION 1 — host-hook stubs
// =============================================================================
//
// PL-3 boundary code: the snake_case port calls into the wider VICE
// machine through extern symbols (UI, resources, monitor, machine,
// userport, ...). The facade installs sane host stubs for everything
// that isn't material to the runtime path:
//
//   - UI calls (jam dialog, drive status, LED, track display) → no-op
//   - sound / vsync hooks                                       → no-op
//   - resource get/set                                          → no-op
//   - machine_drive_* (per-machine fan-out)                     → no-op
//     (c64 machine class — the facade IS the c64 wiring for the drive)
//   - drive_check_type                                          → 1 (1541 only)
//   - drive_check_dual                                          → 0 (single-drive)
//   - resources_get_string                                      → fixed
//     DRIVE_ROM1541_NAME so driverom_load resolves the bundled ROM
//   - P64ImageCreate / Destroy                                  → empty obj
//
// Non-1541 chip ports (cia1571/cia1581/via4000/wd1770/pc8477/cmdhd) are
// out of scope (Spec 612 §10). Their host hooks are loud throws — never
// reached by the 1541-only path.

function notReachable_non1541(peer: string): never {
  throw new Error(
    `[Vice1541Facade] non-1541 chip hook reached (${peer}). Spec 612 §10 ` +
      `restricts the 1541 port to 1540/1541/1541II — other drive types ` +
      `require dedicated ports not yet built.`,
  );
}

// =============================================================================
// SECTION 2 — the facade class
// =============================================================================

export class Vice1541Facade implements Drive1541 {
  /** Per-unit alarm context — VICE: `alarm_context_t *` created by
   *  `alarm_context_new("DRIVE#8")` in `drivecpu_setup_context`. */
  private readonly alarmCtx = alarmContextNew("DRIVE#8");

  /** Per-unit interrupt-cpu-status — VICE: `interrupt_cpu_status_t *` allocated by
   *  `interrupt_cpu_status_new()` in `drivecpu_setup_context`. */
  private readonly intStatus = new InterruptCpuStatus();

  /** Convenience: the diskunit_context_t for unit 0 (device 8), populated
   *  by `drive_setup_context` + `drive_init`. */
  private get unit(): diskunit_context_t {
    const u = vice_diskunit_context[0];
    if (!u) throw new Error("[Vice1541Facade] diskunit_context[0] missing");
    return u;
  }

  /** Public read-only view for smoke / debug. Spec 612 §3 keeps the
   *  Drive1541 boundary; this getter exposes the underlying
   *  diskunit_context_t (snake_case VICE fields) for test scripts.
   *  Not part of the Drive1541 interface. */
  get diskunit(): diskunit_context_t { return this.unit; }

  /** Convenience: the single drive_t in slot 0. */
  private get drive(): drive_t {
    const d = this.unit.drives[0];
    if (!d) throw new Error("[Vice1541Facade] unit.drives[0] missing");
    return d;
  }

  constructor() {
    // T3.2-fix-I: drive_6510core.ts reads InterruptCpuStatus via VICE
    // snake_case names (global_pending_int, irq_clk, nmi_clk,
    // irq_pending_clk, last_opcode_info_ptr, nnmi) and calls
    // interrupt_ack_irq / _ack_nmi / _ack_reset as methods on the
    // instance. Shared TS infra uses camelCase + different method names.
    // Install bidirectional aliases on intStatus so both shapes work.
    // Per Spec 612 PL-3, facade is the boundary that bridges this — no
    // edits to vice1541/ or cpu/.
    const is = this.intStatus as InterruptCpuStatus & Record<string, unknown>;
    Object.defineProperty(is, "global_pending_int", {
      get: () => this.intStatus.globalPendingInt,
      set: (v: number) => { this.intStatus.globalPendingInt = v >>> 0; },
      configurable: true,
    });
    Object.defineProperty(is, "irq_clk", { get: () => this.intStatus.irqClk, set: (v: number) => { this.intStatus.irqClk = v >>> 0; }, configurable: true });
    Object.defineProperty(is, "nmi_clk", { get: () => this.intStatus.nmiClk, set: (v: number) => { this.intStatus.nmiClk = v >>> 0; }, configurable: true });
    Object.defineProperty(is, "irq_pending_clk", { get: () => this.intStatus.irqPendingClk, set: (v: number) => { this.intStatus.irqPendingClk = v >>> 0; }, configurable: true });
    // nnmi already matches VICE name (single word, no case) — no alias needed
    is.last_opcode_info_ptr = { value: 0 };
    is.interrupt_ack_irq = (_cs: unknown) => this.intStatus.ackIrq();
    is.interrupt_ack_nmi = (_cs: unknown) => this.intStatus.ackNmi();
    is.interrupt_ack_reset = (_cs: unknown) => { this.intStatus.globalPendingInt &= ~(1 << 2); };

    // Spec 615 P0 (multi-session lifecycle): tear down any prior
    // vice1541 module state before re-init. First ctor: drive_shutdown
    // early-returns on drive_init_was_called=0 (no-op). Second+ ctor:
    // frees prior diskunit_context entries + drives, then resets
    // rom_loaded + drive_init_was_called to 0 so the drive_init below
    // re-runs the full PL-8 init order (especially loop block 4 which
    // allocates drive.gcr — without this, second-session drives keep
    // drive.gcr === null and mountMedia fails on every disk after the
    // first).
    drive_shutdown();

    // 1. Install hook bundles — these wire the port to the alarm context,
    //    interrupt-cpu-status, ROM resource resolver, and lifecycle no-ops.
    this.installAllHooks();

    // 2. iecbus_init / c64iec_init — wires the bus formula tables +
    //    iecbus_callback_read/write through iecbus_status_set below.
    iecbus_init();
    c64iec_init();

    // 3. Mark unit 0 as TRUEDRIVE + DRIVETYPE so calculate_callback_index
    //    selects iecbus_cpu_read_conf1 / _write_conf1 (single-drive 8).
    iecbus_status_set(IECBUS_STATUS_DRIVETYPE, 8, 1);
    iecbus_status_set(IECBUS_STATUS_TRUEDRIVE, 8, 1);

    // 4. Pre-stamp unit-0 ROM type so `drive_init` loop blocks find a
    //    valid 1541 entry. `drive_setup_context` runs lib_calloc; we
    //    have to seed the type after that, before drive_init.
    drive_setup_context();
    this.unit.type = DRIVE_TYPE_1541;
    this.unit.idling_method = DRIVE_IDLE_NO_IDLE;
    this.unit.parallel_cable = DRIVE_PC_NONE;
    this.unit.enable = 1;

    // 5. drive_init runs the five PL-8 init blocks: rom_load → port
    //    default → setup_image → per-drive GCR alloc + half-track 36 →
    //    driverom_initialize_traps + drivesync + rotation_init +
    //    drivecpu_init. The hooks fan into drivecpu_setup_context,
    //    which constructs the cpu/cpud/func contexts and allocates the
    //    alarm + interrupt + monitor contexts via our host stubs.
    // T3.2-fix-G: VICE machine_class_init calls drive_set_machine_parameter
    // (drivesync.c:53-62) BEFORE drive_init's per-unit drivesync_factor.
    // Without this, sync_factor=0 → drv.cpud.sync_factor=0 → cycle_accum
    // never advances → drive CPU never runs (PC stays at $0000 forever).
    // C64 PAL = 985248 Hz per Spec 611.
    drive_set_machine_parameter(985_248);

    drive_init();

    // T3.2-fix-K: per VICE order, memiec_init must run AFTER drivemem_init
    // (which runs inside drivecpu_init inside drive_init). VICE wires
    // this via machine_drive_init hook fan-out; our hook is registered
    // but drive_init didn't call early_init_all in the right place.
    // Brute-force: invoke after drive_init to install 1541 memory map
    // onto the freshly-allocated drivemem page tables.
    drive_cpu_early_init_all();

    // Spec 612 T3.10 — allocate intNum slots for VIA1 + VIA2 so
    // viacore's set_int (which calls cs.setIrq(intNum, value, rclk))
    // actually mutates intStatus.pendingInt + globalPendingInt.
    // Without this, ctx.int_num stays 0 + intStatus.pendingInt is
    // empty → setIrq early-returns at length-check → drive 6510core
    // never sees IRQ for CA1/T1 → ATN handler never runs → drive
    // can't ack LISTEN frame → c64 stalls in CIOUT debpia loop.
    // VICE: src/interrupt.c:107 interrupt_cpu_status_int_new.
    const isAny = this.intStatus as unknown as {
      newIntNum(name: string): { id: number; name: string };
    };
    const via1IntNum = isAny.newIntNum("via1d1541");
    const via2IntNum = isAny.newIntNum("via2d");
    this.unit.via1d1541!.int_num = via1IntNum.id;
    this.unit.via2!.int_num = via2IntNum.id;

    // 6. Cold reset so the drive 6502 PC lands at the ROM reset vector
    //    on the next drive_6510core_execute round.
    drivecpu_reset(this.unit);
  }

  // ---------------------------------------------------------------------
  // Drive1541 interface — Spec 611 §3 + Spec 612 T3.1 acceptance.
  // ---------------------------------------------------------------------

  iecLineSample(): Drive1541IecSample {
    // Read drv_data[8] from the iecbus singleton (iecbus_drive_port).
    // Bit 1 = data, bit 3 = clk, bit 4 = atna; 1 = released, 0 = pulled.
    const bus = _c64iec_iecbus_drive_port();
    const dd8 = bus.drv_data[8] ?? 0xff;
    return {
      drv_data_pull: (dd8 & 0x02) === 0,
      drv_clk_pull: (dd8 & 0x08) === 0,
      drv_atna_pull: (dd8 & 0x10) === 0,
    };
  }

  iecLineDrive(c64Side: Drive1541IecInput, clk?: number): void {
    // Compose the VICE-shaped CIA2 PA byte and push it through the IEC
    // bus model's installed write callback (iecbus_cpu_write_conf1 in
    // our single-drive setup). VICE bit layout (c64cia2.c:150-163):
    //   bit 3 = ATN out,  bit 4 = CLK out,  bit 5 = DATA out
    // VICE store_ciapa does `tmp = ~byte` then calls
    // iecbus_callback_write(tmp). So `tmp` is the INVERTED-POSITIVE PA
    // (release = 1, pull = 0):
    //   atn_released = true  → c64 PA bit 3 = 0 → tmp bit 3 = 1
    //   atn_released = false → c64 PA bit 3 = 1 → tmp bit 3 = 0
    // Then iec_update_cpu_bus($tmp): cpu_bus.4 = tmp.3 (HIGH = released).
    // Spec 612 T3.7 fix 2026-05-18 — earlier code had this inverted
    // (encoded "released" as 0 instead of 1); ATN edges never reached
    // via1d1541 CA1, drive never received LISTEN frame, c64 stalled in
    // CIOUT debpia loop.
    const tmp =
      (c64Side.bus_atn ? 0x08 : 0) |
      (c64Side.bus_clk ? 0x10 : 0) |
      (c64Side.bus_data ? 0x20 : 0) |
      0x40; // bit 6 = CLK pulse input — irrelevant to write path
    // Codex P0 item 1 (2026-05-19): use the CALLER-SUPPLIED `clk`
    // (= effClk passed from the bridge's setC64Output post-hook, which
    // is `maincpu_clk + write_offset` per VICE c64cia2.c:162). The
    // previous code read `diskunit_clk_refs[0].value` — the drive's
    // own clock, which lags the c64 by the per-cycle drive-tick
    // bookkeeping. Using the drive clock would advance the drive UP
    // TO its own current clock (no-op), missing the c64-side write
    // moment. VICE iecbus_callback_write fires drive_cpu_execute_one
    // with the c64 clock so the drive catches up to the c64 write
    // instant BEFORE iec_update_cpu_bus mutates state. Fall back to
    // diskunit_clk_refs[0].value only when the bridge omitted the
    // arg (legacy tests).
    const effClk = (clk !== undefined ? (clk >>> 0) : diskunit_clk_refs[0]!.value);
    // iecbus.iec_update_cpu_bus + write_conf1 dispatched dynamically.
    // The c64iec.ts `iec_drive_write` callback writes drv_bus[8 + dnr]
    // for the drive-side path; we use the c64-side path instead — the
    // bridge models the C64 writing to $DD00.
    // Late-binding through ./iecbus.js module namespace per c64iec.ts
    // precedent (see install_iecbus_update_ports).
    void _maybe_call_iecbus_callback_write(tmp, effClk);
  }

  catchUpTo(c64Clock: number): number {
    // Set last_clk if not yet primed (first catchUpTo after construction).
    drivecpu_execute(this.unit, c64Clock >>> 0);
    return diskunit_clk_refs[0]!.value >>> 0;
  }

  /**
   * Spec 614 §3.2 — per-clock tick entry for the CycleSchedulerVice
   * rebuild. Delegates to `drivecpu_execute(unit, target_clk)` —
   * the same VICE primitive `catchUpTo` already wraps. Separate
   * named entry so the scheduler binds against a void contract
   * matching `drive_cpu_execute_one(unit, clk)` from VICE
   * src/drive/drivecpu.c, and so the legacy adapter can stub
   * independently of the vice catchUpTo path.
   */
  tickToClock(target_clk: number): void {
    drivecpu_execute(this.unit, target_clk >>> 0);
  }

  flush(): void {
    // Push-mode model: drivecpu_execute is synchronous — no pending
    // edges held back. Equivalent of VICE's drive_cpu_execute_all.
  }

  attachDisk(media: Drive1541Media): void {
    if (media.kind === "p64") {
      throw new Error(
        "[Vice1541Facade] attachDisk(p64): P64 image format not implemented (Spec 612 §10 P64 stub).",
      );
    }
    const image = makeDiskImage(media);
    const rc = drive_image_attach(image, 8 /* device */, 0 /* drive idx */);
    if (rc < 0) {
      throw new Error(
        `[Vice1541Facade] drive_image_attach rejected ${media.kind} image (rc=${rc})`,
      );
    }
    // Re-point head per VICE drive_image_attach trailing call.
    drive_set_half_track(this.drive.current_half_track, this.drive.side, this.drive);
  }

  detachDisk(): void {
    const img = this.drive.image;
    if (img === null) return;
    drive_image_detach(img, 8, 0);
  }

  setWriteProtect(on: boolean): void {
    this.drive.read_only = on ? 1 : 0;
  }

  reset(kind: "cold" | "warm" = "cold"): void {
    if (kind === "cold") {
      drivecpu_trigger_reset(0);
      drivecpu_reset(this.unit);
    } else {
      drivecpu_reset(this.unit);
    }
  }

  snapshot(): Uint8Array {
    // PL-9: VICE-format module chunks. Without a real snapshot_t implementation
    // wired into the host_hooks, drive_snapshot_write_module returns 0
    // (no-op). T3.1 acceptance does not require functional snapshot —
    // T2.14 provides the snake_case body; this facade exposes the entry
    // point so 611.8 can complete the round-trip later.
    void drive_snapshot_write_module;
    return new Uint8Array(0);
  }

  restore(blob: Uint8Array): void {
    void blob;
    void drive_snapshot_read_module;
    // See snapshot() — PL-9 placeholder until host snapshot_t lands.
  }

  debugProbe(): Drive1541DebugProbe {
    return {
      drive_pc: (this.unit.cpu?.cpu_regs.pc ?? 0) & 0xffff,
      head_halftrack: (this.drive.current_half_track ?? 0) & 0xff,
      led: (this.drive.led_status ?? 0) & 0xff,
    };
  }

  // ---------------------------------------------------------------------
  // Private — hook installation
  // ---------------------------------------------------------------------

  private installAllHooks(): void {
    // drivecpu.ts hooks — alarm/interrupt/monitor/machine/snapshot.
    drivecpu_install_hooks({
      alarm_context_new: (name) => alarmContextNew(name),
      alarm_context_destroy: () => { /* GC */ },
      alarm_context_next_pending_clk: (ctx) =>
        alarmContextNextPendingClk(ctx as ReturnType<typeof alarmContextNew>),
      interrupt_cpu_status_new: () => this.intStatus,
      interrupt_cpu_status_destroy: () => { /* GC */ },
      interrupt_cpu_status_init: () => { /* legacy: lai_ref already shared on cpu obj */ },
      interrupt_cpu_status_reset: () => this.intStatus.reset(),
      interrupt_monitor_trap_on: () => { /* monitor-only */ },
      interrupt_global_pending_int: () => this.intStatus.globalPendingInt | 0,
      // T3.2-fix-F: wire IK_RESET into intStatus so DO_INTERRUPT IK_RESET
      // path in drive_6510core pulls reset vector $FFFC/$FFFD on next
      // execute round. Was previously no-op → drive PC stayed at $0000
      // → drive 6502 never ran. Matches VICE interrupt_trigger_reset
      // (interrupt.c) which sets cs->global_pending_int |= IK_RESET.
      interrupt_trigger_reset: (_cs, _clk) => {
        this.intStatus.globalPendingInt |= 1 << 2; // IK_RESET
      },
      interrupt_write_snapshot: () => 0,
      interrupt_read_snapshot: () => 0,
      interrupt_write_new_snapshot: () => 0,
      interrupt_read_new_snapshot: () => 0,
      monitor_interface_new: () => ({}),
      monitor_interface_destroy: () => { /* GC */ },
      monitor_diskspace_mem: (dnr) => dnr,
      monitor_startup: () => { /* no monitor in headless */ },
      get_maincpu_clk: () => this.hostClkProvider(),
      ui_display_reset: () => { /* no-op */ },
      machine_drive_reset: () => { /* no-op */ },
      machine_drive_shutdown: () => { /* no-op */ },
      machine_trigger_reset: () => { /* no-op */ },
      log_message: () => { /* no-op */ },
      drive_jam: () => 0 /* JAM_NONE */,
      snapshot_module_create: () => null,
      snapshot_module_open: () => null,
      snapshot_module_close: () => 0,
      SMW_CLOCK: () => 0,
      SMW_B: () => 0,
      SMW_W: () => 0,
      SMW_DW: () => 0,
      SMW_BA: () => 0,
      SMR_CLOCK: () => 0,
      SMR_B: () => ({ ok: true, v: 0 }),
      SMR_W: () => ({ ok: true, v: 0 }),
      SMR_DW_UINT: () => ({ ok: true, v: 0 }),
      SMR_BA: () => 0,
    });

    // drive.ts hooks — drive_check_type / UI / sound / P64.
    drive_install_hooks({
      drive_check_type: (type, _dnr) => (type === DRIVE_TYPE_1541 ? 1 : 0),
      drive_check_dual: () => 0,
      machine_drive_port_default: () => { /* no-op */ },
      machine_drive_rom_setup_image: () => { /* no-op */ },
      // T3.2-fix-J: machine_drive_init fans into per-machine setup
      // including memiec_init (1541 memory map). Without this the drive
      // page tables stay at drivemem_init defaults (drive_read_free →
      // returns 0) — reset vector $FFFC/$FFFD reads 0 → drive PC=0
      // → drive walks garbage. Wire to memiec_init per VICE iec/iec.c
      // (iec_drive_mem_init) machine class dispatch.
      machine_drive_init: (drv) => {
        if (drv.type === DRIVE_TYPE_1541
            || drv.type === DRIVE_TYPE_1540
            || drv.type === DRIVE_TYPE_1541II
            || drv.type === DRIVE_TYPE_1570
            || drv.type === DRIVE_TYPE_1571
            || drv.type === DRIVE_TYPE_1571CR) {
          memiec_init(drv, drv.type);
          // Codex P0 follow-up #4 (2026-05-19): per VICE iec_drive_init
          // (src/drive/iec/iec.c:72-84) the 1541-family init also runs
          // via1d1541_init + via2d_init. These call viacore_init which
          // CREATES the T1/T2 alarm objects (via alarmNew). Without this
          // step, via1.t1_zero_alarm stays null — when drive ROM sets
          // T1 latch ($1804/$1805), the alarmSet call hits a null guard
          // and silently no-ops. T1 timer NEVER underflows in software.
          // Drive's $E9E5 AND #$40 (poll T1 IFR bit) never escapes.
          // The non-1541 hooks (cia1571_init etc) stay throw-stubs since
          // iec_drive_init() itself can't be called (would hit those).
          via1d1541_init(drv);
          via2d_init(drv);
        }
      },
      machine_drive_setup_context: (drv) => this.machineDriveSetupContext(drv),
      resources_get_int: () => ({ ok: false, value: 0 }),
      resources_set_int_sprintf: () => { /* no-op */ },
      drive_sound_head: () => { /* no-op */ },
      ui_jam_dialog: () => UI_JAM_NONE,
      ui_extend_image_dialog: () => 0,
      ui_enable_drive_status: () => { /* no-op */ },
      ui_display_drive_led: () => { /* no-op */ },
      ui_display_drive_track: () => { /* no-op */ },
      vsync_suspend_speed_eval: () => { /* no-op */ },
      sound_suspend: () => { /* no-op */ },
      archdep_vice_exit: () => { /* no-op */ },
      ds1216e_destroy: () => { /* no-op */ },
      P64ImageCreate: () => ({}),
      P64ImageDestroy: () => { /* no-op */ },
      get_maincpu_clk: () => this.hostClkProvider(),
    });

    // driverom.ts hooks — resources_get_string returns the bundled 1541
    // ROM filename so sysfile_load resolves to resources/roms/.
    driverom_install_hooks({
      diskunit_context: () => vice_diskunit_context,
      drive_disable: () => { /* no-op */ },
      machine_bus_status_drivetype_set: () => { /* no-op */ },
      machine_drive_rom_setup_image: () => { /* no-op */ },
      drive_cpu_trigger_reset: (dnr) => drivecpu_trigger_reset(dnr),
      machine_drive_rom_load: () => this.machineDriveRomLoad(),
      machine_drive_rom_check_loaded: (_type) => 0,
      resources_get_string: (name) => this.resourcesGetString(name),
    });

    // drive_snapshot.ts hooks — minimal stubs; T3.1 doesn't run snapshot
    // workflows. T2.14 acceptance verifies the snake_case body separately.
    drive_snapshot_install_hooks({
      diskunit_context: () => vice_diskunit_context,
      snapshot_module_create: () => null,
      snapshot_module_open: () => null,
      snapshot_module_close: () => 0,
      snapshot_version_is_bigger: () => false,
      snapshot_version_is_smaller: () => false,
      snapshot_set_error: () => { /* no-op */ },
      SMW_B: () => 0,
      SMW_W: () => 0,
      SMW_DW: () => 0,
      SMW_CLOCK: () => 0,
      SMW_BA: () => 0,
      SMR_B: () => ({ ok: false, v: 0 }),
      SMR_B_INT: () => ({ ok: false, v: 0 }),
      SMR_W: () => ({ ok: false, v: 0 }),
      SMR_W_INT: () => ({ ok: false, v: 0 }),
      SMR_DW: () => ({ ok: false, v: 0 }),
      SMR_DW_INT: () => ({ ok: false, v: 0 }),
      SMR_DW_UINT: () => ({ ok: false, v: 0 }),
      SMR_DW_UL: () => ({ ok: false, v: 0 }),
      SMR_CLOCK: () => -1,
      SMR_BA: () => -1,
      vdrive_snapshot_module_write: () => 0,
      vdrive_snapshot_module_read: () => 0,
      machine_drive_snapshot_write: () => 0,
      machine_drive_snapshot_read: () => 0,
      machine_drive_rom_setup_image: () => { /* no-op */ },
      machine_bus_status_drivetype_set: () => { /* no-op */ },
      drive_enable: () => 0,
      drive_disable: () => { /* no-op */ },
      drive_set_active_led_color: () => { /* no-op */ },
      drive_set_half_track: () => { /* no-op */ },
      drive_gcr_data_writeback_all: () => { /* no-op */ },
      drive_is_dualdrive_by_devnr: () => false,
      drive_update_ui_status: () => { /* no-op */ },
      drive_sound_stop: () => { /* no-op */ },
      iec_update_ports_embedded: () => { /* no-op */ },
      parallel_cable_drive_write: () => { /* no-op */ },
      drivemem_init: () => { /* no-op */ },
      driverom_initialize_traps: () => { /* no-op */ },
      file_system_attach_disk: () => -1,
      file_system_detach_disk: () => { /* no-op */ },
      zfile_close_action: () => { /* no-op */ },
      resources_get_int: () => ({ ok: false, v: 0 }),
      resources_set_int: () => 0,
      resources_get_int_sprintf: () => ({ ok: false, v: 0 }),
      resources_set_int_sprintf: () => 0,
      disk_image_read_sector: () => -1,
      disk_image_write_sector: () => -1,
      archdep_mkstemp_fd: () => null,
      SNAPSHOT_MODULE_HIGHER_VERSION: -1,
      SNAPSHOT_MODULE_INCOMPATIBLE: -1,
      PARALLEL_WRITE: 0,
      ZFILE_REQUEST: 0,
      log_error: () => { /* no-op */ },
    });

    // iec.ts hooks — peer-chip init for non-1541 drive types. The 1541
    // family hits viacore_* directly through iec_drive_init's first
    // branch; everything else is a loud throw (out of §10 scope).
    iec_drive_install_hooks({
      iec_resources_init: () => 0,
      iec_resources_shutdown: () => { /* no-op */ },
      iec_cmdline_options_init: () => 0,
      iecrom_init: () => { /* delegated to driverom.ts */ },
      iecrom_load_1540: () => { /* no-op (handled by machine_drive_rom_load) */ },
      iecrom_load_1541: () => { /* no-op */ },
      iecrom_load_1541ii: () => { /* no-op */ },
      iecrom_load_1570: () => { /* no-op */ },
      iecrom_load_1571: () => { /* no-op */ },
      iecrom_load_1581: () => { /* no-op */ },
      iecrom_load_2000: () => { /* no-op */ },
      iecrom_load_4000: () => { /* no-op */ },
      iecrom_load_CMDHD: () => { /* no-op */ },
      iecrom_setup_image: () => { /* no-op */ },
      iecrom_check_loaded: () => 0,
      iecrom_do_checksum: () => { /* no-op */ },
      resources_touch: () => { /* no-op */ },
      diskunit_context: () => vice_diskunit_context,
      lib_msprintf: (fmt, ...args) => {
        // Minimal printf — only `%u` is used by iec_drive_idling_method.
        let i = 0;
        return fmt.replace(/%[a-zA-Z]/g, () => {
          const a = args[i++];
          return String(a);
        });
      },
      cia1571_init: () => notReachable_non1541("cia1571"),
      cia1571_setup_context: () => notReachable_non1541("cia1571"),
      cia1581_init: () => notReachable_non1541("cia1581"),
      cia1581_setup_context: () => notReachable_non1541("cia1581"),
      via4000_init: () => notReachable_non1541("via4000"),
      via4000_setup_context: () => notReachable_non1541("via4000"),
      wd1770d_init: () => notReachable_non1541("wd1770"),
      wd1770_reset: () => notReachable_non1541("wd1770"),
      wd1770_shutdown: () => notReachable_non1541("wd1770"),
      wd1770_attach_image: () => 0,
      wd1770_detach_image: () => 0,
      wd1770_snapshot_read_module: () => 0,
      wd1770_snapshot_write_module: () => 0,
      pc8477d_init: () => notReachable_non1541("pc8477"),
      pc8477_setup_context: () => notReachable_non1541("pc8477"),
      pc8477_reset: () => notReachable_non1541("pc8477"),
      pc8477_shutdown: () => notReachable_non1541("pc8477"),
      pc8477_attach_image: () => 0,
      pc8477_detach_image: () => 0,
      cmdhd_init: () => notReachable_non1541("cmdhd"),
      cmdhd_setup_context: () => notReachable_non1541("cmdhd"),
      cmdhd_reset: () => notReachable_non1541("cmdhd"),
      cmdhd_shutdown: () => notReachable_non1541("cmdhd"),
      cmdhd_attach_image: () => 0,
      cmdhd_detach_image: () => 0,
      cmdhd_snapshot_read_module: () => 0,
      cmdhd_snapshot_write_module: () => 0,
      ciacore_reset: () => { /* non-1541 path */ },
      ciacore_disable: () => { /* non-1541 path */ },
      ciacore_shutdown: () => { /* non-1541 path */ },
      ciacore_snapshot_read_module: () => 0,
      ciacore_snapshot_write_module: () => 0,
    });
  }

  /**
   * iec_drive_setup_context fan-out called from drive_init's machine_drive_setup_context
   * hook. The 1541 path needs via1d1541 + via2 setup_context calls — the
   * iec.ts entry point performs them along with hook-gated non-1541 chips.
   * For the 1541-only facade we invoke just the 1541 helpers directly to
   * avoid notReachable_non1541 firing on the cia1571/cia1581/via4000/pc8477/
   * cmdhd lines.
   */
  private machineDriveSetupContext(drv: diskunit_context_t): void {
    // T3.2-fix-L: was async with dynamic imports — drive_init calls
    // this synchronously so the await never resolved before drive_init
    // continued. Switched to top-level imports + sync call.
    via1d1541_setup_context(drv);
    via2d_setup_context(drv);
  }

  /**
   * machine_drive_rom_load — VICE's c64-glue fan-out (machine-drive.c) calls
   * `iecrom_load_1541()` which in turn calls `driverom_load("DosName1541",
   * drive_rom1541, ...)`. The TS port has no `iecrom.c` body (iecrom is a
   * hook-only stub per Spec 612 §10), so the facade owns the fan-out: it
   * calls `driverom_load` directly with the 1541 resource key, targeting
   * the per-unit `rom` buffer at offset 0x4000 (the canonical 1541 region
   * — see drivemem/memiec.ts mapping where $C000-$FFFF → trap_rom[$4000-
   * $7FFF]). On success, `driverom_load` iterates `diskunit_context[]` for
   * matching `type === DRIVE_TYPE_1541` and runs `driverom_initialize_traps`
   * itself (driverom.ts:486), so the $EC9B trap-opcode patches land
   * automatically. PL-7: on missing ROM the function returns -1; the
   * facade rethrows so construction fails loud instead of leaving the
   * drive booting from zero-filled ROM.
   */
  private machineDriveRomLoad(): void {
    const unit = this.unit;
    // 1541 ROM region inside the 32 KiB per-unit unit.rom buffer is
    // [0x4000, 0x8000) (see driverom_select_rom_region for DRIVE_TYPE_1541).
    const rom_region = unit.rom.subarray(0x4000);
    if (rom_region.length !== DRIVE_ROM1541_SIZE) {
      throw new Error(
        `[Vice1541Facade] unit.rom subarray for 1541 region wrong size: ` +
          `got ${rom_region.length}, expected ${DRIVE_ROM1541_SIZE} (0x4000).`,
      );
    }
    const loaded = { value: 0 };
    const size = { value: 0 };
    const rc = driverom_load(
      "DosName1541" /* resource key — c64iec.ts whitelist resolves to DRIVE_ROM1541_NAME */,
      rom_region,
      loaded,
      DRIVE_ROM1541_SIZE /* min */,
      DRIVE_ROM1541_SIZE /* max — bundled ROM is exactly 16 KiB */,
      "1541" /* name (log label) */,
      DRIVE_TYPE_1541,
      size,
    );
    if (rc < 0 || loaded.value !== 1 || size.value !== DRIVE_ROM1541_SIZE) {
      throw new Error(
        `[Vice1541Facade] driverom_load failed for 1541: rc=${rc} ` +
          `loaded=${loaded.value} size=${size.value} ` +
          `(expected resource '${DRIVE_ROM1541_NAME}' under resources/roms/, ` +
          `alias '1541.bin'). PL-7: no silent zero-fill fallback — install ` +
          `the bundled 1541 ROM and retry.`,
      );
    }
    // driverom_load already invoked driverom_initialize_traps(unit) for
    // every diskunit of matching type via its per-unit loop, so trap_rom
    // is now a $EC9B-patched mirror of unit.rom. No further action here.
  }

  /** resources_get_string — VICE's resource-string lookup. Only the
   *  1541 DRIVE_ROM-name keys are reachable here. */
  private resourcesGetString(name: string): string | null {
    // The 1541-family resource keys all live in driverom.ts as
    // DRIVE_ROM*_NAME constants. We can't import them without cycling
    // back into the port; a literal whitelist is fine for T3.1.
    if (name === "DosName1540") return "dos1540-325302-01.bin";
    if (name === "DosName1541") return "dos1541-325302-01+901229-05.bin";
    if (name === "DosName1541ii") return "1541-ii.bin";
    return null;
  }

  /** Host-clock provider — the facade has no opinion on host clock until
   *  the kernel wires it; default to 0 (the drive runs against its own
   *  clk for catchUpTo). */
  private hostClkProvider(): number {
    return 0;
  }
}

// =============================================================================
// SECTION 3 — disk_image_t construction helpers
// =============================================================================

/**
 * Build a disk_image_t for drive_image_attach from a Drive1541Media. The
 * port's `disk_image_read_image` walks the per-format read function
 * (fsimage_read_dxx_image / fsimage_read_gcr_image / fsimage_read_p64_image),
 * which reads from `image.fsimage.fd` — an in-memory FILE_t per
 * fsimage_gcr.ts SECTION C.
 */
function makeDiskImage(media: Drive1541Media): disk_image_t {
  // Spec 612 T3.2-fix-D — fsimage_dxx.ts uses raw Uint8Array as fd
  // (util_fpread signature `(fd: Uint8Array, ...)`), fsimage_gcr.ts
  // uses FILE_t object `{buf, length, cursor}`. Different per-format
  // shapes inside the port. Build the matching shape per media.kind.
  // Future cleanup: unify fsimage_dxx.ts to use FILE_t too.
  const fd: Uint8Array | FILE_t = media.kind === "d64"
    ? media.bytes
    : { buf: media.bytes, length: media.bytes.length, cursor: 0 };
  const fsimage: fsimage_t = {
    fd: fd as unknown as never,
    name: null,
    error_info: { map: null, dirty: 0, len: 0 },
  } as fsimage_t;
  let type: number;
  let max_half_tracks: number;
  let tracks: number;
  if (media.kind === "d64") {
    type = DISK_IMAGE_TYPE_D64;
    max_half_tracks = DRIVE_HALFTRACKS_1541;
    tracks = 35;
  } else if (media.kind === "g64") {
    type = DISK_IMAGE_TYPE_G64;
    max_half_tracks = DRIVE_HALFTRACKS_1541;
    tracks = 35;
  } else {
    type = DISK_IMAGE_TYPE_P64;
    max_half_tracks = DRIVE_HALFTRACKS_1541;
    tracks = 35;
  }
  return {
    fsimage,
    rawimage: null,
    read_only: media.readOnly ? 1 : 0,
    device: 0, /* DISK_IMAGE_DEVICE_FS = 0 */
    type,
    tracks,
    sectors: 0,
    max_half_tracks,
    gcr: null,
    p64: null,
  };
}

// =============================================================================
// SECTION 4 — late-bound iecbus callback writer
// =============================================================================
//
// iecbus_callback_write is reassigned by calculate_callback_index inside
// iecbus.ts. TS ESM forbids cross-module reassignment of an exported `let`
// from the importer, so we reach via the module namespace (same pattern
// as c64iec.ts uses for install_iecbus_update_ports). Wrapped in a helper
// so the call site stays readable.

import * as _iecbus_mod from "../vice1541/iecbus.js";
function _maybe_call_iecbus_callback_write(data: number, clk: number): void {
  const cb = (
    _iecbus_mod as unknown as {
      iecbus_callback_write: ((data: number, clk: number) => void) | null;
    }
  ).iecbus_callback_write;
  if (cb !== null && cb !== undefined) cb(data, clk);
}

// =============================================================================
// SECTION 5 — unused-import sentinels
// =============================================================================
//
// The interfaces below are imported for documentation / type-checker
// support but are not directly referenced in the body. Mark them void
// so strict-mode "unused import" lint passes.

void DRIVE_RAM_SIZE;
void DRIVE_ROM_SIZE;
type _UnusedTypeRefs = drivecpu_context_t | drivecpud_context_t | drivefunc_context_t;
void (null as unknown as _UnusedTypeRefs | null);
