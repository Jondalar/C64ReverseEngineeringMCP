import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ChildProcess } from "node:child_process";
import { createViceConfigWorkspace } from "./config-workspace.js";
import { launchViceProcess, waitForMonitorPort, isMonitorPortOpen } from "./process-launcher.js";
import { allocateViceMonitorPort } from "./port-allocator.js";
import { analyzeRuntimeTrace, analyzeTrace, writeTraceSnapshot, type ViceTraceSnapshot } from "./trace-analyzer.js";
import {
  ViceMonitorClient,
  type ViceCpuHistoryItem,
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

interface ActiveViceSession {
  record: ViceSessionRecord;
  child: ChildProcess;
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
      monitorChisLines: options.runtimeTrace?.monitorChisLines,
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
      record.state = "running";
      if (options.runtimeTrace?.enabled) {
        active.runtimeTraceState = {
          config: options.runtimeTrace,
          running: true,
          sampleIndex: 0,
        };
        await this.writeEvent(record, "runtime_trace_started", {
          intervalMs: options.runtimeTrace.intervalMs,
          cpuHistoryCount: options.runtimeTrace.cpuHistoryCount,
          monitorChisLines: options.runtimeTrace.monitorChisLines,
          firstSampleDelayMs: Math.min(options.runtimeTrace.intervalMs, RUNTIME_TRACE_INITIAL_DELAY_MS),
        });
        this.scheduleRuntimeTraceSample(active, Math.min(options.runtimeTrace.intervalMs, RUNTIME_TRACE_INITIAL_DELAY_MS));
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
    await this.reconcileExitedSession();
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
    await this.reconcileExitedSession();
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

  async readMemory(startAddress: number, endAddress: number): Promise<Buffer> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    return client.readMemory(startAddress, endAddress);
  }

  async readCpuHistory(count: number): Promise<ViceCpuHistoryItem[]> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    return client.getCpuHistory(count);
  }

  async continueExecution(): Promise<{ pc: number }> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const afterSequence = client.currentEventSequence;
    await client.resume();
    return client.waitForResume(afterSequence, 2_000);
  }

  async resetSystem(powerCycle = false): Promise<void> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    await client.resetSystem(powerCycle);
    await this.writeEvent(active.record, "system_reset", {
      powerCycle,
    });
  }

  async stepInto(): Promise<{ pc: number }> {
    const active = this.requireActiveSession();
    const client = await this.getOrCreateMonitorClient(active);
    const afterSequence = client.currentEventSequence;
    await client.advanceInstructions(1, false);
    return client.waitForStop(afterSequence, 2_000);
  }

  async stepOver(): Promise<{ pc: number }> {
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

  private async reconcileExitedSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }
    if (!isProcessAlive(this.activeSession.child.pid) && this.activeSession.record.state !== "stopped") {
      await waitForExit(this.activeSession, 100);
    }
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
    active.monitorClient?.close();

    await this.writeEvent(record, "process_exited", {
      exitCode: code,
      signal,
      stopReason: record.stopReason,
      lastError,
    });
    await this.persistRecord(record);
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

async function waitForExit(active: ActiveViceSession, timeoutMs: number): Promise<boolean> {
  const timedOut = Symbol("timeout");
  const result = await Promise.race([
    active.exitPromise.then(() => true),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);
  return result !== timedOut;
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

function computeDurationMs(startedAt?: string, stoppedAt?: string): number | undefined {
  if (!startedAt || !stoppedAt) {
    return undefined;
  }
  return Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt));
}
