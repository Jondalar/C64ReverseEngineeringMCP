// IntegratedSession — C64 + 1541 drive coupled via shared IEC bus,
// dual-clock cycle accumulator. Real KERNAL/BASIC/CHARROM loaded.
//
// Composition:
// - C64 cpu + memory bus with real ROMs
// - Drive cpu + drive bus + iec bus + cycle accumulator
// - Peripherals (vic-stub, cia1-stub) — replaced by full models in
//   Spec 064 (CIA1/CIA2 timers) + Spec 065 (full VIC)
// - KERNAL traps (kernal-fileio) — removed in Sprint 69 once Spec 064
//   real CIA1 timer lets KERNAL serial run authentically
// - CIA2 wired to iec-bus for IEC PA bits

import { Cpu6510 } from "./cpu6510.js";
import { HeadlessMemoryBus } from "./memory-bus.js";
import { loadAllC64Roms, type LoadedC64RomSet } from "./c64-rom.js";
import { IecBus } from "./iec/iec-bus.js";
import { DriveCpu } from "./drive/drive-cpu.js";
import { TrackBuffer, HeadPosition } from "./drive/head-position.js";
import { GcrShifter } from "./drive/gcr-shifter.js";
import { G64Parser } from "../../disk/g64-parser.js";
import { buildG64 } from "../../disk/g64-builder.js";
import { DiskProvider } from "./providers.js";
import { existsSync, readFileSync } from "node:fs";
import { VicIIVice, installVicIIVice, type VicBackend } from "./vic/vic-ii-vice.js";
import { installSid, type Sid6581 } from "./sid/sid.js";
import { VicFramebuffer, renderTextModeFrame, computeVicBankBase } from "./peripherals/vic-renderer.js";
import { rgbaToPng } from "./peripherals/png-writer.js";
import { writeFileSync } from "node:fs";
import { installCia1 } from "./peripherals/cia1.js";
import type { KeyboardMatrix, JoystickState } from "./peripherals/keyboard.js";
import { installCia2 } from "./peripherals/cia2.js";
import type { Cia6526Vice } from "./cia/cia6526-vice.js";
import {
  handleKernalFileIoTrap,
  makeKernalFileIoState,
  type KernalFileIoState,
} from "./traps/kernal-fileio.js";
import {
  handleKernalSerialTrap,
  makeKernalSerialState,
  type KernalSerialState,
} from "./traps/kernal-serial.js";
import {
  handleKernalIoTrap,
  makeKernalIoState,
  type KernalIoState,
} from "./traps/kernal-io.js";
import { CycleLockstepSchedulerImpl } from "./scheduler/cycle-lockstep-scheduler.js";
import { TraceRegistry } from "./trace/channels.js";
import {
  BusAccessTraceProducerImpl,
  type BusAccessTraceProducer,
} from "./trace/bus-access.js";
import {
  Cpu6510Cycled, AlarmContextCycled, VicCycled, SidCycled,
  DriveCpuCycled, KeyboardCycled,
} from "./scheduler/cycle-wrappers.js";
import { Cpu65xxVice } from "./cpu/cpu65xx-vice.js";
import {
  type AlarmContext,
} from "./alarm/alarm-context.js";
import { HeadlessMachineKernel } from "./kernel/headless-machine-kernel.js";

const C64_HZ_PAL = 985248;
const C64_HZ_NTSC = 1022727;
const DRIVE_HZ = 1000000;

import { type SessionMode, type SessionModeReport, identifyMode, makeModeReport, resolveSessionFlags } from "./session-modes.js";
import { type ResetProfile, applyRamFillPattern, getResetProfile } from "./reset-profiles.js";

// Spec 115 (M3.7) v1 — multi-drive shape. Sessions can declare up to
// two drives via the `drives` array; current runtime instantiates
// only the first / device-8 entry, validates the rest, and reports
// the deferred slots through `multiDriveDeferred`. A second-drive
// runtime is tracked under M3.7 v2 follow-up.
export interface DriveConfig {
  id: number;            // 8 or 9 only (per spec out-of-scope: 10/11)
  disk: string;          // path to .d64 / .g64 image
  startTrack?: number;
  writeProtected?: boolean;
}

export const MULTI_DRIVE_MAX = 2;
export const MULTI_DRIVE_VALID_IDS = [8, 9] as const;

export function validateDrives(drives: DriveConfig[]): { ok: true } | { ok: false; error: string } {
  if (drives.length === 0) return { ok: false, error: "drives: at least one drive required" };
  if (drives.length > MULTI_DRIVE_MAX) {
    return { ok: false, error: `drives: max ${MULTI_DRIVE_MAX} drives, got ${drives.length}` };
  }
  const seen = new Set<number>();
  for (const d of drives) {
    if (!MULTI_DRIVE_VALID_IDS.includes(d.id as 8 | 9)) {
      return { ok: false, error: `drives: id must be 8 or 9, got ${d.id}` };
    }
    if (seen.has(d.id)) return { ok: false, error: `drives: duplicate id ${d.id}` };
    seen.add(d.id);
    if (typeof d.disk !== "string" || d.disk.length === 0) {
      return { ok: false, error: `drives: disk path missing for id ${d.id}` };
    }
  }
  return { ok: true };
}

