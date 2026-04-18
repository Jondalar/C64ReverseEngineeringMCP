import { readFile, writeFile } from "node:fs/promises";
import type { ViceSessionRecord } from "./types.js";
import { decodeTraceInstruction } from "./trace-instruction.js";
import { readRuntimeTrace, type ViceTraceInstructionEvent } from "./trace-runtime.js";
import { loadSemanticResolver, type ViceTraceSemanticLink } from "./trace-semantic.js";

interface CounterEntry {
  count: number;
  firstClock: string;
  lastClock: string;
}

export interface ViceTraceWindowEntityCount {
  key: string;
  count: number;
}

export interface ViceTraceWindowAddressCount {
  address: number;
  reads: number;
  writes: number;
}

export interface ViceTraceWindowFeatures {
  uniquePcCount: number;
  uniqueRoutineCount: number;
  uniqueSegmentCount: number;
  uniqueAddressCount: number;
  callCount: number;
  returnCount: number;
  branchCount: number;
  jumpCount: number;
  readCount: number;
  writeCount: number;
  ioReadCount: number;
  ioWriteCount: number;
  zeroPageAccessCount: number;
  screenAreaAccessCount: number;
  colorRamAccessCount: number;
  vectorWriteCount: number;
  rtiCount: number;
}

export interface ViceTraceWindowSummary {
  level: number;
  windowIndex: number;
  size: number;
  instructionCount: number;
  startClock: string;
  endClock: string;
  startSampleIndex: number;
  endSampleIndex: number;
  phaseId: number;
  dominantPc?: number;
  dominantRoutine?: string;
  dominantSegment?: string;
  topPcs: Array<{ pc: number; count: number }>;
  topRoutines: ViceTraceWindowEntityCount[];
  topSegments: ViceTraceWindowEntityCount[];
  topAddresses: ViceTraceWindowAddressCount[];
  features: ViceTraceWindowFeatures;
}

export interface ViceTracePhaseSummary {
  phaseId: number;
  startWindowIndex: number;
  endWindowIndex: number;
  startClock: string;
  endClock: string;
  instructionCount: number;
  topRoutines: ViceTraceWindowEntityCount[];
  topSegments: ViceTraceWindowEntityCount[];
  topAddresses: ViceTraceWindowAddressCount[];
  dominantRoutine?: string;
  dominantSegment?: string;
}

export interface ViceTraceWindowLevelSummary {
  level: number;
  size: number;
  windowCount: number;
  windows: ViceTraceWindowSummary[];
}

export interface ViceTracePhaseBoundary {
  previousWindowIndex: number;
  currentWindowIndex: number;
  previousPhaseId: number;
  currentPhaseId: number;
  score: number;
  reasons: string[];
}

export interface ViceTraceWindowOverview {
  totalInstructions: number;
  uniquePcCount: number;
  uniqueRoutineCount: number;
  uniqueSegmentCount: number;
  uniqueAddressCount: number;
  topPcs: Array<{ pc: number; count: number }>;
  topRoutines: ViceTraceWindowEntityCount[];
  topSegments: ViceTraceWindowEntityCount[];
  topAddresses: ViceTraceWindowAddressCount[];
}

export interface ViceTraceWindowIndex {
  version: 1;
  generatedAt: string;
  sessionId: string;
  runtimeTracePath: string;
  annotationsPath?: string;
  levels: ViceTraceWindowLevelSummary[];
  phases: ViceTracePhaseSummary[];
  phaseBoundaries: ViceTracePhaseBoundary[];
  overview: ViceTraceWindowOverview;
}

class WindowAccumulator {
  readonly size: number;
  readonly level: number;

  private windowIndex = 0;
  private instructionCount = 0;
  private startClock?: string;
  private endClock?: string;
  private startSampleIndex?: number;
  private endSampleIndex?: number;
  private pcCounts = new Map<number, number>();
  private routineCounts = new Map<string, number>();
  private segmentCounts = new Map<string, number>();
  private addressCounts = new Map<number, { reads: number; writes: number }>();
  private features: ViceTraceWindowFeatures = createEmptyFeatures();

  constructor(level: number, size: number) {
    this.level = level;
    this.size = size;
  }

