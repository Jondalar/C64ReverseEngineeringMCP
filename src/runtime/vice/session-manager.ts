import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createViceConfigWorkspace } from "./config-workspace.js";
import { launchViceProcess, waitForMonitorPort, isMonitorPortOpen } from "./process-launcher.js";
import { allocateViceMonitorPort } from "./port-allocator.js";
import { analyzeRuntimeTrace, analyzeTrace, writeTraceSnapshot, type ViceTraceSnapshot } from "./trace-analyzer.js";
import { keyCodeForViceCharacter, sendMacOsKeyCodesToProcess } from "./macos-input.js";
import {
  ViceMonitorClient,
  type ViceBankDescriptor,
  type ViceCheckpointInfo,
  type ViceCpuHistoryItem,
  type ViceMemspace,
  type ViceMonitorEvent,
  type ViceRegisterDescriptor,
  type ViceRegisterValue,
} from "./monitor-client.js";
import {
  inferViceMediaType,
  type ViceMediaConfig,
  type ViceRuntimeTraceConfig,
  type ViceSessionRecord,
  type ViceSessionStartOptions,
  type ViceSessionStopResult,
  type ViceTraceAnalysis,
  type ViceTraceSummary,
} from "./types.js";

interface ManagedViceProcessHandle {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface ActiveViceSession {
  record: ViceSessionRecord;
  child: ManagedViceProcessHandle;
  monitorClient?: ViceMonitorClient;
  registerDescriptors?: ViceRegisterDescriptor[];
  runtimeTraceState?: {
    config: ViceRuntimeTraceConfig;
    timer?: NodeJS.Timeout;
    running: boolean;
    sampleIndex: number;
    lastClock?: bigint;
  };
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

const RUNTIME_TRACE_INITIAL_DELAY_MS = 250;
const MAX_MEMORY_READ_CHUNK = 0x4000;
const DEFAULT_MONITOR_CHIS_LINES = 16_777_215;

export interface ViceBacktraceFrame {
  stackAddress: number;
  rawReturnAddress: number;
  returnPc: number;
}

export interface ViceRuntimeTraceStatus {
  sessionId: string;
  active: boolean;
  intervalMs?: number;
  cpuHistoryCount?: number;
  monitorChisLines?: number;
  sampleIndex: number;
  lastClock?: string;
  tracePath: string;
}

export interface ViceDisplayCaptureResult {
  imagePath: string;
  metadataPath: string;
  debugWidth: number;
  debugHeight: number;
  innerWidth: number;
  innerHeight: number;
  bitsPerPixel: number;
  bytesWritten: number;
}

export type ViceJoystickDirection = "up" | "down" | "left" | "right" | "fire";

const VICE_SPECIAL_KEY_BYTES: Record<string, number[]> = {
  F1: [0x85],
  F2: [0x89],
  F3: [0x86],
  F4: [0x8a],
  F5: [0x87],
  F6: [0x8b],
  F7: [0x88],
  F8: [0x8c],
  RETURN: [0x0d],
};

export class ViceSessionManager {
  private activeSession?: ActiveViceSession;
  private lastSession?: ViceSessionRecord;

  constructor(private readonly projectDir: string) {}

  async startSession(options: ViceSessionStartOptions): Promise<ViceSessionRecord> {
    await this.reconcileExitedSession();
    if (this.activeSession) {
      throw new Error(`A VICE session is already active (session ${this.activeSession.record.sessionId}).`);
    }

    const monitorPort = await allocateViceMonitorPort();
    const configWorkspace = await createViceConfigWorkspace({
      projectDir: this.projectDir,
      monitorPort,
      monitorChisLines: options.runtimeTrace?.monitorChisLines ?? DEFAULT_MONITOR_CHIS_LINES,
    });
    const media = this.resolveMediaConfig(options);

    const record: ViceSessionRecord = {
      sessionId: configWorkspace.paths.sessionDir.split("/").at(-1) ?? "vice-session",
      projectDir: this.projectDir,
      state: "starting",
      createdAt: new Date().toISOString(),
      monitorPort,
      monitorReady: false,
      media,
      runtimeTrace: options.runtimeTrace,
      workspace: configWorkspace.paths,
      configWorkspace: {
        sourceConfigPath: configWorkspace.sourceConfigPath,
        sourceConfigDir: configWorkspace.sourceConfigDir,
        emulatorSection: configWorkspace.emulatorSection,
        copiedHotkeyFiles: configWorkspace.copiedHotkeyFiles,
      },
    };

    await mkdir(record.workspace.traceDir, { recursive: true });
    await this.writeEvent(record, "session_created", {
      monitorPort,
      media,
      workspace: record.workspace.sessionDir,
    });
    await this.persistRecord(record);

    try {
      const launched = await launchViceProcess({
        workspace: record.workspace,
        projectDir: this.projectDir,
        monitorPort,
        media,
      });

      const exitDeferred = createDeferred();
      const active: ActiveViceSession = {
        record,
        child: launched.child,
        exitPromise: exitDeferred.promise,
        resolveExit: exitDeferred.resolve,
      };
      this.activeSession = active;

      record.pid = launched.child.pid ?? undefined;
      record.viceBinary = launched.binaryPath;
      record.command = launched.command;
      record.startedAt = new Date().toISOString();

      launched.child.once("error", (error) => {
        void this.handleProcessExit(active, null, null, error instanceof Error ? error.message : String(error));
      });
      launched.child.once("exit", (code, signal) => {
        void this.handleProcessExit(active, code, signal, undefined);
      });

      const monitorReady = await waitForMonitorPort(monitorPort);
      if (this.activeSession?.record.sessionId !== record.sessionId || record.state === "failed" || record.state === "stopped") {
        throw new Error(record.lastError ?? "VICE exited before the session became ready.");
      }
      record.monitorReady = monitorReady;
      if (options.runtimeTrace?.enabled && options.runtimeTraceBootstrapReset) {
        await this.bootstrapRuntimeTraceCapture(active);
      }
      record.state = "running";
      if (options.runtimeTrace?.enabled) {
        await this.startRuntimeTrace(options.runtimeTrace);
      }
      await this.writeEvent(record, "process_started", {
        pid: record.pid,
        monitorReady,
        binaryPath: record.viceBinary,
      });
      await this.persistRecord(record);
      return structuredClone(record);
    } catch (error) {
      record.state = "failed";
      record.stopReason = "launch_failed";
      record.lastError = error instanceof Error ? error.message : String(error);
      record.stoppedAt = new Date().toISOString();
      await this.writeEvent(record, "launch_failed", { error: record.lastError });
      await this.persistRecord(record);
      await this.writeSummary(record);
      this.lastSession = structuredClone(record);
      throw error;
    }
  }

