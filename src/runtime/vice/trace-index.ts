import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { ViceSessionRecord } from "./types.js";

interface AnnotationSegment {
  start: string;
  end: string;
  kind: string;
  label?: string;
  comment?: string;
}

interface AnnotationLabel {
  address: string;
  label: string;
  comment?: string;
}

interface AnnotationRoutine {
  address: string;
  name: string;
  comment?: string;
}

interface AnnotationFile {
  version: number;
  binary: string;
  segments?: AnnotationSegment[];
  labels?: AnnotationLabel[];
  routines?: AnnotationRoutine[];
}

interface RuntimeTraceSampleEvent {
  sampleIndex: number;
  cpuHistoryItems?: number;
  appendedItems?: number;
  clockFirst?: string;
  clockLast?: string;
}

interface RuntimeTraceInstructionRow {
  kind?: string;
  sampleIndex?: number;
  clock?: string;
  pc?: number;
}

export interface ViceTraceSemanticLink {
  label?: string;
  labelComment?: string;
  routineAddress?: number;
  routineName?: string;
  routineComment?: string;
  segmentStart?: number;
  segmentEnd?: number;
  segmentKind?: string;
  segmentLabel?: string;
  segmentComment?: string;
}

export interface ViceTraceIndexEntry {
  pc: number;
  count: number;
  firstClock: string;
  lastClock: string;
  firstSampleIndex: number;
  lastSampleIndex: number;
  semantic?: ViceTraceSemanticLink;
}

export interface ViceTraceIndexContinuity {
  status: "ok" | "warning" | "broken";
  sampleCount: number;
  positiveGapCount: number;
  maxClockGap: string;
  maxClockGapBetweenSamples?: {
    previousSampleIndex: number;
    currentSampleIndex: number;
    previousClockLast: string;
    currentClockFirst: string;
  };
  saturatedSampleCount: number;
  fullWindowSampleCount: number;
}

export interface ViceTraceIndex {
  version: 1;
  generatedAt: string;
  sessionId: string;
  runtimeTracePath: string;
  eventsLogPath: string;
  annotationsPath?: string;
  continuity: ViceTraceIndexContinuity;
  pcIndex: ViceTraceIndexEntry[];
}

export async function buildTraceIndex(
  record: ViceSessionRecord,
  options: { annotationsPath?: string } = {},
): Promise<ViceTraceIndex> {
  const pcStats = new Map<number, {
    count: number;
    firstClock: string;
    lastClock: string;
    firstSampleIndex: number;
    lastSampleIndex: number;
  }>();

  for await (const line of readJsonlLines(record.workspace.runtimeTracePath)) {
    try {
      const row = JSON.parse(line) as RuntimeTraceInstructionRow;
      if (row.kind !== "instruction" || row.pc === undefined || row.clock === undefined || row.sampleIndex === undefined) {
        continue;
      }
      const existing = pcStats.get(row.pc);
      if (existing) {
        existing.count += 1;
        existing.lastClock = row.clock;
        existing.lastSampleIndex = row.sampleIndex;
      } else {
        pcStats.set(row.pc, {
          count: 1,
          firstClock: row.clock,
          lastClock: row.clock,
          firstSampleIndex: row.sampleIndex,
          lastSampleIndex: row.sampleIndex,
        });
      }
    } catch {
      // ignore malformed trace rows
    }
  }

  const continuity = await buildContinuityIndex(record.workspace.eventsLogPath);
  const semanticResolver = await loadSemanticResolver(options.annotationsPath);

  const pcIndex: ViceTraceIndexEntry[] = [...pcStats.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([pc, stat]) => ({
      pc,
      count: stat.count,
      firstClock: stat.firstClock,
      lastClock: stat.lastClock,
      firstSampleIndex: stat.firstSampleIndex,
      lastSampleIndex: stat.lastSampleIndex,
      semantic: semanticResolver?.(pc),
    }));

  const index: ViceTraceIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionId: record.sessionId,
    runtimeTracePath: record.workspace.runtimeTracePath,
    eventsLogPath: record.workspace.eventsLogPath,
    annotationsPath: options.annotationsPath,
    continuity,
    pcIndex,
  };

  await writeFile(resolveTraceIndexPath(record), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function loadTraceIndex(record: ViceSessionRecord): Promise<ViceTraceIndex | undefined> {
  try {
    const text = await readFile(resolveTraceIndexPath(record), "utf8");
    return JSON.parse(text) as ViceTraceIndex;
  } catch {
    return undefined;
  }
}

export function resolveTraceIndexPath(record: ViceSessionRecord): string {
  return record.workspace.traceIndexPath ?? join(resolveTraceDir(record), "trace-index.json");
}

function resolveTraceDir(record: ViceSessionRecord): string {
  return record.workspace.traceDir ?? dirname(record.workspace.runtimeTracePath);
}

async function buildContinuityIndex(eventsLogPath: string): Promise<ViceTraceIndexContinuity> {
  const samples: RuntimeTraceSampleEvent[] = [];

  for await (const line of readJsonlLines(eventsLogPath)) {
    try {
      const event = JSON.parse(line) as { type?: string; payload?: RuntimeTraceSampleEvent };
      if (event.type === "runtime_trace_sample" && event.payload?.sampleIndex !== undefined) {
        samples.push(event.payload);
      }
    } catch {
      // ignore malformed event rows
    }
  }

  let positiveGapCount = 0;
  let maxClockGap = 0n;
  let maxClockGapBetweenSamples: ViceTraceIndexContinuity["maxClockGapBetweenSamples"];
  let saturatedSampleCount = 0;
  let fullWindowSampleCount = 0;

  for (const sample of samples) {
    if (sample.cpuHistoryItems !== undefined && sample.appendedItems !== undefined) {
      if (sample.cpuHistoryItems >= 65535) {
        fullWindowSampleCount += 1;
      }
      if (sample.sampleIndex > 0 && sample.appendedItems >= sample.cpuHistoryItems) {
        saturatedSampleCount += 1;
      }
    }
  }

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (!previous.clockLast || !current.clockFirst) {
      continue;
    }
    const gap = BigInt(current.clockFirst) - BigInt(previous.clockLast);
    if (gap > 0n) {
      positiveGapCount += 1;
      if (gap > maxClockGap) {
        maxClockGap = gap;
        maxClockGapBetweenSamples = {
          previousSampleIndex: previous.sampleIndex,
          currentSampleIndex: current.sampleIndex,
          previousClockLast: previous.clockLast,
          currentClockFirst: current.clockFirst,
        };
      }
    }
  }

  let status: ViceTraceIndexContinuity["status"] = "ok";
  if (maxClockGap > 512n || saturatedSampleCount > 3) {
    status = "broken";
  } else if (maxClockGap > 16n || saturatedSampleCount > 0) {
    status = "warning";
  }

  return {
    status,
    sampleCount: samples.length,
    positiveGapCount,
    maxClockGap: maxClockGap.toString(),
    maxClockGapBetweenSamples,
    saturatedSampleCount,
    fullWindowSampleCount,
  };
}

