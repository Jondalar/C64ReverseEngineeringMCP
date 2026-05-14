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
import type { alarm_context_t } from "../alarm/alarm-context.js";
import { InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";
import { alarm_context_new } from "../alarm/alarm-context.js";
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
import {
  DriveCpu,
  C64_PAL_CYCLES_PER_SEC,
  C64_NTSC_CYCLES_PER_SEC,
} from "../drive/drive-cpu.js";
import { TrackBuffer, HeadPosition } from "../drive/head-position.js";
import { GcrShifter } from "../drive/gcr-shifter.js";
import { G64Parser } from "../../../disk/g64-parser.js";
import { buildG64 } from "../../../disk/g64-builder.js";
import { DiskProvider } from "../providers.js";
import { HeadlessKernelBus } from "./headless-kernel-bus.js";
import { KernelIrqRing, type KernelIrqEvent } from "./kernel-irq.js";
import { HookRegistry, type HookName } from "./kernel-hooks.js";
import { EventCatchupStrategy } from "./event-catchup-strategy.js";
import { LockstepStrategy } from "./lockstep-strategy.js";
import type { SyncStrategy } from "./sync-strategy.js";
import { vicii_set_vbank as litViciiSetVbank } from "../vic/literal/vicii.js";

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
  useMicrocodedCpu: boolean;
  useCycleLockstep: boolean;
  driveCyclesPerC64Cycle: number;
}

export interface KernelAlarmContexts {
  readonly maincpu: alarm_context_t;
  readonly drivecpu: alarm_context_t;
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
  /** Spec 309 Phase D: shared with Cpu65xxVice — chips push setIrq/setNmi here. */
  readonly cpuIntStatus: InterruptCpuStatus;
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
  private readonly eventCatchup: EventCatchupStrategy;

  // Spec 200-c4: drive + disk side. Kernel owns parser, head, GCR
  // shifter and drive CPU; IEC drive-side wiring happens here too.
  // diskPath empty / diskProvider undefined when booted with no media
  // (like real C64 + 1541 powered with no disk).
  readonly diskPath: string;
  readonly imageFormat: string;
  readonly parser: G64Parser;
  diskProvider?: DiskProvider;
  readonly trackBuffer: TrackBuffer;
  readonly headPosition: HeadPosition;
  readonly gcrShifter: GcrShifter;
  readonly drive: DriveCpu;

  constructor(deps: HeadlessMachineKernelDeps) {
    this.session = deps.session;
    this.video = deps.video;
    const isPal = this.video === "PAL";
    this.alarms = {
      maincpu: alarm_context_new("maincpu"),
      drivecpu: alarm_context_new("drivecpu"),
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
    // Spec 309 Phase D: shared InterruptCpuStatus instance — chips push
    // setIrq/setNmi here; Cpu65xxVice reads globalPendingInt at opcode boundary.
    this.cpuIntStatus = new InterruptCpuStatus();
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
      stealCpuCycles: (count: number, _clk: number) => {
        (this.c64Cpu as { cycles: number }).cycles += count;
      },
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

    // Spec 213 — GcrShifter (1:1 VICE rotation.c) ALWAYS ON. Legacy
    // TrackBuffer.tickShifter path removed 2026-05-08 with motm boot
    // confirmed via head-cap fix (commit d927a1a) + MM/motm/IM2 title
    // screens rendering. Feature flag retired per Spec 213 acceptance.
    const useGcrShifter = true;

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
    const cyclesPerSec = isPal
      ? C64_PAL_CYCLES_PER_SEC
      : C64_NTSC_CYCLES_PER_SEC;
    this.drive.driveSetMachineParameter(cyclesPerSec);
    this.drive.setSyncBaseline(0);
    this.eventCatchup = new EventCatchupStrategy({
      drive: this.drive,
      c64Clock: () => this.c64Cpu.cycles,
      stepC64Instruction: () => this.session.stepC64Instruction(),
    });

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
    // Spec 441 step 4c — also rebind drive_t.GCR_track_start_ptr on
    // every step so rotation_1541_simple sees the new track's bytes.
    this.headPosition.onStep = (direction, halfTrack) => {
      // Drive_t track rebind (production path post Spec 441 step 4e).
      const driveT = this.drive.drive;
      if (driveT && this.parser) {
        // Lazy import-free call to bindDriveTrack equivalent — direct
        // field writes mirror drive-t.ts bindDriveTrack body.
        driveT.current_half_track = halfTrack;
        const wholeTrack = (halfTrack & 1) === 0 ? (halfTrack >> 1) : -1;
        const bytes = wholeTrack >= 1 ? this.parser.getRawTrackBytes(wholeTrack) : null;
        driveT.GCR_track_start_ptr = bytes;
        driveT.GCR_current_track_size = bytes ? bytes.length : 0;
      }
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
    const driveInstrHook: InstrHook = (prevPc, opcode, b1, b2, a, x, y, sp, p, clk) => {
      this.publishCpuInstruction("drive", prevPc, opcode, b1, b2, a, x, y, sp, p, clk);
    };
    (this.drive.cpu as { onInstructionComplete?: InstrHook }).onInstructionComplete = driveInstrHook;
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
    if (this.session.useCycleLockstep && this.session.scheduler) {
      return new LockstepStrategy(
        this.session.scheduler,
        () => this.c64Cpu.cycles,
      );
    }
    return this.eventCatchup;
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
