// Spec 217 Phase 1 — MCP tools for trace-store DuckDB queries.
//
// Read-only access to a trace-store path. Tools share a single
// resolver: paths must point to a `.duckdb` file or a directory that
// contains `trace.duckdb`.

import { basename, resolve as resolvePath, isAbsolute } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";
import { traceStoreFn } from "./trace-read.js";
import { buildMemoryMapText } from "./trace-memory-map.js";
import { traceDirForProject, traceRoot, tracePointerPath, type TracePointer } from "../trace/trace-location.js";

// Spec 802 — ONE read path, no exception. The store is read INSIDE the runtime
// (it owns the format and the index; clients ask, they never open it themselves).
// The old `localFn` branch — this process opening the same DuckDB with C64RE's own
// `queries.ts` — is gone: it was a second implementation of the same read, and the
// only reason the runtime could ship without being able to read what it wrote.
// The runtime also runs a bounded index-ensure before every `store_fn`, so a store
// whose index never built is recovered there (no caller-side ensureIndex needed).
//
// The wire shapes below are the `store_fn` contract (TRX64 `trx64-traceindex`
// `queries.rs`), mirroring the TS reader's return types 1:1. Numeric columns may
// arrive as JS numbers or as numeric strings (i64 crossing JSON), so every consumer
// below stays tolerant — `String(v)` for display, `Number(v)` where arithmetic is done.

type StoreInfo = {
  meta: Record<string, string>;
  tableCounts: Record<string, number | string>;
  masterClockRange?: { min: number | string; max: number | string } | null;
};
type AnchorRow = { name: string; cpu: string; pc: number; occurrences: number | string; firstClock: number | string; lastClock: number | string };
type AnchorOccurrenceRow = { occurrence: number | string; pc: number; clock: number | string; seq: number | string };
type TopPcRow = { pc: number; count: number | string };
type BusEventRow = { seq: number | string; cpu: string; kind: string; clock: number | string; pc: number | null; value: number | null };
type QueryRow = unknown[];

// Path resolution STAYS caller-side: the runtime is project-agnostic, so a
// project-relative path must be made absolute here or it would resolve against the
// runtime's cwd (wrong project).
//
// Bug-fix (post-Spec 726): `input` is a PATH to a trace.duckdb (or a directory
// holding one), NOT a project hint. The previous implementation passed `input`
// as `hintPath` to `context.projectDir()`, which used it only to pick a project
// root and then discarded it — every non-root path failed with "directory has
// no trace.duckdb". Resolve the input itself: absolute as-is, relative under
// the project dir.
//
// Spec 834 D1/D2 — the hint, and the end of the cwd fallback. This resolver used
// to ask `context.projectDir(undefined, false)` (nothing to walk up from) and
// then fall back to `resolvePath(process.cwd(), input)`. Both are gone:
//   D1  each of the seven readers passes `project_dir ?? path`, the same shape
//       as `disk-g64.ts` and the Spec 833 sandbox tools.
//   D2  a relative path resolves against the project the caller named — and
//       Spec 827 moved a capture OUT of the project, so "against the project"
//       means three real places, tried in order and each PROBED for a store that
//       actually exists: `<project>/<input>` (a store deliberately kept inside
//       the project), `<trace dir>/<input>` (where a capture lands now), and
//       `<project>/runtime/traces.json`, the 827 pointer file recording where
//       each capture really went — the only candidate that finds a store
//       captured under a `C64RE_TRACE_DIR` that is no longer set.
// An ABSOLUTE path never asks for a project at all: that is the flow that runs
// in practice (`defaultTraceOut` composes an absolute path and `headless.ts`
// hands it back as `absOut`), and a capture under the per-user data root has no
// project marker above it to walk up to anyway.

/** The `.c64retrace` binary log beside an index — the Spec 726.B authority. */
function retraceFor(abs: string): string {
  return abs.endsWith(".duckdb") ? abs.slice(0, -".duckdb".length) + ".c64retrace" : abs + ".c64retrace";
}