async function loadSemanticResolver(
  annotationsPath?: string,
): Promise<((pc: number) => ViceTraceSemanticLink | undefined) | undefined> {
  if (!annotationsPath) {
    return undefined;
  }

  let annotations: AnnotationFile;
  try {
    annotations = JSON.parse(await readFile(annotationsPath, "utf8")) as AnnotationFile;
  } catch {
    return undefined;
  }

  const labels = new Map<number, AnnotationLabel>();
  const segments = (annotations.segments ?? [])
    .map((segment) => ({
      ...segment,
      startNum: parseHex(segment.start),
      endNum: parseHex(segment.end),
    }))
    .sort((left, right) => left.startNum - right.startNum || left.endNum - right.endNum);
  const routines = (annotations.routines ?? [])
    .map((routine) => ({
      ...routine,
      addressNum: parseHex(routine.address),
    }))
    .sort((left, right) => left.addressNum - right.addressNum);

  for (const label of annotations.labels ?? []) {
    labels.set(parseHex(label.address), label);
  }

  return (pc: number) => {
    const label = labels.get(pc);
    const segment = findContainingSegment(segments, pc);
    const routine = findOwningRoutine(routines, pc, segment?.startNum, segment?.endNum);

    if (!label && !segment && !routine) {
      return undefined;
    }

    return {
      label: label?.label,
      labelComment: label?.comment,
      routineAddress: routine?.addressNum,
      routineName: routine?.name,
      routineComment: routine?.comment,
      segmentStart: segment?.startNum,
      segmentEnd: segment?.endNum,
      segmentKind: segment?.kind,
      segmentLabel: segment?.label,
      segmentComment: segment?.comment,
    };
  };
}

function findContainingSegment(
  segments: Array<AnnotationSegment & { startNum: number; endNum: number }>,
  pc: number,
): (AnnotationSegment & { startNum: number; endNum: number }) | undefined {
  return segments.find((segment) => segment.startNum <= pc && pc <= segment.endNum);
}

function findOwningRoutine(
  routines: Array<AnnotationRoutine & { addressNum: number }>,
  pc: number,
  segmentStart?: number,
  segmentEnd?: number,
): (AnnotationRoutine & { addressNum: number }) | undefined {
  let candidate: (AnnotationRoutine & { addressNum: number }) | undefined;
  for (const routine of routines) {
    if (routine.addressNum > pc) {
      break;
    }
    if (segmentStart !== undefined && segmentEnd !== undefined) {
      if (routine.addressNum < segmentStart || routine.addressNum > segmentEnd) {
        continue;
      }
    }
    candidate = routine;
  }
  return candidate;
}

function parseHex(value: string): number {
  return parseInt(value.replace(/^\$/, ""), 16);
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