  async getStatus(): Promise<ViceSessionRecord | undefined> {
    await this.ensureActiveSessionLoaded();
    const record = this.activeSession?.record ?? this.lastSession;
    if (!record) {
      return undefined;
    }
    if (record.state === "running") {
      record.monitorReady = await isMonitorPortOpen(record.monitorPort);
      await this.persistRecord(record);
    }
    return structuredClone(record);
  }

  async stopSession(): Promise<ViceSessionStopResult> {
    await this.ensureActiveSessionLoaded();
    if (!this.activeSession) {
      if (!this.lastSession) {
        throw new Error("No VICE session exists.");
      }
      return {
        record: structuredClone(this.lastSession),
        stopMethod: "already_stopped",
      };
    }

    const active = this.activeSession;
    const record = active.record;
    if (record.state !== "stopping") {
      record.state = "stopping";
      record.stopReason = "user_request";
      await this.writeEvent(record, "stop_requested", {});
      await this.persistRecord(record);
    }

    try {
      const client = await this.getOrCreateMonitorClient(active);
      await client.quitVice();
      await this.writeEvent(record, "monitor_quit_sent", {});
      const quitStopped = await waitForExit(active, 1_500);
      if (quitStopped) {
        return {
          record: structuredClone(this.lastSession ?? record),
          stopMethod: "wait",
        };
      }
    } catch (error) {
      await this.writeEvent(record, "monitor_quit_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!isProcessAlive(active.child.pid)) {
      await this.reconcileExitedSession();
      const stopped = this.lastSession ?? record;
      return {
        record: structuredClone(stopped),
        stopMethod: "already_stopped",
      };
    }

    const stoppedNaturally = await waitForExit(active, 500);
    if (stoppedNaturally) {
      return {
        record: structuredClone(this.lastSession ?? record),
        stopMethod: "wait",
      };
    }

    active.child.kill("SIGTERM");
    await this.writeEvent(record, "signal_sent", { signal: "SIGTERM" });
    const sigtermStopped = await waitForExit(active, 3_000);
    if (sigtermStopped) {
      return {
        record: structuredClone(this.lastSession ?? record),
        stopMethod: "sigterm",
      };
    }

    active.child.kill("SIGKILL");
    await this.writeEvent(record, "signal_sent", { signal: "SIGKILL" });
    await waitForExit(active, 1_000);
    return {
      record: structuredClone(this.lastSession ?? record),
      stopMethod: "sigkill",
    };
  }

  async readRegisters(): Promise<{ registers: ViceRegisterValue[]; descriptors: ViceRegisterDescriptor[] }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const descriptors = active.registerDescriptors ?? await client.getRegistersAvailable();
    active.registerDescriptors = descriptors;
    const registers = await client.getRegisters();
    return {
      registers,
      descriptors,
    };
  }

  async readMemory(startAddress: number, endAddress: number, bankId = 0, memspace: ViceMemspace = 0x00): Promise<Buffer> {
    if (endAddress < startAddress) {
      throw new Error("endAddress must be >= startAddress");
    }
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const chunks: Buffer[] = [];
    for (let cursor = startAddress; cursor <= endAddress; ) {
      const chunkEnd = Math.min(endAddress, cursor + MAX_MEMORY_READ_CHUNK - 1);
      chunks.push(await client.readMemory(cursor, chunkEnd, bankId, memspace));
      cursor = chunkEnd + 1;
    }
    return Buffer.concat(chunks);
  }