export interface IntegratedSessionOptions {
  diskPath: string;
  // Spec 115 (M3.7) v1: optional multi-drive declaration. When set,
  // overrides single-drive `diskPath`/`deviceId`. v1 instantiates only
  // the device-8 slot; device-9 is validated and reported via
  // session.multiDriveDeferred but not yet wired to the IEC bus.
  drives?: DriveConfig[];
  isPal?: boolean;
  deviceId?: number;
  startTrack?: number;
  writeProtected?: boolean;
  // Spec 098: named session-mode preset. When set, expands to the
  // boolean flags below (any explicit boolean still wins). Default
  // none — boolean fields drive resolution as before.
  mode?: SessionMode;
  // Spec 064 Sprint 69b: file-IO traps default OFF (KERNAL runs
  // real serial bit-bang to drive). Set true to fall back to the
  // Sprint 67 trap path if the real protocol stalls.
  enableKernalFileIoTraps?: boolean;
  // Sprint 81: serial + IO traps default ON for back-compat, but
  // game stage-2 custom bit-bang needs them OFF so KERNAL drives
  // real CIA2 → drive ATN handler runs and releases ATN_ACK.
  enableKernalSerialTraps?: boolean;
  enableKernalIoTraps?: boolean;
  // Sprint 92: enable cycle-lockstep scheduler. Default false.
  useCycleLockstep?: boolean;
  // Sprint 92.7 v2: use new microcoded cpu6510 (sub-instruction bus
  // access). Implies useCycleLockstep=true. Default false.
  useMicrocodedCpu?: boolean;
  // Spec 093: cycle-stamped IEC edge trace (ring buffer in IecBus).
  traceIec?: boolean;
  traceIecCapacity?: number;
  // Spec 093: drive PC trace ring (per drive instruction).
  traceDrive?: boolean;
  traceDriveCapacity?: number;
  // Spec 142: bus-access trace channel for $DD00 / $1800. When set,
  // hooks IecBus + drive VIA1 to publish events into TraceRegistry's
  // "bus_access" channel. Caller must configure the channel mode
  // (ring or jsonl) on `traceRegistry` before scheduler runs.
  enableBusAccessTrace?: boolean;
  busAccessPcRangesC64?: Array<[number, number]>;
  busAccessPcRangesDrive?: Array<[number, number]>;
  // Spec 138 probe variants. Mutually exclusive.
  //   "A" = push-flush at IEC events (lockstep tick stays + flush hook)
  //   "B" = A + scheduler ticks drive BEFORE c64 each cycle
  //   "C" = push-flush only — disable lockstep drive tick entirely
  // Default undefined = production hybrid (= "A" semantics, but
  // status quo when bus-access tracing is off).
  probeMode?: "A" | "B" | "C";
  // Spec 140: IEC observable mode.
  //   "vice-cache" = VICE-bit-exact cached cpu_port/drv_port + read_prb XOR
  //   "live"       = legacy live-computed line state + standard via.read merge
  // Default = "vice-cache" (Spec 140 v2 milestone).
  iecMode?: "vice-cache" | "live";
  // Spec 141 (Q9): drive head-start before c64 reset deassertion.
  // Replicates real-HW boot order where 1541 boots ~10 PAL frames
  // before c64 KERNAL becomes active, eliminating boot-race that
  // Sprint 66 hacks compensated for. Default 200_000 c64 cycles
  // (≈ 200ms PAL). Set 0 to disable.
  driveHeadStartCycles?: number;
}

export interface PrgLoadResult {
  loadAddress: number;
  endAddress: number;
  bytesLoaded: number;
}

export class IntegratedSession {
  public readonly c64Bus: HeadlessMemoryBus;
  public readonly c64Cpu: Cpu6510;
  public readonly drive: DriveCpu;
  public readonly iecBus: IecBus;
  public readonly trackBuffer: TrackBuffer;
  public readonly headPosition: HeadPosition;
  // Spec 153 / Sprint 114: 1:1 VICE GCR bit-stream shifter. Replaces
  // the inline TrackBuffer shifter for VIA2 PA / SYNC#. Always
  // constructed; passed into DriveCpu so the VIA2 backend reads its
  // dataByte / syncBit and DriveCpuCycled ticks it per drive cycle.
  public readonly gcrShifter: GcrShifter;
  public readonly diskPath: string;
  // Spec 115 v1: list of drive-9+ slots that were declared but not
  // yet instantiated. Empty when only device-8 is in use.
  public readonly multiDriveDeferred: DriveConfig[] = [];
  public readonly parser: G64Parser;
  public readonly romSet: LoadedC64RomSet;
  public readonly diskProvider: DiskProvider;
  public readonly kernalFileIo: KernalFileIoState;
  public readonly kernalSerial: KernalSerialState;
  public readonly kernalIo: KernalIoState;
  public readonly cia1: Cia6526Vice;
  public readonly cia2: Cia6526Vice;
  // Sprint 113 Phase 2: VICE-style IRQ/NMI pin levels. Latched by the
  // CIA backends' setIntClk callbacks and sampled by checkC64Interrupts
  // / updateMicrocodedInterruptLines. Mirrors VICE's int_status pin
  // model (maincpu_set_irq / maincpu_set_nmi).
  private readonly cia1IrqLine: () => boolean;
  private readonly cia2NmiLine: () => boolean;
  public readonly keyboard: KeyboardMatrix;
  public readonly joystick2: JoystickState;
  // Spec 107 (M2.5) v1
  public readonly joystick1: JoystickState;
  // Spec 107 (M2.5) v1: 4 paddles × 256 values, exposed via setPaddle
  // and surfaced through SID POT pins by Spec 108 wiring.
  public readonly paddles: Uint8Array = new Uint8Array(4); // [POTAX, POTAY, POTBX, POTBY]
  // Pre-V2 1541-v2: optional IEC byte-level transaction trace.
  // Set `enableIecByteTrace = true` and inspect `iecByteEvents` post-run.
  // Hooks $EDDD CIOUT body (C64→drive) and $EE13 ACPTR body (drive→C64).
  public enableIecByteTrace = false;
  public readonly iecByteEvents: { cycle: number; pc: number; dir: "send" | "recv"; byte: number; atnLow: boolean }[] = [];
  public readonly vic: VicIIVice;
  public readonly sid: Sid6581;
  public readonly framebuffer: VicFramebuffer;
  public readonly enableKernalFileIoTraps: boolean;
  public readonly enableKernalSerialTraps: boolean;
  public readonly enableKernalIoTraps: boolean;
  // Sprint 92: cycle-lockstep scheduler. Optional opt-in for now via
  // useCycleLockstep option. Default false for back-compat.
  public readonly scheduler?: CycleLockstepSchedulerImpl;
  public readonly cpuCycled?: Cpu6510Cycled;
  public readonly useCycleLockstep: boolean;
  // Spec 200-c1: per-session monolithic emulator kernel. Owns clocks,
  // alarms, trace, status. Construction happens early in the session
  // constructor so subsequent chip wiring reads from kernel-owned
  // resources (alarms today; chips in 200-c3/c4).
  public readonly kernel: HeadlessMachineKernel;
  // Spec 200-c2: alarm contexts moved into kernel. Session fields are
  // forwarders for backward-compat callers; underlying instances are
  // owned by `this.kernel.alarms`. Used by Cpu65xxVice instances when
  // useMicrocodedCpu=true; chip ports (CIA / VIA / VIC / SID) register
  // alarms against these references.
  public readonly maincpuAlarmContext: AlarmContext;
  public readonly drivecpuAlarmContext: AlarmContext;
  // Spec 142: shared trace registry. Always present; channels default
  // to "off" until caller configures.
  public readonly traceRegistry: TraceRegistry = new TraceRegistry();
  public readonly busAccessProducer?: BusAccessTraceProducer;
  public readonly useMicrocodedCpu: boolean;
  // Spec 141 Q9: drive head-start cycles, default 200_000 (≈200ms PAL).
  public readonly driveHeadStartCycles: number;
  // Spec 098: named session-mode preset (resolved at construction).
  public readonly mode: SessionMode;
  // Spec 093: image format string ("g64" | "d64" | "other") + clock ratio.
  public readonly imageFormat: string;
  public readonly driveClockRatio: number;
  // Spec 093: drive PC trace ring (last N drive PCs sampled per step).
  private drivePcTrace: Array<{ cycle: number; pc: number }> = [];
  private drivePcTraceCapacity = 0;
  // NMI edge detection bookkeeping.
  private prevCia2IrqAsserted = false;
  public get lastTrap(): string | undefined { return this.kernalFileIo.lastTrap; }
  public get loadEvents(): KernalFileIoState["loadEvents"] { return this.kernalFileIo.loadEvents; }

