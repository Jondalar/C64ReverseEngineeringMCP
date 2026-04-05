import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ViceCpuHistoryItem, ViceRegisterDescriptor, ViceRegisterValue } from "./monitor-client.js";
import type { ViceSessionRecord, ViceTraceAnalysis } from "./types.js";

export interface ViceTraceSnapshot {
  capturedAt: string;
  media?: ViceSessionRecord["media"];
  registerDescriptors: ViceRegisterDescriptor[];
  currentRegisters: ViceRegisterValue[];
  cpuHistory: ViceCpuHistoryItem[];
}

export async function writeTraceSnapshot(
  record: ViceSessionRecord,
  snapshot: ViceTraceSnapshot,
): Promise<void> {
  await writeFile(record.workspace.traceSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function analyzeTrace(
  record: ViceSessionRecord,
  snapshot: ViceTraceSnapshot,
): Promise<ViceTraceAnalysis> {
  const eventCounts = await readEventCounts(record.workspace.eventsLogPath);
  const currentPc = snapshot.currentRegisters.find((registerValue) => registerValue.id === 3)?.value;
  const registerNameById = new Map(snapshot.registerDescriptors.map((descriptor) => [descriptor.id, descriptor.name]));
  const pcCounts = new Map<number, number>();

  for (const item of snapshot.cpuHistory) {
    const pc = item.registers.find((registerValue) => registerValue.id === 3)?.value;
    if (pc === undefined) {
      continue;
    }
    pcCounts.set(pc, (pcCounts.get(pc) ?? 0) + 1);
  }

  const analysis: ViceTraceAnalysis = {
    sessionId: record.sessionId,
    media: record.media,
    state: record.state,
    stopReason: record.stopReason,
    durationMs: computeDurationMs(record.startedAt, record.stoppedAt),
    cpuHistoryItems: snapshot.cpuHistory.length,
    currentPc,
    currentPcName: currentPc === undefined ? undefined : registerNameById.get(3),
    regionBuckets: buildRegionBuckets(snapshot.cpuHistory),
    topPcs: [...pcCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([pc, count]) => ({ pc, count })),
    eventCounts,
    artifacts: {
      sessionPath: record.workspace.sessionPath,
      summaryPath: record.workspace.summaryPath,
      eventsLogPath: record.workspace.eventsLogPath,
      traceSnapshotPath: record.workspace.traceSnapshotPath,
      traceAnalysisPath: record.workspace.traceAnalysisPath,
      runtimeTracePath: record.workspace.runtimeTracePath,
    },
  };

  await writeFile(record.workspace.traceAnalysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  return analysis;
}

export async function analyzeRuntimeTrace(record: ViceSessionRecord): Promise<ViceTraceAnalysis> {
  const eventCounts = await readEventCounts(record.workspace.eventsLogPath);
  const pcCounts = new Map<number, number>();
  const regionBuckets = createEmptyRegionBuckets();
  let currentPc: number | undefined;
  let cpuHistoryItems = 0;

  for await (const line of readJsonlLines(record.workspace.runtimeTracePath)) {
    try {
      const event = JSON.parse(line) as {
        kind?: string;
        pc?: number;
      };
      if (event.kind !== "instruction" || event.pc === undefined) {
        continue;
      }
      cpuHistoryItems += 1;
      currentPc = event.pc;
      pcCounts.set(event.pc, (pcCounts.get(event.pc) ?? 0) + 1);
      bucketProgramCounter(regionBuckets, event.pc);
    } catch {
      eventCounts.invalid_runtime_trace_json = (eventCounts.invalid_runtime_trace_json ?? 0) + 1;
    }
  }

  const analysis: ViceTraceAnalysis = {
    sessionId: record.sessionId,
    media: record.media,
    state: record.state,
    stopReason: record.stopReason,
    durationMs: computeDurationMs(record.startedAt, record.stoppedAt),
    cpuHistoryItems,
    currentPc,
    regionBuckets,
    topPcs: [...pcCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([pc, count]) => ({ pc, count })),
    eventCounts,
    artifacts: {
      sessionPath: record.workspace.sessionPath,
      summaryPath: record.workspace.summaryPath,
      eventsLogPath: record.workspace.eventsLogPath,
      traceSnapshotPath: record.workspace.traceSnapshotPath,
      traceAnalysisPath: record.workspace.traceAnalysisPath,
      runtimeTracePath: record.workspace.runtimeTracePath,
    },
  };

  await writeFile(record.workspace.traceAnalysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  return analysis;
}

async function readEventCounts(eventsLogPath: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for await (const line of readJsonlLines(eventsLogPath)) {
    try {
      const parsed = JSON.parse(line) as { type?: string };
      if (!parsed.type) {
        continue;
      }
      counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
    } catch {
      counts.invalid_json = (counts.invalid_json ?? 0) + 1;
    }
  }
  return counts;
}

function buildRegionBuckets(cpuHistory: ViceCpuHistoryItem[]): Record<string, number> {
  const buckets = createEmptyRegionBuckets();

  for (const item of cpuHistory) {
    const pc = item.registers.find((registerValue) => registerValue.id === 3)?.value;
    if (pc === undefined) {
      buckets.other += 1;
      continue;
    }
    bucketProgramCounter(buckets, pc);
  }

  return buckets;
}

function createEmptyRegionBuckets(): Record<string, number> {
  return {
    basic: 0,
    kernal: 0,
    ram_low: 0,
    ram_high: 0,
    io: 0,
    char_rom_gap: 0,
    other: 0,
  };
}

function bucketProgramCounter(buckets: Record<string, number>, pc: number): void {
  if (pc >= 0xa000 && pc <= 0xbfff) {
    buckets.basic += 1;
  } else if (pc >= 0xe000 && pc <= 0xffff) {
    buckets.kernal += 1;
  } else if (pc >= 0x0000 && pc <= 0x7fff) {
    buckets.ram_low += 1;
  } else if (pc >= 0x8000 && pc <= 0x9fff) {
    buckets.ram_high += 1;
  } else if (pc >= 0xd000 && pc <= 0xdfff) {
    buckets.io += 1;
  } else if (pc >= 0xc000 && pc <= 0xcfff) {
    buckets.char_rom_gap += 1;
  } else {
    buckets.other += 1;
  }
}

async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      yield line;
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function computeDurationMs(startedAt?: string, stoppedAt?: string): number | undefined {
  if (!startedAt || !stoppedAt) {
    return undefined;
  }
  return Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt));
}