/**
 * Does this absolute path name a REAL store? Returns the path a reader should
 * open, or undefined. Three shapes, all load-bearing:
 *  - a file: the store itself (or a `.c64retrace` handed to the sidecar writer);
 *  - a directory holding `trace.duckdb`;
 *  - a MISSING `.duckdb` whose `.c64retrace` exists — Spec 746.x recovery: the
 *    reader path (`ensureIndex`, runtime-side since Spec 802) rebuilds the index
 *    from the log lazily, so the path passes through instead of being blocked
 *    here (recovers an orphaned store, e.g. a multi-GB trace whose index never
 *    built).
 */
function probeStore(abs: string): string | undefined {
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) return abs;
    const inside = resolvePath(abs, "trace.duckdb");
    return existsSync(inside) ? inside : undefined;
  }
  return existsSync(retraceFor(abs)) ? abs : undefined;
}

/** Spec 827's pointer file, parsed. Never throws: a missing or corrupt pointer is
 *  one candidate fewer, not a failed read. */
function pointerEntries(projectDir: string): TracePointer[] {
  try {
    const parsed = JSON.parse(readFileSync(tracePointerPath(projectDir), "utf8")) as { traces?: TracePointer[] };
    return Array.isArray(parsed.traces) ? parsed.traces : [];
  } catch {
    return [];
  }
}

/** The path this pointer entry offers for `input`, or undefined. Matched on the
 *  file name or a trailing path segment — a caller types the name of a capture,
 *  not the per-user data root it landed in — and last on the run id, which is
 *  what `runtime_trace_finalize` prints. */
function pointerMatch(entry: TracePointer, input: string): string | undefined {
  const wanted = input.replace(/\\/gu, "/").replace(/^\.\//u, "");
  for (const recorded of [entry.duckdbPath, entry.retracePath]) {
    if (!recorded) continue;
    const norm = recorded.replace(/\\/gu, "/");
    if (basename(norm) === basename(wanted) || norm.endsWith(`/${wanted}`)) return entry.duckdbPath ?? recorded;
  }
  if (entry.runId && entry.runId === wanted) return entry.duckdbPath;
  return undefined;
}

function resolveRelativeStore(input: string, context: ServerToolContext, projectHint?: string): string {
  let proj: string;
  try {
    proj = context.projectDir(projectHint ?? input, false);
  } catch (error) {
    throw new Error([
      `trace store path "${input}" is relative and no project could be resolved, so there is nothing to resolve it against.`,
      `Pass project_dir, or an absolute store path.`,
      `Spec 827 keeps a capture OUTSIDE the project: captures live under the per-user trace dir `
        + `(${traceRoot()}/<project key>) and <project>/runtime/traces.json records where each one went.`,
      error instanceof Error ? error.message : String(error),
    ].join("\n"));
  }

  const tried: string[] = [];
  for (const candidate of [resolvePath(proj, input), resolvePath(traceDirForProject(proj), input)]) {
    tried.push(candidate);
    const hit = probeStore(candidate);
    if (hit) return hit;
  }

  // The 827 pointer file, newest capture first.
  const entries = pointerEntries(proj);
  for (const entry of [...entries].reverse()) {
    const recorded = pointerMatch(entry, input);
    if (!recorded) continue;
    const candidate = resolvePath(recorded);
    tried.push(`${candidate}  (from runtime/traces.json)`);
    const hit = probeStore(candidate);
    if (hit) return hit;
  }

  const known = entries.map((e) => e.duckdbPath).filter((p): p is string => !!p);
  throw new Error([
    `trace store not found for "${input}" in project ${proj}.`,
    `Tried:`,
    ...tried.map((t) => `  ${t}`),
    `Spec 827 keeps a capture OUTSIDE the project: captures live under ${traceDirForProject(proj)} `
      + `and ${tracePointerPath(proj)} records where each one went.`,
    known.length
      ? `That pointer file lists ${known.length} capture(s): ${known.slice(-5).join(", ")}`
      : `That pointer file lists no capture yet — nothing has been finalized into this project.`,
  ].join("\n"));
}

/**
 * Resolve a store argument to the path a reader should open.
 *
 * @param projectHint Spec 834 D1 — `project_dir ?? <the tool's own store path>`.
 *                    Consulted only when `input` is relative.
 */
export function resolveStorePath(input: string, context: ServerToolContext, projectHint?: string): string {
  if (!isAbsolute(input)) return resolveRelativeStore(input, context, projectHint);
  // The flow that actually runs: absolute in, absolute out, no project consulted.
  const abs = resolvePath(input);
  const hit = probeStore(abs);
  if (hit) return hit;
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new Error(`directory has no trace.duckdb: ${abs}`);
  }
  throw new Error(`trace store path not found: ${abs}`);
}