  // Spec 098: machine-readable session mode + flag summary.
  public modeReport(): SessionModeReport {
    return makeModeReport(this.mode, {
      enableKernalFileIoTraps: this.enableKernalFileIoTraps,
      enableKernalSerialTraps: this.enableKernalSerialTraps,
      enableKernalIoTraps: this.enableKernalIoTraps,
      useMicrocodedCpu: this.useMicrocodedCpu,
      useCycleLockstep: this.useCycleLockstep,
      traceIec: this.iecBus.isTraceEnabled(),
      traceDrive: this.drivePcTraceCapacity > 0,
    });
  }
  private readonly driveCyclesPerC64Cycle: number;
  private c64InstructionCount = 0;

  constructor(opts: IntegratedSessionOptions) {
    // Spec 115 v1: drives[] takes precedence over diskPath when set.
    // Validate the array first; fold device-8 entry into the legacy
    // single-drive code path below.
    if (opts.drives) {
      const v = validateDrives(opts.drives);
      if (!v.ok) throw new Error(v.error);
      const primary = opts.drives.find((d) => d.id === 8) ?? opts.drives[0]!;
      const deferred = opts.drives.filter((d) => d !== primary);
      this.multiDriveDeferred.push(...deferred);
      // Mutate opts in-place to redirect the rest of the constructor
      // at the primary drive. This keeps the v1 shape change minimal.
      (opts as IntegratedSessionOptions).diskPath = primary.disk;
      if (primary.startTrack !== undefined) (opts as IntegratedSessionOptions).startTrack = primary.startTrack;
      if (primary.writeProtected !== undefined) (opts as IntegratedSessionOptions).writeProtected = primary.writeProtected;
      (opts as IntegratedSessionOptions).deviceId = primary.id;
    }
    if (!existsSync(opts.diskPath)) throw new Error(`Disk image not found: ${opts.diskPath}`);
    // Spec 098: expand named mode preset into boolean overrides; explicit
    // booleans on opts still win over the preset.
    const resolvedFlags = resolveSessionFlags(opts.mode, {
      enableKernalFileIoTraps: opts.enableKernalFileIoTraps,
      enableKernalSerialTraps: opts.enableKernalSerialTraps,
      enableKernalIoTraps: opts.enableKernalIoTraps,
      useMicrocodedCpu: opts.useMicrocodedCpu,
      useCycleLockstep: opts.useCycleLockstep,
      traceIec: opts.traceIec,
      traceDrive: opts.traceDrive,
    });
    opts = {
      ...opts,
      enableKernalFileIoTraps: resolvedFlags.enableKernalFileIoTraps,
      enableKernalSerialTraps: resolvedFlags.enableKernalSerialTraps,
      enableKernalIoTraps: resolvedFlags.enableKernalIoTraps,
      useMicrocodedCpu: resolvedFlags.useMicrocodedCpu,
      useCycleLockstep: resolvedFlags.useCycleLockstep,
      traceIec: resolvedFlags.traceIec,
      traceDrive: resolvedFlags.traceDrive,
    };
    this.mode = opts.mode ?? identifyMode(resolvedFlags);
    // Spec 098: warn when booleans don't match any named preset and
    // caller didn't explicitly opt into "custom". Silenced in test
    // runs by setting C64RE_SUPPRESS_CUSTOM_WARN=1.
    if (
      this.mode === "custom"
      && opts.mode === undefined
      && !process.env.C64RE_SUPPRESS_CUSTOM_WARN
    ) {
      console.warn(
        `[IntegratedSession] booleans don't match any named preset → mode="custom". `
        + `Pass an explicit \`mode\` (fast-trap | real-kernal | true-drive | debug-vice-compare) `
        + `or set mode: "custom" to silence this warning.`,
      );
    }
    const isPal = opts.isPal ?? true;
    this.driveCyclesPerC64Cycle = DRIVE_HZ / (isPal ? C64_HZ_PAL : C64_HZ_NTSC);
    this.driveClockRatio = this.driveCyclesPerC64Cycle;
    const ext = opts.diskPath.toLowerCase().split(".").pop() ?? "";
    this.imageFormat = ext === "g64" ? "g64" : ext === "d64" ? "d64" : ext || "other";
    this.diskPath = opts.diskPath;

    // Spec 200-c5 prep: lockstep flag computed BEFORE kernel build so
    // kernel can decide on legacy beforeC64Read hook installation.
    this.useCycleLockstep = (opts.useCycleLockstep ?? false) || (opts.useMicrocodedCpu ?? false);
    this.useMicrocodedCpu = opts.useMicrocodedCpu ?? false;

    // Spec 200-c2 + c3 + c4: kernel created up-front. Kernel constructor
    // owns alarm contexts, C64-side chips (iecBus, c64Bus, romSet,
    // c64Cpu, cia1, cia2, vic, sid, framebuffer), AND drive-side state
    // (parser, trackBuffer, headPosition, gcrShifter, drive) plus IEC
    // drive-side wiring. Session reads these as backward-compat field
    // aliases. Mirrors VICE machine_specific_init build order.
    this.kernel = new HeadlessMachineKernel({
      session: this,
      video: isPal ? "PAL" : "NTSC",
      diskPath: this.diskPath,
      imageFormat: this.imageFormat,
      deviceId: opts.deviceId ?? 8,
      startTrack: opts.startTrack ?? 18,
      writeProtected: opts.writeProtected,
      useMicrocodedCpu: this.useMicrocodedCpu,
      useCycleLockstep: this.useCycleLockstep,
      driveCyclesPerC64Cycle: this.driveCyclesPerC64Cycle,
    });
    this.maincpuAlarmContext = this.kernel.alarms.maincpu;
    this.drivecpuAlarmContext = this.kernel.alarms.drivecpu;
    this.iecBus = this.kernel.iecBus;
    this.c64Bus = this.kernel.c64Bus;
    this.romSet = this.kernel.romSet;
    this.c64Cpu = this.kernel.c64Cpu;
    this.cia1 = this.kernel.cia1;
    this.cia1IrqLine = this.kernel.cia1IrqLine;
    this.cia2 = this.kernel.cia2;
    this.cia2NmiLine = this.kernel.cia2NmiLine;
    this.keyboard = this.kernel.keyboard;
    this.joystick1 = this.kernel.joystick1;
    this.joystick2 = this.kernel.joystick2;
    this.paddles = this.kernel.paddles;
    this.vic = this.kernel.vic;
    this.sid = this.kernel.sid;
    this.framebuffer = this.kernel.framebuffer;
    this.parser = this.kernel.parser;
    this.diskProvider = this.kernel.diskProvider;
    this.trackBuffer = this.kernel.trackBuffer;
    this.headPosition = this.kernel.headPosition;
    this.gcrShifter = this.kernel.gcrShifter;
    this.drive = this.kernel.drive;

    this.kernalFileIo = makeKernalFileIoState();
    this.kernalSerial = makeKernalSerialState();
    this.kernalIo = makeKernalIoState();
    // Spec 083: real KERNAL serial bit-bang via cycle-precise CIA timer
    // is the default. Traps are opt-in fast-mode.
    this.enableKernalFileIoTraps = opts.enableKernalFileIoTraps ?? false;
    this.enableKernalSerialTraps = opts.enableKernalSerialTraps ?? false;
    this.enableKernalIoTraps = opts.enableKernalIoTraps ?? false;
    // Spec 200-c3: framebuffer constructed inside kernel; assigned via
    // alias above. No additional construction here.
    // Spec 200-c4: useCycleLockstep / useMicrocodedCpu set above before
    // kernel construction (kernel needs them for drive build). No
    // duplicate assignment here.
    // Q9 head-start disabled by default in v3+: with bus formula
    // 1:1 VICE + drive RAM mostly correct, head-start no longer
    // needed for boot-order race. CA1 IRQ + reevaluateCa1Level
    // handle the race during normal scheduler tick. Caller may
    // re-enable via option.
    this.driveHeadStartCycles = opts.driveHeadStartCycles ?? 0;
    // Spec 093: trace wiring. timeSource bound to c64Cpu cycles via getter.
    this.iecBus.timeSource = () => this.c64Cpu.cycles;
    if (opts.traceIec) this.iecBus.enableTrace(opts.traceIecCapacity ?? 1024);
    this.drivePcTraceCapacity = opts.traceDrive ? (opts.traceDriveCapacity ?? 512) : 0;
    if (this.useCycleLockstep) {
      // Sprint 92.7 v2: optional microcoded cpu (per-cycle bus access).
      // Sprint 113 Phase 2: now backed by Cpu65xxVice (1:1 VICE 6510core)
      // with alarm-context dispatch wired into the instruction-fetch
      // boundary. Mirrors VICE PROCESS_ALARMS macro.
      let cpuCompoonent: any;
      if (opts.useMicrocodedCpu) {
        const microcoded = new Cpu65xxVice({
          memBus: this.c64Bus,
          alarmContext: this.maincpuAlarmContext,
        });
        // Replace c64Cpu with microcoded version. Cast — both share
        // public register state interface.
        (this as any).c64Cpu = microcoded;
        // Spec 200-c3: keep kernel's c64Cpu in sync. CIA clkPtr
        // captured a closure on kernel.c64Cpu; without this update
        // CIAs would read the stale Cpu6510's cycles (= 0 forever)
        // and alarm dispatch would storm.
        (this.kernel as unknown as { c64Cpu: unknown }).c64Cpu = microcoded;
        microcoded.reset();
        cpuCompoonent = microcoded;
      } else {
        const cpuCycled = new Cpu6510Cycled(this.c64Cpu);
        cpuCycled.preInstructionCheck = () => this.checkC64Interrupts();
        this.cpuCycled = cpuCycled;
        cpuCompoonent = cpuCycled;
      }
      const c64Components = [
        cpuCompoonent,
        // Sprint 113 Phase 2 (Spec 146): alarm-driven CIAs no longer
        // need per-cycle ticks. Instead a single AlarmContextCycled
        // dispatches all maincpu alarms (CIA1 + CIA2 timers, TOD, SDR)
        // up to the current C64 clock each cycle. Mirrors the VICE
        // CPU loop's PROCESS_ALARMS macro behaviour for the lockstep
        // path where the CPU itself isn't responsible for dispatch.
        new AlarmContextCycled(this.maincpuAlarmContext, () => this.c64Cpu.cycles),
        new VicCycled(this.vic),
        new SidCycled(this.sid),
        new KeyboardCycled(this.keyboard),
      ];
      const driveComponents = [
        new DriveCpuCycled(this.drive),
        // Sprint 113 Phase 2 (Spec 147): VIA1 + VIA2 are alarm-driven
        // (Via1d1541 / Via2d1541). Per-cycle tick() replaced by a single
        // AlarmContextCycled that drains the drivecpu alarm context each
        // cycle — mirrors the same pattern as CIA (Spec 146 migration).
        new AlarmContextCycled(this.drivecpuAlarmContext, () => this.drive.cpu.cycles),
      ];
      this.scheduler = new CycleLockstepSchedulerImpl({
        c64Components, driveComponents,
        c64IsAtInstructionBoundary: () => cpuCompoonent.isAtInstructionBoundary?.() ?? true,
        c64Pc: () => this.c64Cpu.pc,
        isPal,
        // Sprint 93.1: per-cycle IRQ/NMI pin update (VICE pattern).
        updateInterruptLines: opts.useMicrocodedCpu
          ? () => this.updateMicrocodedInterruptLines()
          : undefined,
        // Sprint 96: scheduler ticks peripherals + drive by CPU cycle
        // delta. Required so IRQ service / branch page-cross / illegal
        // burn don't desync drive timing during IEC bit-bang.
        cpuCycleCounter: () => (cpuCompoonent as any).cycles,
        // Spec 138 probe options.
        tickDriveFirst: opts.probeMode === "B",
        disableLockstepDriveTick: opts.probeMode === "C",
        // In probe variants A/B (lockstep + flush), the lockstep loop
        // ticks drive each cycle. We MUST update drive.lastSyncC64Clk
        // here so the IEC-flush hook sees drive-already-current and
        // becomes a no-op. Without this, flush re-ticks all cycles
        // since lastSyncC64Clk=0, causing massive over-tick.
        // For variant C, we DO want flush to do real work, so skip
        // the sync (drive will accumulate naturally per flush call).
        afterCycleSync:
          opts.probeMode === "A" || opts.probeMode === "B"
            ? (c64Cycle, _driveCycle) => this.drive.setSyncBaseline(c64Cycle)
            : undefined,
      });
    }
    // Spec 142: bus-access trace producer wiring. Pass live object
    // references for c64Cpu / drive.cpu / via1 — producer reads
    // pc/cycles/ifr at emit time so live property reads = correct
    // current values. Tracing only emits when (a) producer.enable()
    // is called AND (b) channel mode != "off".
    if (opts.enableBusAccessTrace) {
      const producer = new BusAccessTraceProducerImpl({
        registry: this.traceRegistry,
        c64Cpu: this.c64Cpu as unknown as { pc: number; cycles: number; isAtInstructionBoundary?: () => boolean },
        driveCpu: this.drive.cpu as unknown as { pc: number; cycles: number; isAtInstructionBoundary?: () => boolean },
        schedule: {
          c64Cycle: () => this.scheduler ? this.scheduler.c64Cycle() : this.c64Cpu.cycles,
          driveCycle: () => this.scheduler ? this.scheduler.driveCycle() : ((this.drive.cpu as unknown as { cycles?: number }).cycles ?? 0),
        },
        iecBus: this.iecBus,
        driveVia1: this.drive.bus.via1,
      });
      producer.setFilter({
        pcRangesC64: opts.busAccessPcRangesC64 ?? [],
        pcRangesDrive: opts.busAccessPcRangesDrive ?? [],
      });
      producer.enable();
      this.iecBus.busAccessProducer = producer;
      this.drive.bus.via1.busAccessHook = producer;
      this.drive.bus.via1.baseAddr = 0x1800;
      (this as { busAccessProducer?: BusAccessTraceProducer }).busAccessProducer = producer;
    }
  }

