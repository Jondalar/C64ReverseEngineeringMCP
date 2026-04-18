import { readFile, writeFile } from "node:fs/promises";
import type { ViceSessionRecord } from "./types.js";
import { computeTraceSuccessorPcs, decodeTraceInstruction } from "./trace-instruction.js";
import { loadSemanticResolver, type AnnotationFile, type AnnotationLabel, type AnnotationRoutine, type ViceTraceSemanticLink } from "./trace-semantic.js";
import { readRuntimeTrace, type ViceTraceInstructionEvent } from "./trace-runtime.js";

export interface ViceTraceContextCallEdge {
  fromPc: number;
  toPc: number;
  count: number;
}

export interface ViceTraceContextWriteStat {
  address: number;
  writes: number;
  reads: number;
}

export interface ViceTraceContextSummary {
  id: string;
  kind: "irq" | "nmi" | "interrupt";
  confidence: number;
  classification: string;
  entryClock: string;
  exitClock: string;
  entryPc?: number;
  exitPc?: number;
  startSampleIndex: number;
  endSampleIndex: number;
  instructionCount: number;
  rtiCount: number;
  entrySemantic?: ViceTraceSemanticLink;
  dominantRoutine?: string;
  topPcs: Array<{ pc: number; count: number }>;
  topWrites: ViceTraceContextWriteStat[];
  callEdges: ViceTraceContextCallEdge[];
}

export interface ViceTraceContextIndex {
  version: 1;
  generatedAt: string;
  sessionId: string;
  runtimeTracePath: string;
  annotationsPath?: string;
  contexts: ViceTraceContextSummary[];
}

export interface ViceTraceContextSlice {
  context: ViceTraceContextSummary;
  events: ViceTraceInstructionEvent[];
}

class ContextAccumulator {
  readonly id: string;
  readonly classification: string;
  readonly entryClock: string;
  readonly entryPc?: number;
  readonly startSampleIndex: number;
  readonly entrySemantic?: ViceTraceSemanticLink;
  confidence: number;
  kind: "irq" | "nmi" | "interrupt";
  instructionCount = 0;
  rtiCount = 0;
  exitClock = "";
  exitPc?: number;
  endSampleIndex: number;
  private pcCounts = new Map<number, number>();
  private writeStats = new Map<number, ViceTraceContextWriteStat>();
  private routineCounts = new Map<string, number>();
  private callEdgeCounts = new Map<string, ViceTraceContextCallEdge>();

  constructor(
    id: string,
    kind: "irq" | "nmi" | "interrupt",
    confidence: number,
    classification: string,
    event: ViceTraceInstructionEvent,
    entrySemantic?: ViceTraceSemanticLink,
  ) {
    this.id = id;
    this.kind = kind;
    this.confidence = confidence;
    this.classification = classification;
    this.entryClock = event.clock;
    this.entryPc = event.pc;
    this.startSampleIndex = event.sampleIndex;
    this.endSampleIndex = event.sampleIndex;
    this.entrySemantic = entrySemantic;
  }

  addEvent(event: ViceTraceInstructionEvent, semantic?: ViceTraceSemanticLink): void {
    this.instructionCount += 1;
    this.exitClock = event.clock;
    this.exitPc = event.pc;
    this.endSampleIndex = event.sampleIndex;

    if (event.pc !== undefined) {
      this.pcCounts.set(event.pc, (this.pcCounts.get(event.pc) ?? 0) + 1);
    }

    const routineKey = semantic?.routineName ?? "unknown_routine";
    this.routineCounts.set(routineKey, (this.routineCounts.get(routineKey) ?? 0) + 1);

    const decoded = decodeTraceInstruction(event.instructionBytes);
    if (decoded.mnemonic === "RTI") {
      this.rtiCount += 1;
    }
    if (decoded.directAddress !== undefined) {
      const stat = this.writeStats.get(decoded.directAddress) ?? {
        address: decoded.directAddress,
        writes: 0,
        reads: 0,
      };
      if (decoded.access === "write") {
        stat.writes += 1;
      } else if (decoded.access === "read") {
        stat.reads += 1;
      } else if (decoded.access === "readwrite") {
        stat.reads += 1;
        stat.writes += 1;
      }
      this.writeStats.set(decoded.directAddress, stat);
      if (decoded.directAddress >= 0xd000 && decoded.directAddress <= 0xdfff && stat.writes > 0) {
        this.confidence = Math.min(0.99, this.confidence + 0.01);
      }
    }
    if (decoded.isCall && event.pc !== undefined && decoded.operand !== undefined) {
      const key = `${event.pc.toString(16)}:${decoded.operand.toString(16)}`;
      const edge = this.callEdgeCounts.get(key) ?? {
        fromPc: event.pc,
        toPc: decoded.operand,
        count: 0,
      };
      edge.count += 1;
      this.callEdgeCounts.set(key, edge);
    }
  }