  push(event: ViceTraceInstructionEvent, semantic?: ViceTraceSemanticLink): ViceTraceWindowSummary | undefined {
    if (this.instructionCount === 0) {
      this.startClock = event.clock;
      this.startSampleIndex = event.sampleIndex;
    }

    this.instructionCount += 1;
    this.endClock = event.clock;
    this.endSampleIndex = event.sampleIndex;
    if (event.pc !== undefined) {
      this.pcCounts.set(event.pc, (this.pcCounts.get(event.pc) ?? 0) + 1);
    }

    const routineKey = semantic?.routineName ?? "unknown_routine";
    this.routineCounts.set(routineKey, (this.routineCounts.get(routineKey) ?? 0) + 1);

    const segmentKey = semantic?.segmentLabel
      ?? semantic?.segmentKind
      ?? "unknown_segment";
    this.segmentCounts.set(segmentKey, (this.segmentCounts.get(segmentKey) ?? 0) + 1);

    const decoded = decodeTraceInstruction(event.instructionBytes);
    if (decoded.isCall) this.features.callCount += 1;
    if (decoded.isReturn) this.features.returnCount += 1;
    if (decoded.mnemonic === "RTI") this.features.rtiCount += 1;
    if (decoded.access === "branch") this.features.branchCount += 1;
    if (decoded.access === "jump") this.features.jumpCount += 1;

    if (decoded.directAddress !== undefined) {
      const addressEntry = this.addressCounts.get(decoded.directAddress) ?? { reads: 0, writes: 0 };
      if (decoded.access === "read") {
        addressEntry.reads += 1;
        this.features.readCount += 1;
      } else if (decoded.access === "write") {
        addressEntry.writes += 1;
        this.features.writeCount += 1;
      } else if (decoded.access === "readwrite") {
        addressEntry.reads += 1;
        addressEntry.writes += 1;
        this.features.readCount += 1;
        this.features.writeCount += 1;
      }
      this.addressCounts.set(decoded.directAddress, addressEntry);
      applyAddressFeatureFlags(this.features, decoded.directAddress, decoded.access);
    }

    if (this.instructionCount >= this.size) {
      return this.finalizeAndReset();
    }
    return undefined;
  }

  flush(): ViceTraceWindowSummary | undefined {
    if (this.instructionCount === 0) {
      return undefined;
    }
    return this.finalizeAndReset();
  }

  private finalizeAndReset(): ViceTraceWindowSummary {
    const topPcs = [...this.pcCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 10)
      .map(([pc, count]) => ({ pc, count }));
    const topRoutines = topEntries(this.routineCounts, 8);
    const topSegments = topEntries(this.segmentCounts, 8);
    const topAddresses = [...this.addressCounts.entries()]
      .sort((left, right) => {
        const leftCount = left[1].reads + left[1].writes;
        const rightCount = right[1].reads + right[1].writes;
        return rightCount - leftCount || left[0] - right[0];
      })
      .slice(0, 12)
      .map(([address, counts]) => ({
        address,
        reads: counts.reads,
        writes: counts.writes,
      }));

    const summary: ViceTraceWindowSummary = {
      level: this.level,
      windowIndex: this.windowIndex,
      size: this.size,
      instructionCount: this.instructionCount,
      startClock: this.startClock ?? "0",
      endClock: this.endClock ?? "0",
      startSampleIndex: this.startSampleIndex ?? 0,
      endSampleIndex: this.endSampleIndex ?? 0,
      phaseId: -1,
      dominantPc: topPcs[0]?.pc,
      dominantRoutine: topRoutines[0]?.key,
      dominantSegment: topSegments[0]?.key,
      topPcs,
      topRoutines,
      topSegments,
      topAddresses,
      features: {
        ...this.features,
        uniquePcCount: this.pcCounts.size,
        uniqueRoutineCount: this.routineCounts.size,
        uniqueSegmentCount: this.segmentCounts.size,
        uniqueAddressCount: this.addressCounts.size,
      },
    };

    this.windowIndex += 1;
    this.instructionCount = 0;
    this.startClock = undefined;
    this.endClock = undefined;
    this.startSampleIndex = undefined;
    this.endSampleIndex = undefined;
    this.pcCounts = new Map();
    this.routineCounts = new Map();
    this.segmentCounts = new Map();
    this.addressCounts = new Map();
    this.features = createEmptyFeatures();
    return summary;
  }
}

