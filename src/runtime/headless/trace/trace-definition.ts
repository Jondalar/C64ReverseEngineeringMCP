// Spec 708 — declarative runtime trace definitions (the canonical structured
// object, §2.1). A text field or future UI builder COMPILES to this object;
// the structure is the single authority, DuckDB is only the query/storage
// engine. Definitions express WHAT to observe and WHEN; the compiler
// (trace-compiler.ts) turns them into bounded taps over the EXISTING kernel
// trace channels (no parallel diagnostic path — Spec 708.1).

import type { ChannelName } from "./channels.js";

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

/** Domain → kernel trace channel(s). The reuse map (Spec 708.1). */
export function domainsToChannels(domains: TraceDomain[]): ChannelName[] {
  const set = new Set<ChannelName>();
  for (const d of domains) {
    switch (d) {
      case "c64-cpu": set.add("cpu"); break;
      case "drive8-cpu": set.add("drive_pc"); break;
      case "iec": set.add("iec"); break;
      case "vic": set.add("vic"); break;
      case "sid": set.add("sid"); break;
      case "memory": set.add("io"); set.add("bus_access"); break;
    }
  }
  return [...set];
}

const DOMAINS: TraceDomain[] = ["c64-cpu", "drive8-cpu", "iec", "vic", "sid", "memory"];
const u16 = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffff;

export interface TraceValidationResult { ok: boolean; errors: string[] }

/** Validate a definition. Pure; returns all problems (no throw). */
export function validateTraceDefinition(def: Partial<RuntimeTraceDefinition> | null | undefined): TraceValidationResult {
  const e: string[] = [];
  if (!def || typeof def !== "object") return { ok: false, errors: ["definition is not an object"] };
  if (!def.id || typeof def.id !== "string") e.push("id: required non-empty string");
  if (typeof def.version !== "number" || !Number.isInteger(def.version) || def.version < 1) e.push("version: integer >= 1");
  if (!def.name || typeof def.name !== "string") e.push("name: required non-empty string");

  if (!Array.isArray(def.domains) || def.domains.length === 0) e.push("domains: at least one");
  else for (const d of def.domains) if (!DOMAINS.includes(d)) e.push(`domains: unknown "${d}"`);

  if (!Array.isArray(def.triggers) || def.triggers.length === 0) e.push("triggers: at least one");
  else def.triggers.forEach((t, i) => e.push(...validateTrigger(t, i)));

  if (!Array.isArray(def.captures) || def.captures.length === 0) e.push("captures: at least one");
  else def.captures.forEach((c, i) => e.push(...validateCapture(c, i)));

  if (def.retention !== "transient" && def.retention !== "evidence") e.push('retention: "transient" | "evidence"');
  if (def.checkpointPolicy != null) {
    // Spec 708.7 — runtime implements none/at-start/at-stop. "on-trigger" needs a
    // synchronous hot-path checkpoint (705.B ring integration), not yet wired —
    // reject precisely instead of silently degrading to at-start (§10.2.2).
    if (def.checkpointPolicy === "on-trigger") {
      e.push('checkpointPolicy: "on-trigger" not yet supported — use "at-start" or "at-stop"');
    } else if (!["none", "at-start", "at-stop"].includes(def.checkpointPolicy)) {
      e.push('checkpointPolicy: none | at-start | at-stop');
    }
  }

  // Spec 708.7 — a definition must not silently capture nothing. Every declared
  // capture must be producible by a declared domain, and every trigger's channel
  // must be covered by a domain (else domainsToChannels never enables it).
  if (Array.isArray(def.domains) && Array.isArray(def.captures)) {
    const doms = new Set(def.domains);
    for (let i = 0; i < def.captures.length; i++) {
      const need = captureRequiresDomain(def.captures[i]!);
      if (need && !doms.has(need)) e.push(`captures[${i}]: "${def.captures[i]!.kind}" requires domain "${need}" in domains`);
    }
  }
  if (Array.isArray(def.domains) && Array.isArray(def.triggers)) {
    const doms = new Set(def.domains);
    for (let i = 0; i < def.triggers.length; i++) {
      const need = triggerRequiresDomain(def.triggers[i]!);
      if (need && !doms.has(need)) e.push(`triggers[${i}]: "${def.triggers[i]!.kind}" requires domain "${need}" in domains`);
    }
  }
  if (def.stop != null) {
    if (!["cycle-budget", "event-count", "manual"].includes(def.stop.kind)) e.push("stop.kind invalid");
    if ((def.stop.kind === "cycle-budget" || def.stop.kind === "event-count") &&
        (typeof def.stop.value !== "number" || def.stop.value <= 0)) e.push(`stop.value: positive number for ${def.stop.kind}`);
  }
  return { ok: e.length === 0, errors: e };
}