  finalize(): ViceTraceContextSummary {
    const topPcs = [...this.pcCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 12)
      .map(([pc, count]) => ({ pc, count }));
    const topWrites = [...this.writeStats.values()]
      .sort((left, right) => (right.reads + right.writes) - (left.reads + left.writes) || left.address - right.address)
      .slice(0, 16);
    const callEdges = [...this.callEdgeCounts.values()]
      .sort((left, right) => right.count - left.count || left.fromPc - right.fromPc || left.toPc - right.toPc)
      .slice(0, 16);
    const topRoutine = [...this.routineCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];

    return {
      id: this.id,
      kind: this.kind,
      confidence: Math.round(this.confidence * 1000) / 1000,
      classification: this.classification,
      entryClock: this.entryClock,
      exitClock: this.exitClock || this.entryClock,
      entryPc: this.entryPc,
      exitPc: this.exitPc,
      startSampleIndex: this.startSampleIndex,
      endSampleIndex: this.endSampleIndex,
      instructionCount: this.instructionCount,
      rtiCount: this.rtiCount,
      entrySemantic: this.entrySemantic,
      dominantRoutine: topRoutine?.[0],
      topPcs,
      topWrites,
      callEdges,
    };
  }
}

export async function buildTraceContextIndex(
  record: ViceSessionRecord,
  options: { annotationsPath?: string } = {},
): Promise<ViceTraceContextIndex> {
  const semanticResolver = await loadSemanticResolver(options.annotationsPath);
  const interruptEntries = buildInterruptEntryMap(semanticResolver?.annotations);
  const contexts: ViceTraceContextSummary[] = [];
  let activeContext: ContextAccumulator | undefined;
  let previousEvent: ViceTraceInstructionEvent | undefined;
  let nextId = 1;

  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }
    const semantic = event.pc === undefined ? undefined : semanticResolver?.resolve(event.pc);

    if (!activeContext) {
      const entry = detectInterruptEntry(previousEvent, event, semantic, interruptEntries);
      if (entry) {
        activeContext = new ContextAccumulator(
          `ctx-${String(nextId).padStart(4, "0")}`,
          entry.kind,
          entry.confidence,
          entry.classification,
          event,
          semantic,
        );
        nextId += 1;
      }
    }

    if (activeContext) {
      activeContext.addEvent(event, semantic);
      if (activeContext.instructionCount > 4096 && activeContext.rtiCount === 0) {
        activeContext = undefined;
      } else if (decodeTraceInstruction(event.instructionBytes).mnemonic === "RTI") {
        contexts.push(activeContext.finalize());
        activeContext = undefined;
      }
    }

    previousEvent = event;
  }

  const index: ViceTraceContextIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionId: record.sessionId,
    runtimeTracePath: record.workspace.runtimeTracePath,
    annotationsPath: options.annotationsPath,
    contexts,
  };

  await writeFile(record.workspace.traceContextIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function loadTraceContextIndex(record: ViceSessionRecord): Promise<ViceTraceContextIndex | undefined> {
  try {
    const text = await readFile(record.workspace.traceContextIndexPath, "utf8");
    return JSON.parse(text) as ViceTraceContextIndex;
  } catch {
    return undefined;
  }
}

export async function sliceTraceContext(
  record: ViceSessionRecord,
  context: ViceTraceContextSummary,
  before = 0,
  after = 0,
): Promise<ViceTraceContextSlice> {
  const events: ViceTraceInstructionEvent[] = [];
  const beforeBuffer: ViceTraceInstructionEvent[] = [];
  let started = false;
  let afterRemaining = after;

  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }
    if (!started) {
      if (event.clock === context.entryClock) {
        started = true;
        events.push(...beforeBuffer, event);
        if (event.clock === context.exitClock) {
          continue;
        }
      } else if (before > 0) {
        beforeBuffer.push(event);
        if (beforeBuffer.length > before) {
          beforeBuffer.shift();
        }
      }
      continue;
    }

    events.push(event);
    if (event.clock === context.exitClock) {
      if (afterRemaining <= 0) {
        break;
      }
      continue;
    }
    if (afterRemaining > 0 && BigInt(event.clock) > BigInt(context.exitClock)) {
      afterRemaining -= 1;
      if (afterRemaining <= 0) {
        break;
      }
    }
  }

  return { context, events };
}