  // Render the current VIC state to the framebuffer (text mode only
  // for Phase 65b — bitmap + sprites in 65d/65e).
  renderFrame(): void {
    const cia2Pa = this.cia2.pra & this.cia2.ddra; // output bits only
    const bankBase = computeVicBankBase(cia2Pa & 0x03);
    renderTextModeFrame(this.framebuffer, {
      vic: this.vic,
      bus: this.c64Bus,
      vicBankBase: bankBase,
    });
  }

  // Render current VIC state then write to a PNG file. Phase 65f.
  renderToPng(path: string): { width: number; height: number; bytes: number } {
    this.renderFrame();
    const png = rgbaToPng(this.framebuffer.width, this.framebuffer.height, this.framebuffer.pixels);
    writeFileSync(path, png);
    return { width: this.framebuffer.width, height: this.framebuffer.height, bytes: png.length };
  }

  // Spec 117 (M4.1) v1: stable framebuffer-API descriptor for agents.
  renderDescriptor(): {
    width: number; height: number;
    mode: "text" | "bitmap" | "multicolor" | "ecm";
    ranges: { screen: number; color: number; charset?: number; bitmap?: number; bank: number };
  } {
    this.renderFrame();
    const ctrl1 = this.vic.regs[0x11]!;
    const ctrl2 = this.vic.regs[0x16]!;
    const bmm = (ctrl1 & 0x20) !== 0;
    const ecm = (ctrl1 & 0x40) !== 0;
    const mcm = (ctrl2 & 0x10) !== 0;
    const mode: "text" | "bitmap" | "multicolor" | "ecm" =
      bmm ? "bitmap" : (ecm ? "ecm" : (mcm ? "multicolor" : "text"));
    const vicBank = this.cia2.pra & 0x03;
    const bankBase = (3 - vicBank) * 0x4000;
    const screen = bankBase + this.vic.screenRamOffset();
    const color  = 0xd800;
    const charset = !bmm ? bankBase + this.vic.charRomOffsetWithinBank() : undefined;
    const bitmap  = bmm ? bankBase + this.vic.bitmapBaseWithinBank() : undefined;
    return {
      width: this.framebuffer.width,
      height: this.framebuffer.height,
      mode,
      ranges: { screen, color, charset, bitmap, bank: bankBase },
    };
  }

