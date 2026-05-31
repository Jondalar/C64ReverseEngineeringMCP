// BUG-027 Blocker 1 / Spec 744.2 — the binary trace worker must resolve when the
// MCP server runs from SOURCE via tsx (`npx tsx src/cli.ts`, as every project
// .mcp.json does). This gate imports the writer from `src/` and runs under tsx, so
// `import.meta.url` inside binary-log-writer is the `.ts` path under `src/` — the
// exact condition that produced `ERR_MODULE_NOT_FOUND .../src/.../binary-log-worker.js`.
// Run: npm run e2e:744-2  (which does build:mcp first so the dist worker exists).
import { existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinaryTraceLogWriter } from "../src/runtime/headless/trace/binary-log-writer.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 744.2 — binary trace worker resolves from a tsx-from-src run\n");

const path = join(tmpdir(), `trace-744-2-${process.pid}.c64retrace`);
try { rmSync(path, { force: true }); } catch { /* noop */ }

const meta = {
  runId: "run-744-2", defId: "def-744-2", defVersion: 1, defName: "smoke",
  defJson: "{}", domains: ["c64-cpu"], cycleStart: 0,
  createdAt: "2026-05-31T00:00:00.000Z",
};

let exit = 0;
try {
  // Constructing the writer spawns the worker_thread — throws ERR_MODULE_NOT_FOUND
  // here if the worker path is resolved as src/.../*.js (the BUG-027 failure).
  const w = new BinaryTraceLogWriter(path, meta);
  ok(true, "BinaryTraceLogWriter constructed (worker spawned, no module-not-found)");
  await w.ready();
  ok(true, "worker opened the trace file (ready resolved)");
  for (let i = 0; i < 1000; i++) {
    w.appendCpuStep("c64", i, 0xe000 + (i & 0xff), 0xea, 0, 0, 0, 0xff, 0x20, 0, 0);
  }
  w.appendMark(1000, "done");
  const res = await w.finalize();
  ok(res.bytesWritten > 0, "finalize wrote bytes", `${res.bytesWritten} bytes`);
  ok(existsSync(path) && statSync(path).size > 0, ".c64retrace file exists + non-empty",
    existsSync(path) ? `${statSync(path).size} bytes` : "missing");
  ok(res.stats.eventCount >= 1001 && res.stats.dropped === 0, "all events captured, none dropped",
    `events=${res.stats.eventCount} dropped=${res.stats.dropped}`);
} catch (e) {
  ok(false, "trace worker path resolved", (e as Error).message);
  exit = 1;
} finally {
  try { rmSync(path, { force: true }); } catch { /* noop */ }
}

console.log(`\nSpec 744.2: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
