// Spec 201 — HeadlessKernelBus.
//
// Concrete KernelBus that routes C64 / drive bus accesses with a
// BusAccessContext attached. Cross-domain addresses ($DD00 C64-side
// IEC PA, $1800 drive-side VIA1 PB) go through dedicated paths; all
// other addresses fall through to the local memory bus.
//
// Spec 201-c1 lands the type surface and a working implementation;
// the actual chip routing (CIA2, VIA1) still uses direct iecBus calls
// today and migrates to this bus in 201-c2 / 201-c3.

import type { HeadlessMachineKernel } from "./headless-machine-kernel.js";
import type {
  BusAccessContext,
  KernelBus,
} from "./kernel-bus.js";

export const C64_IEC_PA_ADDR = 0xdd00;
export const DRIVE_IEC_PB_ADDR = 0x1800;

export class HeadlessKernelBus implements KernelBus {
  constructor(private readonly kernel: HeadlessMachineKernel) {}

  c64Read(addr: number, _ctx: BusAccessContext): number {
    if (addr === C64_IEC_PA_ADDR) {
      this.catchUpDriveIfReady(_ctx);
      // VICE iecbus_cpu_read_conf1: cached cpu_port composed from
      // c64 output + AND-gated drv_bus[unit] + ATN gate.
      return this.kernel.iecBus.buildC64InputBits();
    }
    return this.kernel.c64Bus.read(addr);
  }

  c64Write(addr: number, value: number, ctx: BusAccessContext): void {
    if (addr === C64_IEC_PA_ADDR) {
      this.catchUpDriveIfReady(ctx);
      const ddr = ctx.ddrMask ?? 0xff;
      this.kernel.iecBus.setC64Output(value & 0xff, ddr);
      return;
    }
    this.kernel.c64Bus.write(addr, value);
  }

  driveRead(device: number, addr: number, _ctx: BusAccessContext): number {
    if (device !== 8) {
      throw new Error(
        `[kernel-bus] driveRead(${device}) — only device 8 mounted`,
      );
    }
    return this.kernel.drive.bus.read(addr);
  }

  driveWrite(
    device: number,
    addr: number,
    value: number,
    ctx: BusAccessContext,
  ): void {
    if (device !== 8) {
      throw new Error(
        `[kernel-bus] driveWrite(${device}) — only device 8 mounted`,
      );
    }
    if (addr === DRIVE_IEC_PB_ADDR) {
      const ddr = ctx.ddrMask ?? 0xff;
      this.kernel.iecBus.setDriveOutput(value & 0xff, ddr);
      return;
    }
    this.kernel.drive.bus.write(addr, value);
  }

  private catchUpDriveIfReady(ctx: BusAccessContext): void {
    // CIA2 is installed before the drive object is constructed; its
    // initial PA write must not try to catch up an unbuilt drive.
    const maybeDrive = (this.kernel as unknown as { drive?: unknown }).drive;
    if (!maybeDrive) return;
    // Spec 218 hybrid hack: KERNAL ROM ($E000-$FFFF) accesses get
    // legacy whole-instruction drive sync (KERNAL serial timing
    // depends on it). Userland accesses (e.g. motm AB-fastloader at
    // $4278 BIT $DD00) get cycle-stepped sub-cycle sync so drive
    // doesn't overshoot past the C64 PHI2 sample point. PC threshold
    // is the C64 KERNAL/BASIC ROM region split.
    const pc = ctx.pc ?? 0;
    const cycleStepped = pc < 0xa000;
    this.kernel.catchUpDrive(8, ctx.clock, cycleStepped);
  }
}
