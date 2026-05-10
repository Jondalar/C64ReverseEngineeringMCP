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
// Spec 298k literal-port modules (= eager-loaded; modules are tiny and
// avoid module-loader cycle vs ESM/CJS).
import * as LIT_VICII from "./vic/literal/vicii.js";
import * as LIT_TYPES from "./vic/literal/vicii-types.js";
import * as LIT_CYCLE from "./vic/literal/vicii-cycle.js";
import * as LIT_FETCH from "./vic/literal/vicii-fetch.js";
import * as LIT_IRQ from "./vic/literal/vicii-irq.js";
import * as LIT_DRAW from "./vic/literal/vicii-draw-cycle.js";
import * as LIT_MEM from "./vic/literal/vicii-mem.js";
import { installSid, type Sid6581 } from "./sid/sid.js";
import { VicFramebuffer, renderTextModeFrame, computeVicBankBase } from "./peripherals/vic-renderer.js";
import { renderFrameRasterized } from "./peripherals/vic-renderer-rasterized.js";
import { renderFramePixelPerfect } from "./peripherals/vic-renderer-pixel.js";
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
  /** Optional disk image path. Omit to boot drive empty (= no media,
   *  like real C64 + 1541 powered with no disk inserted). PRG / cart
   *  workflows can omit and load directly into RAM. */
  diskPath?: string;
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
  // access). Independent from lockstep; true-drive uses microcoded
  // CPU with event/catch-up, debug-lockstep uses both.
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
  // Spec 262 Phase B-E: opt-in pixel-perfect renderer. Default
  // "per-char-row" (= existing renderer, no regression risk).
  // "per-pixel" enables Spec 262d-i pixel-perfect path using
  // VicIIVice.frameLineLogs. renderToPng() default uses this.
  vicRenderer?: "per-char-row" | "per-pixel" | "vice-rasterized" | "literal-port";
  // Spec 298k: enable literal VICE x64sc port as the rendering source.
  // When true, the literal port runs alongside VicIIVice via the 297a
  // onCycle hook (= one VIC cycle pump, both chips see same cycle
  // count) and writes pixels into a 520×312 framebuffer accumulator.
  // renderToPng with renderer:"literal-port" reads that accumulator
  // (skipping the snapshot replay path entirely).
  useLiteralPortRenderer?: boolean;
  // Spec 299: per-cycle CPU/VIC interleave. When true, the microcoded
  // CPU loop calls vic.tick(1) per executeCycle (= literal port advances
  // 1 raster cycle per CPU bus cycle). Without this flag, the legacy
  // batched per-instruction tick stays. CPU register writes that happen
  // mid-instruction reach the VIC at the exact cycle of the store.
  // Acceptance gated on minimal D020/D018/D016/D011 split PRGs vs
  // VICE x64sc reference.
  useLiteralPortVicPerCycle?: boolean;
  // Spec 300: route $D000-$D3FF reads through literal vicii_read.
  // Defaults to useLiteralPortVicPerCycle (literal raster_y is only in
  // sync when per-cycle hook drives it). Reads return literal-state
  // values (raster line, IRQ status, collision read-clear, unused-bit
  // OR masks) instead of VicIIVice values. Writes still mirror to
  // both chips for diff harness.
  useLiteralPortVicReads?: boolean;
  // Spec 301: route CPU IRQ line to literal vicii.irq_status instead
  // of VicIIVice.irqAsserted(). Defaults to useLiteralPortVicReads.
  // Both chips still maintain their own irq_status; literal IRQ host
  // callbacks remain no-op (this flag controls only which side the CPU
  // samples). Diff harness compares both.
  useLiteralPortVicIrq?: boolean;
  // Spec 302: route CPU bus stall to literal port `ba_low` (returned
  // by vicii_cycle()) instead of VicIIVice.getBusStallForCycle().
  // Defaults to useLiteralPortVicReads. Requires
  // usePerCycleBusStealing=true (otherwise legacy block path is used).
  useLiteralPortVicStall?: boolean;
  // Spec 303: route renderToPng() default to literal port
  // (literalPortFb) instead of snapshot renderers. Defaults to
  // useLiteralPortVicReads. Explicit `opts.renderer` always wins.
  useLiteralPortVicFb?: boolean;
  // Spec 282: VIC palette selection. Default = "colodore" (modern
  // brighter look). Opt-in to "6569r3" (or any other Tobias-measured
  // palette) for byte-exact VICE pixel-diff regression. See
  // src/runtime/headless/vic/palettes.ts for the full list.
  palette?: import("./vic/palettes.js").PaletteKey;
  // Spec 280g: opt-in per-cycle VIC bus stealing. When true, the
  // cycle-lockstep scheduler queries vic.getBusStallForCycle() before
  // each CPU step and stalls the CPU one cycle at a time when VIC
  // owns the bus (badline matrix DMA + sprite DMA). Default false
  // (= legacy block accounting via VicIIVice.computeLineSteal).
  // Requires useCycleLockstep=true.
  usePerCycleBusStealing?: boolean;
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
  public diskPath: string;
  // Spec 115 v1: list of drive-9+ slots that were declared but not
  // yet instantiated. Empty when only device-8 is in use.
  public readonly multiDriveDeferred: DriveConfig[] = [];
  public readonly parser: G64Parser;
  public readonly romSet: LoadedC64RomSet;
  public diskProvider?: DiskProvider;
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
  // Spec 298k: literal port render output. 520×312 color-index buffer
  // accumulated per scanline from the literal port's vicii.dbuf via
  // 297a onCycle hook. Set when useLiteralPortRenderer=true.
  public literalPortFb?: Uint8Array;
  public useLiteralPortRenderer: boolean = false;
  // Spec 299: per-cycle CPU/VIC interleave flag (= literal port timing fix)
  public useLiteralPortVicPerCycle: boolean = false;
  // Spec 300: route $D000-$D3FF reads through literal vicii_read.
  public useLiteralPortVicReads: boolean = false;
  // Spec 301: route CPU IRQ line to literal vicii.irq_status.
  public useLiteralPortVicIrq: boolean = false;
  // Spec 302: route CPU bus stall to literal port ba_low.
  public useLiteralPortVicStall: boolean = false;
  // Spec 303: route renderToPng default to literal port framebuffer.
  public useLiteralPortVicFb: boolean = false;
  // Spec 302: last ba_low captured from litCycle.vicii_cycle() — read
  // by busStallForNextC64Cycle when useLiteralPortVicStall is on.
  private lastLitBaLow: 0 | 1 = 0;
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
  // Spec 205-A c1: trace registry now lives on the kernel. Session
  // exposes it via getter so existing callers (smoke scripts, MCP
  // tools) keep working without churn.
  public get traceRegistry(): TraceRegistry { return this.kernel.traceRegistry; }
  public busAccessProducer?: BusAccessTraceProducer;
  public readonly useMicrocodedCpu: boolean;
  // Spec 141 Q9: drive head-start cycles, default 200_000 (≈200ms PAL).
  public readonly driveHeadStartCycles: number;
  // Spec 098: named session-mode preset (resolved at construction).
  public readonly mode: SessionMode;
  // Spec 262 Phase B-E: default renderer for renderFrame() / renderToPng().
  public readonly vicRenderer: "per-char-row" | "per-pixel" | "vice-rasterized" | "literal-port";
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
    if (opts.diskPath && !existsSync(opts.diskPath)) {
      throw new Error(`Disk image not found: ${opts.diskPath}`);
    }
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
        + `Pass an explicit \`mode\` (fast-trap | real-kernal | true-drive | debug-vice-compare | debug-lockstep) `
        + `or set mode: "custom" to silence this warning.`,
      );
    }
    const isPal = opts.isPal ?? true;
    this.driveCyclesPerC64Cycle = DRIVE_HZ / (isPal ? C64_HZ_PAL : C64_HZ_NTSC);
    this.driveClockRatio = this.driveCyclesPerC64Cycle;
    const ext = (opts.diskPath ?? "").toLowerCase().split(".").pop() ?? "";
    this.imageFormat = ext === "g64" ? "g64" : ext === "d64" ? "d64" : ext || "other";
    this.diskPath = opts.diskPath ?? "";

    // Spec 202: lockstep is diagnostic only. Microcoded CPU no longer
    // implies lockstep; true-drive is microcoded + event/catch-up.
    this.useCycleLockstep = opts.useCycleLockstep ?? false;
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
    // Spec 219 c4 — provide cycle clock for CPU-port capacitor decay.
    this.c64Bus.setCpuPortClock(() => this.c64Cpu.cycles);
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
    // VICE attach/detach delay state machine needs current cpu cycle.
    this.gcrShifter.setClockProvider(() => this.c64Cpu.cycles);
    this.drive = this.kernel.drive;
    if (this.mode === "true-drive" || this.mode === "debug-vice-compare") {
      this.kernel.setMode("true-drive");
    }

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
    // Spec 262 Phase B-E: vicRenderer default = per-char-row (no regression).
    this.vicRenderer = opts.vicRenderer ?? "per-char-row";
    // Spec 282: bind palette to framebuffer. Default colodore (OQ1=b).
    if (opts.palette) this.framebuffer.setPalette(opts.palette);
    // Spec 298k: install literal port renderer if opted in.
    // Spec 304: defaults flipped on. Literal port is now the
    // authoritative VIC-II path out of the box. Explicit `false`
    // in opts still selects legacy VicIIVice-only path for diff
    // comparison harnesses.
    this.useLiteralPortRenderer = opts.useLiteralPortRenderer ?? true;
    this.useLiteralPortVicPerCycle = opts.useLiteralPortVicPerCycle ?? true;
    // Spec 300: literal reads default to per-cycle flag (literal raster_y
    // is only in sync when per-cycle hook drives it).
    this.useLiteralPortVicReads = opts.useLiteralPortVicReads ?? this.useLiteralPortVicPerCycle;
    // Spec 301: literal IRQ defaults to literal-reads flag.
    this.useLiteralPortVicIrq = opts.useLiteralPortVicIrq ?? this.useLiteralPortVicReads;
    // Spec 302: literal stall defaults to literal-reads flag (literal
    // ba_low is only meaningful when per-cycle hook drives vicii_cycle).
    this.useLiteralPortVicStall = opts.useLiteralPortVicStall ?? this.useLiteralPortVicReads;
    // Spec 303: literal framebuffer default routing.
    this.useLiteralPortVicFb = opts.useLiteralPortVicFb ?? this.useLiteralPortVicReads;
    if (this.useLiteralPortRenderer) {
      this.installLiteralPortRenderer();
    }
    // Spec 093: trace wiring. timeSource bound to c64Cpu cycles via getter.
    this.iecBus.timeSource = () => this.c64Cpu.cycles;
    if (opts.traceIec) this.iecBus.enableTrace(opts.traceIecCapacity ?? 1024);
    this.drivePcTraceCapacity = opts.traceDrive ? (opts.traceDriveCapacity ?? 512) : 0;
    // Sprint 113 Phase 2: Cpu65xxVice is the required C64 CPU core for
    // IEC bit-bang correctness. Install it independently from the
    // scheduler so true-drive can run event/catch-up without lockstep.
    let cpuComponent: any;
    if (this.useMicrocodedCpu) {
      const microcoded = new Cpu65xxVice({
        memBus: this.c64Bus,
        alarmContext: this.maincpuAlarmContext,
      });
      // Replace c64Cpu with microcoded version. Cast — both share
      // public register state interface.
      (this as any).c64Cpu = microcoded;
      // Spec 200-c3: keep kernel's c64Cpu in sync. CIA clkPtr captured
      // a closure on kernel.c64Cpu; without this update CIAs would read
      // the stale Cpu6510's cycles (= 0 forever).
      (this.kernel as unknown as { c64Cpu: unknown }).c64Cpu = microcoded;
      // Spec 203-c4: re-attach onInterruptServiced to the new CPU.
      this.kernel.installCpuInterruptHooks();
      microcoded.reset();
      cpuComponent = microcoded;
    }

    if (this.useCycleLockstep) {
      if (!cpuComponent) {
        const cpuCycled = new Cpu6510Cycled(this.c64Cpu);
        cpuCycled.preInstructionCheck = () => this.checkC64Interrupts();
        this.cpuCycled = cpuCycled;
        cpuComponent = cpuCycled;
      }
      const c64Components = [
        cpuComponent,
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
      // Spec 280g: enable per-cycle bus stealing on the VIC chip.
      // Scheduler will query vic.getBusStallForCycle() before each CPU
      // step. When stalled, CPU does NOT step; cpu.cycles still bumps
      // so peripherals + drive (driven off cpu cycle delta) stay in
      // sync, and master clock advances normally.
      if (opts.usePerCycleBusStealing) {
        this.vic.usePerCycleBusStealing = true;
      }
      this.scheduler = new CycleLockstepSchedulerImpl({
        c64Components, driveComponents,
        c64IsAtInstructionBoundary: () => cpuComponent.isAtInstructionBoundary?.() ?? true,
        c64Pc: () => this.c64Cpu.pc,
        isPal,
        // Sprint 93.1: per-cycle IRQ/NMI pin update (VICE pattern).
        updateInterruptLines: opts.useMicrocodedCpu
          ? () => this.updateMicrocodedInterruptLines()
          : undefined,
        // Sprint 96: scheduler ticks peripherals + drive by CPU cycle
        // delta. Required so IRQ service / branch page-cross / illegal
        // burn don't desync drive timing during IEC bit-bang.
        cpuCycleCounter: () => (cpuComponent as any).cycles,
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
        // Spec 280g per-cycle bus stealing wiring.
        // Spec 302: when useLiteralPortVicStall on, sample literal
        // port ba_low (captured in onCycle hook from prior
        // vicii_cycle() call) instead of VicIIVice. Off-by-one alignment
        // matches VICE semantic ("ba_low computed in cycle N gates
        // Φ2 of cycle N+1" via prefetch countdown).
        busStallForNextC64Cycle: opts.usePerCycleBusStealing
          ? (this.useLiteralPortVicStall
              ? () => this.lastLitBaLow === 1
              : () => this.vic.getBusStallForCycle())
          : undefined,
        advanceC64CpuCycleOnStall: opts.usePerCycleBusStealing
          ? () => { (this.c64Cpu as { cycles: number }).cycles += 1; }
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
      this.busAccessProducer = producer;
      // Spec 205-A c1: register producer with kernel trace controller
      // so external consumers can reach it via kernel.trace().
      this.kernel.trace().setBusAccessProducer(producer);
    }
  }

  // Spec 262c: run the c64 forward until the VIC raster reaches the
  // bottom of the visible region (= raster line 251 PAL = first_dma_line
  // 48 + 200 lines + 3 cycle slack ≈ end of active display). Forces a
  // raster wrap to 0 first so scanlineSnapshots / frameLineLogs cover
  // exactly one fresh visible region. Bounded by ~3 frames of CPU
  // cycles to avoid wedging if the c64 is halted (= JAM / WAI loop).
  private runUntilFrameReady(): void {
    const targetVisibleEnd = (this.vic.first_dma_line | 0) + 200; // PAL: 48+200=248
    const maxCycles = this.vic.cycles_per_line * this.vic.screen_height * 3; // ~3 frames
    const startCycles = this.c64Cpu.cycles;
    // Step 1 — force raster wrap to line 0 if we aren't already there.
    // Run small instruction batches and inspect raster_y after each.
    let waitedForWrap = this.vic.raster_y === 0;
    while (!waitedForWrap) {
      if (this.c64Cpu.cycles - startCycles >= maxCycles) return;
      const before = this.vic.raster_y;
      this.runFor(64, { cycleBudget: 256 });
      if (this.vic.raster_y < before) waitedForWrap = true; // wrapped past max
      if (this.vic.raster_y === 0) waitedForWrap = true;
    }
    // Step 2 — run until raster_y >= targetVisibleEnd (within same
    // frame). If raster_y wraps again we still stop on the first
    // iteration where it's >= target.
    while (this.vic.raster_y < targetVisibleEnd) {
      if (this.c64Cpu.cycles - startCycles >= maxCycles) return;
      this.runFor(64, { cycleBudget: 256 });
    }
  }

  // Render the current VIC state to the framebuffer.
  // Spec 262 Phase B-E: dispatch on session.vicRenderer (or per-call
  // override). Default per-char-row remains the canonical path so this
  // method stays a no-regression alias for the legacy renderer.
  renderFrame(opts?: { renderer?: "per-char-row" | "per-pixel" | "vice-rasterized" }): void {
    const renderer = opts?.renderer ?? this.vicRenderer;
    if (renderer === "vice-rasterized") {
      // Spec 280c — VICE-faithful per-line raster_changes renderer.
      const cia2Pa = this.cia2.pra & this.cia2.ddra;
      renderFrameRasterized(this.framebuffer, {
        vic: this.vic,
        bus: this.c64Bus,
        initialCia2PaByte: cia2Pa,
      });
      return;
    }
    if (renderer === "per-pixel") {
      // Build initial CIA2 PA byte from the current PRA & DDRA mask.
      // The pixel-perfect renderer replays the per-cycle log onto the
      // current snapshot; using the live PRA as the seed approximates
      // the pre-frame value (overwritten by any in-frame PA writes).
      const cia2Pa = this.cia2.pra & this.cia2.ddra;
      renderFramePixelPerfect(this.framebuffer, {
        vic: this.vic,
        bus: this.c64Bus,
        initialCia2PaByte: cia2Pa,
      });
      return;
    }
    const cia2Pa = this.cia2.pra & this.cia2.ddra; // output bits only
    const bankBase = computeVicBankBase(cia2Pa & 0x03);
    renderTextModeFrame(this.framebuffer, {
      vic: this.vic,
      bus: this.c64Bus,
      vicBankBase: bankBase,
    });
  }

  // Render current VIC state then write to a PNG file. Phase 65f.
  // Crops 504×312 internal framebuffer to standard VICII PAL visible
  // 384×272 centered on active 320×200 region (VISIBLE_X/Y=24/51 →
  // active center at (184, 151) → crop origin (-8, 15) clamped to (0,15)).
  // Match VICE x64sc visible dimensions; eliminates over-wide right
  // border in raw 504-pixel output.
  renderToPng(
    path: string,
    opts?: { frameAligned?: boolean; renderer?: "per-char-row" | "per-pixel" | "vice-rasterized" | "cycle-pumped" | "literal-port" },
  ): { width: number; height: number; bytes: number } {
    // Spec 298k: literal port renderer = paint accumulated dbuf into
    // framebuffer (= 520×312 color indices → palette → RGBA). Bypass
    // snapshot replay entirely.
    if (opts?.renderer === "literal-port" && this.literalPortFb) {
      return this.renderLiteralPortToPng(path);
    }
    // Spec 303: when useLiteralPortVicFb flag is on AND no explicit
    // renderer requested, default to literal-port framebuffer.
    // Explicit `opts.renderer` always wins (= caller can still request
    // snapshot renderer for diff comparison).
    if (opts?.renderer === undefined &&
        this.useLiteralPortVicFb &&
        this.literalPortFb) {
      return this.renderLiteralPortToPng(path);
    }
    // Spec 262c: optional frame-boundary sync. Default true — running
    // until the visible raster region is fully populated guarantees the
    // per-line scanlineSnapshots cover every visible line, eliminating
    // the "empty rows at top/bottom" race when callers snap a frame
    // mid-trace. Pass `frameAligned: false` to preserve V1 behavior
    // (= render whatever scanline state is currently latched).
    const frameAligned = opts?.frameAligned !== false;
    if (frameAligned) {
      this.runUntilFrameReady();
    }
    // Spec 297l: cycle-pumped mode = framebuffer is filled continuously
    // by VicIIVice.onCycle hook (= installCyclePumpedRenderer at session
    // start). Skip the snapshot re-render so we keep the live cycle
    // pump output.
    if (opts?.renderer !== "cycle-pumped") {
      // literal-port + cycle-pumped already handled above; only the
      // 3 snapshot renderers go through renderFrame()
      const r = opts?.renderer;
      if (r === "per-char-row" || r === "per-pixel" || r === "vice-rasterized" || r === undefined) {
        this.renderFrame({ renderer: r });
      }
    }
    const fb = this.framebuffer;
    // V3.1 (2026-05-09): symmetric borders matching internal renderer
    // layout. VISIBLE_X=24 in vic-renderer.ts → display at internal
    // x=24..343 (320px). Output equal 24-px borders L/R = 368 wide.
    // VICE standard is 384×272 with 32-px borders, but our internal
    // buf has only 24-px left margin (re-rendering wider would
    // require widening framebuffer + adjusting all draw helpers).
    // Symmetric 368×272 = correct ratio, smaller borders than VICE
    // but L/R equal as user requested.
    // VICE x64sc default PAL visible window: 384×272.
    //   L 32 + display 320 + R 32 = 384
    //   T 36 + display 200 + B 36 = 272 (cropY=15 → 51 display start)
    const cropX = 0;
    const cropY = 15;
    const cropW = 384;
    const cropH = 272;
    const cropped = new Uint8Array(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      const srcRow = ((cropY + y) * fb.width + cropX) * 4;
      const dstRow = y * cropW * 4;
      cropped.set(fb.pixels.subarray(srcRow, srcRow + cropW * 4), dstRow);
    }
    const png = rgbaToPng(cropW, cropH, cropped);
    writeFileSync(path, png);
    return { width: cropW, height: cropH, bytes: png.length };
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
    // Cold-reset C64 peripherals. Without this, second+ reset leaves
    // CIA timers / IRQ state from previous run → no 50Hz timer A IRQ
    // → KERNAL cursor blink countdown ($CD) never decrements →
    // cursor stuck (= the "no cursor after reset" bug).
    this.cia1.reset();
    this.cia2.reset();
    this.vic.reset();
    // Reset keyboard clock + drop pending key events — c64Cpu.cycles
    // restarts at 0, keyboard would otherwise schedule events at the
    // pre-reset clock and miss the window.
    this.keyboard.clearEvents();
    this.keyboard.resetClock();
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
    // Spec 205-A c10: publish reset event to session trace channel.
    this.kernel.notifyReset(profile);
    // Spec 298k step 5: reset literal port state on cold reset so
    // multiple sessions / UI resets / repeated tests get clean
    // deterministic literal VIC state per machine reset.
    if (this.useLiteralPortRenderer) {
      LIT_VICII.vicii_reset();
      // Re-bind RAM (= ram_base_phi1/phi2 may have been replaced)
      LIT_VICII.vicii_bind_ram(this.c64Bus.ram);
      LIT_TYPES.vicii.regs = this.vic.regs;
      // Reset literal-port framebuffer accumulator
      this.literalPortFb?.fill(0);
    }
  }

  // Sprint 93.1: queue text typing into keyboard matrix. Hold/gap default
  // tuned for KERNAL SCNKEY raster IRQ (~16400 cyc per scan): 33000 cyc
  // hold + 33000 cyc gap means at least 2 scan ticks see press, 2 scan
  // ticks see release — buffer reliably picks up the key.
  typeText(text: string, holdCycles = 33000, gapCycles = 33000): void {
    this.keyboard.typeText(text, holdCycles, gapCycles);
    // Spec 205-A c10: publish keyboard input event (text-level).
    this.kernel.notifyInputChange("keyboard", { kind: "type_text", length: text.length });
  }

  // Sprint 93.1: set joystick port 2 directional / fire state.
  setJoystick2(state: Partial<JoystickState>): void {
    if (state.up !== undefined) this.joystick2.up = state.up;
    if (state.down !== undefined) this.joystick2.down = state.down;
    if (state.left !== undefined) this.joystick2.left = state.left;
    if (state.right !== undefined) this.joystick2.right = state.right;
    if (state.fire !== undefined) this.joystick2.fire = state.fire;
    this.kernel.notifyInputChange("joystick", { port: 2, state: { ...this.joystick2 } });
  }
  // Spec 107 (M2.5) v1: joystick port 1 + paddle + RESTORE NMI.
  setJoystick1(state: Partial<JoystickState>): void {
    if (state.up !== undefined) this.joystick1.up = state.up;
    if (state.down !== undefined) this.joystick1.down = state.down;
    if (state.left !== undefined) this.joystick1.left = state.left;
    if (state.right !== undefined) this.joystick1.right = state.right;
    if (state.fire !== undefined) this.joystick1.fire = state.fire;
    this.kernel.notifyInputChange("joystick", { port: 1, state: { ...this.joystick1 } });
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
  // Spec 204: each trap that fires records a kernel hook fire.
  // Mode-gating happens inside `kernel.recordHookFire`; in
  // `true-drive` mode any fire throws HookForbiddenError and the
  // session crashes loud — that is the audit signal.
  private checkAndHandleTraps(): boolean {
    // Traps that need disk are no-ops when no disk inserted.
    if (this.enableKernalFileIoTraps && this.diskProvider && handleKernalFileIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, state: this.kernalFileIo,
    })) {
      this.kernel.recordHookFire("kernal-fileio-trap", `pc=$${this.c64Cpu.pc.toString(16)}`);
      return true;
    }
    if (this.enableKernalSerialTraps && this.diskProvider && handleKernalSerialTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, drive: this.drive,
      iecBus: this.iecBus, state: this.kernalSerial,
    })) {
      this.kernel.recordHookFire("kernal-serial-trap", `pc=$${this.c64Cpu.pc.toString(16)}`);
      return true;
    }
    if (this.enableKernalIoTraps && this.diskProvider && handleKernalIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, serial: this.kernalSerial,
      state: this.kernalIo,
    })) {
      this.kernel.recordHookFire("kernal-io-trap", `pc=$${this.c64Cpu.pc.toString(16)}`);
      return true;
    }
    return false;
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
        // Spec 205-A c4: traps are not real instructions; they don't
        // emit a "cpu" trace edge (CPU's onInstructionComplete fires
        // for real instructions only).
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
    // Spec 204: route legacy step path through the same recorder
    // as the scheduler path so hook fires are accounted in both.
    const trapped = this.checkAndHandleTraps();
    if (trapped) {
      this.c64InstructionCount += 1;
      const trapCycles = 7;
      this.c64Cpu.cycles += trapCycles; // audit-ok: trap synthesizes JSR/RTS cost
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
    // BEFORE the C64 instruction starts. In true-drive, individual
    // $DD00 reads/writes push-flush through KernelBus.
    this.kernel.catchUpDrive(8, this.c64Cpu.cycles);
    if (this.useMicrocodedCpu) {
      this.updateMicrocodedInterruptLines();
    } else {
      this.checkC64Interrupts();
    }
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
    if (this.useMicrocodedCpu) {
      this.stepMicrocodedC64Instruction();
    } else {
      this.c64Cpu.step(); // audit-ok: legacy non-lockstep stepping; replaced by SyncStrategy in Spec 202
    }
    this.c64InstructionCount += 1;
    // Spec 205-A c4: cpu trace fires inside Cpu6510.step / Cpu65xxVice
    // — no need to publish here.
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
    // Spec 299: skip end-of-instruction batched tick when per-cycle
    // mode is active (= stepMicrocodedC64Instruction already ticked
    // VIC per CPU cycle, ticking again would double-advance the raster).
    const vicTick = (this.useLiteralPortVicPerCycle && this.useMicrocodedCpu)
      ? { stolenCycles: 0 }
      : this.vic.tick(consumed); // audit-ok: legacy per-instruction VIC tick; replaced by Spec 203
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
  //
  // Spec 202: true-drive also uses this path without lockstep; the
  // event/catch-up instruction loop below calls it before each CPU
  // micro-cycle.
  private updateMicrocodedInterruptLines(): void {
    const cpu = this.c64Cpu as any;
    if (!("irqLine" in cpu)) return;
    // Sprint 113 Phase 2: CIA1/CIA2 expose a latched IRQ-pin level via
    // their setIntClk callback; sample that directly instead of the old
    // irqAsserted() helper. Falls back to irqAsserted for tests that
    // poke icrFlags directly without going through the CIA write API.
    // Spec 301: literal IRQ source when flag on.
    const vicIrqAsserted = this.useLiteralPortVicIrq
      ? ((LIT_TYPES.vicii.irq_status & this.vic.regs[0x1a]! & 0x0f) !== 0)
      : this.vic.irqAsserted();
    cpu.irqLine = (this.cia1IrqLine() || this.cia1.irqAsserted()) || vicIrqAsserted;
    cpu.nmiLine = this.cia2NmiLine() || this.cia2.irqAsserted();
  }

  private stepMicrocodedC64Instruction(): void {
    const cpu = this.c64Cpu as unknown as {
      executeCycle?: () => void;
      isAtInstructionBoundary?: () => boolean;
      pc: number;
    };
    if (typeof cpu.executeCycle !== "function" || typeof cpu.isAtInstructionBoundary !== "function") {
      throw new Error("useMicrocodedCpu=true but c64Cpu does not expose executeCycle/isAtInstructionBoundary");
    }

    let guard = 0;
    if (this.useLiteralPortVicPerCycle) {
      // Spec 299 per-cycle interleave: tick VIC by 1 cycle per CPU bus
      // cycle so any CPU write to $D000-$D03F lands at the EXACT raster
      // cycle of the store (= literal port draws with correct mid-line
      // register value). VicIIVice.tick(1) fires onCycle hook which
      // advances literal port via vicii_cycle().
      do {
        this.updateMicrocodedInterruptLines();
        const before = (this.c64Cpu as unknown as { cycles: number }).cycles;
        cpu.executeCycle();
        const after = (this.c64Cpu as unknown as { cycles: number }).cycles;
        const consumed = after - before;
        if (consumed > 0) this.vic.tick(consumed);
        if (++guard > 256) {
          throw new Error(
            `microcoded C64 instruction did not reach boundary pc=$${(cpu.pc & 0xffff).toString(16)}`,
          );
        }
      } while (!cpu.isAtInstructionBoundary());
    } else {
      // Legacy batched path: VIC ticks AFTER full instruction (= caller
      // does this.vic.tick(consumed) after stepMicrocodedC64Instruction).
      do {
        this.updateMicrocodedInterruptLines();
        cpu.executeCycle();
        if (++guard > 256) {
          throw new Error(
            `microcoded C64 instruction did not reach boundary pc=$${(cpu.pc & 0xffff).toString(16)}`,
          );
        }
      } while (!cpu.isAtInstructionBoundary());
    }
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

  /**
   * Spec 298k — install literal VICE x64sc port as the rendering source.
   *
   * Setup:
   *   - Bind literal port's vicii.regs to share session.vic.regs by reference
   *   - Bind literal port's ram_base_phi1/phi2 to c64Bus.ram
   *   - Hook color RAM (= io[0x0800..]) and chargen ROM
   *   - vicii_init + vicii_reset
   *   - Install 297a onCycle hook that mirrors color regs (= equivalent
   *     to vicii-mem.c colreg writes) + calls vicii_cycle() per cycle
   *   - On raster_line transition, copy vicii.dbuf into literalPortFb
   *
   * Resulting `literalPortFb` (520×312 color indices) is rendered to
   * PNG by renderToPng({ renderer: "literal-port" }).
   */
  private installLiteralPortRenderer(): void {
    const { vicii } = LIT_TYPES;
    const lit = LIT_VICII;
    const litCycle = LIT_CYCLE;
    const litFetch = LIT_FETCH;
    const litIrq = LIT_IRQ;
    const litDraw = LIT_DRAW;

    // Bind RAM + share regs[] by reference (= no per-cycle copy)
    lit.vicii_bind_ram(this.c64Bus.ram);
    vicii.regs = this.vic.regs;

    // Color RAM lives at io[0x0800..0x0bff]
    const colorRamView = new Uint8Array(
      this.c64Bus.io.buffer,
      this.c64Bus.io.byteOffset + 0x0800,
      0x400,
    );

    litFetch.setFetchHost({
      mem_chargen_rom_ptr: this.c64Bus.charRom,
      mem_color_ram_vicii: colorRamView,
      export_ultimax_phi1: 0,
      export_ultimax_phi2: 0,
      ultimax_romh_phi1_read: () => null,
      ultimax_romh_phi2_read: () => null,
      reg_pc: 0,
    });
    litIrq.setIrqHost({
      maincpu_set_irq: () => {},
      maincpu_set_irq_clk: () => {},
      maincpu_clk: () => 0,
      interrupt_cpu_status_int_new: () => 0,
    });

    lit.vicii_init();
    lit.vicii_reset();

    // Spec 298k step 2: register $D000-$D03F write hooks so literal port
    // sees ALL VIC reg writes via vicii_store (= proper side effects:
    // ysmooth update, raster_irq_line update, sprite x recompute, IRQ
    // raise/clear, color reg cregs[] propagation). Replaces poll-based
    // color reg sync. Reads stay through VicIIVice (= legacy snapshot
    // renderer still uses VICE-rasterized snapshots).
    const bus = this.c64Bus as unknown as {
      registerIoHandler: (a: number, h: { read: (a: number) => number; write: (a: number, v: number) => void }) => void;
    };
    const useLitReads = this.useLiteralPortVicReads;
    for (let mirror = 0; mirror < 0x400; mirror += 0x40) {
      for (let r = 0; r < 0x40; r++) {
        const a = 0xd000 + mirror + r;
        const reg = r;
        const vicChip = this.vic;
        bus.registerIoHandler(a, {
          // Spec 300: read source = literal vicii_read when flag on
          // (literal raster_y is in sync via per-cycle hook), else
          // legacy VicIIVice. Diff harness compares both via direct
          // chip access regardless of which one serves IO reads.
          read: useLitReads
            ? () => LIT_MEM.vicii_read(reg)
            : () => vicChip.read(reg),
          write: (_addr, value) => {
            // Mirror to literal port FIRST (= VICE order: store updates
            // derived state immediately, draw_cycle picks up in same cycle)
            LIT_MEM.vicii_store(reg, value);
            // Also keep VicIIVice in sync (= UI / scheduler / IRQ pump
            // still depend on VicIIVice raster_y / IRQ status)
            vicChip.write(reg, value);
          },
        });
      }
    }

    // 520×312 framebuffer accumulator (= 65 cycles × 8 px = 520 wide)
    const FB_W = 65 * 8;
    const FB_H = 312;
    this.literalPortFb = new Uint8Array(FB_W * FB_H);
    const fb = this.literalPortFb;
    let lastRasterLine = -1;

    this.vic.onCycle = (_raster_y, _raster_cycle, _clk) => {
      // Bind VIC bank from CIA2 PA (inverted bits 0-1)
      const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
      const bank = (~cia2Pa) & 0x03;
      vicii.vbank_phi1 = bank * 0x4000;
      vicii.vbank_phi2 = bank * 0x4000;

      // Spec 302: capture ba_low for next CPU cycle's stall query.
      this.lastLitBaLow = (litCycle.vicii_cycle() & 1) as 0 | 1;

      // Capture dbuf when line changes
      if (vicii.raster_line !== lastRasterLine) {
        if (lastRasterLine >= 0 && lastRasterLine < FB_H) {
          const off = lastRasterLine * FB_W;
          for (let x = 0; x < FB_W; x++) {
            fb[off + x] = vicii.dbuf[x]!;
          }
        }
        lastRasterLine = vicii.raster_line;
      }
    };
    void litDraw; // import retained for previous polling path; now unused
  }

  /**
   * Spec 298k — render the literalPortFb (= 520×312 color indices) as
   * PNG. Bypasses snapshot replay; reads only what the literal port
   * has accumulated.
   */
  private renderLiteralPortToPng(path: string): { width: number; height: number; bytes: number } {
    const FB_W_INTERNAL = 65 * 8; // 520 — full dbuf width
    const FB_H_INTERNAL = 312;
    const fb = this.literalPortFb!;
    const palette = this.framebuffer.palette;

    // Spec 298k harness fixes (= what user identified as off):
    //   1. Right-side black band (= 16 px) — dbuf positions [504..519] never
    //      written by visible/sprite-fetch cycles. Crop to display window.
    //   2. Bottom 8-px black band — last raster line never captured because
    //      hook fires on raster_line CHANGE and cycle 1 of new line resets
    //      dbuf BEFORE we copy. Force-capture line 311 by reading dbuf at
    //      render time even if hook hasn't seen the wrap yet.
    //   3. Asymmetric L/R borders — caused by 1+2 above plus alignment
    //      mismatch between dbuf coord (cycle 1 = pixel 0) and VICE x64sc
    //      canvas (display first pixel = canvas x=32). Crop to canvas.
    //
    // Output: VICE x64sc PAL canvas convention = 384×272 visible window.
    //   - Display columns 0..39 land in dbuf at [128..447] (= cycle 17
    //     phi1 emit at dbuf[128]).
    //   - Add 32-px left border + 32-px right border:
    //       canvas crop X = dbuf[96..480] = 384 px wide
    //   - First displayed line per VICE PAL = line 16, height 272:
    //       canvas crop Y = fb[16..288] = 272 px tall
    const CANVAS_X0 = 96;
    const CANVAS_W = 384;
    const CANVAS_Y0 = 16;
    const CANVAS_H = 272;

    const rgba = new Uint8Array(CANVAS_W * CANVAS_H * 4);
    for (let cy = 0; cy < CANVAS_H; cy++) {
      const srcY = cy + CANVAS_Y0;
      if (srcY >= FB_H_INTERNAL) continue;
      for (let cx = 0; cx < CANVAS_W; cx++) {
        const srcX = cx + CANVAS_X0;
        if (srcX >= FB_W_INTERNAL) continue;
        const cIdx = fb[srcY * FB_W_INTERNAL + srcX]! & 0x0f;
        const [r, g, b] = palette[cIdx]!;
        const off = (cy * CANVAS_W + cx) * 4;
        rgba[off] = r;
        rgba[off + 1] = g;
        rgba[off + 2] = b;
        rgba[off + 3] = 0xff;
      }
    }
    const pngBytes = rgbaToPng(CANVAS_W, CANVAS_H, rgba);
    writeFileSync(path, pngBytes);
    return { width: CANVAS_W, height: CANVAS_H, bytes: pngBytes.length };
  }
}
