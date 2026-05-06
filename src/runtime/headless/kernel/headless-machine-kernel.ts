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
import type { IntegratedSession } from "../integrated-session.js";
import type { VideoSystem } from "./clock-domains.js";
import type { MachineKernel, MachineSnapshot, MountedMedia } from "./machine-kernel.js";
import type { KernelStatus, KernelMode } from "./kernel-status.js";
import type { KernelTraceController } from "./kernel-trace.js";
import { KernelTraceControllerImpl } from "./kernel-trace.js";
import { TraceRegistry } from "../trace/channels.js";
import type { AlarmContext } from "../alarm/alarm-context.js";
import { alarmContextNew } from "../alarm/alarm-context.js";
import { Cpu6510 } from "../cpu6510.js";
import { HeadlessMemoryBus } from "../memory-bus.js";
import { loadAllC64Roms, type LoadedC64RomSet } from "../c64-rom.js";
import { IecBus } from "../iec/iec-bus.js";
import { VicIIVice, installVicIIVice, type VicBackend } from "../vic/vic-ii-vice.js";
import { installSid, type Sid6581 } from "../sid/sid.js";
import { VicFramebuffer } from "../peripherals/vic-renderer.js";
import { installCia1 } from "../peripherals/cia1.js";
import type { KeyboardMatrix, JoystickState } from "../peripherals/keyboard.js";
import { installCia2 } from "../peripherals/cia2.js";
import type { Cia6526Vice } from "../cia/cia6526-vice.js";
import { DriveCpu } from "../drive/drive-cpu.js";
import { TrackBuffer, HeadPosition } from "../drive/head-position.js";
import { GcrShifter } from "../drive/gcr-shifter.js";
import { G64Parser } from "../../../disk/g64-parser.js";
import { buildG64 } from "../../../disk/g64-builder.js";
import { DiskProvider } from "../providers.js";
import { HeadlessKernelBus } from "./headless-kernel-bus.js";
import { KernelIrqRing, type KernelIrqEvent } from "./kernel-irq.js";
import { HookRegistry, type HookName } from "./kernel-hooks.js";

export interface HeadlessMachineKernelDeps {
  session: IntegratedSession;
  video: VideoSystem;
  diskPath: string;
  imageFormat: string;
  deviceId: number;
  startTrack: number;
  writeProtected?: boolean;
  useMicrocodedCpu: boolean;
  useCycleLockstep: boolean;
  driveCyclesPerC64Cycle: number;
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

  // Spec 204: TrueDrive hook hygiene. Mode is widened by Spec 207; for
  // now `mode` is a private mutable field starting at "debug-lockstep".
  // `hooks` registers every legacy rescue hook; `recordHookFire` is the
  // single entry point hook callsites use to record + audit fires.
  private mode: KernelMode = "debug-lockstep";
  readonly hooks: HookRegistry = new HookRegistry(() => this.mode);

  // Spec 200-c3: shared IEC bus. Created here because both C64 (CIA2)
  // and drive sides reference it; ownership belongs to the kernel.
  readonly iecBus: IecBus;

  // Spec 200-c3: C64 side chips. Constructed by the kernel; session
  // reads them for backward-compat field access.
  readonly c64Bus: HeadlessMemoryBus;
  readonly romSet: LoadedC64RomSet;
  // Mutable: Cpu65xxVice may replace Cpu6510 during scheduler init in
  // commit 200-c5 when useMicrocodedCpu is set.
  c64Cpu: Cpu6510;
  readonly cia1: Cia6526Vice;
  readonly cia2: Cia6526Vice;
  readonly cia1IrqLine: () => boolean;
  readonly cia2NmiLine: () => boolean;
  readonly keyboard: KeyboardMatrix;
  readonly joystick1: JoystickState;
  readonly joystick2: JoystickState;
  readonly paddles: Uint8Array = new Uint8Array(4); // [POTAX, POTAY, POTBX, POTBY]
  readonly vic: VicIIVice;
  readonly sid: Sid6581;
  readonly framebuffer: VicFramebuffer;

  // Spec 201-c1: KernelBus instance. Concrete implementation owned by
  // kernel; cross-domain accesses ($DD00, $1800) get routed through
  // here in 201-c2 / 201-c3.
  readonly bus: HeadlessKernelBus;

  // Spec 200-c4: drive + disk side. Kernel owns parser, head, GCR
  // shifter and drive CPU; IEC drive-side wiring happens here too.
  readonly diskPath: string;
  readonly imageFormat: string;
  readonly parser: G64Parser;
  readonly diskProvider: DiskProvider;
  readonly trackBuffer: TrackBuffer;
  readonly headPosition: HeadPosition;
  readonly gcrShifter: GcrShifter;
  readonly drive: DriveCpu;

