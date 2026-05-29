// Spec 200 — HeadlessMachineKernel.
//
// Commit chain progress:
//   200-c1 ✓ type surface
//   200-c2 ✓ alarm contexts
//   200-c3 ◀ C64 chips (CPU, CIA1/2, VIC, SID, memory bus, ROMs, IEC bus, framebuffer)
//   200-c4   drive chips
//   200-c5   session wrapper + ESLint
//   200-c6   smoke + acceptance
//
// The kernel constructor builds C64 chips up-front. IntegratedSession
// reads kernel.<chip> as forwarder for backward-compat field access.

import { readFileSync } from "node:fs";
import { createNoDiskParser } from "../disk/no-disk-parser.js";
import type { IntegratedSession } from "../integrated-session.js";
import type { VideoSystem } from "./clock-domains.js";
import type { MachineKernel, MachineSnapshot, MountedMedia } from "./machine-kernel.js";
import type { KernelStatus, KernelMode } from "./kernel-status.js";
import type { KernelTraceController } from "./kernel-trace.js";
import { KernelTraceControllerImpl } from "./kernel-trace.js";
import { TraceRegistry } from "../trace/channels.js";
import type { AlarmContext } from "../alarm/alarm-context.js";
import { InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";
import {
  alarmContextNew,
  alarmContextCaptureSchedule,
  alarmContextRestoreSchedule,
} from "../alarm/alarm-context.js";
import { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import { HeadlessMemoryBus } from "../memory-bus.js";
import { loadCartridgeMapperFromBytes } from "../cartridge.js";
import { snapshotSha256 } from "./native-snapshot.js";
import type { RuntimeCheckpointMedia } from "./runtime-checkpoint.js";
import type { HeadlessCartridgeState } from "../types.js";
import { loadAllC64Roms, type LoadedC64RomSet } from "../c64-rom.js";
import { IecBus } from "../iec/iec-bus.js";
import { VicIIVice, installVicIIVice, type VicBackend } from "../vic/vic-ii-vice.js";
import { installSid, type Sid6581 } from "../sid/sid.js";
import { VicFramebuffer } from "../peripherals/vic-renderer.js";
import { installCia1 } from "../peripherals/cia1.js";
import type { KeyboardMatrix, JoystickState } from "../peripherals/keyboard.js";
import { installCia2 } from "../peripherals/cia2.js";
import type { Cia6526Vice } from "../cia/cia6526-vice.js";
// Spec 704 §11 R3 — legacy drive/** removed. VICE1541 is the only drive.
import { G64Parser } from "../../../disk/g64-parser.js";
import { buildG64 } from "../../../disk/g64-builder.js";
import { DiskProvider } from "../providers.js";
import { HeadlessKernelBus } from "./headless-kernel-bus.js";
import { KernelIrqRing, type KernelIrqEvent } from "./kernel-irq.js";
import { HookRegistry, type HookName } from "./kernel-hooks.js";
import { EventCatchupStrategy } from "./event-catchup-strategy.js";
import type { SyncStrategy } from "./sync-strategy.js";
import { vicii_set_vbank as litViciiSetVbank } from "../vic/literal/vicii.js";
import { vicii_snapshot_write, vicii_snapshot_read } from "../vic/literal/vicii-snapshot.js";
import {
  RUNTIME_CHECKPOINT_SCHEMA_VERSION,
  type RuntimeCheckpoint,
} from "./runtime-checkpoint.js";
import type {
  Drive1541,
  Drive1541Implementation,
} from "../drive1541/drive1541.js";
import { createDrive1541 } from "../drive1541/drive1541-factory.js";
// Spec 612 T3.1 — drv_data[8] live read source for the Vice1541 bridge.
// The new snake_case port owns the canonical iecbus singleton; the
// bridge reads from it (NOT from legacy core closure refs).
// Spec 621.2 — iecbus_drive_port is machine-specific in VICE
// (c64iec.c canonical for C64). Moved off iecbus.ts.
import { iecbus_drive_port as vice_iecbus_drive_port } from "../vice1541/c64iec.js";

export interface HeadlessMachineKernelDeps {
  session: IntegratedSession;
  video: VideoSystem;
  /** Optional disk image. Omit to boot drive empty (= no media), like
   *  real C64 + 1541 powered with no disk inserted. */
  diskPath?: string;
  imageFormat?: string;
  deviceId: number;
  startTrack: number;
  writeProtected?: boolean;
  driveCyclesPerC64Cycle: number;
  /** Spec 428 Phase C — drive dispatch mode flag. */
  driveDispatchMode?: "cycle-stepped" | "vice-whole-instruction";
}

export interface KernelAlarmContexts {
  readonly maincpu: AlarmContext;
  readonly drivecpu: AlarmContext;
}

export class HeadlessMachineKernel implements MachineKernel {
  private readonly session: IntegratedSession;
  // Spec 205-A c1: kernel owns the trace registry. Channels off by
  // default; IntegratedSession (or external clients) configure them
  // via `kernel.trace().configureChannel`.
  readonly traceRegistry: TraceRegistry = new TraceRegistry();
  private readonly traceCtrl: KernelTraceControllerImpl = new KernelTraceControllerImpl(this.traceRegistry);
  readonly video: VideoSystem;

  // Spec 200-c2: alarm contexts.
  readonly alarms: KernelAlarmContexts;

  // Spec 203-c1: IRQ / NMI / SO / CA1 / CB1 event ring. Chip backends
  // emit timestamped edges via `emitIrqEvent`; consumers read via
  // `irqEvents()`. Used by CPU interrupt-delay accounting and by the
  // first-divergence diff tooling in Spec 205.
  private readonly irqRing = new KernelIrqRing(4096);

  // Spec 204: TrueDrive hook hygiene. `hooks` registers every legacy rescue
  // hook; `recordHookFire` is the single entry point hook callsites use to
  // record + audit fires.
  // Spec 723.7b: starts at "true-drive" (debug-lockstep removed).
  private mode: KernelMode = "true-drive";
  readonly hooks: HookRegistry = new HookRegistry(() => this.mode);

  // Spec 200-c3: shared IEC bus. Created here because both C64 (CIA2)
  // and drive sides reference it; ownership belongs to the kernel.
  readonly iecBus: IecBus;

  // Spec 200-c3: C64 side chips. Constructed by the kernel; session
  // reads them for backward-compat field access.
  readonly c64Bus: HeadlessMemoryBus;
  readonly romSet: LoadedC64RomSet;
  // Spec 723.4c: the C64 product CPU is always the microcoded Cpu65xxVice,
  // built directly in the constructor (no legacy Cpu6510 base + swap).
  c64Cpu: Cpu65xxVice;
  readonly cia1: Cia6526Vice;
  readonly cia2: Cia6526Vice;
  /** Spec 309 Phase D: shared with Cpu65xxVice — chips push setIrq/setNmi here. */
  readonly cpuIntStatus: InterruptCpuStatus;
  readonly keyboard: KeyboardMatrix;
  readonly joystick1: JoystickState;
  readonly joystick2: JoystickState;
  // Spec 429: unconnected POT lines read $80, matching VICE. (gold trace
  // $D419 = $80 on every read; VICE sid.c makepotval(read_joyport_potx())).
  // A default of 0 made Last Ninja Remix's POTX bit-7 gate
  // ($0917 LDA $D419 / CMP #$00 / BMI) fall through to the in-game path
  // (Central Park) instead of the SYSTEM3/title/intro. setPaddle() overrides.
  readonly paddles: Uint8Array = new Uint8Array([0x80, 0x80, 0x80, 0x80]); // [POTAX, POTAY, POTBX, POTBY]
  readonly vic: VicIIVice;
  readonly sid: Sid6581;
  readonly framebuffer: VicFramebuffer;

  // Spec 201-c1: KernelBus instance. Concrete implementation owned by
  // kernel; cross-domain accesses ($DD00, $1800) get routed through
  // here in 201-c2 / 201-c3.
  readonly bus: HeadlessKernelBus;
  private readonly eventCatchup: EventCatchupStrategy;

  // Spec 200-c4: drive + disk side. Kernel owns parser, head, GCR
  // shifter and drive CPU; IEC drive-side wiring happens here too.
  // diskPath empty / diskProvider undefined when booted with no media
  // (like real C64 + 1541 powered with no disk).
  readonly diskPath: string;
  readonly imageFormat: string;
  readonly parser: G64Parser;
  diskProvider?: DiskProvider;
  // Spec 723.6a/6b: the only drive is the VICE1541 facade. This is a constant
  // "vice" status field (the resolve/assert selection layer + the mount.ts
  // impl-guards are gone). Kept as a single-path status indicator that proof
  // scripts assert on.
  readonly drive1541Implementation: Drive1541Implementation = "vice";
  /**
   * Spec 614.3 — per-c64-cycle overlay from vice iecbus → legacy core,
   * installed by `installVice1541Bridge` in vice mode. Called by the
   * scheduler's `afterCycleSync` AFTER `drive1541.tickToClock(c64Cycle)`
   * so the C64-side $DD00 read formulas (which read from legacy
   * `core.cpu_port`) reflect the current vice drive state. Without
   * this per-cycle overlay, legacy `core.drv_port` is stale between
   * $DD00 writes (pushFlush only fires on writes), causing the c64
   * to read mis-aligned drive state during bit-bang.
   */
  viceCycleOverlay?: () => void;
  /**
   * Spec 611 phase 611.2 — when `drive1541: "vice"` is selected the kernel
   * instantiates VICE1541 alongside the legacy DriveCpu (factory-wiring
   * evidence). The C64 side keeps reading the legacy drive for real work
   * until the Drive1541 surface is fully wired in later phases.
   */
  readonly drive1541?: Drive1541;

  constructor(deps: HeadlessMachineKernelDeps) {
    this.session = deps.session;
    this.video = deps.video;
    // Spec 723.6a: drive1541Implementation is the constant "vice" (field
    // initializer). No resolve/assert selection layer.
    // Spec 611 phase 611.7e.3 — defer drive1541 instantiation to the
    // end of the constructor (after `this.drive` + `this.iecBus` are
    // wired). The vice path needs nothing here, but we keep the deferred
    // instantiation point.
    const isPal = this.video === "PAL";
    this.alarms = {
      maincpu: alarmContextNew("maincpu"),
      drivecpu: alarmContextNew("drivecpu"),
    };

    // Spec 200-c4: disk image + parser. D64 sources are pre-encoded to
    // a G64 byte stream in memory and then parsed normally. Real drive
    // ROM, real GCR pipeline, real IEC — same code path as native G64.
    this.diskPath = deps.diskPath ?? "";
    this.imageFormat = deps.imageFormat ?? "";
    if (deps.diskPath) {
      let imageBytes: Uint8Array = readFileSync(deps.diskPath);
      if (this.imageFormat === "d64") {
        imageBytes = buildG64({ d64: imageBytes });
      }
      this.parser = new G64Parser(imageBytes);
      this.diskProvider = DiskProvider.fromImagePath(deps.diskPath);
    } else {
      // No-disk boot: drive on, drive empty. Sentinel parser returns
      // null/empty for all reads so GcrShifter sees no sync (= "drive
      // empty" behavior matching real HW).
      this.parser = createNoDiskParser();
      this.diskProvider = undefined;
    }
    // Spec 704 §11 R3 — legacy TrackBuffer / HeadPosition removed. In
    // vice mode VICE1541 owns its own disk image + head geometry
    // (vice1541/driveimage.ts + rotation.ts), wired via drive1541.attachDisk.

    // Spec 200-c3: shared IEC bus. Drive-side wiring happens after
    // drive build below.
    this.iecBus = new IecBus();

    // Spec 201-c1: KernelBus constructed early so CIA2 / VIA1 install
    // callbacks can route $DD00 / $1800 access through it. Bus methods
    // that touch drive-side state are only valid after drive exists at
    // the end of this constructor.
    this.bus = new HeadlessKernelBus(this);

    // Spec 200-c3: C64 memory bus + ROMs.
    this.c64Bus = new HeadlessMemoryBus();
    this.romSet = loadAllC64Roms();
    if (this.romSet.allRomsAvailable) {
      this.c64Bus.loadKernalRom(this.romSet.kernal.bytes);
      this.c64Bus.loadBasicRom(this.romSet.basic.bytes);
      this.c64Bus.loadCharRom(this.romSet.charRom.bytes);
    }

    // Spec 309 Phase D: shared InterruptCpuStatus instance — chips push
    // setIrq/setNmi here; Cpu65xxVice reads globalPendingInt at opcode boundary.
    // Built before the CPU (the microcoded CPU takes it as a ctor dep).
    this.cpuIntStatus = new InterruptCpuStatus();
    // CPU built BEFORE CIA install — Cia6526Vice's Ciat sub-modules capture the
    // CPU clock at construction time via clkPtr(), so the CPU must already exist.
    // Spec 723.4c: the C64 product CPU is the microcoded Cpu65xxVice, built
    // directly here (the legacy Cpu6510 base + later swap is gone). The per-cycle
    // VIC hook (c64ViciiCycle) is installed later by IntegratedSession via
    // setC64ViciiCycle(), once the VIC/literal-port wiring exists.
    this.c64Cpu = new Cpu65xxVice({
      memBus: this.c64Bus,
      alarmContext: this.alarms.maincpu,
      cpuIntStatus: this.cpuIntStatus,
    });

    // Spec 083 / VICE-style: when C64 reads or writes IEC bus state,
    // first catch the drive CPU up to the current cycle so drive's
    // response reflects all elapsed time. Without this, drive lag
    // breaks serial bit timing.
    const ciaClkPtr = () => this.c64Cpu.cycles;
    // Spec 201-c2: CIA2 PA writes/reads route through KernelBus. We
    // pass deferred-resolution callbacks because `this.bus` is wired
    // at end of constructor; the closures resolve at runtime when CIA2
    // actually accesses PA, by which time `this.bus` exists.
    // Spec 417 / §17.2 OQ-417-1 — pin CIA2 write_offset = 0 for the
    // x64sc / SCPU64 machine class. VICE
    // `cia2_setup_context` forces `cia->write_offset = 0` for both
    // VICE_MACHINE_C64SC and VICE_MACHINE_SCPU64 (`vice/src/c64/
    // c64cia2.c:307-310`); the default in `ciacore_setup_context` is 1
    // (`vice/src/core/ciacore.c:2028`). The store_ciapa wrapper then
    // invokes `(*iecbus_callback_write)(tmp, maincpu_clk +
    // !(cia_context->write_offset))` (`vice/src/c64/c64cia2.c:162`),
    // so x64sc passes `maincpu_clk + 1`. We use the same pin for
    // CIA1 below — both CIAs share the C64SC override.
    const c64CiaWriteOffset = 0;
    const buildC64BusCtx = (access: "read" | "write", clock = this.c64Cpu.cycles) => ({
      side: "c64" as const,
      clock,
      pc: this.c64Cpu.pc | 0,
      opcode: 0,
      phase: "phi2" as const,
      addr: 0xdd00,
      access,
    });
    const cia2Install = installCia2(this.c64Bus, {
      alarmContext: this.alarms.maincpu,
      clkPtr: ciaClkPtr,
      writeOffset: c64CiaWriteOffset,
      cpuIntStatus: this.cpuIntStatus,
      onNmiEdge: (asserted, edgeClock) => {
        this.emitIrqEvent({
          line: "nmi",
          asserted,
          source: "cia2",
          target: "c64-cpu",
          edgeClock,
          visibleClock: edgeClock,
        });
      },
      iecWrite: (or, ddr, effectiveClock) => {
        // Spec 201-c2: $DD00 write goes through KernelBus. The DDR
        // mask travels via BusAccessContext.ddrMask; bus dispatches
        // to IecBus.setC64Output with the full (or, ddr) tuple.
        this.bus.c64Write(0xdd00, or, { ...buildC64BusCtx("write", effectiveClock), ddrMask: ddr });
        // Spec 262b: mirror the composed PA byte into the VIC per-cycle
        // log (reg=0x80) so the future pixel-perfect renderer can
        // reconstruct mid-frame VIC bank changes (FLI / FLD / split).
        // Guard with optional chain — VIC is constructed AFTER CIA2
        // and CIA2's installer fires an initial iecWrite before that.
        this.vic?.recordCia2PaChange(or & 0xff);
      },
      iecReadPins: () => this.bus.c64Read(0xdd00, buildC64BusCtx("read")),
      // Spec 426 — VIC bank switch push. CIA2 fires when effective PA
      // bits 0..1 inversion changes. Routes to literal VIC vbank setter.
      // VICE: c64cia2.c:148 → c64_glue_set_vbank → vicii_set_vbank.
      onVicBankChange: (newVbank) => litViciiSetVbank(newVbank),
    });
    this.cia2 = cia2Install.cia;
    const cia1Install = installCia1(this.c64Bus, {
      alarmContext: this.alarms.maincpu,
      clkPtr: ciaClkPtr,
      writeOffset: c64CiaWriteOffset,
      cpuIntStatus: this.cpuIntStatus,
      onIrqEdge: (asserted, edgeClock) => {
        this.emitIrqEvent({
          line: "irq",
          asserted,
          source: "cia1",
          target: "c64-cpu",
          edgeClock,
          visibleClock: edgeClock,
        });
      },
    });
    this.cia1 = cia1Install.cia;
    this.keyboard = cia1Install.keyboard;
    this.joystick2 = cia1Install.joystick2;
    this.joystick1 = cia1Install.joystick1;

    // Sprint 113 Phase 2 (Spec 150): VicIIVice — alarm-driven B-level core.
    // Backend wiring:
    //   stealCpuCycles → advance maincpu_clk (CPU does not execute
    //     during stolen window; driven via cycles property bump).
    //   setIrqLine → OR'd into CIA1 IRQ path (sampled by
    //     checkC64Interrupts / updateMicrocodedInterruptLines).
    //   readVbus / readColorRam → optional data reads; B-level uses
    //     zero (cycle counting only, renderer reads RAM directly).
    // Spec 203-c3: VIC raster IRQ edge tracking. setIrqLine is called
    // by VicIIVice on every irq state update; only level transitions
    // emit a kernel event.
    let vicPrevAsserted = false;
    const vicBusBackend: VicBackend = {
      // Spec 723.7d: stealCpuCycles removed (batched tick() path deleted).
      setIrqLine: (asserted: boolean, clk: number) => {
        // Phase E' REVERTED: chip-side push caused VIC graphics regression
        // (D018 / raster splits misaligned by ~1-2 cycles vs pre-E' baseline).
        // VIC IRQ stays sampled by session-side updateMicrocodedInterruptLines
        // (= 1-cycle delay vs vic-tick = matches game expectations).
        if (asserted !== vicPrevAsserted) {
          vicPrevAsserted = asserted;
          this.emitIrqEvent({
            line: "irq",
            asserted,
            source: "vic",
            target: "c64-cpu",
            edgeClock: clk,
            visibleClock: clk,
          });
        }
      },
      readVbus: () => 0,
      readColorRam: () => 0,
    };
    const vic = new VicIIVice({
      backend: vicBusBackend,
      alarmContext: this.alarms.maincpu,
      clkPtr: ciaClkPtr,
      name: "VIC",
    });
    vic.powerup();
    if (!isPal) vic.setNtsc();
    installVicIIVice(this.c64Bus, vic);
    this.vic = vic;
    this.sid = installSid(this.c64Bus);
    // Spec 108 (M2.6c) v1: bridge POT readback to paddles[].
    // Paddle 0 → POT A, paddle 2 → POT B.
    this.sid.potReader = (idx) => this.paddles[idx === 0 ? 0 : 2] ?? 0x80;
    this.c64Bus.reset();

    this.framebuffer = new VicFramebuffer(isPal);

    // Spec 704 §11 R3 — legacy GcrShifter + DriveCpu removed. VICE1541
    // (drive1541-facade → vice1541/**) is the only drive: it owns the
    // drive 6502, VIA1/VIA2, GCR rotation, and IEC drive-side wiring.
    // The C64-side IEC view is bridged via installVice1541Bridge below.
    // Spec 140 v3: 1:1 VICE port. No mode flag — VICE is THE behavior.
    // Spec 141 v2: drive clock source for ATN edge IRQ stamping.
    //
    // Codex P0 follow-up (2026-05-19): in `drive1541="vice"` mode the
    // legacy DriveCpu is quiet (Spec 612 T3.2-fix-O) so its `cpu.cycles`
    // field lags the c64 master clock by ~hundreds of K cycles. Feeding
    // that stale legacy clock into `pushFlush.all/one` corrupts the
    // vice1541 drivecpu's `last_clk` (drivecpu_execute sets last_clk
    // = clk_value unconditionally at exit). Next per-c64-cycle
    // afterCycleSync then computes `cycles = c64_clock - stale_last_clk
    // = ~367K`, drive runs 367K cycles in one call → drive clock runs
    // away by 18000× normal rate.
    //
    // Fix: in vice mode driveClockSource returns the c64 master clock
    // (same domain the scheduler uses for tickToClock). In legacy mode
    // it stays the legacy drive cycles (= the real drive clock there).
    // Spec 704 §11 R3 — vice-only: drive clock = c64 master clock (the
    // domain the scheduler uses for tickToClock). The vice drive's own
    // clock advances via drive1541.catchUpTo / tickToClock.
    this.iecBus.driveClockSource = () =>
      (this.c64Cpu as { cycles: number }).cycles;
    // Spec 418 — push-flush invariant per docs/vice-iec-arc42.md
    // §15 Phase C steps 7-9 + §5.11 call-site enumeration.
    //
    // VICE 1:1 mapping:
    //   IecBus.pushFlush.one(unit, clk)  ⇒ drive_cpu_execute_one(unit, clk)
    //                                        (src/iecbus/iecbus.c:241,
    //                                         src/drive/drive.c:991)
    //   IecBus.pushFlush.all(clk)        ⇒ drive_cpu_execute_all(clk)
    //                                        (src/iecbus/iecbus.c:229,
    //                                         src/drive/drive.c:1001)
    //
    // Promoted from a KernelBus precondition (Spec 218
    // `catchUpDriveIfReady`) to a property of the IecBus mutation
    // primitive itself, so a future caller cannot mutate the bus
    // without flushing first. KernelBus retains the cycleStepped
    // PC heuristic (Spec 218 hybrid hack) and forwards it through
    // setC64Output/buildC64InputBits → flushCycleStepped.
    this.iecBus.pushFlush = {
      one: (unit, clk, cycleStepped) => {
        if (unit !== 8) return;
        this.catchUpDrive(8, clk, cycleStepped);
      },
      all: (clk, cycleStepped) => {
        // Single-1541 baseline: "all" == "unit 8". Multi-drive (conf3)
        // would walk every active TDE unit here.
        this.catchUpDrive(8, clk, cycleStepped);
      },
    };
    // Spec 090 / Spec 409: configure drive's sync_factor + zero baseline.
    //
    // VICE init path (`drive_set_machine_parameter(cyclesPerSec)`) takes
    // the host C64 cycles-per-second directly and computes the 16.16
    // sync_factor via `floor(65536 * 1_000_000 / cycles_per_sec)`. We
    // mirror that here using the kernel's PAL/NTSC selection so the
    // factor is byte-identical to VICE (PAL=0x103D5, NTSC=0xFA4F).
    //
    // The legacy `setSyncRatio(driveCyclesPerC64Cycle)` path is preserved
    // for back-compat; the new entry point is the canonical 1:1 port.
    //
    // Doc: docs/vice-1541-arch.md §5.1, §5.3, §13 Phase C step 7,
    //      §17 OQ-409-1/2/3.
    // VICE: src/drive/drivesync.c:55-65 drive_set_machine_parameter().
    // Spec 704 §11 R3 — legacy drive_set_machine_parameter / setSyncBaseline
    // removed; the vice drive (vice1541/drivesync.ts) self-configures its
    // sync_factor. eventCatchup advances the vice drive via
    // setAdditionalCatchUp (wired below), not via a legacy deps.drive.
    this.eventCatchup = new EventCatchupStrategy({
      c64Clock: () => this.c64Cpu.cycles,
      stepC64Instruction: () => this.session.stepC64Instruction(),
    });

    // Spec 204: register every legacy rescue hook. `allowedModes`
    // = modes in which the hook may fire without raising
    // HookForbiddenError. Spec 723.7b: with debug-lockstep gone, these legacy
    // rescue hooks are allowed in NO mode — if one ever fires it raises
    // HookForbiddenError, surfacing a regression (the product path never
    // triggers them).
    const debugOnly: readonly KernelMode[] = [];
    this.hooks.register("atn-poke-7c", debugOnly);
    this.hooks.register("iec-release-clk", debugOnly);
    this.hooks.register("iec-release-data", debugOnly);
    this.hooks.register("kernal-serial-trap", debugOnly);
    this.hooks.register("kernal-fileio-trap", debugOnly);
    this.hooks.register("kernal-io-trap", debugOnly);
    this.hooks.register("fake-disk-byte", debugOnly);
    this.hooks.register("forced-pc-jump", debugOnly);

    // Spec 204: install hook recorder on IEC bus so synthetic line
    // releases route through the kernel registry.
    this.iecBus.setHookRecorder((name, description) =>
      this.recordHookFire(name, description),
    );

    // Spec 205-A c5: bridge IEC line edges into the "iec" trace
    // channel. No-op when the channel is "off".
    this.iecBus.setEdgeListener((rec) => {
      if (!this.traceRegistry.isEnabled("iec")) return;
      this.traceCtrl.publish("iec", rec.cycle, {
        side: rec.side,
        atn: rec.atn, clk: rec.clk, data: rec.data,
        c64Atn: rec.c64Atn, c64Clk: rec.c64Clk, c64Data: rec.c64Data,
        drvClk: rec.drvClk, drvData: rec.drvData, drvAtnAck: rec.drvAtnAck,
      });
    });

    // Spec 704 §11 R3 — legacy GCR-shifter / head trace wiring removed
    // (byte_ready / sync / head_step / motor / density). The vice drive
    // owns the GCR pipeline; equivalent trace lanes, if needed, come from
    // vice1541 via the drive1541 facade.

    // Spec 723.7d: the VIC raster/frame trace bridge (vic.onRasterLine /
    // onFrame) is removed — those hooks fired only from the deleted batched
    // VicIIVice.tick(). The product VIC trace comes off the literal port.

    // Spec 205-A c8: bridge CIA1 + CIA2 chip-side IRQ flag sets into
    // the "cia" trace channel. bits encode CIA_IM_* (TA=0x01, TB=0x02,
    // ALARM=0x04, SDR=0x08, FLAG=0x10).
    this.cia1.onIrqFlagSet = (bits, clk) => {
      if (!this.traceRegistry.isEnabled("cia")) return;
      this.traceCtrl.publish("cia", clk, { chip: "cia1", bits });
    };
    this.cia2.onIrqFlagSet = (bits, clk) => {
      if (!this.traceRegistry.isEnabled("cia")) return;
      this.traceCtrl.publish("cia", clk, { chip: "cia2", bits });
    };

    // Spec 203-c4: install onInterruptServiced on c64 + drive CPUs so
    // every vector fetch backfills `servicedClock` on the matching
    // ring entry. Kernel installs once on the current Cpu6510 here;
    // when IntegratedSession swaps c64Cpu to Cpu65xxVice for
    // microcoded mode, the swap path re-installs through
    // `installCpuInterruptHooks`.
    this.installCpuInterruptHooks();

    // Spec 611 phase 611.7e.4 + Spec 704 §11 R3 — VICE1541 is the only
    // drive. Construct it and bridge the C64-side IEC view through it.
    this.drive1541 = createDrive1541();
    // Narrow C64-IEC ↔ Vice1541 bridge: routes the C64-side $DD00
    // write/read path through Vice1541, wrapping the EXISTING IecBus
    // public surface — does NOT mutate IecBusCore formulas, CIA2 PA
    // inversion/DDR handling, setC64Output()/buildC64InputBits()
    // semantics, pushFlush order, or ATN edge polarity.
    this.installVice1541Bridge(this.drive1541);
    // Spec 612 T3.6 — per-instruction vice drive tick: EventCatchupStrategy
    // also calls vice.catchUpTo so the drive 6502 runs lockstep with the
    // c64 (not only on $DD00 pushFlush events).
    const viceForTick = this.drive1541;
    this.eventCatchup.setAdditionalCatchUp((targetClock) => {
      viceForTick.catchUpTo(targetClock);
    });
  }

  /**
   * Spec 611 phase 611.7e.4 + Spec 612 T3.1 — narrow bridge that wires
   * the C64-side IEC view through Vice1541. When `drive1541="vice"`:
   *
   *   1. `IecBus.setC64Output` POST-hook mirrors the **C64-side
   *      intent** (from `core.cpu_bus` bits, NOT combined-bus
   *      getters) to `Vice1541.iecLineDrive(...)`. Combined-bus
   *      lines include drive pulls and would feed back into the
   *      C64-side contribution.
   *
   *   2. `IecBus.pushFlush.{one,all}` re-targets:
   *        a. `vice.catchUpTo(clk)`
   *        b. `vice.flush()`
   *        c. overlay `core.drv_data[8]` from the **new** vice1541
   *           iecbus.ts singleton (`iecbus_drive_port()`), NOT the
   *           legacy core closure refs (Spec 612 T3.1 acceptance)
   *        d. `core.recompute_drv_bus(8)`
   *        e. `core.iec_update_ports()`
   *
   * The overlay still goes into the legacy `IecBus.core` so the
   * C64-side `$DD00` read still returns the combined value through
   * the established formulas. ATN edge polarity, CIA2 PA inversion,
   * pushFlush invocation order — ALL unchanged.
   */
  private installVice1541Bridge(vice: Drive1541): void {
    const iec = this.iecBus;
    const core = (iec as unknown as {
      core: {
        cpu_bus: number;
        drv_data: Record<number, number>;
        recompute_drv_bus(unit: number): void;
        iec_update_ports(): void;
      };
    }).core;

    // Spec 612 T3.1 — read drv_data[8] from the new vice1541 iecbus.ts
    // singleton via vice_iecbus_drive_port (top-of-file import). The
    // canonical iecbus.iecbus state is the source of truth for the
    // drive-side overlay; the facade and the bridge both read it.
    const drvData8Live = (): number => {
      const bus = vice_iecbus_drive_port();
      return (bus.drv_data[8] ?? 0xff) & 0xff;
    };

    // Encode Vice1541.iecLineSample() into VICE drv_data[8] byte
    // form: bit 1 = data, bit 3 = clk, bit 4 = atna; 1 = released,
    // 0 = pulled. 0xe5 overlay preserves non-IEC bits (driveid stays
    // high). Used by the pushFlush wrapper below.
    function viceSampleToDrvData8(): number {
      const s = vice.iecLineSample();
      return (
        (s.drv_data_pull ? 0 : 0x02) |
        (s.drv_clk_pull ? 0 : 0x08) |
        (s.drv_atna_pull ? 0 : 0x10) |
        0xe5
      ) & 0xff;
    }

    // Spec 614.3 — per-cycle overlay extracted as a shared helper.
    // Sources drv_data[8] from the vice1541 iecbus.ts singleton; fall
    // back to facade encoding when the singleton lookup fails (test
    // fixtures that don't import the port).
    const overlayFromVice = (): void => {
      let live: number;
      try {
        live = drvData8Live();
      } catch {
        live = viceSampleToDrvData8();
      }
      core.drv_data[8] = live;
      core.recompute_drv_bus(8);
      core.iec_update_ports();
    };

    // Spec 614.3 — expose the overlay so the scheduler can invoke it
    // every c64 cycle. Without per-cycle overlay, legacy core.drv_port
    // is only refreshed on $DD00 writes (via pushFlush below); reads
    // from $DD00 between writes see stale drive state.
    this.viceCycleOverlay = overlayFromVice;

    // 1. Codex P0 item 2 (2026-05-19) — pushFlush restores per-event
    //    drive catch-up BEFORE the overlay. Spec 614.4 had stripped
    //    `vice.catchUpTo(clk)` on the (wrong) assumption that the
    //    Spec 614.3 per-c64-cycle tick covered all events. But VICE's
    //    `iecbus_cpu_read_conf1` (iecbus.c:227) and
    //    `iecbus_cpu_write_conf1` (iecbus.c:255) BOTH call
    //    `drive_cpu_execute_one/all(clock)` AT THE EXACT C64-SIDE
    //    READ/WRITE INSTANT — sub-cycle resolution within a single
    //    c64 instruction. The afterCycleSync per-c64-cycle tick only
    //    advances drive at c64-cycle boundaries, missing the precise
    //    sub-cycle alignment for $DD00 R/W timing.
    //
    //    With drive caught up to the exact event clock, the overlay +
    //    ATN-edge CA1 signal that follow happen with state and IRQs
    //    aligned to VICE. Without it, ATN-edge CA1 fires at a stale
    //    drive clock and the drive's bit-bang routine misses edges.
    //
    //    Spec 614.4 strip was REGRESSION, not improvement. Restoring.
    //
    //    VICE cite: src/iecbus/iecbus.c:227 (iecbus_cpu_read_conf1) +
    //    iecbus.c:255 (iecbus_cpu_write_conf1) — drive_cpu_execute_*
    //    is the FIRST call before iec_update_cpu_bus / overlay.
    iec.pushFlush = {
      one: (unit, clk, _cs) => {
        if (unit !== 8) return; // single-1541 baseline
        vice.tickToClock(clk >>> 0);  // = drive_cpu_execute_one(unit, clk)
        overlayFromVice();
      },
      all: (clk, _cs) => {
        vice.tickToClock(clk >>> 0);  // = drive_cpu_execute_all(clk)
        overlayFromVice();
      },
    };

    // 2. $DD00 write — wrap setC64Output post-hook. Pass C64-side
    //    INTENT from core.cpu_bus, NOT combined-bus getters.
    //    Per VICE iec_update_cpu_bus (c64iec.c):
    //      cpu_bus bit 4 (0x10) = ATN released  (1 = C64 not asserting)
    //      cpu_bus bit 6 (0x40) = CLK released
    //      cpu_bus bit 7 (0x80) = DATA released
    //
    //    Codex P0 item 3 (2026-05-19): post-hook fires
    //    `vice.iecLineDrive(..., effClk)` with the c64-side write
    //    instant (= maincpu_clk + write_offset per c64cia2.c:162).
    //    Vice1541Facade.iecLineDrive (item 1) now uses that effClk
    //    when dispatching `_maybe_call_iecbus_callback_write` →
    //    `iecbus_cpu_write_conf1(tmp, effClk)` →
    //    `drive_cpu_execute_one(unit, effClk)` (un-stubbed via
    //    Spec 614.5 commit ef88f17). Drive now catches up to the
    //    exact write instant BEFORE iec_update_cpu_bus + ATN-edge
    //    viacore_signal(CA1) mutate state — matches VICE order.
    const origSetC64Output = iec.setC64Output.bind(iec);
    iec.setC64Output = (cia2Pa, ddrMask, effClk, cs) => {
      origSetC64Output(cia2Pa, ddrMask, effClk, cs);
      vice.iecLineDrive({
        bus_atn: (core.cpu_bus & 0x10) !== 0,
        bus_clk: (core.cpu_bus & 0x40) !== 0,
        bus_data: (core.cpu_bus & 0x80) !== 0,
      }, effClk);
    };

    // 3. buildC64InputBits wrapper not needed — pushFlush.all (item 2)
    //    performs the drive catch-up + overlay + recompute, so the
    //    original method's subsequent reads of core.cpu_port already
    //    reflect Vice1541 state at the c64-side read instant.
    //    Spec 614.3 per-cycle overlay also keeps it fresh between
    //    pushFlush events.
  }

  /**
   * Spec 203-c4: (re)install onInterruptServiced on the current c64
   * + drive CPU instances. IntegratedSession calls this after swapping
   * c64Cpu to Cpu65xxVice in microcoded mode.
   */
  installCpuInterruptHooks(): void {
    const c64Hook = (vectorAddress: number, clk: number) => {
      const line: import("./kernel-irq.js").KernelIrqLine =
        vectorAddress === 0xfffa ? "nmi" : "irq";
      this.markIrqServiced("c64-cpu", line, clk);
    };
    (this.c64Cpu as { onInterruptServiced?: typeof c64Hook }).onInterruptServiced = c64Hook;
    // Spec 704 §11 R3 — legacy DriveCpu interrupt-serviced hook removed
    // (was already skipped in vice mode; the vice drive owns its own
    // interrupt servicing).

    // Spec 205-A c4 + Spec 217: instruction-complete edges → "cpu"
    // trace channel. Hook receives full register state at boundary so
    // the trace store can record A/X/Y/SP/P + opcode alongside PC.
    type InstrHook = (
      prevPc: number,
      opcode: number,
      b1: number,
      b2: number,
      a: number,
      x: number,
      y: number,
      sp: number,
      p: number,
      clk: number,
    ) => void;
    const c64InstrHook: InstrHook = (prevPc, opcode, b1, b2, a, x, y, sp, p, clk) => {
      this.publishCpuInstruction("c64", prevPc, opcode, b1, b2, a, x, y, sp, p, clk);
    };
    (this.c64Cpu as { onInstructionComplete?: InstrHook }).onInstructionComplete = c64InstrHook;
    // Spec 704 §11 R3 — legacy DriveCpu instruction-complete hook removed
    // (was already skipped in vice mode; the vice drive owns its tracing).
  }

  /**
   * Spec 205-A c4 + Spec 217: publish a CPU instruction-complete
   * event to the "cpu" trace channel with full post-instruction
   * register state. No-op when channel mode = "off" AND no observer
   * is attached (TraceRegistry.publish short-circuits before per-channel
   * dispatch but observers fire regardless — see Spec 217 option B).
   */
  publishCpuInstruction(
    side: "c64" | "drive",
    prevPc: number,
    opcode: number,
    b1: number,
    b2: number,
    a: number,
    x: number,
    y: number,
    sp: number,
    p: number,
    clk: number,
  ): void {
    // Fast path: skip when neither channel nor observer wants it.
    if (!this.traceRegistry.isEnabled("cpu") && !this.traceRegistry.hasObservers()) return;
    this.traceCtrl.publish("cpu", clk, {
      side,
      pc: prevPc & 0xffff,
      opcode: opcode & 0xff,
      b1: b1 & 0xff,
      b2: b2 & 0xff,
      a: a & 0xff,
      x: x & 0xff,
      y: y & 0xff,
      sp: sp & 0xff,
      p: p & 0xff,
      clk,
    });
  }

  /**
   * Spec 204: hook fire entry point. Mode-gated; throws
   * HookForbiddenError if mode (currently always `debug-lockstep`
   * until Spec 207 widens) is not in the hook's allowed modes.
   */
  recordHookFire(name: HookName, description?: string): void {
    this.hooks.recordFire(name, this.c64Cpu.cycles, description);
  }

  /**
   * Spec 207 widens this. Until then only `debug-lockstep` and
   * `true-drive` are valid; switching to `true-drive` enables the
   * hook-hygiene audit (every hook fire throws).
   */
  setMode(mode: KernelMode): void {
    this.mode = mode;
  }

  getMode(): KernelMode {
    return this.mode;
  }

  c64Clock(): number {
    return this.c64Cpu.cycles;
  }

  driveClock(device: number): number {
    if (device !== 8) {
      throw new Error(
        `[kernel] driveClock(${device}) — only device 8 mounted in this session`,
      );
    }
    // Spec 704 §11 R3 — vice-only: the legacy DriveCpu clock is gone. The
    // vice drive shares the c64 master clock domain (see driveClockSource),
    // so report that. A precise per-unit clk_ptr read on the vice
    // diskunit_context is a future facade accessor.
    return (this.c64Cpu as { cycles: number }).cycles;
  }

  /**
   * Spec 203-c1: emit a timestamped IRQ / NMI / SO / CA1 / CB1 event.
   * Chip backends call this on every line edge. The kernel ring
   * preserves up to 4096 most-recent events for diff tooling.
   *
   * Spec 205-A c3: also publishes the event to the "irq" trace
   * channel so first-divergence tooling sees IRQs and bus accesses
   * on one timeline. No-op when channel mode = "off".
   */
  emitIrqEvent(event: Omit<KernelIrqEvent, "seq">): KernelIrqEvent {
    const stamped = this.irqRing.emit(event);
    if (this.traceRegistry.isEnabled("irq")) {
      this.traceCtrl.publish("irq", stamped.edgeClock, {
        line: stamped.line,
        asserted: stamped.asserted,
        source: stamped.source,
        target: stamped.target,
        edgeClock: stamped.edgeClock,
        visibleClock: stamped.visibleClock,
        seq: stamped.seq,
      });
    }
    return stamped;
  }

  /** Spec 203-c1: read the IRQ event ring. */
  irqEvents(): readonly KernelIrqEvent[] {
    return this.irqRing.read();
  }

  /**
   * Spec 203-c4: stamp `servicedClock` on the latest unfilled
   * asserted event matching {target, line}. Called from the CPU IRQ
   * / NMI vector-fetch entry on both Cpu6510 (via session
   * `checkC64Interrupts`) and Cpu65xxVice (via `onInterruptServiced`
   * callback installed by the kernel).
   */
  markIrqServiced(
    target: import("./kernel-irq.js").KernelIrqTarget,
    line: import("./kernel-irq.js").KernelIrqLine,
    clock: number,
  ): void {
    const stamped = this.irqRing.markServiced(target, line, clock);
    if (stamped && this.traceRegistry.isEnabled("irq")) {
      // Spec 205-A c3: emit a "serviced" follow-up so consumers can
      // pair the original edge with its vector-fetch cycle without
      // walking the full ring themselves.
      this.traceCtrl.publish("irq", clock, {
        kind: "serviced",
        line: stamped.line,
        target: stamped.target,
        source: stamped.source,
        edgeClock: stamped.edgeClock,
        servicedClock: clock,
        seq: stamped.seq,
      });
    }
  }

  /**
   * Spec 202: cross-domain catch-up. Caller (kernel-internal only)
   * advances the drive clock to `targetClock` before observing a
   * cross-domain access. This is the single legitimate entry point
   * for advancing the drive from outside DriveCpu's own
   * scheduler-driven path.
   *
   * In `debug-lockstep` mode this is a no-op (drive ticks per c64
   * cycle). In `true-drive` mode (Spec 202 default flip) it invokes
   * `drive.executeToClock(targetClock)`.
   */
  catchUpDrive(device: number, targetClock: number, cycleStepped: boolean = false): void {
    this.syncStrategy().catchUpDrive(device, targetClock, cycleStepped);
  }

  runCycles(n: number): void {
    this.syncStrategy().runCycles(n);
  }

  runInstructions(n: number): void {
    this.syncStrategy().runInstructions(n);
  }

  private syncStrategy(): SyncStrategy {
    // Spec 723.7b: event-catchup is the only drive-sync strategy.
    return this.eventCatchup;
  }

  /** Live C64 color RAM ($D800-$DBFF) view — separate 1K nibble RAM in io. */
  private colorRamView(): Uint8Array {
    return new Uint8Array(this.c64Bus.io.buffer, this.c64Bus.io.byteOffset + 0x0800, 0x0400);
  }

  // Spec 705.A step 3 — native RuntimeCheckpoint capture. Contract: called at
  // an atomic CPU instruction boundary with the controller paused (Cpu65xxVice
  // mid-instruction `inst` is null at a boundary, so register/clk capture is
  // deterministic). reSID PCM is the explicit follow-on (step 4); SID
  // software-visible registers ARE captured.
  snapshot(): MachineSnapshot {
    const cpu = this.c64Cpu as unknown as {
      pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number;
      maincpu_ba_low_flags?: number; soLine?: number; jammed?: boolean;
    };
    const cs = this.cpuIntStatus;
    const core = this.iecBus.core;
    const j1 = this.joystick1, j2 = this.joystick2;
    const payload: RuntimeCheckpoint = {
      schemaVersion: RUNTIME_CHECKPOINT_SCHEMA_VERSION,
      atInstructionBoundary: true,
      cpu: {
        pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, flags: cpu.flags, cycles: cpu.cycles,
        maincpu_ba_low_flags: cpu.maincpu_ba_low_flags, soLine: cpu.soLine, jammed: cpu.jammed,
      },
      ram: this.c64Bus.ram.slice(),
      cpuPortDirection: this.c64Bus.getCpuPortDirection(),
      cpuPortValue: this.c64Bus.getCpuPortValue(),
      cia1: this.cia1.snapshot(),
      cia2: this.cia2.snapshot(),
      sid: this.sid.snapshot(),
      iec: {
        cpu_bus: core.cpu_bus, cpu_port: core.cpu_port, drv_port: core.drv_port,
        iec_old_atn: core.iec_old_atn,
        drv_bus: Array.from(core.drv_bus), drv_data: Array.from(core.drv_data),
      },
      cpuIntStatus: {
        pendingInt: [...cs.pendingInt], intNames: [...cs.intNames],
        nirq: cs.nirq, nnmi: cs.nnmi, irqClk: cs.irqClk, nmiClk: cs.nmiClk,
        irqDelayCycles: cs.irqDelayCycles, nmiDelayCycles: cs.nmiDelayCycles,
        irqPendingClk: cs.irqPendingClk, globalPendingInt: cs.globalPendingInt,
        lastStolenCyclesClk: cs.lastStolenCyclesClk,
      },
      keyboard: { livePressed: this.keyboard.livePressedKeys() as string[] },
      joystick1: { up: j1.up, down: j1.down, left: j1.left, right: j1.right, fire: j1.fire },
      joystick2: { up: j2.up, down: j2.down, left: j2.left, right: j2.right, fire: j2.fire },
      paddles: Array.from(this.paddles),
      vic: vicii_snapshot_write(this.colorRamView()),
      vicPresentation: this.session.captureVicPresentation(),
      // Spec 710.4/710.5 — same-frame raster/FLI provenance for THIS frozen
      // frame (null when capture off). Rides the payload so it is durable across
      // ring / .c64re / restore; inspect reads it from the checkpoint.
      vicProvenance: this.session.captureVicProvenance(),
      drive1541: this.drive1541 ? this.drive1541.snapshot() : null,
      // Spec 714.4 — capture the mutable disk image apart from the core blob so
      // the ring can content-address + dedup it (one copy per disk identity).
      driveDiskImage: this.drive1541?.snapshotDiskImage?.() ?? null,
      // Spec 714.5 — large cartridge byte payloads captured apart from the media
      // metadata so the ring dedups them (the original .crt is constant; flash
      // varies only on writes).
      cartBytes: this.captureCartBytes(),
      cartFlash: this.captureCartFlash(),
      media: this.captureMediaCheckpoint(),
      alarmsMaincpu: this.alarms.maincpu ? alarmContextCaptureSchedule(this.alarms.maincpu) : [],
      // Spec 705.A step 4 — optional reSID audio slice when a recorder is
      // registered; null otherwise (core checkpoint works without audio).
      audio: this.session.audioCheckpointProvider
        ? this.session.audioCheckpointProvider.snapshot()
        : null,
    };
    return { schemaVersion: RUNTIME_CHECKPOINT_SCHEMA_VERSION, payload };
  }

  // Spec 705.A step 3 — native RuntimeCheckpoint restore. Same instruction-
  // boundary contract. Order: RAM → CPU-port (re-runs PLA banking) → CPU regs
  // → CIA → SID → IEC core → IRQ status → input → literal VIC → VIC
  // presentation → drive blob.
  restore(snap: MachineSnapshot): void {
    if (snap.schemaVersion !== RUNTIME_CHECKPOINT_SCHEMA_VERSION || snap.payload == null) {
      throw new Error(
        `[kernel] restore: unexpected checkpoint schemaVersion ${snap.schemaVersion} / null payload`,
      );
    }
    const cp = snap.payload as RuntimeCheckpoint;

    this.c64Bus.ram.set(cp.ram.subarray(0, this.c64Bus.ram.length));
    this.c64Bus.setCpuPort(cp.cpuPortDirection, cp.cpuPortValue);

    const cpu = this.c64Cpu as unknown as {
      pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number;
      maincpu_ba_low_flags?: number; soLine?: number; jammed?: boolean;
    };
    cpu.pc = cp.cpu.pc; cpu.a = cp.cpu.a; cpu.x = cp.cpu.x; cpu.y = cp.cpu.y;
    cpu.sp = cp.cpu.sp; cpu.flags = cp.cpu.flags; cpu.cycles = cp.cpu.cycles;
    if (cp.cpu.maincpu_ba_low_flags !== undefined && "maincpu_ba_low_flags" in cpu) cpu.maincpu_ba_low_flags = cp.cpu.maincpu_ba_low_flags;
    if (cp.cpu.soLine !== undefined && "soLine" in cpu) cpu.soLine = cp.cpu.soLine;
    if (cp.cpu.jammed !== undefined && "jammed" in cpu) cpu.jammed = cp.cpu.jammed;

    this.cia1.restore(cp.cia1);
    this.cia2.restore(cp.cia2);
    this.sid.restore(cp.sid);

    const core = this.iecBus.core;
    core.cpu_bus = cp.iec.cpu_bus; core.cpu_port = cp.iec.cpu_port;
    core.drv_port = cp.iec.drv_port; core.iec_old_atn = cp.iec.iec_old_atn;
    core.drv_bus.set(cp.iec.drv_bus.slice(0, core.drv_bus.length));
    core.drv_data.set(cp.iec.drv_data.slice(0, core.drv_data.length));

    const cs = this.cpuIntStatus;
    cs.pendingInt.length = 0; cs.pendingInt.push(...cp.cpuIntStatus.pendingInt);
    cs.intNames.length = 0; cs.intNames.push(...cp.cpuIntStatus.intNames);
    cs.nirq = cp.cpuIntStatus.nirq; cs.nnmi = cp.cpuIntStatus.nnmi;
    cs.irqClk = cp.cpuIntStatus.irqClk; cs.nmiClk = cp.cpuIntStatus.nmiClk;
    cs.irqDelayCycles = cp.cpuIntStatus.irqDelayCycles; cs.nmiDelayCycles = cp.cpuIntStatus.nmiDelayCycles;
    cs.irqPendingClk = cp.cpuIntStatus.irqPendingClk; cs.globalPendingInt = cp.cpuIntStatus.globalPendingInt;
    cs.lastStolenCyclesClk = cp.cpuIntStatus.lastStolenCyclesClk;

    this.keyboard.releaseAllLive();
    for (const k of cp.keyboard.livePressed) this.keyboard.setKeyDown(k);
    const j1 = this.joystick1, j2 = this.joystick2;
    j1.up = cp.joystick1.up; j1.down = cp.joystick1.down; j1.left = cp.joystick1.left; j1.right = cp.joystick1.right; j1.fire = cp.joystick1.fire;
    j2.up = cp.joystick2.up; j2.down = cp.joystick2.down; j2.left = cp.joystick2.left; j2.right = cp.joystick2.right; j2.fire = cp.joystick2.fire;
    this.paddles.set(cp.paddles.slice(0, this.paddles.length));

    vicii_snapshot_read(cp.vic, this.colorRamView());
    this.session.restoreVicPresentation(cp.vicPresentation);
    // Spec 710.4/710.5 — repopulate same-frame provenance so a fresh inspect
    // capture after restore/undump reflects THIS frame, not a later one.
    this.session.restoreVicProvenance(cp.vicProvenance ?? null);

    if (cp.drive1541 && this.drive1541) {
      this.drive1541.restore(cp.drive1541);
      // Spec 714.4 — after the core blob rebuilds the drive + GCR buffer, overlay
      // the mutable disk image (GCRIMAGE) so the written tracks are restored
      // (mutable-wins, §6.1). null = no disk image captured (empty drive / older
      // checkpoint that embedded the disk in the core blob).
      const diskImage = cp.driveDiskImage;
      if (diskImage && diskImage.byteLength > 0) this.drive1541.restoreDiskImage?.(diskImage);
    }

    // Spec 709.7 / 714.5 — restore the attached cartridge: recreate the mapper
    // from the original .crt bytes, restore its bank/control state, overlay the
    // mutable flash image (714.5), re-attach (or detach if no cartridge).
    this.restoreMediaCheckpoint(cp.media, cp.cartBytes ?? null, cp.cartFlash ?? null);

    // Re-arm the maincpu alarm schedule LAST, after all chip-state restore, so
    // the captured CIA timer/TOD/SDR/idle alarm clks line up with the restored
    // master clock and override any partial per-chip re-derivation.
    if (this.alarms.maincpu) alarmContextRestoreSchedule(this.alarms.maincpu, cp.alarmsMaincpu);

    // Spec 705.A step 4 — optional reSID audio restore. The provider restores
    // the VICE-shaped synthesis state (no register replay) and FLUSHES the live
    // PCM transport (pre-restore buffered audio is dropped + re-buffered).
    if (cp.audio != null && this.session.audioCheckpointProvider) {
      this.session.audioCheckpointProvider.restore(cp.audio as never);
    }
  }

  // Spec 709.7 — build the media slice of a checkpoint: disk identity + (when a
  // cartridge is attached) embedded .crt bytes + sha256 + mapper continuation
  // state. The bytes ride in the payload → the 707 codec serializes them to
  // .c64re.
  private captureMediaCheckpoint(): RuntimeCheckpointMedia {
    const media: RuntimeCheckpointMedia = { diskPath: this.diskPath, imageFormat: this.imageFormat };
    const cart = this.c64Bus.getCartridge();
    const cartMedia = this.c64Bus.getCartridgeMedia();
    if (cart && cartMedia) {
      // Spec 714.5 — metadata only; the big .crt bytes + flash image ride in
      // top-level cartBytes/cartFlash so the ring can dedup them.
      media.cartridge = {
        name: cartMedia.name,
        sha256: snapshotSha256(cartMedia.bytes),
        mapperType: cart.getMapperType(),
        state: cart.getState(),
      };
    }
    return media;
  }

  // Spec 714.5 — the attached cartridge's original .crt bytes (constant; pooled),
  // or null when no cartridge.
  private captureCartBytes(): Uint8Array | null {
    const cart = this.c64Bus.getCartridge();
    const cartMedia = this.c64Bus.getCartridgeMedia();
    return cart && cartMedia ? cartMedia.bytes : null;
  }

  // Spec 714.5 — the attached cartridge's mutable device image (flash low+high),
  // or null when the cart has no writable hardware state.
  private captureCartFlash(): Uint8Array | null {
    return this.c64Bus.getCartridge()?.getWritableImage?.() ?? null;
  }

  // Spec 709.7 / 714.5 — restore the cartridge medium (or detach if none).
  // Rebuilds the mapper from the original .crt bytes, restores bank/control
  // state, then overlays the mutable flash image (mutable-wins).
  private restoreMediaCheckpoint(
    media: RuntimeCheckpointMedia,
    cartBytes: Uint8Array | null,
    cartFlash: Uint8Array | null,
  ): void {
    const c = media.cartridge;
    if (!c || !cartBytes) { this.c64Bus.attachCartridge(undefined); return; }
    const bytes = cartBytes instanceof Uint8Array ? cartBytes : new Uint8Array(cartBytes as ArrayLike<number>);
    const mapper = loadCartridgeMapperFromBytes(bytes, c.name);
    mapper.setState(c.state as HeadlessCartridgeState);
    if (cartFlash && cartFlash.byteLength > 0) mapper.setWritableImage?.(cartFlash);
    this.c64Bus.attachCartridge(mapper, { bytes, name: c.name });
  }

  mountMedia(device: number, media: MountedMedia): void {
    if (device !== 8) {
      throw new Error(
        `[kernel] mountMedia(${device}) — only device 8 supported in Spec 200`,
      );
    }
    // Spec 205-A c10: publish to session channel.
    if (this.traceRegistry.isEnabled("session")) {
      this.traceCtrl.publish("session", this.c64Cpu.cycles, {
        kind: "media_mount",
        device,
        imagePath: media.imagePath,
        bytes: media.bytes.length,
      });
    }
  }

  /**
   * Spec 205-A c10: explicit notify entry for IntegratedSession to call
   * after every cold reset. The kernel itself can't observe the
   * reset — IntegratedSession owns resetCold and must publish.
   */
  notifyReset(profile: string): void {
    if (this.traceRegistry.isEnabled("session")) {
      this.traceCtrl.publish("session", this.c64Cpu.cycles, {
        kind: "reset_cold",
        profile,
      });
    }
  }

  /** Spec 205-A c10: keyboard / joystick input change publish. */
  notifyInputChange(kind: "keyboard" | "joystick", detail: Record<string, unknown>): void {
    const channel = kind;
    if (!this.traceRegistry.isEnabled(channel)) return;
    this.traceCtrl.publish(channel, this.c64Cpu.cycles, detail);
  }

  trace(): KernelTraceController {
    return this.traceCtrl;
  }

  status(): KernelStatus {
    return {
      mode: this.mode,
      c64Clock: this.c64Clock(),
      driveClocks: { 8: this.driveClock(8) },
      hooks: this.hooks.list(),
      mediaSlots: [
        { device: 8, mounted: true, imagePath: this.session.diskPath },
      ],
      video: this.video,
    };
  }
}