  // Spec 100: deterministic reset profile. Default "pal-default"
  // matches legacy resetCold() behavior. Pin every cold-reset knob
  // (RAM fill pattern, VIC raster phase, drive head track, peripheral
  // neutrals) so two reset+run pairs with the same inputs produce
  // byte-identical state at every cycle.
  resetCold(profile: ResetProfile = "pal-default"): void {
    const spec = getResetProfile(profile);
    this.c64Bus.reset();
    applyRamFillPattern(this.c64Bus.ram, spec);
    this.iecBus.reset();
    if (this.iecBus.isTraceEnabled()) this.iecBus.clearTrace();
    this.c64Cpu.reset();
    this.drive.reset();
    this.drive.setSyncBaseline(this.c64Cpu.cycles);
    // Spec 145 v3+: re-sync drive VIA1 CA1 pin baseline AFTER
    // drive.reset() resets the VIA's lastCa1Pin to true.
    this.iecBus.syncDriveCa1Baseline();
    // Spec 141 (Q9): drive head-start. Run drive ROM standalone for N
    // c64-equivalent cycles BEFORE c64 starts, replicating real-HW
    // boot order. Eliminates ATN-edge boot-race.
    const headStart = this.driveHeadStartCycles;
    if (headStart > 0) {
      this.kernel.catchUpDrive(8, headStart);
      this.drive.setSyncBaseline(this.c64Cpu.cycles); // = 0 still
    }
    this.sid.reset();
    // Pin VIC raster phase deterministically.
    (this.vic as { rasterLine?: number }).rasterLine = spec.vicRasterPhase;
    // Pin drive head to profile-specified start track.
    this.headPosition.reset(spec.driveStartTrack);
    // Wipe keyboard + joystick state.
    const kb = this.keyboard as unknown as { clear?: () => void };
    if (typeof kb.clear === "function") kb.clear();
    this.joystick2.up = false;
    this.joystick2.down = false;
    this.joystick2.left = false;
    this.joystick2.right = false;
    this.joystick2.fire = false;
    this.c64InstructionCount = 0;
    this.drivePcTrace = [];
  }

