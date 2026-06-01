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
  void p.catch((e) => console.error(`[trace] background index failed for ${duckdbPath}:`, e instanceof Error ? e.message : e));
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

/** True while a background index for this path is in flight. */
export function isIndexing(duckdbPath: string | undefined): boolean {
  return !!duckdbPath && active.has(duckdbPath);
}
