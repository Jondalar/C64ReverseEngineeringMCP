#!/usr/bin/env node
// Spec 744.4c — `npm run runtime:daemon` entry. Thin wrapper that runs the built
// daemon (src/runtime/headless/daemon/run.ts → dist/.../run.js). The MCP also
// AUTO-STARTS the daemon (detached) when C64RE_RUNTIME_ENDPOINT is set, so you
// normally never run this by hand — it is here for an explicit/foreground launch.
//
// Usage: npm run runtime:daemon -- --project <dir> [--port 4312] [--dev-samples]
import { resolve as resolvePath } from "node:path";
const repoRoot = resolvePath(import.meta.dirname, "..");
// BUG-047 — run.js no longer autostarts on import (import-safety for probes);
// wrappers call runDaemon() explicitly.
const { runDaemon } = await import(`${repoRoot}/dist/runtime/headless/daemon/run.js`);
runDaemon(process.argv.slice(2)).catch((e) => {
  console.error(`[daemon] failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
