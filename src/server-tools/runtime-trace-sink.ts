// Spec 726.2c — live-session trace sink wiring for the MCP runtime tools.
// Binds the existing TraceRunController (RuntimeController.traceRun, Spec 708) to
// a live session: build a capture-all definition from the requested domains,
// enable the matching passive producers, stream to a project-resolved
// trace.duckdb. ONE production path (§2b); no parallel trace system.
import { resolve, isAbsolute, join } from "node:path";
import type { IntegratedSession } from "../runtime/headless/integrated-session.js";
import type {
  RuntimeTraceDefinition, TraceDomain, TraceTrigger, TraceCapture,
} from "../runtime/headless/trace/trace-definition.js";

export const ALL_DOMAINS: TraceDomain[] = ["c64-cpu", "drive8-cpu", "iec", "vic", "memory"];

/** Default capture domains for the use-case (cpu code/data split + bus). The
 *  caller may override with a narrower/wider set. */
export const DEFAULT_TRACE_DOMAINS: TraceDomain[] = ["c64-cpu", "memory"];

/** Session-construction producer opts implied by the trace domains. A domain's
 *  events only flow if its PRODUCER is enabled, not just the channel sink. */
export function producerOptsForDomains(domains: TraceDomain[]): {
  traceIec?: boolean; traceDrive?: boolean; enableBusAccessTrace?: boolean;
} {
  return {
    traceIec: domains.includes("iec") ? true : undefined,
    traceDrive: domains.includes("drive8-cpu") ? true : undefined,
    enableBusAccessTrace: domains.includes("memory") ? true : undefined,
  };
}

/** Build a "capture everything in these domains" RuntimeTraceDefinition. Broad
 *  triggers (full PC / address / line range) + the matching capture kinds. */
export function captureAllDef(domains: TraceDomain[]): RuntimeTraceDefinition {
  const triggers: TraceTrigger[] = [];
  const captures: TraceCapture[] = [];
  if (domains.includes("c64-cpu")) {
    triggers.push({ kind: "pc-range", domain: "c64-cpu", from: 0, to: 0xffff });
    captures.push({ kind: "cpu-row", domain: "c64-cpu" });
  }
  if (domains.includes("drive8-cpu")) {
    triggers.push({ kind: "pc-range", domain: "drive8-cpu", from: 0, to: 0xffff });
    captures.push({ kind: "cpu-row", domain: "drive8-cpu" });
  }
  if (domains.includes("memory")) {
    triggers.push({ kind: "mem-access", access: "any", from: 0, to: 0xffff });
    captures.push({ kind: "mem-row" });
  }
  if (domains.includes("iec")) {
    triggers.push({ kind: "iec-transition" });
    captures.push({ kind: "iec-row" });
  }
  if (domains.includes("vic")) {
    triggers.push({ kind: "raster-window", fromLine: 0, toLine: 311 });
    captures.push({ kind: "vic-row" });
  }
  // (marks are recorded via TraceRunController.mark(), not a capture trigger.)
  return {
    id: "live-capture", version: 1, name: "live session capture",
    domains, triggers, captures, retention: "evidence", checkpointPolicy: "none",
  };
}

/** Resolve a trace_out path: absolute as-is, else under <projectDir>. */
export function resolveTraceOut(traceOut: string, projectDir: string | undefined): string {
  if (isAbsolute(traceOut)) return traceOut;
  return projectDir ? resolve(projectDir, traceOut) : resolve(traceOut);
}

/** Start a streaming trace on a live session via its RuntimeController.traceRun.
 *  Returns the run id. Caller must have enabled the matching producers at
 *  session construction (producerOptsForDomains). */
export async function startSessionTrace(
  sessionId: string, session: IntegratedSession, traceOut: string, domains: TraceDomain[],
): Promise<{ runId: string; outputPath: string; domains: TraceDomain[] }> {
  const { ensureRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  const def = captureAllDef(domains);
  const run = await ctrl.traceRun.start(def, { controller: ctrl, outputPath: traceOut });
  return { runId: run.runId, outputPath: traceOut, domains };
}

/** True if a streaming trace run is active for the session. */
export async function sessionTraceActive(sessionId: string): Promise<boolean> {
  const { getRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
  return getRuntimeController(sessionId)?.traceRun.isActive() ?? false;
}

/** Flush the trace queue to DuckDB (called between run-chunks; emulator paused). */
export async function drainSessionTrace(sessionId: string): Promise<void> {
  const { getRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
  const ctrl = getRuntimeController(sessionId);
  if (ctrl?.traceRun.isActive()) await ctrl.traceRun.drain();
}

void join;
