// Spec 746.x — background `.c64retrace` → DuckDB indexer.
//
// trace stop() finalizes the binary log (fast: flush + close) and returns
// IMMEDIATELY, kicking the DuckDB index build here on a worker thread. The UI
// trace-stop button is then instant and the daemon never freezes on the decode
// (the prior synchronous indexBinaryLog blocked the event loop for up to minutes
// on a large trace). The .c64retrace is the timeline authority; the index is a
// rebuildable projection, so it is correct to defer it.
//
// Any reader that needs the DuckDB store (swimlane / trace_store_query / MCP
// finalize-then-read) calls awaitIndex(duckdbPath) first, which transparently
// blocks only until THIS path's index is ready (or resolves instantly if it
// already is, or was never indexed in this process).

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep } from "node:path";
import type { IndexResult } from "./binary-log-indexer.js";
import type { RuntimeTraceRun } from "./trace-definition.js";

// Resolve the worker's built `.js` (the MCP server runs from src/ via tsx, so the
// sibling here is `.ts`; the build emits the worker to dist/). Mirrors
// binary-log-writer.ts's resolver.
function indexWorkerScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  const sibling = resolvePath(here, "..", "binary-log-index-worker.js");
  if (existsSync(sibling)) return sibling;
  const distTwin = sibling.replace(`${sep}src${sep}runtime${sep}`, `${sep}dist${sep}runtime${sep}`);
  if (existsSync(distTwin)) return distTwin;
  throw new Error(
    `binary-log-index-worker not found at ${sibling} or ${distTwin}. ` +
    `Run \`npm run build:mcp\` — the index worker is emitted to dist/.`,
  );
}

// Keyed by the .duckdb output path. The promise stays in the map after it
// settles so a late reader's awaitIndex() resolves immediately; `active` tracks
// the in-flight set for isIndexing().
const inFlight = new Map<string, Promise<IndexResult>>();
const active = new Set<string>();
// Last index failure per path, so a reader can surface WHY the store is missing
// (corrupt log, disk full) instead of a cryptic "store not found". Cleared when a
// fresh build for the path starts.
const indexErrors = new Map<string, string>();

/** `.duckdb` → its `.c64retrace` authority (inlined to avoid a trace-run.ts import
 *  cycle — trace-run.ts imports this module). */
function retracePathFor(duckdbPath: string): string {
  return duckdbPath.endsWith(".duckdb")
    ? duckdbPath.slice(0, -".duckdb".length) + ".c64retrace"
    : duckdbPath + ".c64retrace";
}

/** Kick a DuckDB index build on a worker thread. Fire-and-forget: returns the
 *  promise for callers that want it, but stop() does NOT await it. */
export function startBackgroundIndex(
  retracePath: string,
  duckdbPath: string,
  overrides?: Partial<RuntimeTraceRun>,
): Promise<IndexResult> {
  // (review #8) Never spawn a second index worker for a path already building —
  // two workers renaming onto the same final path would race. In practice every
  // trace gets a unique path (live_<ts>.duckdb), so this is a guard, not a flow.
  const existing = inFlight.get(duckdbPath);
  if (active.has(duckdbPath) && existing) return existing;
  active.add(duckdbPath);
  indexErrors.delete(duckdbPath); // fresh attempt clears any prior failure
  const p = new Promise<IndexResult>((res, rej) => {
    let worker: Worker;
    try { worker = new Worker(indexWorkerScriptPath()); }
    catch (e) { rej(e instanceof Error ? e : new Error(String(e))); return; }
    const cleanup = () => { try { void worker.terminate(); } catch { /* noop */ } };
    worker.once("message", (m: { ok: boolean; result?: IndexResult; error?: string }) => {
      cleanup();
      if (m.ok && m.result) res(m.result);
      else rej(new Error(m.error ?? "index worker failed"));
    });
    worker.once("error", (e) => { cleanup(); rej(e); });
    worker.once("exit", (code) => { if (code !== 0) rej(new Error(`index worker exited ${code}`)); });
    worker.postMessage({ retracePath, duckdbPath, overrides });
  });
  // (review #5) FULLY swallow on the guard promise (no re-throw) so a stop() that
  // fires-and-forgets this index never raises an unhandledRejection. awaitIndex()
  // re-reads the raw `p` from inFlight and catches its own error; a failed index
  // just leaves the .c64retrace authority on disk (re-indexable).
  void p.catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    indexErrors.set(duckdbPath, msg);
    console.error(`[trace] background index failed for ${duckdbPath}:`, msg);
  });
  inFlight.set(duckdbPath, p);
  // (review #7) Bound the map: drop the settled entry after a grace window (late
  // readers within it still resolve instantly; after it, the index is long done +
  // atomically published, so a direct open is safe). `active` is the truth for
  // isIndexing(). unref so the timer never holds the process open.
  p.finally(() => {
    active.delete(duckdbPath);
    const t = setTimeout(() => { if (inFlight.get(duckdbPath) === p) inFlight.delete(duckdbPath); }, 30_000);
    (t as { unref?: () => void }).unref?.();
  }).catch(() => {});
  return p;
}

/** Block until THIS path's background index is done (or instantly if it already
 *  is / was never indexed in this process). Never throws — a failed index leaves
 *  the reader to open whatever is on disk. */
export async function awaitIndex(duckdbPath: string | undefined): Promise<void> {
  if (!duckdbPath) return;
  const p = inFlight.get(duckdbPath);
  if (!p) return;
  try { await p; } catch { /* index failed; reader sees on-disk state */ }
}

/** Spec 746.x — LAZY-ON-READ. Guarantee a queryable `.duckdb` exists for this
 *  path before a reader opens it: wait for an in-flight build, trust a present
 *  store, else (re)build it from the `.c64retrace` authority. This both
 *  materializes the index on first read AND recovers an ORPHANED store — e.g. a
 *  multi-GB trace whose old whole-file index failed (now fixed by the streaming
 *  indexer). Throws with the real reason if the (re)build failed, so the failure
 *  is surfaced to the LLM/UI rather than reading a missing store. */
export async function ensureIndex(duckdbPath: string | undefined): Promise<void> {
  if (!duckdbPath) return;
  if (active.has(duckdbPath)) { await awaitIndex(duckdbPath); }
  else if (!existsSync(duckdbPath)) {
    const retrace = retracePathFor(duckdbPath);
    if (existsSync(retrace)) { // a trace authority with no index → build it lazily
      startBackgroundIndex(retrace, duckdbPath);
      await awaitIndex(duckdbPath);
    }
  }
  if (!existsSync(duckdbPath)) {
    const why = indexErrors.get(duckdbPath);
    if (why) throw new Error(`trace index unavailable for ${duckdbPath}: ${why}`);
  }
}

/** The last index-build failure reason for a path, if any. */
export function indexError(duckdbPath: string | undefined): string | undefined {
  return duckdbPath ? indexErrors.get(duckdbPath) : undefined;
}

/** True while a background index for this path is in flight. */
export function isIndexing(duckdbPath: string | undefined): boolean {
  return !!duckdbPath && active.has(duckdbPath);
}
