// Spec 726.2c — trace-definition + path helpers for the MCP runtime tools.
//
// Spec 806 step 3: the three functions that DROVE a trace (startSessionTrace /
// sessionTraceActive / drainSessionTrace) bound an in-process RuntimeController
// and went with the TS emulator. Starting, draining and finalizing a live trace
// is the runtime daemon's job (runtime_trace_start / _finalize / _status).
// What stays is backend-neutral: the domain→definition builder, the producer
// options implied by a domain set, and the trace_out path resolver.
import { resolve, isAbsolute } from "node:path";
import type {
  RuntimeTraceDefinition, TraceDomain, TraceTrigger, TraceCapture,
} from "../trace/trace-definition.js";

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
