// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// Spec 271 — Distributed scenario runner: worker thread entry point.
//
// Receives { scenarioId, projectDir? } via parentPort.
// Loads the scenario from the registry, runs it, posts back ReplayResult.
// On error posts { error: message }.

import { workerData, parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("scenario-worker: must be run as a worker_thread");
}

// Apply projectDir if provided (before importing scenario-registry which reads env).
const wd = workerData as { projectDir?: string };
if (wd?.projectDir) {
  process.env.C64RE_PROJECT_DIR = wd.projectDir;
}

// Lazy-import scenario registry and runner.
async function run(scenarioId: string): Promise<void> {
  const { loadScenario } = await import("../v2/scenario-registry.js");
  const { runScenario } = await import("../v2/scenario.js");

  const s = loadScenario(scenarioId);
  if (!s) {
    parentPort!.postMessage({ error: `scenario '${scenarioId}' not found` });
    return;
  }

  // Normalise startSnapshot: file path or base64 → Buffer.
  const startSnapshot: Uint8Array | string =
    typeof s.startSnapshot === "string" && s.startSnapshot
      ? s.startSnapshot // file path — runScenario handles it
      : Buffer.from(String(s.startSnapshot ?? ""), "base64");

  const scenario: any = { ...s, startSnapshot };

  try {
    const result = runScenario(scenario);
    parentPort!.postMessage({ result });
  } catch (e: unknown) {
    parentPort!.postMessage({ error: (e as Error).message ?? String(e) });
  }
}

// Listen for work messages.
parentPort.on("message", (msg: { scenarioId: string }) => {
  run(msg.scenarioId).catch((e: Error) => {
    parentPort!.postMessage({ error: e.message ?? String(e) });
  });
});
