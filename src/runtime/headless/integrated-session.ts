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
// Spec 704 §11 R3 — legacy drive/** (DriveCpu / TrackBuffer / HeadPosition /
// GcrShifter) removed. VICE1541 is the only drive.
import { G64Parser } from "../../disk/g64-parser.js";
import { buildG64 } from "../../disk/g64-builder.js";
import { DiskProvider } from "./providers.js";
import { existsSync, readFileSync } from "node:fs";
import { VicIIVice, installVicIIVice, type VicBackend } from "./vic/vic-ii-vice.js";
// Spec 298k literal-port modules (= eager-loaded; modules are tiny and
// avoid module-loader cycle vs ESM/CJS).
import * as LIT_VICII from "./vic/literal/vicii.js";
import * as LIT_TYPES from "./vic/literal/vicii-types.js";
import type { RuntimeCheckpointVicPresentation } from "./kernel/runtime-checkpoint.js";
import * as LIT_CYCLE from "./vic/literal/vicii-cycle.js";
import * as LIT_FETCH from "./vic/literal/vicii-fetch.js";
import * as LIT_IRQ from "./vic/literal/vicii-irq.js";
import * as LIT_DRAW from "./vic/literal/vicii-draw-cycle.js";
import * as LIT_MEM from "./vic/literal/vicii-mem.js";
import { installSid, type Sid6581 } from "./sid/sid.js";
// Spec 404: removed `renderTextModeFrame`, `computeVicBankBase` from
// import (= legacy snapshot renderer deleted; bank-base not needed here).
import { VicFramebuffer } from "./peripherals/vic-renderer.js";
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
  KeyboardCycled,
} from "./scheduler/cycle-wrappers.js";
import { Cpu65xxVice } from "./cpu/cpu65xx-vice.js";
import {
  type AlarmContext,
} from "./alarm/alarm-context.js";
import { HeadlessMachineKernel } from "./kernel/headless-machine-kernel.js";
import type { Drive1541Implementation, Drive1541DebugProbe } from "./drive1541/drive1541.js";

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
  /**
   * Spec 428 Phase C — drive CPU dispatch mode (opt-in flag).
   * - "cycle-stepped" (default): post-Spec-401 path.
   * - "vice-whole-instruction": VICE drivecpu.c shape (= IM2 Epyx fix).
   */
  driveDispatchMode?: "cycle-stepped" | "vice-whole-instruction";
  // Spec 611: side-by-side 1541 rebuild. Default remains "legacy" until
  // VICE1541 passes the runtime proof gates.
  drive1541?: Drive1541Implementation;
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
  /** @deprecated Spec 309: literal-port is sole renderer. This option is
   *   ignored. Kept here only so old callers don't TS-error during
   *   migration window. */
  vicRenderer?: "literal-port";
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
  public readonly iecBus: IecBus;
  // Spec 704 §11 R3 — legacy drive / trackBuffer / headPosition / gcrShifter
  // fields removed. VICE1541 (kernel.drive1541) is the only drive; it owns
  // its 6502 / VIAs / GCR rotation / head geometry internally.
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
  // Phase-C compat-bridge: per-source IntNum + NMI edge state.
  private intNumCia1Irq: any = null;
  private intNumVicIrq: any = null;
  private intNumCia2Nmi: any = null;
  private prevCia2NmiBridgeLevel = false;
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
  // Spec 307: literal driver state — moved out of onCycle closure so
  // tickLitVic() can be called directly from stepMicrocodedC64Instruction.
  private litLastRasterLine: number = -1;
  private readonly litFbW: number = 65 * 8;
  private readonly litFbH: number = 312;
  // Spec V-stable-frame: complete-frame snapshot. literalPortFb is the
  // ACCUMULATOR (= currently filling). literalPortFbStable is the LAST
  // COMPLETE FRAME (= snap of literalPortFb taken when raster wraps to
  // line 0 = full frame just finished). renderLiteralPortToPng reads
  // from stable buffer so it never sees a half-filled frame.
  public literalPortFbStable: Uint8Array | null = null;
  private litStableFrameCount: number = 0;
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
  /** Always "literal-port" since Spec 309 (sole renderer). */
  public readonly vicRenderer: "literal-port" = "literal-port";
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

    // Spec 622 §4.0 (2026-05-20) — do NOT force useCycleLockstep in vice
    // mode. The earlier force (Spec 614.3) globally switched the C64/VIC
    // into the per-cycle CycleLockstepScheduler, but that is not
    // VICE-shaped and is the prime perf cost:
    //   - the vice drive is ALREADY event-driven (afterCycleSync=undefined;
    //     the bridge's pushFlush.one/all → vice.tickToClock(clk) catches the
    //     1541 up to the exact $DD00 R/W clock, exactly like VICE's
    //     iecbus_cpu_*_conf1 → drive_cpu_execute_one). The Spec 614.3
    //     per-c64-cycle drive tick was already reverted as over-engineering.
    //   - VIC cycle-accuracy comes from the CPU tick calling vicii_cycle()
    //     per cycle (Spec 425) in BOTH scheduler paths — proven by the
    //     Spec 600 proof-gate screenshots, which run eventCatchup
    //     (useCycleLockstep=false) and are pixel-exact.
    // So vice mode runs the VICE-shaped EventCatchupStrategy (instruction-
    // stepped C64 + drive catch-up at IEC events) like every other mode.
    // useCycleLockstep stays opt-driven (default false) and is still
    // reachable explicitly for probes/bisects.
    //
    // Verification gates (Spec 622 §4.0): proof-oracle pixel diff = 0,
    // 616/617 byte-fidelity + check:1541-fidelity green, motm gold
    // fastloader swimlane 0 byte-divergence.

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
      driveDispatchMode: opts.driveDispatchMode,
      drive1541: opts.drive1541,
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
    this.cia2 = this.kernel.cia2;
    // Phase D: CIA1/CIA2 now push into cpuIntStatus directly; no level
    // getters needed on the session. Keep stub closures only for legacy
    // checkC64Interrupts path (Cpu6510 non-microcoded).
    this.cia1IrqLine = () => this.cia1.irqAsserted();
    this.cia2NmiLine = () => this.cia2.irqAsserted();
    this.keyboard = this.kernel.keyboard;
    this.joystick1 = this.kernel.joystick1;
    this.joystick2 = this.kernel.joystick2;
    this.paddles = this.kernel.paddles;
    this.vic = this.kernel.vic;
    this.sid = this.kernel.sid;
    this.framebuffer = this.kernel.framebuffer;
    this.parser = this.kernel.parser;
    this.diskProvider = this.kernel.diskProvider;
    // Spec 704 §11 R3 — legacy drive object mirrors removed.
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
    // Spec 309: vicRenderer is always "literal-port" (default value applies).
    void opts.vicRenderer; // accepted for backwards-compat, ignored
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
        cpuIntStatus: this.kernel.cpuIntStatus,
        // Spec 425 — C64 CPU calls vicii_cycle() from inside tick() per
        // VICE CLK_INC. Drive CPU MUST NOT pass this hook.
        c64ViciiCycle: this.useLiteralPortVicPerCycle
          ? () => this.tickLitVic()
          : undefined,
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
      // Spec 704 §11 R3 — vice-only: the scheduler ticks no legacy drive
      // (disableLockstepDriveTick was already true in vice mode). The vice
      // drive advances via eventCatchup / pushFlush → drive1541.tickToClock.
      const driveComponents: import("./scheduler/cycle-steppable.js").CycleSteppable[] = [];
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
        // Spec 138 probe options. Spec 614.3 overrides for vice drive
        // (see afterCycleSync below): drive1541="vice" forces
        // disableLockstepDriveTick on (legacy DriveCpu stays quiet in
        // vice mode per Spec 612 T3.2-fix-O; per-cycle drive tick
        // happens through drive1541.tickToClock).
        tickDriveFirst: opts.probeMode === "B",
        // Spec 704 §11 R3 — vice-only: never tick a legacy lockstep drive.
        disableLockstepDriveTick: true,
        // Spec 614.3 §3.3 — per-c64-cycle drive tick wiring. In vice
        // mode, every c64 cycle the scheduler advances the vice1541
        // drive to the current c64 clk. This is the core fix for
        // Spec 614 §1 mismatch 1 (atomicity granularity) and §1
        // mismatch 3 (stable-read failure of drive ROM $E9C0-$E9C3
        // debpia). VICE equiv: drive_cpu_execute_one called per c64
        // cycle by maincpu_mainloop (src/maincpu.c).
        //
        // For probe variants A/B (legacy lockstep + flush, no vice
        // drive), the original setSyncBaseline hook is preserved.
        // Spec 704 §11 R3 — vice-only: the drive ticks only on $DD00 R/W
        // via pushFlush → vice.tickToClock (event-driven, VICE-shaped).
        // No per-cycle afterCycleSync drive tick.
        afterCycleSync: undefined,
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
      // Spec 704 §11 R3 — drive-side bus trace reads the vice drive via
      // driveDebug() (probe). The legacy drive VIA1 busAccessHook is gone,
      // so drive-VIA register-access events are not captured here
      // (driveVia1 omitted); the drive-CPU pc/clk lane still works.
      const self = this;
      const driveCpuView = {
        get pc() { return self.driveDebug().drive_pc; },
        get cycles() { return self.driveDebug().drive_clk; },
      };
      const producer = new BusAccessTraceProducerImpl({
        registry: this.traceRegistry,
        c64Cpu: this.c64Cpu as unknown as { pc: number; cycles: number; isAtInstructionBoundary?: () => boolean },
        driveCpu: driveCpuView as unknown as { pc: number; cycles: number; isAtInstructionBoundary?: () => boolean },
        schedule: {
          c64Cycle: () => this.scheduler ? this.scheduler.c64Cycle() : this.c64Cpu.cycles,
          driveCycle: () => this.scheduler ? this.scheduler.driveCycle() : self.driveDebug().drive_clk,
        },
        iecBus: this.iecBus,
      });
      producer.setFilter({
        pcRangesC64: opts.busAccessPcRangesC64 ?? [],
        pcRangesDrive: opts.busAccessPcRangesDrive ?? [],
      });
      producer.enable();
      this.iecBus.busAccessProducer = producer;
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
    // Spec 307: read literal raster_line directly (literal port is the
    // authority; VicIIVice.raster_y may not advance in fidelity mode
    // when stepMicrocodedC64Instruction skips vic.tick).
    const litRy = () => LIT_TYPES.vicii.raster_line;
    const targetVisibleEnd = (this.vic.first_dma_line | 0) + 200; // PAL: 48+200=248
    const maxCycles = this.vic.cycles_per_line * this.vic.screen_height * 3; // ~3 frames
    const startCycles = this.c64Cpu.cycles;
    let waitedForWrap = litRy() === 0;
    while (!waitedForWrap) {
      if (this.c64Cpu.cycles - startCycles >= maxCycles) return;
      const before = litRy();
      this.runFor(64, { cycleBudget: 256 });
      if (litRy() < before) waitedForWrap = true; // wrapped past max
      if (litRy() === 0) waitedForWrap = true;
    }
    while (litRy() < targetVisibleEnd) {
      if (this.c64Cpu.cycles - startCycles >= maxCycles) return;
      this.runFor(64, { cycleBudget: 256 });
    }
  }

  // Render the current VIC state to the framebuffer.
  // Spec 262 Phase B-E: dispatch on session.vicRenderer (or per-call
  // override). Default per-char-row remains the canonical path so this
  // method stays a no-regression alias for the legacy renderer.
  /** Spec 309: paint literal port literalPortFb into framebuffer.pixels
   *  RGBA. Only video.ts export pipeline still uses this; renderToPng
   *  now writes directly via renderLiteralPortToPng (no framebuffer
   *  copy). */
  renderFrame(): void {
    if (!this.literalPortFb) return;
    const FB_W = this.litFbW;
    const FB_H = this.litFbH;
    const fb = this.framebuffer;
    const palette = fb.palette;
    const dst = fb.pixels;
    const src = this.literalPortFb;
    // VICE x64sc visible window crop (= same as renderLiteralPortToPng):
    // X=[96..480) → 384 wide, Y=[16..288) → 272 tall, mapped to fb at
    // (0..384, 0..272). fb.width default 504; we paint columns 0..384.
    const dispW = 384, dispH = 272;
    const xOff = 96, yOff = 16;
    for (let y = 0; y < dispH; y++) {
      for (let x = 0; x < dispW; x++) {
        const idx = src[(y + yOff) * FB_W + (x + xOff)] & 0x0f;
        const rgb = palette[idx]!;
        const off = (y * fb.width + x) * 4;
        dst[off]     = rgb[0];
        dst[off + 1] = rgb[1];
        dst[off + 2] = rgb[2];
        dst[off + 3] = 0xff;
      }
    }
  }

  // Render current VIC state then write to a PNG file. Phase 65f.
  // Crops 504×312 internal framebuffer to standard VICII PAL visible
  // 384×272 centered on active 320×200 region (VISIBLE_X/Y=24/51 →
  // active center at (184, 151) → crop origin (-8, 15) clamped to (0,15)).
  // Match VICE x64sc visible dimensions; eliminates over-wide right
  // border in raw 504-pixel output.
  renderToPng(
    path: string,
    opts?: { frameAligned?: boolean },
  ): { width: number; height: number; bytes: number } {
    // Spec 309: literal-port is sole renderer.
    if (opts?.frameAligned !== false) this.runUntilFrameReady();
    if (this.literalPortFb) return this.renderLiteralPortToPng(path);
    // Defensive: paint via renderFrame (= literal port too).
    this.renderFrame();
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
  /**
   * Spec 704 §11 R3 — vice-drive debug snapshot. Replaces the legacy
   * `this.drive.cpu.*` / `this.headPosition.currentTrack` reads on the
   * snapshot / VSF / status / trace surfaces. Returns zeros if the drive
   * facade exposes no probe (should not happen in vice-only mode).
   */
  driveDebug(): Drive1541DebugProbe {
    const d = this.kernel.drive1541 as { debugProbe?(): Drive1541DebugProbe } | undefined;
    return d?.debugProbe?.() ?? {
      drive_pc: 0, drive_a: 0, drive_x: 0, drive_y: 0, drive_sp: 0,
      drive_flags: 0, drive_clk: 0, head_halftrack: 0, current_track: 0, led: 0,
    };
  }

  resetCold(profile: ResetProfile = "pal-default", opts?: { keepRam?: boolean }): void {
    const spec = getResetProfile(profile);
    if (opts?.keepRam) {
      // HW reset-button: keep user RAM, restore only banking + PLA.
      this.c64Bus.resetCpuPortKeepRam();
    } else {
      this.c64Bus.reset();
      applyRamFillPattern(this.c64Bus.ram, spec);
    }
    this.iecBus.reset();
    if (this.iecBus.isTraceEnabled()) this.iecBus.clearTrace();
    this.c64Cpu.reset();
    // Spec 704 §11 R3 — vice-only: reset the vice drive. (Legacy
    // this.drive.reset / setSyncBaseline removed.) Without this the vice
    // drive holds last_clk from before resetCold; c64 cycles reset to 0
    // → first catchUpTo(0) sees clk_value < last_clk → drive never
    // advances during boot. Reset vice in lockstep with the c64.
    const kernelAny = this.kernel as unknown as { drive1541?: { reset?: (kind?: "cold" | "warm") => void } };
    kernelAny.drive1541?.reset?.("cold");
    // Spec 145 v3+: re-sync drive VIA1 CA1 pin baseline AFTER
    // drive.reset() resets the VIA's lastCa1Pin to true.
    this.iecBus.syncDriveCa1Baseline();
    // Spec 141 (Q9): drive head-start. Run drive ROM standalone for N
    // c64-equivalent cycles BEFORE c64 starts, replicating real-HW
    // boot order. Eliminates ATN-edge boot-race.
    const headStart = this.driveHeadStartCycles;
    if (headStart > 0) {
      this.kernel.catchUpDrive(8, headStart);
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
    // Spec 704 §11 R3 — vice drive owns head geometry (reset via
    // drive1541.reset above); legacy headPosition.reset removed.
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

  /**
   * Reset button (HW RESET line): re-init the CPU + C64 I/O chips + drive,
   * restore default banking, and re-enter the KERNAL reset routine via the
   * $FFFC vector (= $FCE2). KEEPS user RAM — unlike a power-cycle, which
   * fills the cold-boot RAM pattern. Recovers from a running or JAMmed
   * game (c64Cpu.reset clears the jammed flag + pending IRQ/NMI; chip
   * resets clear active raster-IRQ / CIA timers that would otherwise
   * re-hijack execution). The 1541 disk stays mounted; the drive re-runs
   * its ROM so it is back at a known head/track for the next access.
   */
  resetWarm(profile: ResetProfile = "pal-default"): void {
    this.resetCold(profile, { keepRam: true });
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

  // Spec 310: live key press / release (browser passthrough).
  keyDown(key: import("./peripherals/keyboard.js").KeyName): void {
    this.keyboard.setKeyDown(key);
    this.kernel.notifyInputChange("keyboard", { kind: "key_down", key });
  }
  keyUp(key: import("./peripherals/keyboard.js").KeyName): void {
    this.keyboard.setKeyUp(key);
    this.kernel.notifyInputChange("keyboard", { kind: "key_up", key });
  }
  releaseAllKeys(): void {
    this.keyboard.releaseAllLive();
    this.kernel.notifyInputChange("keyboard", { kind: "release_all" });
  }
  pressedKeys(): import("./peripherals/keyboard.js").KeyName[] {
    return this.keyboard.livePressedKeys();
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
    const pc = this.driveDebug().drive_pc;
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
    // Spec 704 §11 R3 — legacy KERNAL-serial fast-trap removed: it poked
    // the legacy drive RAM/PC (M-W/M-E), incompatible with VICE1541, and
    // was forbidden in true-drive mode anyway (Spec 429 §8). The kernalSerial
    // state survives for handleKernalIoTrap below.
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
    // Spec 404 Phase D — VIC IRQ chip-side push migration (= 1:1 VICE).
    // All IRQ/NMI sources now push into kernel.cpuIntStatus directly:
    //   - CIA1 IRQ:   ciacore my_set_int chokepoint (spec 403 / Phase 309-D').
    //   - CIA2 NMI:   same chokepoint (spec 403).
    //   - VIC IRQ:    literal-port `setIrqHost` calls cpuIntStatus.setIrq
    //                 from inside vicii_irq_set_line / vicii_irq_raster_set
    //                 (= chip-side push, see installLiteralPortRenderer
    //                 wiring above). Doc §5.11; VICE vicii-irq.c:36-67.
    // No session-side sampling required. Function retained as no-op for
    // legacy call-sites (stepC64Instruction non-microcoded fallback path,
    // CycleLockstepScheduler updateInterruptLines binding).
  }

  /**
   * Spec 401 — per-cycle orchestrator entry. Each iteration is one
   * x64sc bus cycle (= one VICE CLK_INC pass). The CPU's executeCycle
   * internally does the canonical CLK_INC: alarm-drain → bumpDelays →
   * clk++ (Cpu65xxVice.tick(), doc §11 steps 1-3, c64cpusc.c:47).
   * VIC tick stays at the orchestrator level for spec 401 Phase A;
   * spec 404 Phase D folds vicii_cycle() back into the CPU's tick().
   *
   * Doc: docs/vice-c64-arch.md §11 step 4; VICE: maincpu.c:526
   * maincpu_mainloop.
   */
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
      // Spec 425 — Cpu65xxVice.tick() owns CLK_INC. Every CPU clock
      // increment (= internal tick) calls vicii_cycle() via c64ViciiCycle
      // hook. No session-side vic.tick pumping. IRQ entry, branch +1,
      // page-cross, illegal-opcode burn cycles all interleave with VIC
      // automatically.
      do {
        this.updateMicrocodedInterruptLines();
        cpu.executeCycle();
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
      // Spec 704 §11 R3 — vice-redirect: drive snapshot from the vice
      // drive probe (was legacy drive.cpu / headPosition).
      drive: ((d) => ({
        pc: d.drive_pc, a: d.drive_a, x: d.drive_x, y: d.drive_y,
        sp: d.drive_sp, flags: d.drive_flags,
        cycles: d.drive_clk, instructions: 0,
        track: d.current_track,
      }))(this.driveDebug()),
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
    // Spec 404 Phase D — VIC-II IRQ chip-side push (= 1:1 VICE port).
    // Doc anchor: docs/vice-c64-arch.md §5.11 ("Push site (chip-side, not
    // alarm-driven)") + §12 step 19.
    // VICE source: src/viciisc/vicii-irq.c:36-67 (vicii_irq_set_line,
    // vicii_irq_raster_set / vicii_irq_set_line_clk) + maincpu.c maincpu_set_irq /
    // maincpu_set_irq_clk wrappers around interrupt_set_irq() on
    // maincpu_int_status.
    //
    // Previously: session-side sampling in updateMicrocodedInterruptLines
    // (Phase 309-E revert). With spec 401 perCycleAlarmDrain landed, tick
    // order is correct → chip-side push is now safe (no D018 misalignment).
    // OQ-404-3 RESOLVED: chip-side push, with maincpu_set_irq_clk taking
    // an explicit mclk so INTERRUPT_DELAY=2 anchors to the raster-compare
    // cycle.
    const sessionForIrq = this;
    let vicIntNum: number = -1;
    litIrq.setIrqHost({
      maincpu_set_irq: (_int_num: number, value: number) => {
        const cpu = sessionForIrq.c64Cpu as unknown as { cpuIntStatus?: { setIrq: (n: number, v: boolean, clk: number) => void; newIntNum: (s: string) => number }; cycles: number };
        if (!cpu.cpuIntStatus) return;
        if (vicIntNum < 0) vicIntNum = cpu.cpuIntStatus.newIntNum("vic-irq");
        cpu.cpuIntStatus.setIrq(vicIntNum, value !== 0, cpu.cycles);
        sessionForIrq.intNumVicIrq = vicIntNum;
      },
      maincpu_set_irq_clk: (_int_num: number, value: number, mclk: number) => {
        const cpu = sessionForIrq.c64Cpu as unknown as { cpuIntStatus?: { setIrq: (n: number, v: boolean, clk: number) => void; newIntNum: (s: string) => number } };
        if (!cpu.cpuIntStatus) return;
        if (vicIntNum < 0) vicIntNum = cpu.cpuIntStatus.newIntNum("vic-irq");
        cpu.cpuIntStatus.setIrq(vicIntNum, value !== 0, mclk);
        sessionForIrq.intNumVicIrq = vicIntNum;
      },
      maincpu_clk: () => (sessionForIrq.c64Cpu as unknown as { cycles: number }).cycles,
      interrupt_cpu_status_int_new: (name: string) => {
        const cpu = sessionForIrq.c64Cpu as unknown as { cpuIntStatus?: { newIntNum: (s: string) => number } };
        if (!cpu.cpuIntStatus) return 0;
        const n = cpu.cpuIntStatus.newIntNum(name);
        vicIntNum = n;
        sessionForIrq.intNumVicIrq = n;
        return n;
      },
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

    // Spec 307: 520×312 framebuffer accumulator allocated once.
    // tickLitVic() uses the persistent state fields (litLastRasterLine,
    // litFbW, litFbH) so it can be called directly from
    // stepMicrocodedC64Instruction without a closure indirection.
    this.literalPortFb = new Uint8Array(this.litFbW * this.litFbH);
    this.litLastRasterLine = -1;
    // Spec 307: onCycle still wired for cycle-lockstep + fast-trap
    // paths (= scheduler / non-microcoded routes that don't hit
    // stepMicrocodedC64Instruction). For the microcoded per-cycle
    // path (default in true-drive mode), tickLitVic() is called
    // DIRECTLY instead of through this hook.
    this.vic.onCycle = () => this.tickLitVic();
    void litDraw; // import retained for previous polling path; now unused
  }

  /**
   * Spec 307 — literal port per-cycle driver. Called directly from
   * stepMicrocodedC64Instruction (per-cycle path) to advance literal
   * VIC state by one cycle without going through VicIIVice.tick +
   * onCycle callback. Also captures the dbuf scanline into the
   * accumulator framebuffer when raster line changes.
   */
  private tickLitVic(): 0 | 1 {
    const lv = LIT_TYPES.vicii;
    // Spec V-V2-fix: VIC samples vbank at START of cycle (= Phi1 fetch).
    // Run vicii_cycle() FIRST with vbank from PREVIOUS cycle. CIA2 PA
    // bits change due to mid-cycle CPU write (= Phi2). New bank takes
    // effect NEXT cycle.
    const baLow = (LIT_CYCLE.vicii_cycle() & 1) as 0 | 1;
    this.lastLitBaLow = baLow;
    // Spec 425 — BA-low return now folded into maincpu_ba_low_flags
    // BY THE CPU, not here. Cpu65xxVice.tick() calls c64ViciiCycle hook
    // and ORs the result. tickLitVic is pure side-effect-free w.r.t. CPU.
    // Spec 426 — VIC bank derivation REMOVED from tickLitVic. Bank
    // switch now pushed from CIA2 PA/DDRA store path
    // (peripherals/cia2.ts onVicBankChange → vicii_set_vbank).
    // Previous bug: `pra & ddra` zeroed input bits → wrong bank when
    // DDRA had bits 0/1 as input (real C64: those float high).
    if (lv.raster_line !== this.litLastRasterLine) {
      const last = this.litLastRasterLine;
      if (last >= 0 && last < this.litFbH) {
        const off = last * this.litFbW;
        const fb = this.literalPortFb!;
        const w = this.litFbW;
        for (let x = 0; x < w; x++) {
          fb[off + x] = lv.dbuf[x]!;
        }
      }
      // Spec V-stable-frame: when wrapping to line 0 (= frame complete),
      // snapshot the just-finished accumulator into the stable buffer.
      // renderLiteralPortToPng uses stable so it never sees a half-
      // filled frame mid-render.
      if (lv.raster_line === 0 && last !== 0 && last !== -1) {
        const acc = this.literalPortFb;
        if (acc) {
          if (this.literalPortFbStable === null) {
            this.literalPortFbStable = new Uint8Array(acc.length);
          }
          this.literalPortFbStable.set(acc);
          this.litStableFrameCount++;
        }
      }
      this.litLastRasterLine = lv.raster_line;
    }
    return baLow;
  }

  /**
   * Spec 298k — render the literalPortFb (= 520×312 color indices) as
   * PNG. Bypasses snapshot replay; reads only what the literal port
   * has accumulated.
   */
  private renderLiteralPortToPng(path: string): { width: number; height: number; bytes: number } {
    const f = this.renderLiteralPortRgba();
    if (!f) return { width: 0, height: 0, bytes: 0 };
    const pngBytes = rgbaToPng(f.width, f.height, f.rgba);
    writeFileSync(path, pngBytes);
    return { width: f.width, height: f.height, bytes: pngBytes.length };
  }

  /**
   * Spec 701 §7 — extract the current literal-port frame as raw RGBA (the
   * VICE x64sc 384×272 visible window). Shared by renderToPng (screenshots)
   * and the live binary frame stream (RuntimeController → broadcastFrame),
   * so the live display no longer pays the PNG/base64 encode cost per frame.
   * Reads the stable (= last complete) frame, falling back to the in-fill
   * accumulator just after boot. Returns null if no literal-port FB yet.
   */
  renderLiteralPortRgba(): { width: number; height: number; rgba: Uint8Array } | null {
    if (!this.literalPortFbStable && !this.literalPortFb) return null;
    const FB_W_INTERNAL = 65 * 8; // 520 — full dbuf width
    const FB_H_INTERNAL = 312;
    const fb = this.literalPortFbStable ?? this.literalPortFb!;
    const palette = this.framebuffer.palette;
    // VICE x64sc PAL canvas convention (see renderLiteralPortToPng history):
    //   X = dbuf[104..488] = 384 px (balanced 32-px L/R borders)
    //   Y = fb[16..288]    = 272 px (first displayed PAL line = 16)
    const CANVAS_X0 = 104, CANVAS_W = 384, CANVAS_Y0 = 16, CANVAS_H = 272;
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
        rgba[off] = r; rgba[off + 1] = g; rgba[off + 2] = b; rgba[off + 3] = 0xff;
      }
    }
    return { width: CANVAS_W, height: CANVAS_H, rgba };
  }

  /**
   * Live VIC raster position from the literal-port renderer (the authority).
   * The legacy `vic.raster_y` / `raster_cycle` stay 0 in literal-port mode, so
   * any UI reading them shows a frozen raster — read these instead.
   */
  vicRaster(): { line: number; cycle: number } {
    return {
      line: LIT_TYPES.vicii.raster_line | 0,
      cycle: LIT_TYPES.vicii.raster_cycle | 0,
    };
  }

  /**
   * Spec 705.A step 3 — capture the literal-VIC presentation seam for the
   * native RuntimeCheckpoint. VICE carries this visible-continuation state in
   * `raster_t` (not ported); here it is the render fields. literalPortFb is the
   * mid-frame accumulator (continuation-relevant), literalPortFbStable the
   * immediately-visible freeze image. Copies, so the checkpoint is detached
   * from the live buffers.
   */
  captureVicPresentation(): RuntimeCheckpointVicPresentation {
    return {
      literalPortFb: this.literalPortFb ? this.literalPortFb.slice() : null,
      literalPortFbStable: this.literalPortFbStable ? this.literalPortFbStable.slice() : null,
      litLastRasterLine: this.litLastRasterLine,
      lastLitBaLow: this.lastLitBaLow,
      litStableFrameCount: this.litStableFrameCount,
    };
  }

  /** Spec 705.A step 3 — restore the literal-VIC presentation seam. */
  restoreVicPresentation(p: RuntimeCheckpointVicPresentation): void {
    if (p.literalPortFb) {
      if (!this.literalPortFb || this.literalPortFb.length !== p.literalPortFb.length) {
        this.literalPortFb = new Uint8Array(p.literalPortFb.length);
      }
      this.literalPortFb.set(p.literalPortFb);
    }
    if (p.literalPortFbStable) {
      if (!this.literalPortFbStable || this.literalPortFbStable.length !== p.literalPortFbStable.length) {
        this.literalPortFbStable = new Uint8Array(p.literalPortFbStable.length);
      }
      this.literalPortFbStable.set(p.literalPortFbStable);
    }
    this.litLastRasterLine = p.litLastRasterLine;
    this.lastLitBaLow = p.lastLitBaLow;
    this.litStableFrameCount = p.litStableFrameCount;
  }

  /**
   * Spec 701 §7 (preferred transport) — palette-indexed frame: 1 byte/pixel
   * (the 4-bit C64 colour index) + a 16-colour RGB palette (48 bytes). ~107
   * KiB/frame vs ~417 KiB raw RGBA → ~4× less WebSocket bandwidth, so a 50fps
   * live stream stays well within what the browser WS + canvas can sustain.
   * The UI expands index→RGBA into a reused ImageData.
   */
  renderLiteralPortIndexed():
    { width: number; height: number; indices: Uint8Array; palette: Uint8Array } | null {
    if (!this.literalPortFbStable && !this.literalPortFb) return null;
    const FB_W_INTERNAL = 65 * 8, FB_H_INTERNAL = 312;
    const fb = this.literalPortFbStable ?? this.literalPortFb!;
    const pal = this.framebuffer.palette;
    const CANVAS_X0 = 104, CANVAS_W = 384, CANVAS_Y0 = 16, CANVAS_H = 272;
    const indices = new Uint8Array(CANVAS_W * CANVAS_H);
    for (let cy = 0; cy < CANVAS_H; cy++) {
      const srcY = cy + CANVAS_Y0;
      if (srcY >= FB_H_INTERNAL) continue;
      for (let cx = 0; cx < CANVAS_W; cx++) {
        const srcX = cx + CANVAS_X0;
        if (srcX >= FB_W_INTERNAL) continue;
        indices[cy * CANVAS_W + cx] = fb[srcY * FB_W_INTERNAL + srcX]! & 0x0f;
      }
    }
    const palette = new Uint8Array(48);
    for (let i = 0; i < 16; i++) {
      const [r, g, b] = pal[i] ?? [0, 0, 0];
      palette[i * 3] = r; palette[i * 3 + 1] = g; palette[i * 3 + 2] = b;
    }
    return { width: CANVAS_W, height: CANVAS_H, indices, palette };
  }
}