// BUG-035's caller-side `ensureTraceIndex` (a wrapper over C64RE's TS
// background-indexer) is REMOVED with Spec 802: indexing now lives next to the
// writer, in the runtime, and `store_fn` runs the same bounded ensure before every
// dispatch. An orphaned binary log is still recovered on first read — one
// implementation instead of two, and an index failure surfaces at capture time.

function fmtHex(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

export function registerTraceStoreTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "trace_store_info",
    "Report the DuckDB trace-store status — runs, event counts, schema. Use to see what trace evidence exists. Not for querying events (use trace_store_query). Inputs: optional run id. Returns: store summary.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
    },
    safeHandler("trace_store_info", async ({ project_dir, path }) => {
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const info = await traceStoreFn<StoreInfo>("getInfo", dbPath);
      const lines = [`trace_store_info: ${dbPath}`, ``, `meta:`];
      for (const [k, v] of Object.entries(info.meta)) lines.push(`  ${k} = ${v}`);
      lines.push(``, `tables:`);
      for (const [t, n] of Object.entries(info.tableCounts)) lines.push(`  ${t} = ${n}`);
      if (info.masterClockRange) {
        lines.push(``, `master_clock range: ${info.masterClockRange.min} .. ${info.masterClockRange.max}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_anchor_list",
    "List named trace anchors (saved cycle/PC markers) for a run. Use to see bookmarked points in a trace. Not for finding the nearest one (use trace_store_anchor_find). Inputs: run id. Returns: anchors.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
    },
    safeHandler("trace_store_anchor_list", async ({ project_dir, path }) => {
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const rows = await traceStoreFn<AnchorRow[]>("listAnchors", dbPath);
      const lines = [`anchors (${rows.length}):`, ``];
      lines.push(`name\tcpu\tpc\toccurrences\tfirst_clock\tlast_clock`);
      for (const r of rows) {
        lines.push(`${r.name}\t${r.cpu}\t${fmtHex(r.pc)}\t${r.occurrences}\t${r.firstClock}\t${r.lastClock}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_anchor_find",
    "Find the trace anchor nearest a cycle/PC. Use to jump to a bookmarked point. Not for listing all (use trace_store_anchor_list). Inputs: run id, cycle/PC. Returns: nearest anchor.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
      name: z.string().describe("Anchor name (alphanumeric/underscore/dash only)."),
      limit: z.number().int().positive().max(10000).optional().describe("Max occurrences to return (default 200)."),
    },
    safeHandler("trace_store_anchor_find", async ({ project_dir, path, name, limit }) => {
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const rows = await traceStoreFn<AnchorOccurrenceRow[]>("findAnchor", dbPath, { name, limit: limit ?? 200 });
      const lines = [`occurrences of '${name}' (${rows.length}):`, ``];
      lines.push(`occ\tpc\tclock\tseq`);
      for (const r of rows) lines.push(`${r.occurrence}\t${fmtHex(r.pc)}\t${r.clock}\t${r.seq}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_top_pcs",
    "Return the most-executed PCs in a trace run (hot spots). Use to find where time goes. Not for a specific PC's events (use trace_store_query). Inputs: run id, limit. Returns: ranked PCs.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
      cpu: z.enum(["c64", "drive8"]).describe("CPU side."),
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 20)."),
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. Hotspot ranking is the archetypal 'reached for statistics instead of reading the code' — it CONFIRMS where a routine you already located spends time; it is not how you find structure. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("trace_store_top_pcs", async ({ project_dir, path, cpu, limit, hypothesis }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = checkRuntimeDiscipline(hypothesis, { tool: "trace_store_top_pcs", act: "ranking the hottest PCs (statistics)" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const rows = await traceStoreFn<TopPcRow[]>("topPcs", dbPath, { cpu, limit: limit ?? 20 });
      const lines = [`top ${rows.length} PCs for cpu=${cpu}:`, ``];
      for (const r of rows) lines.push(`${fmtHex(r.pc)}\t${r.count}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_bus_find",
    "Find IEC/bus events in the trace store ($DD00 / CIA2 / VIA reads+writes). Use to debug loader/bus protocols from durable evidence. Not for CPU PCs (use trace_store_top_pcs). Inputs: run id, lane/value filters. Returns: bus events.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
      addr: z.string().describe("Address as hex (e.g. $DD00, 0xDD00, DD00) or decimal."),
      limit: z.number().int().positive().max(10000).optional().describe("Max rows (default 100)."),
    },
    safeHandler("trace_store_bus_find", async ({ project_dir, path, addr, limit }) => {
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const cleaned = String(addr).trim().replace(/^\$/, "").replace(/^0x/i, "");
      let n: number;
      if (/^[0-9a-fA-F]+$/.test(cleaned) && (cleaned.length > 1 || /[a-fA-F]/.test(cleaned))) {
        n = parseInt(cleaned, 16);
      } else {
        n = Number(addr);
      }
      const rows = await traceStoreFn<BusEventRow[]>("findBusEvents", dbPath, { addr: n, limit: limit ?? 100 });
      const lines = [`bus_events at ${fmtHex(n)} (${rows.length}):`, ``, `seq\tcpu\tkind\tclock\tpc\tvalue`];
      for (const r of rows) {
        lines.push(`${r.seq}\t${r.cpu}\t${r.kind}\t${r.clock}\t${r.pc !== null ? fmtHex(r.pc) : ""}\t${r.value ?? ""}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_query",
    "Run a structured query over the DuckDB trace store (by PC, address, event family, cycle range). Use for durable trace evidence. Not for live state (use runtime_monitor_*). Inputs: query filters. Returns: matching rows.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
      sql: z.string().describe("Read-only SELECT or WITH query."),
      limit: z.number().int().positive().max(2000).optional().describe("Max rows returned (default 200)."),
    },
    safeHandler("trace_store_query", async ({ project_dir, path, sql, limit }) => {
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      const rows = await traceStoreFn<QueryRow[]>("safeQuery", dbPath, { sql, limit: limit ?? 200 });
      const lines = [`query (${rows.length} rows):`, ``];
      for (const r of rows) {
        lines.push(r.map((c) => typeof c === "bigint" ? c.toString() : String(c)).join("\t"));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  // Spec 753 P3 — page memory map from bus_events (writes/reads, incl. the
  // indirect EAs the instruction-decode path cannot resolve) + instructions
  // (executed = CODE). BEHAVIOUR, not grounding (Spec 752 §6): free-RAM /
  // persistence footprint for porting, NOT "what a block is".
  server.tool(
    "trace_memory_map",
    "Reconstruct a per-page RAM memory map from a trace store: which pages are CODE (executed), DATA-W (written — incl. indirect STA (zp),Y targets the decode path can't see), DATA-R (read-only), or untouched; per-region write/read/mutation counts (old≠new = the persistence surface) + writer-PC count; and a 'provably free' free-hole list (untouched this run AND not static-occupied). Use for porting/footprint work (free EF-legal RAM, what mutates). Optional static_ranges reconciles with the module load-map. Coverage = THIS RUN ONLY (a trace is one path) — this is runtime behaviour, NOT identity grounding. Not for 'what is this block' (extract+disasm). Inputs: store path, cpu, optional static_ranges. Returns: ASCII page map + region table + free holes.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json. Consulted only when path is relative — an absolute store path is opened as given."),
      path: z.string().describe("Path to trace.duckdb or its parent directory. Absolute is the normal case (Spec 827 keeps a capture outside the project). A relative name is looked up under the project, then the project's per-user trace dir, then its runtime/traces.json pointer file — never against the process cwd."),
      cpu: z.enum(["c64", "drive8"]).optional().describe("CPU side (default c64)."),
      static_ranges: z.array(z.object({
        from: z.number().int().describe("Inclusive start address."),
        to: z.number().int().describe("Inclusive end address."),
        label: z.string().optional().describe("Owner label (module / segment)."),
      })).optional().describe("Statically-owned address ranges (module load-map / analysis-json). Pages overlapping these are reconciled: a static-owned page untouched in the run is flagged NOT provably free."),
      run_label: z.string().optional().describe("Optional run label for the header."),
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. The page map CONFIRMS a free-RAM/footprint hypothesis for porting; it is runtime behaviour for ONE path, NOT identity grounding, and not how you discover what a block is. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("trace_memory_map", async ({ project_dir, path, cpu, static_ranges, run_label, hypothesis }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = checkRuntimeDiscipline(hypothesis, { tool: "trace_memory_map", act: "reconstructing a per-page RAM map" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const dbPath = resolveStorePath(path, context, project_dir ?? path);
      // Spec 802 — the two SQL passes run inside the runtime (`store_fn`/`safeQuery`,
      // which self-heals an orphaned `.c64retrace` via its own bounded index-ensure —
      // the old BUG-035 caller-side ensureTraceIndex is no longer needed). Only the
      // RENDERING is local, and rendering a remote result is not a second reader.
      // Kept on safeQuery rather than the runtime's finished `map` text so this tool
      // keeps `static_ranges` + `run_label` + its structured `res.map` totals.
      const side = cpu ?? "c64";
      const runQuery = (sql: string) => traceStoreFn<QueryRow[]>("safeQuery", dbPath, { sql, limit: 300 });
      const res = await buildMemoryMapText(runQuery, { cpu: side, staticRanges: static_ranges, runLabel: run_label });
      const text = res ? res.text : `trace_memory_map: no memory accesses captured for cpu=${side}. Re-run the trace with the 'memory' domain (captures mem-row) to populate bus_events.`;
      return { content: [{ type: "text" as const, text }] };
    }),
  );
}

/** Spec 753 P3 — finalize auto-artifact. When a finalized trace captured memory
 *  accesses, write a `<store>.memorymap.md` sidecar next to the store (the page
 *  map: free RAM + persistence surface). Soft-fail (never breaks finalize) and
 *  daemon-safe (queries route through the daemon — no concurrent store open).
 *  Returns a one-line summary to append to the finalize output, or null.
 *
 *  Deliberately a loose sidecar, NOT a registered knowledge artifact: per Spec
 *  752 a trace is behaviour, not grounding — keeping it out of the artifact store
 *  means it can never satisfy the L1 backing predicate. */
export async function writeTraceMemoryMapSidecar(storePathRef: string, context: ServerToolContext, runLabel?: string): Promise<string | null> {
  try {
    const dbPath = resolveStorePath(storePathRef, context);
    // Spec 802 — runtime-side query (its `store_fn` ensures the index itself, so the
    // BUG-035 self-heal survives without a caller-side indexer).
    const runQuery = (sql: string) => traceStoreFn<QueryRow[]>("safeQuery", dbPath, { sql, limit: 300 });
    const res = await buildMemoryMapText(runQuery, { cpu: "c64", runLabel });
    if (!res) return null; // no memory capture → no sidecar
    const sidecar = dbPath.endsWith(".duckdb") ? dbPath.slice(0, -".duckdb".length) + ".memorymap.md" : dbPath + ".memorymap.md";
    writeFileSync(sidecar, res.text, "utf8");
    return `Memory map (mem-row captured): ${sidecar} — ${res.map.totals.freePages} free / ${res.map.totals.writtenPages} written pages (coverage = THIS RUN ONLY; runtime behaviour, not grounding).`;
  } catch {
    return null; // soft fail — never break finalize
  }
}
