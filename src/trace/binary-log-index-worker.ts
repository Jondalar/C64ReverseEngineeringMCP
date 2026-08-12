// Spec 746.x — `.c64retrace` → DuckDB INDEX worker (off the daemon event loop).
//
// indexBinaryLog() reads the whole binary log back + runs a tight synchronous
// decode loop (~tens of millions of events) + bulk-appends to DuckDB. On the
// main thread that BLOCKS the shared daemon for seconds-to-minutes on a large
// trace → the UI freezes + the trace-stop button can't update until it returns.
//
// Running it here, on a separate worker thread, keeps the daemon fully
// responsive (and steals no main-thread CPU → no emulation FPS dip) while the
// index builds. The .c64retrace is the timeline authority and is already closed
// before this runs; the DuckDB index is a rebuildable projection, so stop() can
// return the moment the log is finalized and kick this in the background.
//
// Protocol (main → worker):  { retracePath, duckdbPath, overrides }
// Protocol (worker → main):  { ok: true, result } | { ok: false, error }

import { parentPort } from "node:worker_threads";
import { indexBinaryLog } from "./binary-log-indexer.js";
import type { RuntimeTraceRun } from "./trace-definition.js";

if (!parentPort) throw new Error("binary-log-index-worker: must run as a worker_thread");
const port = parentPort;

port.on("message", async (msg: { retracePath: string; duckdbPath: string; overrides?: Partial<RuntimeTraceRun> }) => {
  try {
    const result = await indexBinaryLog(msg.retracePath, msg.duckdbPath, msg.overrides);
    port.postMessage({ ok: true, result });
  } catch (e) {
    port.postMessage({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
});