export async function buildTraceWindowIndex(
  record: ViceSessionRecord,
  options: {
    annotationsPath?: string;
    windowSizes?: number[];
  } = {},
): Promise<ViceTraceWindowIndex> {
  const sizes = [...new Set((options.windowSizes ?? [256, 1024, 4096, 16384]).filter((size) => size > 0))]
    .sort((left, right) => left - right);
  const levels = sizes.map((size, index) => new WindowAccumulator(index, size));
  const semanticResolver = await loadSemanticResolver(options.annotationsPath);
  const globalPcCounts = new Map<number, number>();
  const globalRoutineCounts = new Map<string, number>();
  const globalSegmentCounts = new Map<string, number>();
  const globalAddressCounts = new Map<number, { reads: number; writes: number }>();
  let totalInstructions = 0;

  const levelWindows = new Map<number, ViceTraceWindowSummary[]>();
  for (const level of levels) {
    levelWindows.set(level.level, []);
  }

  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }
    totalInstructions += 1;
    const semantic = event.pc === undefined ? undefined : semanticResolver?.resolve(event.pc);
    if (event.pc !== undefined) {
      globalPcCounts.set(event.pc, (globalPcCounts.get(event.pc) ?? 0) + 1);
    }
    const routineKey = semantic?.routineName ?? "unknown_routine";
    const segmentKey = semantic?.segmentLabel ?? semantic?.segmentKind ?? "unknown_segment";
    globalRoutineCounts.set(routineKey, (globalRoutineCounts.get(routineKey) ?? 0) + 1);
    globalSegmentCounts.set(segmentKey, (globalSegmentCounts.get(segmentKey) ?? 0) + 1);

    const decoded = decodeTraceInstruction(event.instructionBytes);
    if (decoded.directAddress !== undefined) {
      const addressEntry = globalAddressCounts.get(decoded.directAddress) ?? { reads: 0, writes: 0 };
      if (decoded.access === "read") {
        addressEntry.reads += 1;
      } else if (decoded.access === "write") {
        addressEntry.writes += 1;
      } else if (decoded.access === "readwrite") {
        addressEntry.reads += 1;
        addressEntry.writes += 1;
      }
      globalAddressCounts.set(decoded.directAddress, addressEntry);
    }

    for (const level of levels) {
      const finished = level.push(event, semantic);
      if (finished) {
        levelWindows.get(level.level)?.push(finished);
      }
    }
  }

  for (const level of levels) {
    const trailing = level.flush();
    if (trailing) {
      levelWindows.get(level.level)?.push(trailing);
    }
  }

  const baseWindows = levelWindows.get(0) ?? [];
  const { phases, phaseBoundaries } = detectPhases(baseWindows);
  const levelSummaries: ViceTraceWindowLevelSummary[] = levels.map((level) => ({
    level: level.level,
    size: level.size,
    windowCount: levelWindows.get(level.level)?.length ?? 0,
    windows: levelWindows.get(level.level) ?? [],
  }));

  const overview: ViceTraceWindowOverview = {
    totalInstructions,
    uniquePcCount: globalPcCounts.size,
    uniqueRoutineCount: globalRoutineCounts.size,
    uniqueSegmentCount: globalSegmentCounts.size,
    uniqueAddressCount: globalAddressCounts.size,
    topPcs: [...globalPcCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 20)
      .map(([pc, count]) => ({ pc, count })),
    topRoutines: topEntries(globalRoutineCounts, 20),
    topSegments: topEntries(globalSegmentCounts, 20),
    topAddresses: [...globalAddressCounts.entries()]
      .sort((left, right) => {
        const leftCount = left[1].reads + left[1].writes;
        const rightCount = right[1].reads + right[1].writes;
        return rightCount - leftCount || left[0] - right[0];
      })
      .slice(0, 20)
      .map(([address, counts]) => ({
        address,
        reads: counts.reads,
        writes: counts.writes,
      })),
  };

  const index: ViceTraceWindowIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionId: record.sessionId,
    runtimeTracePath: record.workspace.runtimeTracePath,
    annotationsPath: options.annotationsPath,
    levels: levelSummaries,
    phases,
    phaseBoundaries,
    overview,
  };

  await writeFile(record.workspace.traceWindowIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function loadTraceWindowIndex(record: ViceSessionRecord): Promise<ViceTraceWindowIndex | undefined> {
  try {
    const text = await readFile(record.workspace.traceWindowIndexPath, "utf8");
    return JSON.parse(text) as ViceTraceWindowIndex;
  } catch {
    return undefined;
  }
}

function detectPhases(
  windows: ViceTraceWindowSummary[],
): { phases: ViceTracePhaseSummary[]; phaseBoundaries: ViceTracePhaseBoundary[] } {
  if (windows.length === 0) {
    return { phases: [], phaseBoundaries: [] };
  }

  let phaseId = 0;
  windows[0]!.phaseId = phaseId;
  const phaseBoundaries: ViceTracePhaseBoundary[] = [];

  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1]!;
    const current = windows[index]!;
    const change = measureWindowChange(previous, current);
    if (change.score >= 0.72) {
      phaseId += 1;
      phaseBoundaries.push({
        previousWindowIndex: previous.windowIndex,
        currentWindowIndex: current.windowIndex,
        previousPhaseId: previous.phaseId,
        currentPhaseId: phaseId,
        score: roundScore(change.score),
        reasons: change.reasons,
      });
    }
    current.phaseId = phaseId;
  }

  const phaseAccumulator = new Map<number, {
    startWindowIndex: number;
    endWindowIndex: number;
    startClock: string;
    endClock: string;
    instructionCount: number;
    routineCounts: Map<string, number>;
    segmentCounts: Map<string, number>;
    addressCounts: Map<number, { reads: number; writes: number }>;
  }>();

  for (const window of windows) {
    const entry = phaseAccumulator.get(window.phaseId) ?? {
      startWindowIndex: window.windowIndex,
      endWindowIndex: window.windowIndex,
      startClock: window.startClock,
      endClock: window.endClock,
      instructionCount: 0,
      routineCounts: new Map<string, number>(),
      segmentCounts: new Map<string, number>(),
      addressCounts: new Map<number, { reads: number; writes: number }>(),
    };
    entry.endWindowIndex = window.windowIndex;
    entry.endClock = window.endClock;
    entry.instructionCount += window.instructionCount;
    mergeEntityCounts(entry.routineCounts, window.topRoutines);
    mergeEntityCounts(entry.segmentCounts, window.topSegments);
    mergeAddressCounts(entry.addressCounts, window.topAddresses);
    phaseAccumulator.set(window.phaseId, entry);
  }

  const phases = [...phaseAccumulator.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([id, phase]) => {
      const topRoutines = topEntries(phase.routineCounts, 8);
      const topSegments = topEntries(phase.segmentCounts, 8);
      const topAddresses = [...phase.addressCounts.entries()]
        .sort((left, right) => {
          const leftCount = left[1].reads + left[1].writes;
          const rightCount = right[1].reads + right[1].writes;
          return rightCount - leftCount || left[0] - right[0];
        })
        .slice(0, 12)
        .map(([address, counts]) => ({
          address,
          reads: counts.reads,
          writes: counts.writes,
        }));
      return {
        phaseId: id,
        startWindowIndex: phase.startWindowIndex,
        endWindowIndex: phase.endWindowIndex,
        startClock: phase.startClock,
        endClock: phase.endClock,
        instructionCount: phase.instructionCount,
        topRoutines,
        topSegments,
        topAddresses,
        dominantRoutine: topRoutines[0]?.key,
        dominantSegment: topSegments[0]?.key,
      };
    });

  return { phases, phaseBoundaries };
}

