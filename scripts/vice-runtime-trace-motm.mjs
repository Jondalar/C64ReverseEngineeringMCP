#!/usr/bin/env node
// Spec 152 (revised) — VICE runtime trace via cpuhistory chunks.
//
// Replaces the per-step binmon approach (vice-full-trace.mjs) which
// hit binmon timeouts + slow throughput. This wrapper drives the
// existing ViceSessionManager.startSession(... runtimeTrace.enabled)
// infrastructure that the MCP tool `vice_trace_runtime_start` uses.
//
// Behavior:
//   1. Spawn visible VICE with -8 motm.g64 (or any disk via --disk).
//   2. Enable cpuhistory periodic sampling at --interval-ms.
//   3. User plays motm interactively (LOAD"*",8,1 → RUN, watch boot).
//   4. User closes VICE window when done (e.g. at title screen).
//   5. Script detects VICE exit + reports output paths.
//   6. Trace JSONL files land in session_dir/trace.jsonl +
//      drive-history.jsonl per existing infrastructure.
//
// Usage:
//   npm run trace:motm-vice-runtime
//   npm run trace:motm-vice-runtime -- --disk samples/motm.g64 \
//                                      --interval-ms 1000 \
//                                      --cpu-history 200 \
//                                      --monitor-chis-lines 200
//
// Output:
//   <project>/runtime-vice-sessions/<session-id>/trace.jsonl
//   <project>/runtime-vice-sessions/<session-id>/drive-history.jsonl
//   <project>/runtime-vice-sessions/<session-id>/headless-trace.jsonl
//   (per existing session-manager workspace layout)

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const diskPath = args.disk
  ? resolve(repoRoot, args.disk)
  : resolve(repoRoot, "samples/motm.g64");

if (!existsSync(diskPath)) {
  console.error(`Disk not found: ${diskPath}`);
  process.exit(2);
}

const intervalMs       = Number(args["interval-ms"] ?? 1000);
const cpuHistoryCount  = Number(args["cpu-history"] ?? 200);
const monitorChisLines = Number(args["monitor-chis-lines"] ?? 200);
// Default ON: capture drive cpuhistory (memspace 1 = drive 8) too.
// motm divergence localization needs drive-side trace alongside c64.
const captureDriveHistory = args["no-drive-history"] !== true;
const projectDir       = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;

console.error(`[vice-runtime-trace] Spec 152 (revised) — cpuhistory chunked sampling`);
console.error(`[vice-runtime-trace] disk=${diskPath}`);
console.error(`[vice-runtime-trace] interval-ms=${intervalMs}  cpu-history=${cpuHistoryCount}  monitor-chis-lines=${monitorChisLines}`);
console.error(`[vice-runtime-trace] project-dir=${projectDir}`);

// Lazy import compiled session-manager (after build:mcp).
const { ViceSessionManager } =
  await import("../dist/runtime/vice/session-manager.js");

const manager = new ViceSessionManager(projectDir);

// Detect already-active session and clean up if dead.
try {
  await manager.reconcileExitedSession?.();
} catch { /* manager may not expose reconcile; that's fine */ }

console.error(`[vice-runtime-trace] Starting VICE session…`);
const record = await manager.startSession({
  mediaPath: diskPath,
  autostart: false,        // user types LOAD manually for visibility
  runtimeTraceBootstrapReset: true,
  runtimeTrace: {
    enabled: true,
    intervalMs,
    cpuHistoryCount,
    monitorChisLines,
    captureDriveHistory,
  },
});

console.error(``);
console.error(`[vice-runtime-trace] VICE session started (id=${record.sessionId}, pid=${record.pid})`);
console.error(`[vice-runtime-trace] Trace output: ${record.workspace.runtimeTracePath}`);
console.error(``);
console.error(`════════════════════════════════════════════════════════════════════════`);
console.error(`  USER ACTION REQUIRED:`);
console.error(`    1. VICE window has opened with motm.g64 attached.`);
console.error(`    2. At BASIC READY, type:  LOAD"*",8,1   then press RETURN`);
console.error(`    3. Wait for "READY." (LOAD complete; murder.prg auto-runs at \$4000).`);
console.error(`    4. Watch screen go grey/black (= AB.prg running, fastloader install).`);
console.error(`    5. Wait until title screen (or fail point) is reached.`);
console.error(`    6. Close VICE window.`);
console.error(`  Script will detect close and report output paths.`);
console.error(`════════════════════════════════════════════════════════════════════════`);
console.error(``);

// Poll for VICE exit. getStatus() triggers internal reconciliation
// (private reconcileExitedSession). State flips to "stopped" when VICE
// process terminates.
const pollInterval = 1000;
let lastReport = Date.now();
while (true) {
  await new Promise((r) => setTimeout(r, pollInterval));
  const status = await manager.getStatus();
  const state = status?.state ?? "stopped";
  if (state !== "running" && state !== "starting") {
    console.error(`\n[vice-runtime-trace] VICE session ended (state=${state})`);
    break;
  }

  // Periodic heartbeat every 30s
  if (Date.now() - lastReport > 30_000) {
    console.error(`[vice-runtime-trace] (still running — close VICE when done)`);
    lastReport = Date.now();
  }
}

console.error(``);
console.error(`[vice-runtime-trace] Trace files:`);
console.error(`  ${record.workspace.runtimeTracePath}`);
if (record.workspace.driveHistoryPath) {
  console.error(`  ${record.workspace.driveHistoryPath}`);
}
console.error(``);
console.error(`[vice-runtime-trace] Next: run analyze + diff against headless capture.`);
process.exit(0);
