// Spec 611 phase 611.3 — VICE1541 drive 6502 + push-mode dispatch.
//
// VICE source:  src/drive/drivecpu.c
// Doc anchor:   docs/vice-1541-arch.md §3 + §4 + §13 B + §13 C
//
// What this phase delivers:
//   - Drive memory map (RAM $0000-$07FF + mirrors, VIA1 / VIA2 stubs
//     + mirrors, ROM at $C000-$FFFF mirrored at $8000-$BFFF).
//   - 1541 DOS ROM loaded from `resources/roms` via the VICE1541
//     ROM loader (NO `legacy1541/**` import).
//   - 6502 core: shared Cpu65xxVice instance (per arch §3 "or reuse
//     the C64 one, same template"). Drive instance leaves `ioPortHook`
//     unset (no $00/$01 capacitor) and `c64ViciiCycle` unset (no
//     VIC-II BA hook).
//   - Push-mode dispatch: `driveCpuExecute(hostClk)` ports VICE
//     drivecpu_execute() per §13 C step 8. Converts host cycles to
//     drive cycles via 16.16 sync_factor, runs drive instructions
//     until `drive_clk >= stop_clk`, returns drive cycles spent.
//
// What this phase does NOT do (per Spec 611 §5 611.3 + §7 DO NOT):
//   - No real VIA1/VIA2 behaviour (stubs only; phases 611.4 / 611.5).
//   - No real rotation / GCR / BYTE-READY → SO (phases 611.6 / 611.7).
//   - No IRQ from VIA1/VIA2 into the drive CPU (added in 611.4).
//   - No disk attach / detach / write (phase 611.7).
//   - No snapshot (phase 611.8).
//   - No C64-side LOAD or game gate.

