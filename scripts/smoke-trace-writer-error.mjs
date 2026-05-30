// Spec 726.B review fix (P2b) — BinaryTraceLogWriter must never HANG on a
// writer/worker error. Before the fix, the worker "error" set this.error but
// finalize() waited forever for a "done" that never came.
//
// Deterministic trigger: point the log at a path the worker cannot open (an
// ancestor is a regular file → ENOTDIR on mkdir/open). The worker posts "error";
// ready() must reject, and finalize() must reject FAST (not hang).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { BinaryTraceLogWriter } = await import(`${ROOT}/dist/runtime/headless/trace/binary-log-writer.js`);

console.log("Spec 726.B — smoke-trace-writer-error (no-hang on worker error)\n");

// package.json is a regular file → using it as a directory ancestor fails.
const BAD_PATH = `${ROOT}/package.json/nope/trace.c64retrace`;
const meta = {
  runId: "run_err", defId: "err", defVersion: 1, defName: "err",
  defJson: "{}", domains: ["c64-cpu"], cycleStart: 0, createdAt: "1970-01-01T00:00:00Z",
};

const w = new BinaryTraceLogWriter(BAD_PATH, meta);

const withTimeout = (p, ms, tag) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG:${tag}`)), ms))]);

let readyRejected = false, readyMsg = "";
try { await withTimeout(w.ready(), 4000, "ready"); }
catch (e) { readyRejected = !/^HANG/.test(e.message); readyMsg = e.message; }
ok(readyRejected, "ready() rejects on worker open error (no hang)", readyMsg);

let finRejected = false, finMsg = "";
try { await withTimeout(w.finalize(), 4000, "finalize"); }
catch (e) { finRejected = !/^HANG/.test(e.message); finMsg = e.message; }
ok(finRejected, "finalize() rejects fast on an errored writer (no hang)", finMsg);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-writer-error: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
