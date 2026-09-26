// Spec 708 — the shape of a runtime trace definition (§2.1) and of the run it produced
// (§2.2). Types only: the runtime daemon validates a definition, compiles it into taps
// and captures the run; C64RE hands it the object and reads back the record. The
// TypeScript channel map, validator and id-slugger that used to live here served the
// in-process runtime, which is gone (Spec 806), and nothing called them after that.

export type TraceDomain = "c64-cpu" | "drive8-cpu" | "iec" | "vic" | "sid" | "memory";

// ---- triggers (§3 first-pass set) ----
export type TraceTrigger =
  | { kind: "pc-range"; domain: "c64-cpu" | "drive8-cpu"; from: number; to: number }
  | { kind: "mem-access"; access: "read" | "write" | "any"; from: number; to: number }
  | { kind: "iec-transition"; line?: "atn" | "clk" | "data" }
  | { kind: "raster-window"; fromLine: number; toLine: number }
  | { kind: "monitor-stop" }     // breakpoint / monitor halt
  | { kind: "manual-mark" };      // record only on an explicit tracedb mark

export type TraceTriggerKind = TraceTrigger["kind"];

// ---- captures (§3 first-pass set) ----
export type TraceCapture =
  | { kind: "cpu-row"; domain: "c64-cpu" | "drive8-cpu" }
  | { kind: "mem-row" }
  | { kind: "iec-row" }
  | { kind: "vic-row" }
  | { kind: "checkpoint-ref" };

export type TraceCaptureKind = TraceCapture["kind"];

export interface TraceStopCondition {
  kind: "cycle-budget" | "event-count" | "manual";
  value?: number;
}

/** The canonical, versioned trace definition (Spec 708 §2.1). */
export interface RuntimeTraceDefinition {
  id: string;
  version: number;
  name: string;
  domains: TraceDomain[];
  triggers: TraceTrigger[];
  captures: TraceCapture[];
  stop?: TraceStopCondition;
  retention: "transient" | "evidence";
  checkpointPolicy?: "none" | "at-start" | "on-trigger" | "at-stop";
}

// ---- trace run record (Spec 708 §2.2) — bound to a checkpointed experiment ----
export interface RuntimeTraceRun {
  runId: string;
  definitionId: string;
  definitionVersion: number;
  startCheckpointId?: string;       // 705.B / 707 checkpoint ref (checkpointPolicy at-start)
  stopCheckpointId?: string;        // checkpoint captured at stop() (checkpointPolicy at-stop)
  media?: { sha256?: string; sourceName?: string };
  branchId?: string;                // intervention branch (Spec 711, later)
  cycleStart: number;
  cycleEnd?: number;
  marks: { cycle: number; label: string }[];
  evidenceRef: string;              // DuckDB key for this run's rows
  // explicit hot-path cost (Spec 708 §2.3)
  eventCount: number;
  bytesWritten: number;
  overheadMs?: number;
  aborted?: boolean;                // BUG-030 — stopped on a poisoned writer (e.g. backpressure ceiling); partial .c64retrace prefix on disk
}