function validateTrigger(t: TraceTrigger, i: number): string[] {
  const p = `triggers[${i}]`;
  switch (t?.kind) {
    case "pc-range":
      return [
        ...(t.domain === "c64-cpu" || t.domain === "drive8-cpu" ? [] : [`${p}.domain: c64-cpu | drive8-cpu`]),
        ...(u16(t.from) && u16(t.to) && t.from <= t.to ? [] : [`${p}: from/to must be 0..$FFFF with from<=to`]),
      ];
    case "mem-access":
      return [
        ...(["read", "write", "any"].includes(t.access) ? [] : [`${p}.access: read | write | any`]),
        ...(u16(t.from) && u16(t.to) && t.from <= t.to ? [] : [`${p}: from/to must be 0..$FFFF with from<=to`]),
      ];
    case "iec-transition":
      return t.line == null || ["atn", "clk", "data"].includes(t.line) ? [] : [`${p}.line: atn | clk | data`];
    case "raster-window":
      return Number.isInteger(t.fromLine) && Number.isInteger(t.toLine) && t.fromLine <= t.toLine
        ? [] : [`${p}: fromLine<=toLine integers`];
    // Spec 708.7 — these have no runtime event semantics yet; reject precisely
    // rather than accept-and-silently-no-op (§10.2.3).
    case "monitor-stop":
      return [`${p}: "monitor-stop" trigger not supported — no runtime event semantics; use pc-range / mem-access / raster-window`];
    case "manual-mark":
      return [`${p}: "manual-mark" trigger not supported — record marks via trace/run/mark, not as a capture trigger`];
    default:
      return [`${p}: unknown trigger kind "${(t as { kind?: string })?.kind}"`];
  }
}

function validateCapture(c: TraceCapture, i: number): string[] {
  const p = `captures[${i}]`;
  switch (c?.kind) {
    case "cpu-row":
      return c.domain === "c64-cpu" || c.domain === "drive8-cpu" ? [] : [`${p}.domain: c64-cpu | drive8-cpu`];
    case "mem-row": case "iec-row": case "vic-row": case "checkpoint-ref":
      return [];
    default:
      return [`${p}: unknown capture kind "${(c as { kind?: string })?.kind}"`];
  }
}

/** The domain a capture row needs in order to be produced (Spec 708.7 coverage).
 *  null = no domain required (checkpoint-ref). */
function captureRequiresDomain(c: TraceCapture): TraceDomain | null {
  switch (c?.kind) {
    case "cpu-row": return c.domain === "drive8-cpu" ? "drive8-cpu" : "c64-cpu";
    case "mem-row": return "memory";
    case "iec-row": return "iec";
    case "vic-row": return "vic";
    case "checkpoint-ref": return null;
    default: return null;
  }
}

/** The domain a trigger needs so its channel is enabled (Spec 708.7 coverage). */
function triggerRequiresDomain(t: TraceTrigger): TraceDomain | null {
  switch (t?.kind) {
    case "pc-range": return t.domain === "drive8-cpu" ? "drive8-cpu" : "c64-cpu";
    case "mem-access": return "memory";
    case "iec-transition": return "iec";
    case "raster-window": return "vic";
    default: return null;
  }
}

/** Stable kebab-case id from a name (used when a definition omits an explicit id). */
export function slugTraceId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || `trace-${Date.now().toString(36)}`;
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