  async writeMemory(startAddress: number, data: Buffer, bankId = 0, memspace: ViceMemspace = 0x00, sideEffects = false): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    for (let offset = 0; offset < data.length; offset += MAX_MEMORY_READ_CHUNK) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + MAX_MEMORY_READ_CHUNK));
      await client.writeMemory(startAddress + offset, chunk, bankId, memspace, sideEffects);
    }
    await this.writeEvent(active.record, "memory_written", {
      startAddress,
      bytes: data.length,
      bankId,
      memspace,
      sideEffects,
    });
  }

  async setRegistersByName(values: Record<string, number>, memspace: ViceMemspace = 0x00): Promise<ViceRegisterValue[]> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const descriptors = active.registerDescriptors ?? await client.getRegistersAvailable(memspace);
    active.registerDescriptors = descriptors;
    const descriptorByName = new Map(descriptors.map((descriptor) => [descriptor.name.toUpperCase(), descriptor]));
    const registerValues: ViceRegisterValue[] = [];

    for (const [name, value] of Object.entries(values)) {
      const descriptor = descriptorByName.get(name.toUpperCase());
      if (!descriptor) {
        throw new Error(`Unknown register name: ${name}`);
      }
      registerValues.push({
        id: descriptor.id,
        value,
      });
    }

    await client.setRegisters(registerValues, memspace);
    await this.writeEvent(active.record, "registers_set", {
      memspace,
      registers: values,
    });
    return client.getRegisters(memspace);
  }

  async getBanksAvailable(): Promise<ViceBankDescriptor[]> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    return client.getBanksAvailable();
  }

  async addBreakpoint(options: {
    startAddress: number;
    endAddress?: number;
    stopWhenHit?: boolean;
    enabled?: boolean;
    operation?: number;
    temporary?: boolean;
    memspace?: ViceMemspace;
  }): Promise<ViceCheckpointInfo> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const checkpoint = await client.setCheckpoint({
      startAddress: options.startAddress,
      endAddress: options.endAddress ?? options.startAddress,
      stopWhenHit: options.stopWhenHit ?? true,
      enabled: options.enabled ?? true,
      operation: options.operation ?? 0x04,
      temporary: options.temporary ?? false,
      memspace: options.memspace ?? 0x00,
    });
    await this.writeEvent(active.record, "breakpoint_added", {
      checkpointNumber: checkpoint.checkpointNumber,
      startAddress: checkpoint.startAddress,
      endAddress: checkpoint.endAddress,
      operation: checkpoint.operation,
      temporary: checkpoint.temporary,
      memspace: checkpoint.memspace,
    });
    return checkpoint;
  }

  async listBreakpoints() {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    return client.listCheckpoints();
  }

  async deleteBreakpoint(checkpointNumber: number): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    await client.deleteCheckpoint(checkpointNumber);
    await this.writeEvent(active.record, "breakpoint_deleted", {
      checkpointNumber,
    });
  }

  async sendKeys(text: string): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const bytes = Buffer.from(text, "latin1");
    await this.sendKeyboardBytes(bytes, {
      text,
      bytes: bytes.length,
    });
  }

  async sendPetsciiBytes(values: number[]): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const bytes = Buffer.from(values.map((value) => value & 0xff));
    await this.sendKeyboardBytes(bytes, {
      petsciiBytes: values.map((value) => value & 0xff),
      bytes: bytes.length,
    });
  }

  async sendSpecialKeys(keys: string[]): Promise<number[]> {
    await this.ensureActiveSessionLoaded();
    const resolved = keys.flatMap((key) => {
      const bytes = VICE_SPECIAL_KEY_BYTES[key.toUpperCase()];
      if (!bytes) {
        throw new Error(`Unsupported special VICE key: ${key}`);
      }
      return bytes;
    });
    await this.sendPetsciiBytes(resolved);
    return resolved;
  }

  private async sendKeyboardBytes(bytes: Buffer, payload: object): Promise<void> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    await client.keyboardFeed(bytes);
    await this.writeEvent(active.record, "keyboard_feed", {
      ...payload,
    });
  }

  async sendJoystickInput(
    port: number,
    directions: ViceJoystickDirection[],
    durationMs: number,
  ): Promise<{ keyCodes: number[]; characters: string[] }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    if (process.platform !== "darwin") {
      throw new Error("Joystick input injection is currently implemented for macOS only.");
    }
    if (!active.child.pid) {
      throw new Error("VICE PID is unavailable for joystick input injection.");
    }

    const mapping = await loadViceKeysetMapping(active.record.workspace.vicercPath, port);
    const characters = Array.from(new Set(directions.map((direction) => mapping[direction])));
    const keyCodes = characters.map((character) => keyCodeForViceCharacter(character));
    await sendMacOsKeyCodesToProcess(active.child.pid, keyCodes, durationMs);
    await this.writeEvent(active.record, "joystick_input", {
      port,
      directions,
      durationMs,
      characters,
      keyCodes,
    });
    return {
      keyCodes,
      characters,
    };
  }

  async attachMedia(mediaPath: string, runAfterLoading = true, fileIndex = 0): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const absolutePath = resolve(this.projectDir, mediaPath);
    await client.autostart(absolutePath, runAfterLoading, fileIndex);
    active.record.media = {
      path: absolutePath,
      type: inferViceMediaType(absolutePath) ?? "prg",
      autostart: runAfterLoading,
    };
    await this.writeEvent(active.record, "media_attached", {
      mediaPath: absolutePath,
      runAfterLoading,
      fileIndex,
    });
    await this.persistRecord(active.record);
  }

  async captureDisplay(outputPath: string, useVicII = true): Promise<ViceDisplayCaptureResult> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const absolutePath = resolve(this.projectDir, outputPath);
    const metadataPath = absolutePath.replace(/\.[^.]+$/i, ".json");
    await mkdir(dirname(absolutePath), { recursive: true });
    const display = await client.getDisplay(useVicII, 0);
    const header = Buffer.from(`P5\n${display.debugWidth} ${display.debugHeight}\n255\n`, "ascii");
    const pgm = Buffer.concat([header, display.pixels]);
    await writeFile(absolutePath, pgm);
    await writeFile(metadataPath, `${JSON.stringify({
      debugWidth: display.debugWidth,
      debugHeight: display.debugHeight,
      xOffset: display.xOffset,
      yOffset: display.yOffset,
      innerWidth: display.innerWidth,
      innerHeight: display.innerHeight,
      bitsPerPixel: display.bitsPerPixel,
      imagePath: absolutePath,
      note: "Display exported as 8-bit indexed pixels mapped directly into a grayscale PGM preview.",
    }, null, 2)}\n`, "utf8");
    await this.writeEvent(active.record, "display_captured", {
      imagePath: absolutePath,
      metadataPath,
      debugWidth: display.debugWidth,
      debugHeight: display.debugHeight,
      innerWidth: display.innerWidth,
      innerHeight: display.innerHeight,
    });
    return {
      imagePath: absolutePath,
      metadataPath,
      debugWidth: display.debugWidth,
      debugHeight: display.debugHeight,
      innerWidth: display.innerWidth,
      innerHeight: display.innerHeight,
      bitsPerPixel: display.bitsPerPixel,
      bytesWritten: pgm.length,
    };
  }

  async resetMachine(target: number): Promise<void> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    await client.reset(target);
    await this.writeEvent(active.record, "machine_reset", {
      target,
    });
  }

  async saveSnapshot(outputPath: string, saveRoms = true, saveDisks = true): Promise<string> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const absolutePath = resolve(this.projectDir, outputPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await client.dumpSnapshot(absolutePath, saveRoms, saveDisks);
    await this.writeEvent(active.record, "snapshot_saved", {
      outputPath: absolutePath,
      saveRoms,
      saveDisks,
    });
    return absolutePath;
  }

  async saveMemoryRange(
    startAddress: number,
    endAddress: number,
    outputPath: string,
    options: {
      bankId?: number;
      memspace?: ViceMemspace;
      includeLoadAddress?: boolean;
    } = {},
  ): Promise<{ outputPath: string; bytesWritten: number; bankId: number; memspace: ViceMemspace }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const bankId = options.bankId ?? 0;
    const memspace = options.memspace ?? 0x00;
    const includeLoadAddress = options.includeLoadAddress ?? false;
    const absolutePath = resolve(this.projectDir, outputPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const memory = await this.readMemory(startAddress, endAddress, bankId, memspace);
    const fileData = includeLoadAddress
      ? Buffer.concat([Buffer.from([startAddress & 0xff, (startAddress >> 8) & 0xff]), memory])
      : memory;
    await writeFile(absolutePath, fileData);
    await this.writeEvent(active.record, includeLoadAddress ? "memory_saved_prg" : "memory_saved_binary", {
      outputPath: absolutePath,
      startAddress,
      endAddress,
      bankId,
      memspace,
      bytesWritten: fileData.length,
    });
    return {
      outputPath: absolutePath,
      bytesWritten: fileData.length,
      bankId,
      memspace,
    };
  }

  async buildBacktrace(maxFrames = 16): Promise<{
    frames: ViceBacktraceFrame[];
    stackPointer: number;
    stackBase: number;
  }> {
    await this.ensureActiveSessionLoaded();
    const { registers, descriptors } = await this.readRegisters();
    const nameById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.name.toUpperCase()]));
    const registerByName = new Map(
      registers.map((registerValue) => [nameById.get(registerValue.id) ?? `R${registerValue.id}`, registerValue.value]),
    );
    const stackPointer = registerByName.get("SP");
    if (stackPointer === undefined) {
      throw new Error("Could not determine the SP register from VICE.");
    }
    const stackStart = 0x0100 + ((stackPointer + 1) & 0xff);
    const stackEnd = 0x01ff;
    const stack = await this.readMemory(stackStart, stackEnd);
    const frames: ViceBacktraceFrame[] = [];

    for (let index = 0; index + 1 < stack.length && frames.length < maxFrames; index += 2) {
      const low = stack[index] ?? 0;
      const high = stack[index + 1] ?? 0;
      const rawReturnAddress = (high << 8) | low;
      const returnPc = (rawReturnAddress + 1) & 0xffff;
      frames.push({
        stackAddress: stackStart + index,
        rawReturnAddress,
        returnPc,
      });
    }

    return {
      frames,
      stackPointer,
      stackBase: stackStart,
    };
  }

  async readCpuHistory(count: number): Promise<ViceCpuHistoryItem[]> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    return client.getCpuHistory(count);
  }

  async continueExecution(): Promise<{ pc: number }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const afterSequence = client.currentEventSequence;
    await client.resume();
    return client.waitForResume(afterSequence, 2_000);
  }

  async resetSystem(powerCycle = false): Promise<void> {
    await this.ensureActiveSessionLoaded();
    await this.resetMachine(powerCycle ? 0x01 : 0x00);
  }

  async stepInto(): Promise<{ pc: number }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const afterSequence = client.currentEventSequence;
    await client.advanceInstructions(1, false);
    return client.waitForStop(afterSequence, 2_000);
  }

  async stepOver(): Promise<{ pc: number }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const afterSequence = client.currentEventSequence;
    await client.advanceInstructions(1, true);
    return client.waitForStop(afterSequence, 2_000);
  }

  async debugRun(breakpointAddresses: number[], timeoutMs: number, temporary = false): Promise<{
    event: ViceMonitorEvent;
    breakpoints: number[];
  }> {
    await this.ensureActiveSessionLoaded();
    if (breakpointAddresses.length === 0) {
      throw new Error("At least one breakpoint is required.");
    }

    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const created: number[] = [];

    for (const address of breakpointAddresses) {
      const checkpoint = await client.setExecCheckpoint(address, temporary);
      created.push(checkpoint.checkpointNumber);
      await this.writeEvent(active.record, "breakpoint_set", {
        address,
        checkpointNumber: checkpoint.checkpointNumber,
        temporary,
      });
    }

    const afterSequence = client.currentEventSequence;
    await client.resume();
    const event = await client.waitForCheckpointOrStop(afterSequence, timeoutMs);
    return { event, breakpoints: created };
  }

  async stopAndAnalyze(cpuHistoryCount = 20_000): Promise<{
    record: ViceSessionRecord;
    stopMethod: ViceSessionStopResult["stopMethod"];
    analysis: ViceTraceAnalysis;
  }> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    const traceSnapshot = await this.captureTraceSnapshot(active, cpuHistoryCount);
    const stopResult = await this.stopSession();
    const analysis = await analyzeTrace(stopResult.record, traceSnapshot);
    return {
      record: stopResult.record,
      stopMethod: stopResult.stopMethod,
      analysis,
    };
  }

  async analyzeLastSession(): Promise<ViceTraceAnalysis> {
    await this.reconcileExitedSession();
    if (this.activeSession) {
      throw new Error("A VICE session is still active. Close VICE or stop the session first.");
    }
    if (!this.lastSession) {
      this.lastSession = await this.loadLastSessionFromDisk();
    }
    if (!this.lastSession) {
      throw new Error("No completed VICE session exists.");
    }
    return analyzeRuntimeTrace(this.lastSession);
  }

  async startRuntimeTrace(config: ViceRuntimeTraceConfig): Promise<ViceRuntimeTraceStatus> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    if (active.record.state !== "running") {
      throw new Error("VICE must be running before runtime tracing can start.");
    }

    const existing = active.runtimeTraceState;
    if (active.record.runtimeTraceActive && isProcessAlive(active.record.runtimeTraceWorkerPid)) {
      throw new Error("Runtime trace is already active.");
    }

    active.record.runtimeTrace = config;
    active.record.runtimeTraceActive = true;
    active.record.runtimeTraceWorkerPid = undefined;
    active.runtimeTraceState = {
      config,
      running: true,
      sampleIndex: existing?.sampleIndex ?? 0,
      lastClock: existing?.lastClock,
    };

    if (active.monitorClient?.isConnected) {
      active.monitorClient.close();
      active.monitorClient = undefined;
      await this.writeEvent(active.record, "monitor_client_released", {
        source: "runtime_trace_start",
      });
    }

    await this.writeEvent(active.record, "runtime_trace_started", {
      intervalMs: config.intervalMs,
      cpuHistoryCount: config.cpuHistoryCount,
      monitorChisLines: config.monitorChisLines,
      firstSampleDelayMs: Math.min(config.intervalMs, RUNTIME_TRACE_INITIAL_DELAY_MS),
      resumed: Boolean(existing),
      nextSampleIndex: active.runtimeTraceState.sampleIndex,
    });
    await this.persistRecord(active.record);
    active.record.runtimeTraceWorkerPid = await launchRuntimeTraceWorker(active.record.workspace.sessionPath);
    await this.persistRecord(active.record);
    await this.writeEvent(active.record, "runtime_trace_worker_spawned", {
      pid: active.record.runtimeTraceWorkerPid,
    });
    return this.buildRuntimeTraceStatus(active);
  }

  async stopRuntimeTrace(): Promise<ViceRuntimeTraceStatus> {
    await this.ensureActiveSessionLoaded();
    const active = this.requireActiveSession();
    active.runtimeTraceState = await loadRuntimeTraceState(active.record);
    const state = active.runtimeTraceState;
    if (!state?.running) {
      throw new Error("Runtime trace is not active.");
    }

    state.running = false;
    active.record.runtimeTraceActive = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    await this.writeEvent(active.record, "runtime_trace_stopped", {
      sampleIndex: state.sampleIndex,
      lastClock: state.lastClock?.toString(),
    });
    await this.persistRecord(active.record);
    await stopRuntimeTraceWorker(active.record.runtimeTraceWorkerPid);
    active.record.runtimeTraceWorkerPid = undefined;
    await this.persistRecord(active.record);
    return this.buildRuntimeTraceStatus(active);
  }

  async getRuntimeTraceStatus(): Promise<ViceRuntimeTraceStatus | undefined> {
    await this.ensureActiveSessionLoaded();
    if (!this.activeSession) {
      return undefined;
    }
    this.activeSession.runtimeTraceState = await loadRuntimeTraceState(this.activeSession.record);
    return this.buildRuntimeTraceStatus(this.activeSession);
  }

  private async reconcileExitedSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    if (!isProcessAlive(this.activeSession.child.pid) && this.activeSession.record.state !== "stopped") {
      await this.handleProcessExit(this.activeSession, null, null, undefined);
    }
  }

  private async ensureActiveSessionLoaded(): Promise<void> {
    await this.reconcileExitedSession();
    if (this.activeSession) {
      if (this.activeSession.record.runtimeTraceActive) {
        this.activeSession.runtimeTraceState = await loadRuntimeTraceState(this.activeSession.record);
      }
      return;
    }

    const record = await this.loadRunningSessionFromDisk();
    if (!record) {
      return;
    }

    const exitDeferred = createDeferred();
    this.activeSession = {
      record,
      child: createExternalProcessHandle(record.pid),
      exitPromise: exitDeferred.promise,
      resolveExit: exitDeferred.resolve,
      runtimeTraceState: await loadRuntimeTraceState(record),
    };
    this.lastSession = undefined;
  }

  private resolveMediaConfig(options: ViceSessionStartOptions): ViceMediaConfig | undefined {
    if (!options.mediaPath) {
      return undefined;
    }

    const mediaPath = resolve(this.projectDir, options.mediaPath);
    const mediaType = options.mediaType ?? inferViceMediaType(mediaPath);
    if (!mediaType) {
      throw new Error("Could not infer media type. Pass media_type explicitly.");
    }

    return {
      path: mediaPath,
      type: mediaType,
      autostart: options.autostart ?? true,
    };
  }

  private async handleProcessExit(
    active: ActiveViceSession,
    code: number | null,
    signal: NodeJS.Signals | null,
    lastError?: string,
  ): Promise<void> {
    if (this.activeSession?.record.sessionId !== active.record.sessionId && this.lastSession?.sessionId === active.record.sessionId) {
      active.resolveExit();
      return;
    }

    const record = active.record;
    record.exitCode = code;
    record.signal = signal;
    record.monitorReady = false;
    record.stoppedAt = new Date().toISOString();
    if (!record.stopReason) {
      record.stopReason = signal === "SIGTERM"
        ? "sigterm"
        : signal === "SIGKILL"
          ? "sigkill"
          : "process_exit";
    }
    if (lastError) {
      record.lastError = lastError;
      record.state = "failed";
    } else {
      record.state = "stopped";
    }
    if (active.runtimeTraceState) {
      active.runtimeTraceState.running = false;
      if (active.runtimeTraceState.timer) {
        clearTimeout(active.runtimeTraceState.timer);
      }
    }
    record.runtimeTraceActive = false;
    await stopRuntimeTraceWorker(record.runtimeTraceWorkerPid);
    record.runtimeTraceWorkerPid = undefined;
    active.monitorClient?.close();

    await this.writeEvent(record, "process_exited", {
      exitCode: code,
      signal,
      stopReason: record.stopReason,
      lastError,
    });
    await this.persistRecord(record);
    await this.finalizeRuntimeTrace(record);
    await this.writeSummary(record);

    this.lastSession = structuredClone(record);
    if (this.activeSession?.record.sessionId === record.sessionId) {
      this.activeSession = undefined;
    }
    active.resolveExit();
  }

  private async writeEvent(record: ViceSessionRecord, type: string, payload: object): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      payload,
    });
    await appendFile(record.workspace.eventsLogPath, `${line}\n`, "utf8");
  }

  private async persistRecord(record: ViceSessionRecord): Promise<void> {
    await writeFile(record.workspace.sessionPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private async writeSummary(record: ViceSessionRecord): Promise<void> {
    const summary: ViceTraceSummary = {
      sessionId: record.sessionId,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      durationMs: computeDurationMs(record.startedAt, record.stoppedAt),
      pid: record.pid,
      viceBinary: record.viceBinary,
      monitorPort: record.monitorPort,
      monitorReady: record.monitorReady,
      media: record.media,
      stopReason: record.stopReason,
      exitCode: record.exitCode,
      signal: record.signal,
      lastError: record.lastError,
    };
    await writeFile(record.workspace.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  private async bootstrapRuntimeTraceCapture(active: ActiveViceSession): Promise<void> {
    const client = await this.getOrCreateMonitorClient(active);
    await this.writeEvent(active.record, "runtime_trace_bootstrap_reset_requested", {
      resetTarget: "system",
    });
    await client.resetSystem(false);
    const afterSequence = client.currentEventSequence;
    await client.resume();
    await client.waitForResume(afterSequence, 1_000).catch(() => undefined);
    await this.writeEvent(active.record, "runtime_trace_bootstrap_reset_completed", {
      resetTarget: "system",
    });
  }

  private async finalizeRuntimeTrace(record: ViceSessionRecord): Promise<void> {
    if (!record.runtimeTrace) {
      return;
    }

    await writeFile(record.workspace.runtimeTracePath, "", { encoding: "utf8", flag: "a" });

    try {
      await analyzeRuntimeTrace(record);
      await this.writeEvent(record, "runtime_trace_finalized", {
        runtimeTracePath: record.workspace.runtimeTracePath,
        traceAnalysisPath: record.workspace.traceAnalysisPath,
      });
    } catch (error) {
      await this.writeEvent(record, "runtime_trace_finalize_failed", {
        error: error instanceof Error ? error.message : String(error),
        runtimeTracePath: record.workspace.runtimeTracePath,
      });
    }
  }

  private async captureTraceSnapshot(active: ActiveViceSession, cpuHistoryCount: number): Promise<ViceTraceSnapshot> {
    const client = await this.getOrCreateMonitorClient(active);
    const descriptors = active.registerDescriptors ?? await client.getRegistersAvailable();
    active.registerDescriptors = descriptors;
    const currentRegisters = await client.getRegisters();
    const cpuHistory = await client.getCpuHistory(cpuHistoryCount);
    const snapshot: ViceTraceSnapshot = {
      capturedAt: new Date().toISOString(),
      media: active.record.media,
      registerDescriptors: descriptors,
      currentRegisters,
      cpuHistory,
    };
    await writeTraceSnapshot(active.record, snapshot);
    await this.writeEvent(active.record, "trace_snapshot_written", {
      cpuHistoryItems: cpuHistory.length,
      path: active.record.workspace.traceSnapshotPath,
    });
    return snapshot;
  }

  private requireActiveSession(): ActiveViceSession {
    if (!this.activeSession) {
      throw new Error("No active VICE session.");
    }
    return this.activeSession;
  }

  private async getOrCreateMonitorClient(active: ActiveViceSession): Promise<ViceMonitorClient> {
    if (active.monitorClient?.isConnected) {
      return active.monitorClient;
    }

    const client = new ViceMonitorClient({
      host: "127.0.0.1",
      port: active.record.monitorPort,
      onTraceEvent: (type, payload) => {
        void this.writeEvent(active.record, type, payload);
      },
    });
    await client.connect();
    active.monitorClient = client;
    active.record.monitorReady = true;
    await this.writeEvent(active.record, "monitor_client_ready", {
      port: active.record.monitorPort,
    });
    await this.persistRecord(active.record);
    return client;
  }

  private async loadLastSessionFromDisk(): Promise<ViceSessionRecord | undefined> {
    const runtimeRoot = join(this.projectDir, "analysis", "runtime");
    let entries;
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }

    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const sessionPath = join(runtimeRoot, entry.name, "session.json");
        try {
          const [sessionText, stats] = await Promise.all([
            readFile(sessionPath, "utf8"),
            stat(sessionPath),
          ]);
          return {
            record: JSON.parse(sessionText) as ViceSessionRecord,
            mtimeMs: stats.mtimeMs,
          };
        } catch {
          return undefined;
        }
      }));

    return sessions
      .filter((value): value is { record: ViceSessionRecord; mtimeMs: number } => Boolean(value))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
      ?.record;
  }

  private async loadRunningSessionFromDisk(): Promise<ViceSessionRecord | undefined> {
    const runtimeRoot = join(this.projectDir, "analysis", "runtime");
    let entries;
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }

    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const sessionPath = join(runtimeRoot, entry.name, "session.json");
        try {
          const [sessionText, stats] = await Promise.all([
            readFile(sessionPath, "utf8"),
            stat(sessionPath),
          ]);
          const record = JSON.parse(sessionText) as ViceSessionRecord;
          if (record.projectDir !== this.projectDir) {
            return undefined;
          }
          if (record.state !== "running" && record.state !== "stopping") {
            return undefined;
          }
          if (!isProcessAlive(record.pid)) {
            return undefined;
          }
          return {
            record,
            mtimeMs: stats.mtimeMs,
          };
        } catch {
          return undefined;
        }
      }));

    return sessions
      .filter((value): value is { record: ViceSessionRecord; mtimeMs: number } => Boolean(value))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
      ?.record;
  }

  private scheduleRuntimeTraceSample(active: ActiveViceSession, delayMs = active.runtimeTraceState?.config.intervalMs): void {
    const state = active.runtimeTraceState;
    if (!state || !state.running) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      void this.collectRuntimeTraceSample(active);
    }, delayMs);
  }

  private buildRuntimeTraceStatus(active: ActiveViceSession): ViceRuntimeTraceStatus {
    const state = active.runtimeTraceState;
    return {
      sessionId: active.record.sessionId,
      active: Boolean(active.record.runtimeTraceActive && isProcessAlive(active.record.runtimeTraceWorkerPid)),
      intervalMs: state?.config.intervalMs ?? active.record.runtimeTrace?.intervalMs,
      cpuHistoryCount: state?.config.cpuHistoryCount ?? active.record.runtimeTrace?.cpuHistoryCount,
      monitorChisLines: state?.config.monitorChisLines ?? active.record.runtimeTrace?.monitorChisLines,
      sampleIndex: state?.sampleIndex ?? 0,
      lastClock: state?.lastClock?.toString(),
      tracePath: active.record.workspace.runtimeTracePath,
    };
  }

  private async collectRuntimeTraceSample(active: ActiveViceSession): Promise<void> {
    const state = active.runtimeTraceState;
    if (!state || !state.running) {
      return;
    }
    if (
      this.activeSession?.record.sessionId !== active.record.sessionId
      || active.record.state !== "running"
      || !isProcessAlive(active.child.pid)
    ) {
      state.running = false;
      return;
    }

    try {
      const client = await this.getOrCreateMonitorClient(active);
      const descriptors = active.registerDescriptors ?? await client.getRegistersAvailable();
      active.registerDescriptors = descriptors;
      const currentRegisters = await client.getRegisters();
      const cpuHistory = await client.getCpuHistory(state.config.cpuHistoryCount);
      const appended = await this.appendRuntimeTrace(active.record, state, descriptors, currentRegisters, cpuHistory);
      const afterSequence = client.currentEventSequence;
      await client.resume();
      await client.waitForResume(afterSequence, 1_000).catch(() => undefined);
      await this.writeEvent(active.record, "runtime_trace_sample", {
        sampleIndex: state.sampleIndex,
        cpuHistoryItems: cpuHistory.length,
        appendedItems: appended.appendedItems,
        clockFirst: appended.clockFirst,
        clockLast: appended.clockLast,
      });
      state.sampleIndex += 1;
    } catch (error) {
      if (active.record.state !== "running" || !isProcessAlive(active.child.pid)) {
        state.running = false;
        return;
      }
      await this.writeEvent(active.record, "runtime_trace_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.scheduleRuntimeTraceSample(active);
  }

  private async appendRuntimeTrace(
    record: ViceSessionRecord,
    state: NonNullable<ActiveViceSession["runtimeTraceState"]>,
    descriptors: ViceRegisterDescriptor[],
    currentRegisters: ViceRegisterValue[],
    cpuHistory: ViceCpuHistoryItem[],
  ): Promise<{ appendedItems: number; clockFirst?: string; clockLast?: string }> {
    const registerNames = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.name]));
    let appended = 0;
    let clockFirst: string | undefined;
    let clockLast: string | undefined;
    const lines: string[] = [];

    lines.push(JSON.stringify({
      kind: "sample",
      sampleIndex: state.sampleIndex,
      capturedAt: new Date().toISOString(),
      currentPc: currentRegisters.find((registerValue) => registerValue.id === 3)?.value,
      items: cpuHistory.length,
    }));

    for (const item of cpuHistory) {
      const clock = BigInt(item.clock);
      if (state.lastClock !== undefined && clock <= state.lastClock) {
        continue;
      }
      const registerMap: Record<string, number> = {};
      let pc: number | undefined;
      for (const registerValue of item.registers) {
        const name = registerNames.get(registerValue.id) ?? `R${registerValue.id}`;
        registerMap[name] = registerValue.value;
        if (registerValue.id === 3) {
          pc = registerValue.value;
        }
      }
      lines.push(JSON.stringify({
        kind: "instruction",
        sampleIndex: state.sampleIndex,
        clock: item.clock,
        pc,
        instructionBytes: item.instructionBytes,
        registers: registerMap,
      }));
      if (!clockFirst) {
        clockFirst = item.clock;
      }
      clockLast = item.clock;
      state.lastClock = clock;
      appended += 1;
    }

    await appendFile(record.workspace.runtimeTracePath, `${lines.join("\n")}\n`, "utf8");
    return {
      appendedItems: appended,
      clockFirst,
      clockLast,
    };
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadViceKeysetMapping(
  vicercPath: string,
  port: number,
): Promise<Record<ViceJoystickDirection, string>> {
  const configText = await readFile(vicercPath, "utf8");
  const resourceMap = parseViceResourceMap(configText);
  const joyDevice = resourceMap.get(`JoyDevice${port}`);
  if (joyDevice !== "3") {
    throw new Error(`JoyDevice${port} is not configured as keyset joystick in ${vicercPath}. Current value: ${joyDevice ?? "unset"}.`);
  }

  return {
    up: parseViceKeyCharacter(resourceMap, `KeySet${port}North`),
    right: parseViceKeyCharacter(resourceMap, `KeySet${port}East`),
    down: parseViceKeyCharacter(resourceMap, `KeySet${port}South`),
    left: parseViceKeyCharacter(resourceMap, `KeySet${port}West`),
    fire: parseViceKeyCharacter(resourceMap, `KeySet${port}Fire`),
  };
}

