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

  c64Read(addr: number, ctx: BusAccessContext): number {
    if (addr === C64_IEC_PA_ADDR) {
      // VICE iecbus_cpu_read_conf1 (iecbus.c:229) → drive_cpu_execute_all,
      // returns cached iecbus.cpu_port. Push-flush happens inside
      // IecBus._performC64Read via pushFlush.all(clock).
      // Spec 435: hybrid `cycleStepped` hint removed. DriveCpu always
      // runs the cycle-stepped microcoded path (Spec 401).
      return this.kernel.iecBus.buildC64InputBits(ctx.clock, false);
    }
    return this.kernel.c64Bus.read(addr);
  }

  c64Write(addr: number, value: number, ctx: BusAccessContext): void {
    if (addr === C64_IEC_PA_ADDR) {
      const ddr = ctx.ddrMask ?? 0xff;
      // Spec 417: forward ctx.clock (= maincpu_clk + !write_offset per
      // c64cia2.c:162). For x64sc (write_offset=0) → maincpu_clk + 1.
      // Spec 418: drive flush inside IecBus._performC64Write via
      // pushFlush.one(8, clock) ⇒ drive_cpu_execute_one
      // (iecbus.c:241, drive.c:991).
      // Spec 435: hybrid `cycleStepped` hint removed.
      this.kernel.iecBus.setC64Output(value & 0xff, ddr, ctx.clock, false);
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

}
