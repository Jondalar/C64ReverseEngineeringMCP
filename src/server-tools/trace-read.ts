// Spec 802 — C64RE is a pure FACADE over TRX64 for trace reads.
//
// THE RULE: TRX64 is the runtime AND the monitor. It writes `.c64retrace`, it
// builds the DuckDB index, and it reads both back natively (crate
// `trx64-traceindex`, DuckDB statically bundled). C64RE consumes that and keeps
// **no second reader** on the customer path.
//
// Before 802 every read site carried a `localFn` fallback that opened the store
// in THIS process with `@duckdb/node-api` and ran C64RE's own TypeScript readers.
// That fallback was the silent second implementation: the same question answered
// by two codebases, drifting independently, and the reason a trace read could
// "work" while the runtime that produced the data could not read it at all.
//
// This module is the ONE door. Every trace-store read in C64RE — MCP tools and
// the workspace-UI REST endpoints alike — goes through `traceRead`. There is no
// alternate path and no fallback: an unreachable runtime is an actionable error,
// not a quiet switch to a different reader.
//
// Ops the daemon's `trace/read` accepts (TRX64 `TRACE_READ_OPS`):
//   index · store_fn · map · swimlane · swimlane_text · taint · taint_text
// plus `query_events` / `follow_path` / `profile_loader`, which are known to the
// wire contract but have no native reader yet — the daemon answers those with an
// explicit error rather than reinstating a spawn. The raw `sql` passthrough is
// DROPPED (Spec 802 OQ1); `store_fn`/`safeQuery` is the query door.

import { isAbsolute, resolve as resolvePath } from "node:path";

/** Where a caller-relative store path is anchored. The daemon is project-agnostic:
 *  a relative path sent raw would resolve against the DAEMON's cwd (wrong project),
 *  so it is made absolute here, caller-side. */
function absStorePath(storePath: string): string {
  if (isAbsolute(storePath)) return storePath;
  return resolvePath(process.env.C64RE_PROJECT_DIR ?? process.cwd(), storePath);
}

/**
 * Read a trace store THROUGH the runtime. `storePath` is the `.duckdb` index path
 * (absolute, or resolved against the project dir); TRX64 builds it lazily from the
 * sibling `.c64retrace` authority on first read, so a store whose index never ran
 * is recovered daemon-side — C64RE no longer needs its own `ensureIndex`.
 *
 * Throws with the runtime setup recipe when no runtime is configured/reachable.
 * That is deliberate: the alternative (falling back to an in-process reader) is
 * the architecture violation Spec 802 exists to remove.
 */
export async function traceRead<T = unknown>(
  op: string,
  storePath: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  // Spec 806: the endpoint always resolves (there is no in-process opt-out any more), so
  // an unreachable runtime surfaces as a connect error carrying the setup recipe, not as
  // a "no endpoint configured" branch here.
  const { runtimeDaemon } = await import("../runtime/daemon-client.js");
  return runtimeDaemon.traceRead<T>(op, absStorePath(storePath), args);
}

/**
 * `store_fn` convenience: the typed reader family (`getInfo`, `topPcs`,
 * `findBusEvents`, `listAnchors`, `findAnchor`, `safeQuery`). The daemon runs a
 * bounded index-ensure before dispatching, so callers must NOT pre-build an index.
 */
export async function traceStoreFn<T = unknown>(
  fn: string,
  storePath: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return traceRead<T>("store_fn", storePath, { fn, args });
}
