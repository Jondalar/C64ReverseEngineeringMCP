// Spec 708 (corrective slice) — reusable trace-definition builders.
//
// These replace the one-off /tmp diagnostic scripts the team kept re-writing
// (PC histograms, $DD00 call-site watches, IEC line traces) with canonical,
// versioned RuntimeTraceDefinitions that run over the EXISTING kernel channels
// and land in DuckDB (708.1). Each builder only uses fields confirmed working
// after 708.7-708.9: pc-range / mem-access(.access) / iec-transition(.line)
// triggers, cpu/mem/iec-row captures, at-start/at-stop checkpoints.
//
// NOTE — what is deliberately NOT here:
//   * full-RAM page-liveness ("access map"): needs EVERY RAM read/write, which
//     the bus_access/io channels do not carry (§7 non-goal — no firehose). That
//     analysis stays in the standalone `runtime_memory_access_map` tool, which
//     taps `HeadlessMemoryBus.setAccessObserver` directly.
//   * periodic screen-RAM snapshot ("screen-sig timeline"): not event-driven;
//     no trigger kind models a fixed-interval sampler. It stays a render sampler.

import type { RuntimeTraceDefinition } from "./trace-definition.js";
import { slugTraceId } from "./trace-definition.js";

/** "Where does the CPU spend time / pass through?" — PC-range execution profile.
 *  Query the resulting trace_event rows GROUP BY pc for a histogram (see
 *  `pcHistogramSql`). Replaces the ad-hoc PC-sampling scripts. */
export function pcRegionProfile(opts: {
  from: number; to: number;
  domain?: "c64-cpu" | "drive8-cpu";
  id?: string; name?: string;
  cycleBudget?: number;
  checkpointPolicy?: "none" | "at-start" | "at-stop";
}): RuntimeTraceDefinition {
  const domain = opts.domain ?? "c64-cpu";
  const name = opts.name ?? `PC profile ${domain} $${hex(opts.from)}-$${hex(opts.to)}`;
  return {
    id: opts.id ?? slugTraceId(name),
    version: 1,
    name,
    domains: [domain],
    triggers: [{ kind: "pc-range", domain, from: opts.from, to: opts.to }],
    captures: [{ kind: "cpu-row", domain }],
    stop: opts.cycleBudget ? { kind: "cycle-budget", value: opts.cycleBudget } : undefined,
    retention: "evidence",
    checkpointPolicy: opts.checkpointPolicy ?? "at-start",
  };
}

/** "Who touches this I/O register / range, and how?" — bus-access watch over the
 *  bus_access channel (the $DD00 / $1800 / VIA tap, Spec 142). `access` filters
 *  read vs write (708.7). Replaces ad-hoc $DD00 call-site dumps. */
export function ioAccessWatch(opts: {
  from: number; to: number;
  access?: "read" | "write" | "any";
  id?: string; name?: string;
  cycleBudget?: number;
}): RuntimeTraceDefinition {
  const access = opts.access ?? "any";
  const name = opts.name ?? `IO ${access} $${hex(opts.from)}-$${hex(opts.to)}`;
  return {
    id: opts.id ?? slugTraceId(name),
    version: 1,
    name,
    domains: ["memory"],
    triggers: [{ kind: "mem-access", access, from: opts.from, to: opts.to }],
    captures: [{ kind: "mem-row" }],
    stop: opts.cycleBudget ? { kind: "cycle-budget", value: opts.cycleBudget } : undefined,
    retention: "evidence",
  };
}

/** "When does this IEC line move?" — IEC transition trace, optionally one line. */
export function iecLineTrace(opts?: {
  line?: "atn" | "clk" | "data";
  id?: string; name?: string;
  cycleBudget?: number;
}): RuntimeTraceDefinition {
  const line = opts?.line;
  const name = opts?.name ?? `IEC ${line ?? "all"} transitions`;
  return {
    id: opts?.id ?? slugTraceId(name),
    version: 1,
    name,
    domains: ["iec"],
    triggers: [{ kind: "iec-transition", ...(line ? { line } : {}) }],
    captures: [{ kind: "iec-row" }],
    stop: opts?.cycleBudget ? { kind: "cycle-budget", value: opts.cycleBudget } : undefined,
    retention: "evidence",
  };
}

/** SQL for a PC histogram over a pcRegionProfile run's DuckDB evidence.
 *  `pc` is read out of the captured cpu-row JSON. */
export function pcHistogramSql(runId: string, limit = 32): string {
  return (
    `SELECT CAST(json_extract(data_json, '$.pc') AS INTEGER) AS pc, count(*) AS hits ` +
    `FROM trace_event WHERE run_id = '${runId.replace(/'/g, "''")}' AND channel = 'cpu' ` +
    `GROUP BY pc ORDER BY hits DESC LIMIT ${Math.trunc(limit)}`
  );
}

function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