  // Sprint 93.1: queue text typing into keyboard matrix. Hold/gap default
  // tuned for KERNAL SCNKEY raster IRQ (~16400 cyc per scan): 33000 cyc
  // hold + 33000 cyc gap means at least 2 scan ticks see press, 2 scan
  // ticks see release — buffer reliably picks up the key.
  typeText(text: string, holdCycles = 33000, gapCycles = 33000): void {
    this.keyboard.typeText(text, holdCycles, gapCycles);
  }

  // Sprint 93.1: set joystick port 2 directional / fire state.
  setJoystick2(state: Partial<JoystickState>): void {
    if (state.up !== undefined) this.joystick2.up = state.up;
    if (state.down !== undefined) this.joystick2.down = state.down;
    if (state.left !== undefined) this.joystick2.left = state.left;
    if (state.right !== undefined) this.joystick2.right = state.right;
    if (state.fire !== undefined) this.joystick2.fire = state.fire;
  }
  // Spec 107 (M2.5) v1: joystick port 1 + paddle + RESTORE NMI.
  setJoystick1(state: Partial<JoystickState>): void {
    if (state.up !== undefined) this.joystick1.up = state.up;
    if (state.down !== undefined) this.joystick1.down = state.down;
    if (state.left !== undefined) this.joystick1.left = state.left;
    if (state.right !== undefined) this.joystick1.right = state.right;
    if (state.fire !== undefined) this.joystick1.fire = state.fire;
  }
  setPaddle(idx: 0 | 1 | 2 | 3, value: number): void {
    this.paddles[idx] = value & 0xff;
  }
  // RESTORE key triggers NMI via CIA2 PB6 falling edge in real HW.
  // VICE: c64keyboard.c:172 calls cia2_set_flag() which is a thin
  // wrapper over ciacore_set_flag(); the CIA's IFR FLAG bit raises
  // and (if enabled in the mask) the NMI line goes active.
  //
  // Sprint 113 Phase 2 (Spec 146): drive the legacy compat fields
  // directly so test harnesses can call this BEFORE any C64 cycle has
  // elapsed (cycles=0 → cia.write() would underflow rclk into uint32
  // wrap and stall the alarm dispatcher). The semantic outcome —
  // FLAG flag latched in IFR + mask enabled + irqAsserted() returns
  // true — matches the real CIA2 path; the integrated NMI line
  // refresh sees this on the next updateInterruptLines tick.
  triggerRestoreNmi(): void {
    this.cia2.icrMask |= 0x10;
    this.cia2.icrFlags |= 0x10;
  }

  // Spec 093: drive PC sample (called per C64 instruction step).
  private sampleDrivePc(): void {
    if (this.drivePcTraceCapacity <= 0) return;
    const pc = this.drive.cpu.pc;
    const last = this.drivePcTrace[this.drivePcTrace.length - 1];
    if (last && last.pc === pc) return; // dedupe consecutive
    this.drivePcTrace.push({ cycle: this.c64Cpu.cycles, pc });
    if (this.drivePcTrace.length > this.drivePcTraceCapacity) this.drivePcTrace.shift();
  }

  getDrivePcTrace(): Array<{ cycle: number; pc: number }> { return this.drivePcTrace.slice(); }
  getIecTrace() { return this.iecBus.getTrace(); }

  loadPrgIntoRam(prgPath: string, overrideLoadAddress?: number): PrgLoadResult {
    if (!existsSync(prgPath)) throw new Error(`PRG not found: ${prgPath}`);
    const data = readFileSync(prgPath);
    if (data.length < 2) throw new Error(`PRG too short: ${prgPath}`);
    const headerAddress = data[0]! | (data[1]! << 8);
    const loadAddress = overrideLoadAddress ?? headerAddress;
    const payload = data.slice(2);
    for (let i = 0; i < payload.length; i++) {
      this.c64Bus.ram[(loadAddress + i) & 0xffff] = payload[i]!;
    }
    return {
      loadAddress,
      endAddress: (loadAddress + payload.length - 1) & 0xffff,
      bytesLoaded: payload.length,
    };
  }