function parseViceResourceMap(configText: string): Map<string, string> {
  const resourceMap = new Map<string, string>();
  for (const rawLine of configText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[") || !line.includes("=")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/u, "$1");
    resourceMap.set(key, value);
  }
  return resourceMap;
}

function parseViceKeyCharacter(resourceMap: Map<string, string>, key: string): string {
  const value = resourceMap.get(key);
  if (!value) {
    throw new Error(`Missing ${key} in copied VICE config.`);
  }
  const codePoint = Number.parseInt(value, 10);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 255) {
    throw new Error(`Unsupported ${key} value ${value}; expected ASCII-compatible key code.`);
  }
  return String.fromCharCode(codePoint);
}

async function launchRuntimeTraceWorker(sessionPath: string): Promise<number | undefined> {
  const compiledWorkerPath = fileURLToPath(new URL("./trace-worker.js", import.meta.url));
  const sourceWorkerPath = fileURLToPath(new URL("./trace-worker.ts", import.meta.url));
  const tsxBinName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const tsxBinPath = fileURLToPath(new URL(`../../../node_modules/.bin/${tsxBinName}`, import.meta.url));
  const command = existsSync(compiledWorkerPath) ? process.execPath : tsxBinPath;
  const args = existsSync(compiledWorkerPath)
    ? [compiledWorkerPath, sessionPath]
    : [sourceWorkerPath, sessionPath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

async function stopRuntimeTraceWorker(pid?: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid!, "SIGTERM");
  } catch {
    // ignore missing or already-exited worker processes
  }
}

