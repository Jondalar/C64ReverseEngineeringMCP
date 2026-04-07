import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ViceMonitorClient, type ViceCpuHistoryItem, type ViceRegisterDescriptor, type ViceRegisterValue } from "./monitor-client.js";
import { type ViceRuntimeTraceConfig, type ViceSessionRecord } from "./types.js";

interface RuntimeTraceWorkerState {
  config: ViceRuntimeTraceConfig;
  running?: boolean;
  sampleIndex: number;
  lastClock?: bigint;
}

let activeClient: ViceMonitorClient | undefined;
let shuttingDown = false;

process.on("SIGTERM", () => {
  shuttingDown = true;
  activeClient?.close();
});
process.on("SIGINT", () => {
  shuttingDown = true;
  activeClient?.close();
});

async function main(): Promise<void> {
  const sessionPath = process.argv[2];
  if (!sessionPath) {
    throw new Error("Missing session.json path.");
  }

  let record = await readSessionRecord(sessionPath);
  if (!record.runtimeTrace || !record.runtimeTraceActive) {
    return;
  }

  const state = await loadRuntimeTraceState(record) ?? {
    config: record.runtimeTrace,
    sampleIndex: 0,
  };

  record.runtimeTraceWorkerPid = process.pid;
  await persistRecord(record);
  await writeEvent(record, "runtime_trace_worker_started", {
    pid: process.pid,
    sampleIndex: state.sampleIndex,
  });

  let registerDescriptors: ViceRegisterDescriptor[] | undefined;

  try {
    while (!shuttingDown) {
      record = await readSessionRecord(sessionPath);
      if (
        record.state !== "running"
        || !record.runtimeTrace
        || !record.runtimeTraceActive
      ) {
        break;
      }

      if (!activeClient?.isConnected) {
        activeClient?.close();
        activeClient = new ViceMonitorClient({
          host: "127.0.0.1",
          port: record.monitorPort,
          onTraceEvent: (type, payload) => {
            void writeEvent(record, type, payload);
          },
        });
        await activeClient.connect();
        await writeEvent(record, "monitor_client_ready", {
          port: record.monitorPort,
          source: "trace_worker",
        });
      }

      try {
        registerDescriptors ??= await activeClient.getRegistersAvailable();
        const currentRegisters = await activeClient.getRegisters();
        const cpuHistory = await activeClient.getCpuHistory(record.runtimeTrace.cpuHistoryCount);
        const appended = await appendRuntimeTrace(record, state, registerDescriptors, currentRegisters, cpuHistory);
        const afterSequence = activeClient.currentEventSequence;
        await activeClient.resume();
        await activeClient.waitForResume(afterSequence, 1_000).catch(() => undefined);
        await writeEvent(record, "runtime_trace_sample", {
          sampleIndex: state.sampleIndex,
          cpuHistoryItems: cpuHistory.length,
          appendedItems: appended.appendedItems,
          clockFirst: appended.clockFirst,
          clockLast: appended.clockLast,
        });
        state.sampleIndex += 1;
      } catch (error) {
        activeClient?.close();
        activeClient = undefined;
        await writeEvent(record, "runtime_trace_error", {
          error: error instanceof Error ? error.message : String(error),
          source: "trace_worker",
        });
      }

      await sleep(record.runtimeTrace.intervalMs);
    }
  } finally {
    activeClient?.close();
    activeClient = undefined;
    const latest = await readSessionRecord(sessionPath).catch(() => undefined);
    if (latest?.runtimeTraceWorkerPid === process.pid) {
      latest.runtimeTraceWorkerPid = undefined;
      await persistRecord(latest);
      await writeEvent(latest, "runtime_trace_worker_stopped", {
        pid: process.pid,
        sampleIndex: state.sampleIndex,
        lastClock: state.lastClock?.toString(),
      });
    }
  }
}

async function readSessionRecord(sessionPath: string): Promise<ViceSessionRecord> {
  return JSON.parse(await readFile(sessionPath, "utf8")) as ViceSessionRecord;
}

async function persistRecord(record: ViceSessionRecord): Promise<void> {
  await writeFile(record.workspace.sessionPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function writeEvent(record: ViceSessionRecord, type: string, payload: object): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  });
  await appendFile(record.workspace.eventsLogPath, `${line}\n`, "utf8");
}

async function appendRuntimeTrace(
  record: ViceSessionRecord,
  state: RuntimeTraceWorkerState,
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

async function loadRuntimeTraceState(record: ViceSessionRecord): Promise<RuntimeTraceWorkerState | undefined> {
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
    // ignore missing or unreadable event logs
  }

  return {
    config: record.runtimeTrace,
    running,
    sampleIndex,
    lastClock,
  };
}

main().catch(async (error) => {
  const sessionPath = process.argv[2];
  if (sessionPath) {
    try {
      const record = await readSessionRecord(sessionPath);
      await writeEvent(record, "runtime_trace_worker_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (record.runtimeTraceWorkerPid === process.pid) {
        record.runtimeTraceWorkerPid = undefined;
        record.runtimeTraceActive = false;
        await persistRecord(record);
      }
    } catch {
      // ignore secondary failure during worker shutdown
    }
  }
  process.exitCode = 1;
});