  // Sprint 92: extracted helper for trap dispatch — used by both
  // legacy stepC64Instruction and scheduler-backed path.
  private checkAndHandleTraps(): boolean {
    return ((this.enableKernalFileIoTraps && handleKernalFileIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, state: this.kernalFileIo,
    })) || (this.enableKernalSerialTraps && handleKernalSerialTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, drive: this.drive,
      iecBus: this.iecBus, state: this.kernalSerial,
    })) || (this.enableKernalIoTraps && handleKernalIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, serial: this.kernalSerial,
      state: this.kernalIo,
    }))) === true;
  }

  stepC64Instruction(): void {
    if (this.scheduler) {
      // Sprint 92: route through cycle-lockstep scheduler. Trap path
      // still checked at instruction boundary BEFORE delegating to
      // scheduler — traps short-circuit a real instruction.
      const trapped = this.checkAndHandleTraps();
      if (trapped) {
        // Trap consumed an "instruction" worth of cycles. Run scheduler
        // for ~7 cycles to advance peripherals + drive.
        this.scheduler.runCycles(7);
        this.sampleDrivePc();
        return;
      }
      this.scheduler.runInstructions(1);
      this.sampleDrivePc();
      return;
    }
    // Spec 064 Sprint 69b: KERNAL file-IO traps now opt-in via
    // enableKernalFileIoTraps. Default is real KERNAL serial via
    // CIA1 timer + drive ROM bit-bang. Trap path kept as fallback
    // for cases where the real protocol stalls (still being tuned).
    // Sprint 67 + 72: KERNAL trap suite. Try fileio first then serial.
    // enableKernalFileIoTraps gates fileio path (default off — Sprint
    // 69 wants real KERNAL serial). Serial trap suite always on; it's
    // the workaround for the byte-tx mutual-wait until Sprint 69b
    // finish lands.
    const trapped = (this.enableKernalFileIoTraps && handleKernalFileIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, state: this.kernalFileIo,
    })) || (this.enableKernalSerialTraps && handleKernalSerialTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, drive: this.drive,
      iecBus: this.iecBus, state: this.kernalSerial,
    })) || (this.enableKernalIoTraps && handleKernalIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, serial: this.kernalSerial,
      state: this.kernalIo,
    }));
    if (trapped) {
      this.c64InstructionCount += 1;
      const trapCycles = 7;
      this.c64Cpu.cycles += trapCycles;
      this.cia1.tick(trapCycles); // audit-ok: legacy trap-cycle pump; replaced by Spec 204 hook hygiene
      this.cia2.tick(trapCycles); // audit-ok: legacy trap-cycle pump; replaced by Spec 204 hook hygiene
      this.vic.tick(trapCycles); // audit-ok: legacy trap-cycle pump; replaced by Spec 204 hook hygiene
      this.sid.tick(trapCycles); // audit-ok: legacy trap-cycle pump; replaced by Spec 204 hook hygiene
      this.keyboard.advance(trapCycles);
      // Spec 090: drive lazy executeToClock instead of accumulator drain.
      this.kernel.catchUpDrive(8, this.c64Cpu.cycles);
      this.sampleDrivePc();
      return;
    }
    // Spec 090 / VICE pattern: drive catches up to current C64 clock
    // BEFORE the C64 instruction starts (so any bus access during
    // the instruction sees up-to-date drive state).
    this.kernel.catchUpDrive(8, this.c64Cpu.cycles);
    this.checkC64Interrupts();
    // Pre-V2 1541-v2: IEC byte trace. $EDDD = CIOUT body entry
    // (KERNAL byte-send to listener). $EE13 = ACPTR body entry
    // (KERNAL byte-receive from talker). Hook PC match before step.
    if (this.enableIecByteTrace) {
      const pc = this.c64Cpu.pc;
      if (pc === 0xEDDD) {
        // CIOUT entry: A holds byte to send.
        this.iecByteEvents.push({
          cycle: this.c64Cpu.cycles,
          pc,
          dir: "send",
          byte: this.c64Cpu.a & 0xff,
          atnLow: !this.iecBus.atnLine,
        });
      } else if (pc === 0xEE13) {
        // ACPTR entry: A holds 0 going in, byte set on return at $EE51.
        // Capture pre-state; we'll log byte by hooking the return PC
        // ($EE51 typical exit) below.
      } else if (pc === 0xEE51) {
        // ACPTR exit: A holds received byte.
        this.iecByteEvents.push({
          cycle: this.c64Cpu.cycles,
          pc,
          dir: "recv",
          byte: this.c64Cpu.a & 0xff,
          atnLow: !this.iecBus.atnLine,
        });
      }
    }
    const before = this.c64Cpu.cycles;
    this.c64Cpu.step(); // audit-ok: legacy non-lockstep stepping; replaced by SyncStrategy in Spec 202
    this.c64InstructionCount += 1;
    const consumed = this.c64Cpu.cycles - before;
    // Sprint 84: VIC may steal cycles via bad-line + sprite DMA. CPU
    // pauses; peripherals still tick during stolen cycles ("wall
    // clock" advances).
    // Sprint 113 Phase 2 (Spec 150): VicIIVice's tick() internally
    // calls VicBackend.stealCpuCycles(count, clk) which advances
    // c64Cpu.cycles directly. Do NOT bump again here — that was the
    // old per-tick contract before the new core moved the bump to
    // the backend hook (caused uint32 wrap during long runs, motm
    // probe at clk≈0xFFFFD192).
    const vicTick = this.vic.tick(consumed); // audit-ok: legacy per-instruction VIC tick; replaced by Spec 203
    const totalCycles = consumed + vicTick.stolenCycles;
    // Tick CIA / SID / keyboard for the full wall-clock window.
    this.cia1.tick(totalCycles); // audit-ok: legacy CIA wall-clock tick; replaced by Spec 203
    this.cia2.tick(totalCycles); // audit-ok: legacy CIA wall-clock tick; replaced by Spec 203
    this.sid.tick(totalCycles); // audit-ok: legacy SID wall-clock tick; replaced by Spec 216
    this.keyboard.advance(totalCycles);
    // Spec 090: drive catches up to NEW C64 clock after instruction.
    this.kernel.catchUpDrive(8, this.c64Cpu.cycles);
    this.sampleDrivePc();
  }

  runFor(maxC64Instructions: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }): {
    instructionsExecuted: number;
    lastPc: number;
    aborted?: "breakpoint" | "cycle-budget";
  } {
    const breakpoints = opts?.breakpoints;
    const cycleBudget = opts?.cycleBudget ?? Infinity;
    const startCycles = this.c64Cpu.cycles;
    let i = 0;
    for (; i < maxC64Instructions; i++) {
      if (breakpoints && breakpoints.has(this.c64Cpu.pc)) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "breakpoint" };
      }
      if (this.c64Cpu.cycles - startCycles >= cycleBudget) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "cycle-budget" };
      }
      this.stepC64Instruction();
    }
    return { instructionsExecuted: i, lastPc: this.c64Cpu.pc };
  }

  // Spec 090: legacy flushDriveCycles kept as no-op shim for any
  // remaining callers. Drive lazy-executes via drive.executeToClock
  // now. Wrapper just forwards to executeToClock with current C64 clk.
  flushDriveCycles(): void {
    this.kernel.catchUpDrive(8, this.c64Cpu.cycles);
  }

  // Sprint 93.1: per-cycle IRQ/NMI pin refresh for microcoded CPU. Called
  // by the cycle-lockstep scheduler before each cycle. Mirrors VICE's
  // maincpu_int_status pattern: peripherals assert/deassert IRQ/NMI pin,
  // CPU samples it at instruction boundary (handled inside microcoded
  // cpu's startInstructionCycle).
  private updateMicrocodedInterruptLines(): void {
    const cpu = this.c64Cpu as any;
    if (!("irqLine" in cpu)) return;
    // Sprint 113 Phase 2: CIA1/CIA2 expose a latched IRQ-pin level via
    // their setIntClk callback; sample that directly instead of the old
    // irqAsserted() helper. Falls back to irqAsserted for tests that
    // poke icrFlags directly without going through the CIA write API.
    cpu.irqLine = (this.cia1IrqLine() || this.cia1.irqAsserted()) || this.vic.irqAsserted();
    cpu.nmiLine = this.cia2NmiLine() || this.cia2.irqAsserted();
  }

  private checkC64Interrupts(): void {
    // CIA2 → C64 NMI (edge-triggered). RESTORE-key NMI deferred.
    const cia2Irq = this.cia2NmiLine() || this.cia2.irqAsserted();
    if (cia2Irq && !this.prevCia2IrqAsserted) {
      this.c64Cpu.serviceInterrupt(0xfffa, false);
    }
    this.prevCia2IrqAsserted = cia2Irq;
    // CIA1 + VIC → C64 IRQ (level-triggered, gated by I-flag).
    const cia1Irq = this.cia1IrqLine() || this.cia1.irqAsserted();
    if (!this.c64Cpu.interruptsDisabled() && (cia1Irq || this.vic.irqAsserted())) {
      this.c64Cpu.serviceInterrupt(0xfffe, false);
    }
  }

  status(): {
    c64: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number; instructions: number };
    drive: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number; instructions: number; track: number };
    iecBus: ReturnType<IecBus["snapshot"]>;
    romSet: { kernal: string; basic: string; charRom: string };
    runtime: {
      imageFormat: string;
      diskPath: string;
      mode: SessionMode;
      modeReport: SessionModeReport;
      useCycleLockstep: boolean;
      useMicrocodedCpu: boolean;
      driveClockRatio: number;
      enableKernalFileIoTraps: boolean;
      enableKernalSerialTraps: boolean;
      enableKernalIoTraps: boolean;
      iecTraceEnabled: boolean;
      drivePcTraceCapacity: number;
    };
  } {
    return {
      c64: {
        pc: this.c64Cpu.pc, a: this.c64Cpu.a, x: this.c64Cpu.x, y: this.c64Cpu.y,
        sp: this.c64Cpu.sp, flags: this.c64Cpu.flags,
        cycles: this.c64Cpu.cycles, instructions: this.c64InstructionCount,
      },
      drive: {
        pc: this.drive.cpu.pc, a: this.drive.cpu.a, x: this.drive.cpu.x, y: this.drive.cpu.y,
        sp: this.drive.cpu.sp, flags: this.drive.cpu.flags,
        cycles: this.drive.cpu.cycles, instructions: 0,
        track: this.headPosition.currentTrack,
      },
      iecBus: this.iecBus.snapshot(),
      romSet: {
        kernal: `${this.romSet.kernal.source}${this.romSet.kernal.path ? ` (${this.romSet.kernal.path})` : ""}`,
        basic: `${this.romSet.basic.source}${this.romSet.basic.path ? ` (${this.romSet.basic.path})` : ""}`,
        charRom: `${this.romSet.charRom.source}${this.romSet.charRom.path ? ` (${this.romSet.charRom.path})` : ""}`,
      },
      runtime: {
        imageFormat: this.imageFormat,
        diskPath: this.diskPath,
        mode: this.mode,
        modeReport: this.modeReport(),
        useCycleLockstep: this.useCycleLockstep,
        useMicrocodedCpu: this.useMicrocodedCpu,
        driveClockRatio: this.driveClockRatio,
        enableKernalFileIoTraps: this.enableKernalFileIoTraps,
        enableKernalSerialTraps: this.enableKernalSerialTraps,
        enableKernalIoTraps: this.enableKernalIoTraps,
        iecTraceEnabled: this.iecBus.isTraceEnabled(),
        drivePcTraceCapacity: this.drivePcTraceCapacity,
      },
    };
  }
}
