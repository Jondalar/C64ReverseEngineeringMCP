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