function detectInterruptEntry(
  previous: ViceTraceInstructionEvent | undefined,
  current: ViceTraceInstructionEvent,
  semantic: ViceTraceSemanticLink | undefined,
  interruptEntries: Map<number, { kind: "irq" | "nmi" | "interrupt"; classification: string; confidence: number }>,
): { kind: "irq" | "nmi" | "interrupt"; classification: string; confidence: number } | undefined {
  if (current.pc === undefined) {
    return undefined;
  }

  const knownEntry = interruptEntries.get(current.pc);
  if (knownEntry) {
    return knownEntry;
  }

  const semanticName = `${semantic?.label ?? ""} ${semantic?.routineName ?? ""}`.toLowerCase();
  if (semanticName.includes("irq") || semanticName.includes("interrupt") || semanticName.includes("raster")) {
    return {
      kind: semanticName.includes("nmi") ? "nmi" : "irq",
      classification: semanticName.includes("raster") ? "semantic_raster_handler" : "semantic_interrupt_handler",
      confidence: 0.9,
    };
  }

  if (!previous || previous.pc === undefined) {
    return undefined;
  }

  const expectedSuccessors = computeTraceSuccessorPcs(previous.pc, previous.instructionBytes);
  if (expectedSuccessors.includes(current.pc)) {
    return undefined;
  }

  const previousDecoded = decodeTraceInstruction(previous.instructionBytes);
  if (previousDecoded.mnemonic === "JMP" && previousDecoded.mode === "ind") {
    return undefined;
  }

  return {
    kind: "interrupt",
    classification: "unexpected_control_transfer_rti_candidate",
    confidence: 0.55,
  };
}

function buildInterruptEntryMap(
  annotations: AnnotationFile | undefined,
): Map<number, { kind: "irq" | "nmi" | "interrupt"; classification: string; confidence: number }> {
  const result = new Map<number, { kind: "irq" | "nmi" | "interrupt"; classification: string; confidence: number }>();
  if (!annotations) {
    return result;
  }

  for (const routine of annotations.routines ?? []) {
    maybeAddInterruptEntry(result, routine.address, `${routine.name} ${routine.comment ?? ""}`);
  }
  for (const label of annotations.labels ?? []) {
    maybeAddInterruptEntry(result, label.address, `${label.label} ${label.comment ?? ""}`);
  }
  return result;
}

function maybeAddInterruptEntry(
  result: Map<number, { kind: "irq" | "nmi" | "interrupt"; classification: string; confidence: number }>,
  address: string,
  text: string,
): void {
  const lowered = text.toLowerCase();
  if (!/(irq|nmi|interrupt|raster)/.test(lowered)) {
    return;
  }
  const kind = lowered.includes("nmi") ? "nmi" : (lowered.includes("irq") || lowered.includes("raster") ? "irq" : "interrupt");
  const classification = lowered.includes("raster")
    ? "annotated_raster_handler"
    : kind === "nmi"
      ? "annotated_nmi_handler"
      : "annotated_irq_handler";
  const parsed = parseInt(address.replace(/^\$/, ""), 16);
  result.set(parsed, {
    kind,
    classification,
    confidence: 0.98,
  });
}
