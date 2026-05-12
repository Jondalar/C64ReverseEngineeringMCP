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
      // VICE iecbus_cpu_read_conf1: cached cpu_port composed from
      // c64 output + AND-gated drv_bus[unit] + ATN gate.
      // Spec 417: forward `ctx.clock` so the iecbus callback sees
      // the correct maincpu_clk.
      // Spec 418: drive flush now happens INSIDE
      // IecBus._performC64Read via `pushFlush.all(clock, cycleStepped)`
      // ⇒ drive_cpu_execute_all (src/iecbus/iecbus.c:229,
      //   src/drive/drive.c:1001). Doc §15 Phase C step 7,
      // §5.11 row 2. KernelBus only supplies the cycleStepped hint.
      const cycleStepped = this.computeCycleStepped(ctx);
      return this.kernel.iecBus.buildC64InputBits(ctx.clock, cycleStepped);
    }
    return this.kernel.c64Bus.read(addr);
  }

  c64Write(addr: number, value: number, ctx: BusAccessContext): void {
    if (addr === C64_IEC_PA_ADDR) {
      const ddr = ctx.ddrMask ?? 0xff;
      // Spec 417: forward `ctx.clock` (= CIA2's
      // `maincpu_clk + !write_offset` — see c64cia2.c:162). For x64sc
      // / SCPU64 (write_offset=0) this is `maincpu_clk + 1`. The
      // IecBus routes through `callbacks.callbackWrite(...)` to mimic
      // VICE's `(*iecbus_callback_write)(tmp, clock)` pointer call.
      // Spec 418: drive flush now happens INSIDE
      // IecBus._performC64Write via `pushFlush.one(8, clock, cycleStepped)`
      // ⇒ drive_cpu_execute_one (src/iecbus/iecbus.c:241,
      //   src/drive/drive.c:991). Doc §15 Phase C step 7,
      // §5.11 row 1. KernelBus only supplies the cycleStepped hint.
      const cycleStepped = this.computeCycleStepped(ctx);
      this.kernel.iecBus.setC64Output(value & 0xff, ddr, ctx.clock, cycleStepped);
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

  // Spec 418 — Spec 218 hybrid-sync rule lifted out of the old
  // catchUpDriveIfReady. The drive flush itself is now invoked from
  // IecBus._performC64{Write,Read} (= the §5.11 mutation primitive);
  // KernelBus only supplies the `cycleStepped` flag. KERNAL ROM
  // ($A000+) → whole-instruction sync; userland ($0000-$9FFF) →
  // cycle-stepped sub-cycle sync (e.g. motm AB-fastloader at $4278
  // BIT $DD00). Doc §15 Phase C step 7 (push-flush invariant);
  // VICE: src/iecbus/iecbus.c:229,241.
  private computeCycleStepped(ctx: BusAccessContext): boolean {
    const pc = ctx.pc ?? 0;
    return pc < 0xa000;
  }
}