import {
  alarmContextNew,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import type { CpuMemory } from "../cpu6510.js";
import { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import { IK_MONITOR, InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";
import type { DiskUnitContext } from "./diskunit.js";
import {
  loadVice1541Rom,
  VICE1541_ROM_BASE,
  VICE1541_ROM_SIZE,
} from "./drive-rom-loader.js";
import {
  C64_HZ_PAL,
  computeSyncFactor,
  SYNC_FACTOR_SCALE,
} from "./drivesync.js";
import { Vice1541IecBus } from "./iec-bus.js";
import { rotation_reset } from "./rotation.js";
import { createVia1d, signalVia1Ca1 } from "./via1d.js";
import type { Via6522 } from "./via6522.js";
import { createVia2d, pulseByteReady } from "./via2d.js";

/** Drive RAM size used by stock 1541 (2 KB at $0000-$07FF). */
export const DRIVE_RAM_BYTES = 0x0800;

/**
 * Safety cap on instructions per `driveCpuExecute()` call. VICE has
 * no such cap (drivecpu.c:393-441 runs until *clk_ptr >= stop_clk).
 * The port keeps the cap purely to surface runaway loops loudly as
 * a thrown error rather than silently dropping cycles (audit D13).
 */
// VICE has NO safety cap on drivecpu_execute. Raised from 2M → 50M
// because the bridge layer calls catchUpTo() lazily on IEC reads
// (not per host cycle), so a single call may legitimately catch up
// multi-second host gaps (e.g. 8s @ 1MHz = 8M drive cycles).
// 50M = ~50 host-seconds — still finite for runaway-loop detection.
const EXECUTE_SAFETY_CAP = 50_000_000;

/**
 * Drive memory bus per docs/vice-1541-arch.md §4.1 + §4.2.
 *
 * Address map (stock 1541, no extra RAM expansions):
 *   $0000-$07FF   2 KB RAM
 *   $0800-$17FF   open bus
 *   $1800-$1BFF   VIA1 (16 regs mirrored ×64)
 *   $1C00-$1FFF   VIA2 (16 regs mirrored ×64)
 *   $2000-$27FF   RAM mirror (a14/a15 do not decode)
 *   $2800-$37FF   open bus
 *   $3800-$3BFF   VIA1 mirror
 *   $3C00-$3FFF   VIA2 mirror
 *   $4000-$47FF   RAM mirror
 *   $4800-$57FF   open bus
 *   $5800-$5BFF   VIA1 mirror
 *   $5C00-$5FFF   VIA2 mirror
 *   $6000-$67FF   RAM mirror
 *   $6800-$77FF   open bus
 *   $7800-$7BFF   VIA1 mirror
 *   $7C00-$7FFF   VIA2 mirror
 *   $8000-$BFFF   ROM mirror (16 KB DOS ROM mapped here too — VICE
 *                 memiec.c:166-176 maps trap_rom[0..0x3FFF] when
 *                 drive_ram8/rama are disabled, and iecrom.c copies
 *                 the loaded 16 KB into rom[0..0x3FFF] so trap_rom
 *                 here mirrors the canonical $C000-$FFFF block.)
 *   $C000-$FFFF   ROM canonical (16 KB DOS ROM)
 */
class Vice1541DriveMemBus implements CpuMemory {
  /**
   * VICE `drv->cpu->cpu_last_data` (drivecpu.c:594, drivemem.c:78-91 +
   * 100-122). Updated by VICE on:
   *   - open-bus reads only (`drive_read_free` returns `cpu_last_data`,
   *     no implicit update there — but watchpoint trampolines write
   *     it on every read);
   *   - every store via `drive_store_free` and the watchpoint store
   *     trampolines (`cpu_last_data = value`).
   *
   * Port semantics (audit D21): we mirror the "open-bus reads + ALL
   * writes" subset that is observable WITHOUT watchpoints. RAM / ROM /
   * VIA reads do NOT mutate `cpu_last_data`, matching the no-watchpoint
   * VICE path. Initial value 0 to match `lib_calloc` of the
   * drivecpu_context_t (audit D32, drivecpu.c:76 / drivecpu.c:594).
   */
  public cpuLastData: number = 0x00;

  constructor(
    public readonly ram: Uint8Array,
    public readonly rom: Uint8Array,
    public readonly via1: Via6522,
    public readonly via2: Via6522,
  ) {
    if (ram.length !== DRIVE_RAM_BYTES) {
      throw new Error(
        `[VICE1541] drive RAM expected ${DRIVE_RAM_BYTES} bytes, got ${ram.length}`,
      );
    }
    if (rom.length !== VICE1541_ROM_SIZE) {
      throw new Error(
        `[VICE1541] drive ROM expected ${VICE1541_ROM_SIZE} bytes, got ${rom.length}`,
      );
    }
  }

  read(addr: number): number {
    const a = addr & 0xffff;
    // RAM + mirrors — VICE drivemem.c read_tab[] points at the per-page
    // RAM reader, which does NOT touch `cpu_last_data` (only watchpoint
    // trampolines do). Audit D21: do NOT update cpuLastData here.
    if (a < 0x0800) return this.ram[a] ?? 0;
    if (a >= 0x2000 && a < 0x2800) return this.ram[a - 0x2000] ?? 0;
    if (a >= 0x4000 && a < 0x4800) return this.ram[a - 0x4000] ?? 0;
    if (a >= 0x6000 && a < 0x6800) return this.ram[a - 0x6000] ?? 0;
    // VIA1 + mirrors — VICE via1d1541.c:68-71 via1d1541_read explicitly
    // updates `cpu_last_data` on every VIA read:
    //   return ctxptr->cpu->cpu_last_data = viacore_read(...);
    // Cross-file audit r3 follow-up: previous "only open-bus updates"
    // was incomplete; VIA wrappers DO update cpu_last_data.
    if (a >= 0x1800 && a < 0x1c00) return this.cpuLastData = this.via1.read(a & 0x0f);
    if (a >= 0x3800 && a < 0x3c00) return this.cpuLastData = this.via1.read(a & 0x0f);
    if (a >= 0x5800 && a < 0x5c00) return this.cpuLastData = this.via1.read(a & 0x0f);
    if (a >= 0x7800 && a < 0x7c00) return this.cpuLastData = this.via1.read(a & 0x0f);
    // VIA2 + mirrors — VICE via2d.c equivalent wrapper updates
    // cpu_last_data identically.
    if (a >= 0x1c00 && a < 0x2000) return this.cpuLastData = this.via2.read(a & 0x0f);
    if (a >= 0x3c00 && a < 0x4000) return this.cpuLastData = this.via2.read(a & 0x0f);
    if (a >= 0x5c00 && a < 0x6000) return this.cpuLastData = this.via2.read(a & 0x0f);
    if (a >= 0x7c00 && a < 0x8000) return this.cpuLastData = this.via2.read(a & 0x0f);
    // ROM canonical $C000-$FFFF — VICE drivemem.c installs the ROM
    // reader without `cpu_last_data` side-effect; do not update here.
    if (a >= VICE1541_ROM_BASE) return this.rom[a - VICE1541_ROM_BASE] ?? 0;
    // ROM mirror $8000-$BFFF — VICE memiec.c:166-176 maps trap_rom
    // here on a stock 1541 (drive_ram8/rama disabled). iecrom.c copies
    // the 16 KB ROM image into rom[0..0x3FFF] so the mirror equals the
    // canonical $C000-$FFFF block. Audit D34 — leave unconditional;
    // RAM-expansion variants are out of scope (stock 1541, drive_ram8
    // always 0).
    if (a >= 0x8000 && a < VICE1541_ROM_BASE) return this.rom[a & 0x3fff] ?? 0;
    // Open bus — VICE drivemem.c:78-91 `drive_read_free` returns
    // `cpu_last_data` and does NOT mutate it. We deliberately do NOT
    // reassign `cpuLastData = cpuLastData` here either; only writes
    // (drive_store_free, drivemem.c:100-122) feed it. Audit D21.
    return this.cpuLastData;
  }

  write(addr: number, value: number): void {
    const a = addr & 0xffff;
    const v = value & 0xff;
    // VICE drivemem.c:81-85 `drive_store_free` ONLY latches
    // `cpu_last_data = value` on the open-bus fallback path. Per-page
    // store functions installed for RAM, VIA, and ROM regions do NOT
    // update `cpu_last_data` (only the watchpoint trampolines do —
    // drivemem.c:96-116, watchpoint-active path which the port does
    // not model). Audit r3 #32: restrict cpuLastData update to the
    // open-bus fallback at end-of-function.
    if (a < 0x0800) { this.ram[a] = v; return; }
    if (a >= 0x2000 && a < 0x2800) { this.ram[a - 0x2000] = v; return; }
    if (a >= 0x4000 && a < 0x4800) { this.ram[a - 0x4000] = v; return; }
    if (a >= 0x6000 && a < 0x6800) { this.ram[a - 0x6000] = v; return; }
    // VIA1 + mirrors — VICE via1d1541.c:62-66 via1d1541_store latches
    // cpu_last_data BEFORE viacore_store:
    //   ctxptr->cpu->cpu_last_data = data;
    //   viacore_store(..., addr, data);
    if (a >= 0x1800 && a < 0x1c00) { this.cpuLastData = v; this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x3800 && a < 0x3c00) { this.cpuLastData = v; this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x5800 && a < 0x5c00) { this.cpuLastData = v; this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x7800 && a < 0x7c00) { this.cpuLastData = v; this.via1.write(a & 0x0f, v); return; }
    // VIA2 + mirrors — VICE via2d.c equivalent wrapper latches identically.
    if (a >= 0x1c00 && a < 0x2000) { this.cpuLastData = v; this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x3c00 && a < 0x4000) { this.cpuLastData = v; this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x5c00 && a < 0x6000) { this.cpuLastData = v; this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x7c00 && a < 0x8000) { this.cpuLastData = v; this.via2.write(a & 0x0f, v); return; }
    // ROM region $8000-$FFFF — writes ignored, and per VICE per-page
    // store function (drivemem.c) `cpu_last_data` is NOT updated for
    // ROM stores. Audit r3 #32.
    if (a >= 0x8000) return;
    // Open-bus fallback — VICE drivemem.c:81-85 `drive_store_free`.
    this.cpuLastData = v;
  }
}

/**
 * VICE1541 drive CPU + push-mode dispatch wrapper. Owns the drive
 * 6502, the drive alarm context, the memory bus, and the
 * sync_factor / cycle_accum bookkeeping.
 */
export class Vice1541DriveCpu {
  readonly cpu: Cpu65xxVice;
  readonly cpuIntStatus: InterruptCpuStatus;
  readonly mem: Vice1541DriveMemBus;
  readonly via1: Via6522;
  readonly via2: Via6522;
  readonly iecBus: Vice1541IecBus;
  readonly alarms: AlarmContext;
  readonly diskunit: DiskUnitContext;
  readonly romSource: string;
  /** Last ATN-released state we observed from the C64 side — used to
   *  detect edges and forward them to VIA1 CA1. */
  private lastAtnReleased: boolean = true;

  /** 16.16 host→drive cycle ratio per VICE drivesync.c. */
  syncFactor: number;
  /** Low 16 bits = fractional drive-cycle accumulator (per VICE drivecpu.c:330). */
  cycleAccum: number = 0;
  /** Drive-clock target derived from accumulator. */
  stopClk: number = 0;
  /** Last host-clock value processed. */
  lastHostClk: number = 0;
  /**
   * VICE drivecpu.c:214-217 `drivecpu_trigger_reset` queues a reset
   * at `diskunit_clk[dnr] + 1`. The port wires this as a one-shot
   * flag drained at the next `driveCpuExecute` entry (audit D9).
   */
  private pendingTriggerReset: boolean = false;

  constructor(diskunit: DiskUnitContext, opts?: { hostHz?: number }) {
    this.diskunit = diskunit;
    this.iecBus = new Vice1541IecBus();
    this.cpuIntStatus = new InterruptCpuStatus();
    this.alarms = alarmContextNew("drivecpu-vice1541");

    // VIA1 (IEC interface) — real implementation per Spec 611 phase 611.4.
    // Spec 611 phase 611.7g — pass drive cpu AlarmContext for T1 alarm.
    // Spec 611 phase 611.7g.2 — pass live clkRef so alarm callback can
    // read cpu.clk directly (clkPtr.value is only synced AFTER
    // executeCycle returns, but Cpu65xxVice dispatches alarms INSIDE
    // the cycle loop — stale clkPtr would re-introduce IRQ timestamp skew).
    this.via1 = createVia1d({
      bus: this.iecBus,
      cpuIntStatus: this.cpuIntStatus,
      clkPtr: diskunit.clkPtr,
      mynumber: diskunit.mynumber,
      alarmContext: this.alarms,
      clkRef: () => this.cpu.clk,
    });
    // VIA2 (disk controller) — real implementation per Spec 611 phase 611.5.
    // Rotation is still absent (lands in 611.6); the VIA2 BYTE-READY CA1
    // edge is driven synthetically via `pulseByteReady()` from the
    // 611.5 smoke. The cpu SO line wires through here so the V-flag
    // fast-path fires when rotation eventually drives it for real.
    this.via2 = createVia2d({
      diskunit,
      cpuIntStatus: this.cpuIntStatus,
      clkPtr: diskunit.clkPtr,
      setSoLine: (level) => this.cpu.setSoLine(level),
      setOverflowFlag: () => {
        // VICE drivecpu_set_overflow(): direct P_OVERFLOW set on
        // drive CPU. Mirrors src/drive/drivecpu.c:219-223.
        this.cpu.reg_p = (this.cpu.reg_p | 0x40) & 0xff;
      },
      alarmContext: this.alarms,
      clkRef: () => this.cpu.clk,
    });

    const loaded = loadVice1541Rom();
    this.romSource = loaded.source;
    diskunit.rom.set(loaded.bytes, 0);
    const rom = diskunit.rom.subarray(0, VICE1541_ROM_SIZE);

    const ram = diskunit.drvRam.subarray(0, DRIVE_RAM_BYTES);
    this.mem = new Vice1541DriveMemBus(ram, rom, this.via1, this.via2);

    this.cpu = new Cpu65xxVice({
      memBus: this.mem,
      alarmContext: this.alarms,
      cpuIntStatus: this.cpuIntStatus,
      // No ioPortHook (no $00/$01 capacitor on a 1541).
      // No c64ViciiCycle (no VIC-II BA stall on a 1541).
    });

    this.syncFactor = computeSyncFactor(opts?.hostHz ?? C64_HZ_PAL);
  }

  /**
   * Synthetic BYTE-READY pulse helper for 611.5 testing. Real
   * BYTE-READY pulses land with 611.6 rotation; this helper lets
   * the smoke verify VIA2 CA1 → IFR + drive CPU SO V-flag wiring.
   */
  pulseByteReady(): void {
    pulseByteReady(this.via2, (level) => this.cpu.setSoLine(level));
  }

  /**
   * Drive C64-side IEC line state into the drive. Detects ATN edges
   * and forwards them to VIA1 CA1. Called by Vice1541.iecLineDrive().
   *
   * Spec 611 phase 611.7f.24 — optional `clk` (host clk at C64 write
   * moment) used for CA1 IRQ stamp via signalVia1Ca1(clk). Falls back
   * to clkPtr.value if not provided. See vice1541.ts for rationale.
   *
   * Audit D26: external consumers reading `diskunit.clkPtr.value`
   * see the value at the end of the **previous** instruction (it is
   * only synced after `executeCycle()` returns). Mid-cycle hooks
   * inside the drive (VIA1 / VIA2 callbacks, alarm callbacks) read
   * `cpu.clk` via the `clkRef` closure passed to createVia1d /
   * createVia2d above. New external consumers of mid-cycle drive
   * time MUST use the same closure pattern, not `clkPtr.value`.
   */
  setC64IecLines(busAtnReleased: boolean, busClkReleased: boolean, busDataReleased: boolean, clk?: number): void {
    this.iecBus.c64AtnReleased = busAtnReleased;
    this.iecBus.c64ClkReleased = busClkReleased;
    this.iecBus.c64DataReleased = busDataReleased;
    if (busAtnReleased !== this.lastAtnReleased) {
      signalVia1Ca1(this.via1, busAtnReleased, clk);
      this.lastAtnReleased = busAtnReleased;
    }
  }

  /**
   * Cold or warm reset. VICE drive-side reset re-fetches the reset
   * vector at $FFFC/$FFFD from ROM, then clears drive sync state.
   *
   * VICE splits these into two entirely separate entry points:
   *
   *   - Cold = `drivecpu_reset(drv)` (drivecpu.c:194-211):
   *       *clk_ptr = 0
   *       drivecpu_reset_clk(drv)       -- last_clk = maincpu_clk,
   *                                        last_exc_cycles = 0,
   *                                        stop_clk = 0
   *       interrupt_cpu_status_reset(drv->cpu->int_status)
   *       if (preserve_monitor) interrupt_monitor_trap_on(...)
   *       interrupt_trigger_reset(int_status, *clk_ptr)
   *
   *   - Warm = `cpu_reset(drv)` (drivecpu.c:165-184), invoked from
   *     the JAM dispatcher:
   *       interrupt_cpu_status_reset(drv->cpu->int_status)
   *       *clk_ptr = 6
   *       rotation_reset(drv->drives[0])
   *       rotation_reset(drv->drives[1])
   *       machine_drive_reset(drv)
   *       if (preserve_monitor) interrupt_monitor_trap_on(...)
   *     — warm DOES NOT touch last_clk / last_exc_cycles / stop_clk;
   *     those are preserved across a JAM reset (audit D39).
   *
   * Port deviations vs VICE, intentional and documented:
   *
   *  - D3 / D6 / D8: VICE cold queues a reset interrupt via
   *    `interrupt_trigger_reset(int_status, *clk_ptr)` and lets the
   *    6510 core honour it at the proper clk. Cpu65xxVice does not
   *    expose an IK_RESET pipeline; we instead vector-fetch + jump
   *    synchronously here (cold) or drain `pendingTriggerReset` at
   *    the top of `driveCpuExecute()` (warm queued via
   *    `triggerReset()`). Cycle-timing of the reset differs by ≤ 1
   *    drive cycle vs VICE.
   *
   *  - Audit r3 #11/#12/#14: cold path matches VICE — VIA1, VIA2,
   *    IEC bus, and attach_clk fields are NOT reset on cold. Warm
   *    path runs `machine_drive_reset` (via1/via2/iecBus.reset),
   *    1:1 with VICE drivecpu.c:179.
   */
  reset(kind: "cold" | "warm" = "cold", hostClk?: number): void {
    // VICE: preserve IK_MONITOR latch across int-status reset. The
    // bit is re-asserted after the reset clears the pending mask.
    // VICE reads `preserve_monitor` BEFORE `interrupt_cpu_status_reset`
    // on both cold (drivecpu.c:200) and warm (drivecpu.c:169) paths.
    const preserveMonitor =
      (this.cpuIntStatus.globalPendingInt & IK_MONITOR) !== 0;

    this.pendingTriggerReset = false;

    if (kind === "warm") {
      // VICE `cpu_reset` (drivecpu.c:165-184) — warm path invoked
      // from the JAM dispatcher. EXACT sequence (audit r3 #21/#27):
      //   1. interrupt_cpu_status_reset(drv->cpu->int_status)
      //   2. *(drv->clk_ptr) = 6
      //   3. rotation_reset(drv->drives[0])
      //   4. rotation_reset(drv->drives[1])    -- null on stock 1541
      //   5. machine_drive_reset(drv)          -- via1/via2/iecBus
      //   6. if (preserve_monitor) interrupt_monitor_trap_on(...)
      //
      // Warm path does NOT re-fetch the reset vector. The 6510 core
      // resumes from the JAM-redirected PC (drivecpu.c:506-520 set
      // reg_pc = 0xeaa0 before falling into machine_trigger_reset).
      // The TS port's Cpu65xxVice does not pipeline IK_RESET so the
      // PC clobber is performed elsewhere; here we only mirror VICE
      // warm bookkeeping, not the vector fetch (audit r3 #21).
      this.cpuIntStatus.reset();
      this.diskunit.clkPtr.value = 6;
      this.cpu.clk = 6;

      const drive0w = this.diskunit.drives[0];
      if (drive0w) {
        rotation_reset(drive0w);
      }
      // machine_drive_reset(drv) — VICE wires this to the per-machine
      // hook that resets VIA1, VIA2, IEC. Warm path only.
      this.via1.reset();
      this.via2.reset();
      this.iecBus.reset();
      this.lastAtnReleased = true;

      if (preserveMonitor) {
        this.cpuIntStatus.globalPendingInt |= IK_MONITOR;
      }

      // VICE warm path (cpu_reset) does NOT call drivecpu_reset_clk
      // and does NOT touch last_clk / last_exc_cycles / stop_clk.
      // The port previously zero'd `lastHostClk` / `stopClk` /
      // `cycleAccum` here, which desynced push-mode bookkeeping
      // across a JAM-induced warm reset. Preserve them now (audit
      // D39).
    } else {
      // VICE `drivecpu_reset` (drivecpu.c:194-211) — cold path.
      // EXACT sequence (audit r3 #11/#12/#14):
      //   1. *(drv->clk_ptr) = 0
      //   2. drivecpu_reset_clk(drv)
      //   3. preserve_monitor = ...
      //   4. interrupt_cpu_status_reset(drv->cpu->int_status)
      //   5. if (preserve_monitor) interrupt_monitor_trap_on(...)
      //   6. interrupt_trigger_reset(int_status, *(drv->clk_ptr))
      //
      // Cold path does NOT call machine_drive_reset — so via1, via2,
      // iecBus are NOT reset here in VICE (audit r3 #11/#12). It also
      // does NOT touch attach_clk / detach_clk / attach_detach_clk —
      // those live in drive_t and are managed by drive.c attach /
      // detach paths (audit r3 #14).
      //
      // Documented port deviation: Cpu65xxVice has no IK_RESET
      // pipeline, so the cold reset performs a synchronous vector
      // fetch + cpu.reset(vec) in place of `interrupt_trigger_reset`.
      // The 6510 core would otherwise honour the queued reset on the
      // next cycle. ≤ 1 drive cycle drift (audit D3 / D6 / D8).
      this.diskunit.clkPtr.value = 0;
      this.cpu.clk = 0;

      // drivecpu_reset_clk (drivecpu.c:186-191):
      //   drv->cpu->last_clk = maincpu_clk;
      //   drv->cpu->last_exc_cycles = 0;
      //   drv->cpu->stop_clk = 0;
      // Audit D40 / D41: `last_exc_cycles` not modelled.
      this.lastHostClk = hostClk ?? 0;
      this.stopClk = 0;
      this.cycleAccum = 0;

      this.cpuIntStatus.reset();

      if (preserveMonitor) {
        this.cpuIntStatus.globalPendingInt |= IK_MONITOR;
      }

      // Port substitute for `interrupt_trigger_reset(int_status,
      // *(drv->clk_ptr))` — synchronous vector fetch + jump.
      const lo = this.mem.read(0xfffc);
      const hi = this.mem.read(0xfffd);
      const vec = ((hi & 0xff) << 8) | (lo & 0xff);
      this.cpu.reset(vec);
    }
  }

  /**
   * Push-mode clock rebase WITHOUT touching CPU / VIA state.
   *
   * Port of VICE `drivecpu_reset_clk` (drivecpu.c:186-191):
   *   drv->cpu->last_clk = maincpu_clk;
   *   drv->cpu->last_exc_cycles = 0;
   *   drv->cpu->stop_clk = 0;
   *
   * Used by snapshot restore + clock-overflow rebase callers so that
   * the next `driveCpuExecute(hostClk)` sees `cycles = 0` instead of
   * a multi-second catch-up.
   *
   * Audit D2 — `last_exc_cycles` is not modelled. `stop_clk` is set
   * to 0 (absolute, matching VICE), NOT to `cpu.clk`. The
   * `cycleAccum` field is local to the port; it has no VICE
   * counterpart in `drivecpu_reset_clk` but is cleared here so a
   * fresh slice does not carry stale fractional drive cycles.
   */
  resetClk(hostClk: number): void {
    this.lastHostClk = hostClk;
    this.stopClk = 0;
    this.cycleAccum = 0;
  }

  /**
   * Queue a drive-CPU reset at `cpu.clk + 1`. Port of VICE
   * `drivecpu_trigger_reset` (drivecpu.c:214-217):
   *   interrupt_trigger_reset(drivecpu_int_status_ptr[dnr],
   *                           diskunit_clk[dnr] + 1);
   *
   * VICE queues the reset on the drive's `int_status` so the 6510
   * core honours it at exactly `diskunit_clk + 1`. Headless
   * `InterruptCpuStatus` exposes `IK_RESET` as a flag but no
   * pipeline that turns it back into a CPU reset entry — so we
   * latch a flag here and drain it at the top of the next
   * `driveCpuExecute()`, performing a warm reset there.
   *
   * Documented divergence (audit D3 / D6 / D8): VICE runs cycles up
   * to `diskunit_clk + 1` before honouring the reset; the port
   * performs the warm reset BEFORE running any cycles in the next
   * slice. Cycle drift ≤ slice-size for reset timing.
   */
  triggerReset(): void {
    this.pendingTriggerReset = true;
  }

  /**
   * Port of `drivecpu_execute()` (VICE drivecpu.c:356, doc §13 C step 8).
   *
   * Returns the number of drive cycles spent.
   */
  driveCpuExecute(hostClk: number): number {
    // Drain any pending `drivecpu_trigger_reset` before doing any
    // work this slice (audit D9).
    if (this.pendingTriggerReset) {
      this.pendingTriggerReset = false;
      this.reset("warm");
    }

    // VICE drivecpu_execute (drivecpu.c:374-381) calls
    // `drivecpu_wake_up(drv)` BEFORE computing `cycles = clk_value -
    // last_clk`. VICE has NO `hostClk < lastHostClk` backwards-clock
    // guard — the subtraction is unsigned (CLOCK = uint64_t) and the
    // `if (clk_value > cpu->last_clk)` branch yields cycles = 0 on
    // equal-or-backwards motion. Audit r3 #2: drop the port's
    // backwards guard and re-baseline; place wake_up BEFORE cycles.
    //
    // VICE drivecpu_wake_up (drivecpu.c:255-264):
    //   if (maincpu_clk - drv->cpu->last_clk > 0xffffff
    //       && *(drv->clk_ptr) > 934639) {
    //       log_message(drv->log, "Skipping cycles.");
    //       drv->cpu->last_clk = maincpu_clk;
    //   }
    // If the host clock has been advanced by more than ~16.7 M cycles
    // since the last call AND the drive clock has progressed past
    // ~934 k, VICE re-baselines `last_clk` (= our `lastHostClk`),
    // skipping the gap rather than running millions of catch-up
    // drive cycles. Without this guard, big VSF restores / idle
    // pauses cause the port to spin. The "Skipping cycles." log is
    // omitted (cosmetic — audit r3 #1, skipped).
    //
    // Audit D-r4-1: VICE uses `CLOCK = uint64_t` so the subtraction
    // `maincpu_clk - drv->cpu->last_clk` wraps to a HUGE positive value
    // when host clock has moved backwards (e.g. across a VSF restore
    // that rewinds maincpu_clk). The guard then fires and re-baselines.
    // JS `Number` is signed double, so the raw subtraction stays negative
    // on backwards motion and the `> 0xffffff` predicate never fires —
    // leaving `lastHostClk` in the future and `cycles` clamped to 0
    // forever (until host catches back up to lastHostClk).
    //
    // Two-part fix matching VICE behaviour:
    //   1. On backwards motion (hostClk < lastHostClk), rebase
    //      immediately — equivalent to VICE's uint64 wrap producing
    //      a value > 0xffffff and entering the wake_up branch.
    //   2. Compute the forward delta with `>>> 0` to model 32-bit
    //      unsigned subtraction for the standard wake_up predicate.
    if (hostClk < this.lastHostClk) {
      this.lastHostClk = hostClk;
    } else {
      const hostDeltaU32 = (hostClk - this.lastHostClk) >>> 0;
      if (
        hostDeltaU32 > 0xffffff &&
        this.diskunit.clkPtr.value > 934_639
      ) {
        this.lastHostClk = hostClk;
      }
    }

    // VICE drivecpu.c:377-381 — `cycles = 0` if clk_value <= last_clk.
    let cycles = hostClk > this.lastHostClk ? hostClk - this.lastHostClk : 0;
    // Convert host cycles → drive cycles via 16.16 sync_factor.
    while (cycles > 0) {
      const tcycles = cycles > 10000 ? 10000 : cycles;
      cycles -= tcycles;
      this.cycleAccum += this.syncFactor * tcycles;
      this.stopClk += Math.floor(this.cycleAccum / SYNC_FACTOR_SCALE);
      this.cycleAccum = this.cycleAccum % SYNC_FACTOR_SCALE;
    }
    // Run drive instructions until drive_clk >= stop_clk.
    let driveCycles = 0;
    let safety = 0;
    while (this.cpu.clk < this.stopClk) {
      const before = this.cpu.clk;
      this.cpu.executeCycle();
      let dc = this.cpu.clk - before;
      if (dc === 0) {
        // VICE drivecpu_jam dispatcher (drivecpu.c:521-538):
        //
        //   switch (drive_jam(drv, &reason)) {
        //     case JAM_RESET_CPU:
        //         /* reset CPU, keep state, fall through to default */
        //         cpu_reset(drv);          // warm reset
        //         break;
        //     case JAM_POWER_CYCLE:
        //         /* hard reset, re-init drive */
        //         drivecpu_reset(drv);     // cold reset
        //         break;
        //     case JAM_MONITOR:
        //         /* enter monitor; alarms tick; no CLK++ */
        //         monitor_startup(...);
        //         break;
        //     default:
        //         CLK++;                   // narrow JAM-acknowledged tick
        //   }
        //
        // The `CLK++` only runs on the default branch — JAM_RESET_CPU
        // and JAM_POWER_CYCLE diverge into reset paths instead.
        //
        // Audit D-r4-2 (documented deviation): Cpu65xxVice does NOT
        // expose a JAM-reason signal (no hookup to `drive_jam()` /
        // `reason` out-parameter). Without that signal we cannot
        // distinguish JAM_RESET_CPU / JAM_POWER_CYCLE / JAM_MONITOR
        // from the default JAM tick at this layer.
        //
        // TODO(Spec 611 follow-up): wire Cpu65xxVice JAM detection +
        // a `JamReason` enum so this dispatcher can fan out:
        //   - JAM_RESET_CPU   → this.reset("warm");
        //   - JAM_POWER_CYCLE → this.reset("cold");
        //   - JAM_MONITOR     → no CLK++, let alarms tick;
        //   - default         → CLK++ as below.
        //
        // Until that signal exists, fall back to the default branch
        // (`CLK++`) unconditionally. In practice Cpu65xxVice only
        // returns zero cycles on the jam opcode path, so the
        // observable behaviour matches VICE's default branch for
        // stock workloads; only the three non-default JAM reasons
        // are unreachable until the hookup lands. Recorded as a
        // known divergence from drivecpu.c:521-538.
        this.cpu.clk += 1;
        dc = 1;
      }
      driveCycles += dc;
      // Spec 611 phase 611.7g — alarm-based T1 (Codex 12:25) replaces
      // the 611.7f.10 per-instruction serviceTimers polling. T1 zero
      // alarm is dispatched by Cpu65xxVice's per-cycle alarm loop at
      // the exact drive clock, matching VICE viacore_t1_zero_alarm.
      // Keep clkPtr sync for code that polls clkPtr directly.
      this.diskunit.clkPtr.value = this.cpu.clk;
      if (++safety > EXECUTE_SAFETY_CAP) {
        // Audit D13: VICE has no safety cap; the port keeps one to
        // surface runaway loops loudly rather than silently dropping
        // cycles + bumping `lastHostClk` past unrun work. Throwing
        // here also prevents `lastHostClk` desync that would amortise
        // the loss on subsequent calls.
        throw new Error(
          `[VICE1541] driveCpuExecute exceeded EXECUTE_SAFETY_CAP (` +
            `${EXECUTE_SAFETY_CAP} cycles) — possible runaway loop. ` +
            `cpu.clk=${this.cpu.clk} stopClk=${this.stopClk} ` +
            `hostClk=${hostClk} lastHostClk=${this.lastHostClk}`,
        );
      }
    }
    this.diskunit.clkPtr.value = this.cpu.clk;
    this.lastHostClk = hostClk;
    return driveCycles;
  }

  get pc(): number { return this.cpu.reg_pc; }

  /**
   * Live drive clock accessor for non-VIA readers (audit D14).
   *
   * `diskunit.clkPtr.value` is only synced AFTER `cpu.executeCycle()`
   * returns; mid-instruction readers see a one-cycle-stale value.
   * VIA1 / VIA2 alarm callbacks already use the `clkRef` closure
   * pattern (see ctor). External readers that need the live drive
   * clock (e.g. rotation hooks, trace probes) MUST use this accessor
   * instead of `clkPtr.value` so they see `cpu.clk` per-cycle.
   *
   * VICE: CLK macro = `*(drv->clk_ptr)` and is bumped per-cycle by
   * the 6510 core inside the instruction loop (drivecpu.c:393-441,
   * `#include "6510core.c"`), so VICE readers never observe staleness.
   */
  getDriveClk(): number { return this.cpu.clk; }
}