async function loadRuntimeTraceState(record: ViceSessionRecord): Promise<ActiveViceSession["runtimeTraceState"]> {
  if (!record.runtimeTrace) {
    return undefined;
  }

  let running = false;
  let sampleIndex = 0;
  let lastClock: bigint | undefined;

  try {
    const eventsText = await readFile(record.workspace.eventsLogPath, "utf8");
    for (const rawLine of eventsText.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const event = JSON.parse(line) as {
          type?: string;
          payload?: {
            sampleIndex?: number;
            nextSampleIndex?: number;
            lastClock?: string;
            clockLast?: string;
          };
        };
        switch (event.type) {
          case "runtime_trace_started":
            running = true;
            sampleIndex = event.payload?.nextSampleIndex ?? sampleIndex;
            break;
          case "runtime_trace_stopped":
            running = false;
            if (event.payload?.sampleIndex !== undefined) {
              sampleIndex = event.payload.sampleIndex;
            }
            if (event.payload?.lastClock) {
              lastClock = BigInt(event.payload.lastClock);
            }
            break;
          case "runtime_trace_sample":
            if (event.payload?.sampleIndex !== undefined) {
              sampleIndex = Math.max(sampleIndex, event.payload.sampleIndex + 1);
            }
            if (event.payload?.clockLast) {
              lastClock = BigInt(event.payload.clockLast);
            }
            break;
          default:
            break;
        }
      } catch {
        // ignore malformed event rows during trace-state recovery
      }
    }
  } catch {
    // missing event log is tolerated for reattach
  }

  return {
    config: record.runtimeTrace,
    running,
    sampleIndex,
    lastClock,
  };
}

async function waitForExit(active: ActiveViceSession, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(active.child.pid)) {
      return true;
    }
    const settled = await Promise.race([
      active.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (settled) {
      return true;
    }
  }
  return !isProcessAlive(active.child.pid);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createExternalProcessHandle(pid: number | undefined): ManagedViceProcessHandle {
  return {
    pid,
    kill(signal?: NodeJS.Signals | number): boolean {
      if (!pid) {
        return false;
      }
      try {
        process.kill(pid, signal ?? "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  };
}

function computeDurationMs(startedAt?: string, stoppedAt?: string): number | undefined {
  if (!startedAt || !stoppedAt) {
    return undefined;
  }
  return Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt));
}