function measureWindowChange(
  previous: ViceTraceWindowSummary,
  current: ViceTraceWindowSummary,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const prevCounts = Math.max(previous.instructionCount, 1);
  const currentCounts = Math.max(current.instructionCount, 1);

  const ioWriteDelta = Math.abs((previous.features.ioWriteCount / prevCounts) - (current.features.ioWriteCount / currentCounts));
  const writeDelta = Math.abs((previous.features.writeCount / prevCounts) - (current.features.writeCount / currentCounts));
  const callDelta = Math.abs((previous.features.callCount / prevCounts) - (current.features.callCount / currentCounts));
  const branchDelta = Math.abs((previous.features.branchCount / prevCounts) - (current.features.branchCount / currentCounts));
  const vectorDelta = Math.abs((previous.features.vectorWriteCount / prevCounts) - (current.features.vectorWriteCount / currentCounts));
  const uniquePcDelta = Math.abs((previous.features.uniquePcCount / prevCounts) - (current.features.uniquePcCount / currentCounts));
  const uniqueAddressDelta = Math.abs((previous.features.uniqueAddressCount / prevCounts) - (current.features.uniqueAddressCount / currentCounts));
  const overlap = dominantOverlap(previous.topPcs, current.topPcs);

  let score = 0;
  score += ioWriteDelta * 4.0;
  score += writeDelta * 2.5;
  score += callDelta * 2.0;
  score += branchDelta * 1.5;
  score += vectorDelta * 3.0;
  score += uniquePcDelta * 1.5;
  score += uniqueAddressDelta * 1.5;
  score += (1 - overlap) * 0.9;

  if (previous.dominantRoutine !== current.dominantRoutine) {
    score += 0.22;
    reasons.push(`dominant routine changed: ${previous.dominantRoutine ?? "?"} -> ${current.dominantRoutine ?? "?"}`);
  }
  if (previous.dominantSegment !== current.dominantSegment) {
    score += 0.18;
    reasons.push(`dominant segment changed: ${previous.dominantSegment ?? "?"} -> ${current.dominantSegment ?? "?"}`);
  }
  if (ioWriteDelta > 0.03) reasons.push(`I/O write delta ${roundScore(ioWriteDelta)}`);
  if (writeDelta > 0.06) reasons.push(`write density delta ${roundScore(writeDelta)}`);
  if (callDelta > 0.04) reasons.push(`call density delta ${roundScore(callDelta)}`);
  if (uniquePcDelta > 0.05) reasons.push(`unique-PC delta ${roundScore(uniquePcDelta)}`);
  if (overlap < 0.35) reasons.push(`top-PC overlap ${roundScore(overlap)}`);

  return { score, reasons };
}

