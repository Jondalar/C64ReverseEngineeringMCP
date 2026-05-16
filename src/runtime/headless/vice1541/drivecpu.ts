// Spec 611 phase 611.3 — VICE1541 drive 6502 + push-mode dispatch.
//
// VICE source:  src/drive/drivecpu.c
// Doc anchor:   docs/vice-1541-arch.md §3 + §4 + §13 B + §13 C
//
// What this phase delivers:
//   - Drive memory map (RAM $0000-$07FF + mirrors, VIA1 / VIA2 stubs
//     + mirrors, ROM at $C000-$FFFF).
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
import { InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";
import type { DiskUnitContext } from "./diskunit.js";
import {
  loadVice1541Rom,
  VICE1541_ROM_BASE,
  VICE1541_ROM_SIZE,
} from "./drive-rom-loader.js";
import {
  C64_HZ_PAL,
  computeSyncFactor,
  resetAttachClk,
  SYNC_FACTOR_SCALE,
} from "./drivesync.js";
import { Vice1541IecBus } from "./iec-bus.js";
import { createVia1d, signalVia1Ca1 } from "./via1d.js";
import type { Via6522 } from "./via6522.js";
import { createVia2d, pulseByteReady } from "./via2d.js";

/** Drive RAM size used by stock 1541 (2 KB at $0000-$07FF). */
export const DRIVE_RAM_BYTES = 0x0800;

/** Safety cap on instructions per `driveCpuExecute()` call. */
const EXECUTE_SAFETY_CAP = 2_000_000;

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
 *   $8000-$BFFF   ROM low/mid (zero on stock split-ROM image)
 *   $C000-$FFFF   ROM canonical (16 KB DOS ROM)
 */
class Vice1541DriveMemBus implements CpuMemory {
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
    // RAM + mirrors
    if (a < 0x0800) return this.ram[a] ?? 0;
    if (a >= 0x2000 && a < 0x2800) return this.ram[a - 0x2000] ?? 0;
    if (a >= 0x4000 && a < 0x4800) return this.ram[a - 0x4000] ?? 0;
    if (a >= 0x6000 && a < 0x6800) return this.ram[a - 0x6000] ?? 0;
    // VIA1 + mirrors (4 regions of 1 KB each within the lower 32 KB)
    if (a >= 0x1800 && a < 0x1c00) return this.via1.read(a & 0x0f);
    if (a >= 0x3800 && a < 0x3c00) return this.via1.read(a & 0x0f);
    if (a >= 0x5800 && a < 0x5c00) return this.via1.read(a & 0x0f);
    if (a >= 0x7800 && a < 0x7c00) return this.via1.read(a & 0x0f);
    // VIA2 + mirrors
    if (a >= 0x1c00 && a < 0x2000) return this.via2.read(a & 0x0f);
    if (a >= 0x3c00 && a < 0x4000) return this.via2.read(a & 0x0f);
    if (a >= 0x5c00 && a < 0x6000) return this.via2.read(a & 0x0f);
    if (a >= 0x7c00 && a < 0x8000) return this.via2.read(a & 0x0f);
    // ROM region
    if (a >= VICE1541_ROM_BASE) {
      return this.rom[a - VICE1541_ROM_BASE] ?? 0;
    }
    // $8000-$BFFF — ROM low/mid on stock 1541 is zero (split ROM).
    if (a >= 0x8000 && a < VICE1541_ROM_BASE) return 0;
    // Open bus.
    return 0xff;
  }

  write(addr: number, value: number): void {
    const a = addr & 0xffff;
    const v = value & 0xff;
    if (a < 0x0800) { this.ram[a] = v; return; }
    if (a >= 0x2000 && a < 0x2800) { this.ram[a - 0x2000] = v; return; }
    if (a >= 0x4000 && a < 0x4800) { this.ram[a - 0x4000] = v; return; }
    if (a >= 0x6000 && a < 0x6800) { this.ram[a - 0x6000] = v; return; }
    if (a >= 0x1800 && a < 0x1c00) { this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x3800 && a < 0x3c00) { this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x5800 && a < 0x5c00) { this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x7800 && a < 0x7c00) { this.via1.write(a & 0x0f, v); return; }
    if (a >= 0x1c00 && a < 0x2000) { this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x3c00 && a < 0x4000) { this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x5c00 && a < 0x6000) { this.via2.write(a & 0x0f, v); return; }
    if (a >= 0x7c00 && a < 0x8000) { this.via2.write(a & 0x0f, v); return; }
    // ROM region: writes ignored.
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

  constructor(diskunit: DiskUnitContext, opts?: { hostHz?: number }) {
    this.diskunit = diskunit;
    this.iecBus = new Vice1541IecBus();
    this.cpuIntStatus = new InterruptCpuStatus();
    this.alarms = alarmContextNew("drivecpu-vice1541");

    // VIA1 (IEC interface) — real implementation per Spec 611 phase 611.4.
    this.via1 = createVia1d({
      bus: this.iecBus,
      cpuIntStatus: this.cpuIntStatus,
      clkPtr: diskunit.clkPtr,
      mynumber: diskunit.mynumber,
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
   */
  setC64IecLines(busAtnReleased: boolean, busClkReleased: boolean, busDataReleased: boolean): void {
    this.iecBus.c64AtnReleased = busAtnReleased;
    this.iecBus.c64ClkReleased = busClkReleased;
    this.iecBus.c64DataReleased = busDataReleased;
    if (busAtnReleased !== this.lastAtnReleased) {
      signalVia1Ca1(this.via1, busAtnReleased);
      this.lastAtnReleased = busAtnReleased;
    }
  }

  /**
   * Cold or warm reset. VICE drive-side reset re-fetches the reset
   * vector at $FFFC/$FFFD from ROM, then clears drive sync state.
   */
  reset(_kind: "cold" | "warm" = "cold"): void {
    const lo = this.mem.read(0xfffc);
    const hi = this.mem.read(0xfffd);
    const vec = ((hi & 0xff) << 8) | (lo & 0xff);
    this.cpu.reset(vec);
    this.via1.reset();
    this.via2.reset();
    this.iecBus.reset();
    this.lastAtnReleased = true;
    this.lastHostClk = 0;
    this.stopClk = 0;
    this.cycleAccum = 0;
    const drive = this.diskunit.drives[0];
    if (drive) {
      resetAttachClk({
        attachClk: drive.attachClk,
        detachClk: drive.detachClk,
        attachDetachClk: drive.attachDetachClk,
      });
      drive.attachClk = 0;
      drive.detachClk = 0;
      drive.attachDetachClk = 0;
    }
    this.diskunit.clkPtr.value = 0;
  }

  /**
   * Port of `drivecpu_execute()` (VICE drivecpu.c:356, doc §13 C step 8).
   *
   * Returns the number of drive cycles spent.
   */
  driveCpuExecute(hostClk: number): number {
    if (hostClk < this.lastHostClk) {
      // host clock went backwards — likely a reset / snapshot restore.
      // Re-baseline without running.
      this.lastHostClk = hostClk;
      return 0;
    }
    let cycles = hostClk - this.lastHostClk;
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
      const dc = this.cpu.clk - before;
      driveCycles += dc;
      if (dc === 0) {
        // CPU jammed or doing nothing — bail rather than spin.
        break;
      }
      if (++safety > EXECUTE_SAFETY_CAP) break;
    }
    this.diskunit.clkPtr.value = this.cpu.clk;
    this.lastHostClk = hostClk;
    return driveCycles;
  }

  get pc(): number { return this.cpu.reg_pc; }
}