  constructor(deps: HeadlessMachineKernelDeps) {
    this.session = deps.session;
    this.video = deps.video;
    const isPal = this.video === "PAL";
    this.alarms = {
      maincpu: alarmContextNew("maincpu"),
      drivecpu: alarmContextNew("drivecpu"),
    };

    // Spec 200-c4: disk image + parser. D64 sources are pre-encoded to
    // a G64 byte stream in memory and then parsed normally. Real drive
    // ROM, real GCR pipeline, real IEC — same code path as native G64.
    this.diskPath = deps.diskPath;
    this.imageFormat = deps.imageFormat;
    let imageBytes: Uint8Array = readFileSync(this.diskPath);
    if (this.imageFormat === "d64") {
      imageBytes = buildG64({ d64: imageBytes });
    }
    this.parser = new G64Parser(imageBytes);
    this.diskProvider = DiskProvider.fromImagePath(this.diskPath);
    this.trackBuffer = new TrackBuffer(this.parser);
    // Pass G64 parser's actual half-track count so drive head can step
    // beyond standard 35-track cap. motm.g64 has 37 tracks (data up to
    // track 36) used by copy protection.
    const halfTrackCount = this.parser.getHalfTrackCount();
    this.headPosition = new HeadPosition({
      startTrack: deps.startTrack,
      defaultTrackCount: halfTrackCount > 0 ? Math.ceil(halfTrackCount / 2) : 35,
    });

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

    // CPU built BEFORE CIA install — Cia6526Vice's Ciat sub-modules
    // capture the CPU clock at construction time via clkPtr(), so the
    // CPU object must already exist. (Cpu65xxVice may replace this
    // later under useMicrocodedCpu via commit 200-c5.)
    this.c64Cpu = new Cpu6510(this.c64Bus);

    // Spec 083 / VICE-style: when C64 reads or writes IEC bus state,
    // first catch the drive CPU up to the current cycle so drive's
    // response reflects all elapsed time. Without this, drive lag
    // breaks serial bit timing.
    const ciaClkPtr = () => this.c64Cpu.cycles;
    // Spec 201-c2: CIA2 PA writes/reads route through KernelBus. We
    // pass deferred-resolution callbacks because `this.bus` is wired
    // at end of constructor; the closures resolve at runtime when CIA2
    // actually accesses PA, by which time `this.bus` exists.
    const buildC64BusCtx = (access: "read" | "write") => ({
      side: "c64" as const,
      clock: this.c64Cpu.cycles,
      pc: this.c64Cpu.pc | 0,
      opcode: 0,
      phase: "phi2" as const,
      addr: 0xdd00,
      access,
    });
    const cia2Install = installCia2(this.c64Bus, {
      alarmContext: this.alarms.maincpu,
      clkPtr: ciaClkPtr,
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
      iecWrite: (or, ddr) => {
        // Spec 201-c2: $DD00 write goes through KernelBus. The DDR
        // mask travels via BusAccessContext.ddrMask; bus dispatches
        // to IecBus.setC64Output with the full (or, ddr) tuple.
        this.bus.c64Write(0xdd00, or, { ...buildC64BusCtx("write"), ddrMask: ddr });
      },
      iecReadPins: () => this.bus.c64Read(0xdd00, buildC64BusCtx("read")),
    });
    this.cia2 = cia2Install.cia;
    this.cia2NmiLine = cia2Install.nmiLine;
    const cia1Install = installCia1(this.c64Bus, {
      alarmContext: this.alarms.maincpu,
      clkPtr: ciaClkPtr,
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
    this.cia1IrqLine = cia1Install.irqLine;
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
      stealCpuCycles: (count: number, _clk: number) => {
        // Advance C64 CPU clock past stolen window. CPU does not step;
        // scheduler drain (AlarmContextCycled) still fires for CIA timers
        // so wall-clock peripherals advance. Mirrors VICE
        // dma_maincpu_steal_cycles: maincpu_clk += count.
        (this.c64Cpu as { cycles: number }).cycles += count;
      },
      setIrqLine: (asserted: boolean, clk: number) => {
        // IRQ line state is sampled via vic.irqAsserted() in
        // checkC64Interrupts and updateMicrocodedInterruptLines —
        // no additional latching needed here. Spec 203-c3: emit
        // kernel event on edge so divergence diff has visibility into
        // raster IRQ stamping.
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
    this.sid.potReader = (idx) => this.paddles[idx === 0 ? 0 : 2] ?? 0;
    this.c64Bus.reset();

    this.framebuffer = new VicFramebuffer(isPal);

    // Spec 200-c4: 1:1 VICE GCR shifter. Constructed before DriveCpu
    // so it can be supplied (DriveCpu wires byte-ready → VIA2 CA1
    // + CPU SO line and ticks the shifter per drive cycle in lockstep).
    // Same parser + headPosition as TrackBuffer — they share the disk
    // image but the shifter is the source-of-truth for VIA2 PA reads
    // when wired (TrackBuffer remains the write-buffer for V3).
    this.gcrShifter = new GcrShifter({
      parser: this.parser,
      headPosition: this.headPosition,
    });

    // Spec 153 Step 2 — DEFAULT ON 2026-05-06: 1:1 VICE rotation.c
    // GcrShifter is the silicon-faithful GCR pipeline. Legacy
    // TrackBuffer.tickShifter remained the default through Sprint 113
    // because of "kernal-serial-smoke" risk; that worry is moot now
    // that smoke:load (L2/L3/L7 incl. MM 38KB byte-perfect) passes
    // with GcrShifter wired. Set C64RE_USE_LEGACY_GCR=1 to fall back
    // to the simplified shifter while we surface any remaining gaps
    // through diff-trace (Spec 205-B). Fastloader / GCR-protection
    // games that depend on real per-cycle bit advance need this.
    const useGcrShifter = process.env.C64RE_USE_LEGACY_GCR !== "1";

    // Drive build. Spec 090: configure sync ratio + zero baseline.
    this.drive = new DriveCpu({
      deviceId: deps.deviceId,
      iecBus: this.iecBus,
      gcr: {
        trackBuffer: this.trackBuffer,
        headPosition: this.headPosition,
        writeProtected: deps.writeProtected,
      },
      gcrShifter: useGcrShifter ? this.gcrShifter : undefined,
      // Sprint 96 part 6 (Bug 39): drive uses microcoded CPU when c64
      // does. Required for sub-instruction bus access timing during
      // IEC bit-bang.
      useMicrocodedCpu: deps.useMicrocodedCpu,
      alarmContext: this.alarms.drivecpu,
      // Spec 201-c3: $1800 PB store threads through KernelBus.
      iecStorePb: (byte, device) =>
        this.bus.driveWrite(device, 0x1800, byte, {
          side: "drive",
          device,
          clock: this.drive.cpu.cycles,
          pc: this.drive.cpu.pc | 0,
          opcode: 0,
          phase: "phi2",
          addr: 0x1800,
          access: "write",
        }),
      // Spec 203-c3: drive-side IRQ + SO edges into the kernel event
      // ring. Mirror CIA1/CIA2 pattern; targets the drive-cpu instead
      // of the c64-cpu.
      onVia1IrqEdge: (asserted, clk) => {
        this.emitIrqEvent({
          line: "irq",
          asserted,
          source: "via1",
          target: "drive-cpu",
          edgeClock: clk,
          visibleClock: clk,
        });
      },
      onVia2IrqEdge: (asserted, clk) => {
        this.emitIrqEvent({
          line: "irq",
          asserted,
          source: "via2",
          target: "drive-cpu",
          edgeClock: clk,
          visibleClock: clk,
        });
      },
      onSoEdge: (asserted, clk) => {
        this.emitIrqEvent({
          line: "so",
          asserted,
          source: "gcr-shifter",
          target: "drive-cpu",
          edgeClock: clk,
          visibleClock: clk,
        });
      },
    });
    this.iecBus.attachDriveRam(this.drive.bus.ram);
    // Spec 140 v3: 1:1 VICE port. No mode flag — VICE is THE behavior.
    // Spec 141 v2: drive clock source for ATN edge IRQ stamping.
    this.iecBus.driveClockSource = () =>
      (this.drive.cpu as { cycles: number }).cycles;
    // Spec 090: configure drive's sync ratio + zero baseline.
    this.drive.setSyncRatio(deps.driveCyclesPerC64Cycle);
    this.drive.setSyncBaseline(0);

    // Spec 090: bus-read hook for legacy non-lockstep mode. In lockstep
    // mode the scheduler drives the drive per cycle, so the hook is a
    // no-op; skip installing it to avoid double-counting steal cycles
    // (Sprint 113 Phase 2 / Spec 150 fix).
    if (!deps.useCycleLockstep) {
      // Spec 202: legacy non-lockstep IEC pre-read catch-up routed
      // through the kernel's single catchUpDrive entry point.
      this.iecBus.beforeC64Read = () =>
        this.catchUpDrive(8, this.c64Cpu.cycles);
    }

    // Spec 204: register every legacy rescue hook. `allowedModes`
    // = modes in which the hook may fire without raising
    // HookForbiddenError. None of these are allowed in `true-drive`.
    const debugOnly: readonly KernelMode[] = ["debug-lockstep"];
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

    // Spec 205-A c6: bridge GCR shifter byte-ready + SYNC# edges into
    // the "gcr" trace channel. Uses the dedicated trace observer pair
    // so DriveCpu's onByteReady (V-flag + VIA2 CA1) is untouched.
    this.gcrShifter.traceByteReady = (byte) => {
      if (!this.traceRegistry.isEnabled("gcr")) return;
      const driveClk = (this.drive.cpu as { cycles: number }).cycles;
      this.traceCtrl.publish("gcr", driveClk, {
        kind: "byte_ready",
        byte: byte & 0xff,
        track: this.headPosition.currentTrack,
      });
    };
    this.gcrShifter.traceSyncDetected = (active) => {
      if (!this.traceRegistry.isEnabled("gcr")) return;
      const driveClk = (this.drive.cpu as { cycles: number }).cycles;
      this.traceCtrl.publish("gcr", driveClk, {
        kind: "sync",
        active,
        track: this.headPosition.currentTrack,
      });
    };

    // Spec 205-A c9: head step + motor + density transitions.
    this.headPosition.onStep = (direction, halfTrack) => {
      if (!this.traceRegistry.isEnabled("gcr")) return;
      const driveClk = (this.drive.cpu as { cycles: number }).cycles;
      this.traceCtrl.publish("gcr", driveClk, {
        kind: "head_step",
        direction,
        halfTrack,
        track: halfTrack / 2,
      });
    };
    this.gcrShifter.onMotor = (on) => {
      if (!this.traceRegistry.isEnabled("gcr")) return;
      const driveClk = (this.drive.cpu as { cycles: number }).cycles;
      this.traceCtrl.publish("gcr", driveClk, {
        kind: "motor",
        on,
      });
    };
    this.gcrShifter.onDensity = (zone) => {
      if (!this.traceRegistry.isEnabled("gcr")) return;
      const driveClk = (this.drive.cpu as { cycles: number }).cycles;
      this.traceCtrl.publish("gcr", driveClk, {
        kind: "density",
        zone: zone === undefined ? null : zone,
      });
    };

    // Spec 205-A c7: bridge VIC raster line + frame transitions into
    // the "vic" trace channel.
    this.vic.onRasterLine = (raster_y, clk) => {
      if (!this.traceRegistry.isEnabled("vic")) return;
      this.traceCtrl.publish("vic", clk, {
        kind: "raster",
        raster_y,
      });
    };
    this.vic.onFrame = (clk) => {
      if (!this.traceRegistry.isEnabled("vic")) return;
      this.traceCtrl.publish("vic", clk, {
        kind: "frame",
      });
    };

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
    const driveHook = (_vectorAddress: number, clk: number) => {
      this.markIrqServiced("drive-cpu", "irq", clk);
    };
    (this.drive.cpu as { onInterruptServiced?: typeof driveHook }).onInterruptServiced = driveHook;

    // Spec 205-A c4: instruction-complete edges → "cpu" trace channel.
    // Both Cpu6510 (legacy) and Cpu65xxVice (microcoded) expose the
    // same `onInstructionComplete` shape; install per side.
    const c64InstrHook = (pc: number, clk: number) => {
      this.publishCpuInstruction("c64", pc, clk);
    };
    (this.c64Cpu as { onInstructionComplete?: typeof c64InstrHook }).onInstructionComplete = c64InstrHook;
    const driveInstrHook = (pc: number, clk: number) => {
      this.publishCpuInstruction("drive", pc, clk);
    };
    (this.drive.cpu as { onInstructionComplete?: typeof driveInstrHook }).onInstructionComplete = driveInstrHook;
  }

  /**
   * Spec 205-A c4: publish a CPU instruction-complete event to the
   * "cpu" trace channel. No-op when channel mode = "off".
   */
  publishCpuInstruction(side: "c64" | "drive", pc: number, clk: number): void {
    if (!this.traceRegistry.isEnabled("cpu")) return;
    this.traceCtrl.publish("cpu", clk, {
      side,
      pc: pc & 0xffff,
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
    return this.drive.cpu.cycles;
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
  catchUpDrive(device: number, targetClock: number): void {
    if (device !== 8) return;
    // Spec 202: gated by sync mode. Lockstep skips because drive
    // already advanced. Pre-flip we honor both paths so existing
    // callsites can migrate without behavior change.
    this.drive.executeToClock(targetClock); // audit-ok: kernel-internal Spec 202 catch-up
  }

  runCycles(n: number): void {
    // Commit 200-c5 will route this through SyncStrategy. For now
    // delegate to the existing scheduler if present, else fall through
    // to instruction-based stepping.
    const sched = this.session.scheduler;
    if (sched) {
      sched.runCycles(n);
      return;
    }
    const target = this.c64Cpu.cycles + n;
    while (this.c64Cpu.cycles < target) {
      this.session.stepC64Instruction();
    }
  }

  runInstructions(n: number): void {
    for (let i = 0; i < n; i++) this.session.stepC64Instruction();
  }

  snapshot(): MachineSnapshot {
    return { schemaVersion: 0, payload: null };
  }

  restore(_snap: MachineSnapshot): void {
    // Placeholder; real adapter lands in commit 200-c5.
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