function dominantOverlap(
  left: Array<{ pc: number; count: number }>,
  right: Array<{ pc: number; count: number }>,
): number {
  const leftKeys = new Set(left.slice(0, 5).map((entry) => entry.pc));
  const rightKeys = new Set(right.slice(0, 5).map((entry) => entry.pc));
  if (leftKeys.size === 0 && rightKeys.size === 0) {
    return 1;
  }
  let shared = 0;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftKeys.size, rightKeys.size, 1);
}

function mergeEntityCounts(target: Map<string, number>, entries: ViceTraceWindowEntityCount[]): void {
  for (const entry of entries) {
    target.set(entry.key, (target.get(entry.key) ?? 0) + entry.count);
  }
}

function mergeAddressCounts(target: Map<number, { reads: number; writes: number }>, entries: ViceTraceWindowAddressCount[]): void {
  for (const entry of entries) {
    const current = target.get(entry.address) ?? { reads: 0, writes: 0 };
    current.reads += entry.reads;
    current.writes += entry.writes;
    target.set(entry.address, current);
  }
}

function topEntries(map: Map<string, number>, limit: number): ViceTraceWindowEntityCount[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function createEmptyFeatures(): ViceTraceWindowFeatures {
  return {
    uniquePcCount: 0,
    uniqueRoutineCount: 0,
    uniqueSegmentCount: 0,
    uniqueAddressCount: 0,
    callCount: 0,
    returnCount: 0,
    branchCount: 0,
    jumpCount: 0,
    readCount: 0,
    writeCount: 0,
    ioReadCount: 0,
    ioWriteCount: 0,
    zeroPageAccessCount: 0,
    screenAreaAccessCount: 0,
    colorRamAccessCount: 0,
    vectorWriteCount: 0,
    rtiCount: 0,
  };
}

function applyAddressFeatureFlags(features: ViceTraceWindowFeatures, address: number, access: string): void {
  if (address <= 0x00ff) {
    features.zeroPageAccessCount += 1;
  }
  if (address >= 0x0400 && address <= 0x07ff) {
    features.screenAreaAccessCount += 1;
  }
  if (address >= 0xd800 && address <= 0xdbff) {
    features.colorRamAccessCount += 1;
  }
  if (address >= 0xd000 && address <= 0xdfff) {
    if (access === "read" || access === "readwrite") {
      features.ioReadCount += 1;
    }
    if (access === "write" || access === "readwrite") {
      features.ioWriteCount += 1;
    }
  }
  if ((address >= 0x0314 && address <= 0x0319) || address === 0xfffe || address === 0xffff) {
    if (access === "write" || access === "readwrite") {
      features.vectorWriteCount += 1;
    }
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
