#!/usr/bin/env node
// Spec 261/272 — V3 runtime WebSocket server bootstrap (port 4312).
//
// DEV-ONLY / STANDALONE (Spec 744.4b). This starts a SEPARATE-process WS runtime,
// whose runtimeSessions singleton is NOT shared with the IDE-launched MCP process.
// The PRODUCT shared-authority path is the MCP server co-hosting the WS in ONE
// process: set `C64RE_RUNTIME_WS=<port>` in the project `.mcp.json` so `src/cli.ts`
// hosts the Live runtime WS itself (see `maybeHostRuntimeWs`). Use this script only
// for running the UI runtime WITHOUT an MCP/IDE process (local dev of the UI).
//
// Spec 724.3 — project-aware: resolves ONE project dir (--project > env > hard
// error, NO cwd fallback) and hands it to V3WsServer so media scans read the
// project, not process.cwd(). Boots a C64 to BASIC ready, no media mounted.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer } = await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { resolveProjectDir, hasDevSamples } = await import(
  `${repoRoot}/dist/workspace-ui/resolve-project-dir.js`
);
// Spec 744.4 — the UI boots its session through the SINGLE runtime authority, the
// same RuntimeSessionService the MCP runtime_* tools use. No private UI-only session.
const { runtimeSessions } = await import(
  `${repoRoot}/dist/runtime/headless/runtime-session-service.js`
);
const { getIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

// Spec 724.3 — one resolver, shared with the workspace HTTP server. Throws if
// no --project / C64RE_PROJECT_DIR is given (the runtime WS must know which
// project it serves; usable outside the C64RE repo).
const projectDir = resolveProjectDir(process.argv.slice(2), process.env);
const devSamples = hasDevSamples(process.argv.slice(2));
console.log(`[v3] projectDir = ${projectDir}${devSamples ? " (+dev-samples)" : ""}`);

// Boot with NO disk in drive. 1541 powered + drive empty = real C64 behavior.
// User picks disk via media picker. PRG / cart workflows load into RAM directly.
console.log(`[v3] starting session (no disk inserted)`);
// Spec 428 Phase D — default vice-whole-instruction; C64RE_DRIVE_DISPATCH=
// cycle-stepped overrides for regression bisects.
const driveDispatchMode = process.env.C64RE_DRIVE_DISPATCH === "cycle-stepped"
  ? "cycle-stepped"
  : "vice-whole-instruction";
console.log(`[v3] driveDispatchMode = ${driveDispatchMode}`);
// Spec 723: single-path runtime — true-drive + microcoded Cpu65xxVice +
// VICE1541 + event-catchup are the ONLY path. No mode/cpu/drive/lockstep flags.
const { sessionId } = runtimeSessions.start({
  mode: "true-drive",
  driveDispatchMode,
});
console.log(`[v3] session id: ${sessionId}`);

console.log(`[v3] cold reset + boot to BASIC ready...`);
const session = getIntegratedSession(sessionId);
session.resetCold("pal-default");

session.runFor(2_000_000); // boot KERNAL until READY prompt
console.log(`[v3] cycle=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}`);

console.log(`[v3] starting WebSocket server on ws://127.0.0.1:4312`);
const server = new V3WsServer({ port: 4312, host: "127.0.0.1", projectDir, devSamples });

console.log(`[v3] ready.`);
console.log(`[v3]   1. Open http://127.0.0.1:4313`);
console.log(`[v3]   2. UI auto-picks session ${sessionId}`);
console.log(`[v3]   3. Live tab: pick disk from dropdown → click Run → see cursor`);

process.on("SIGINT", async () => {
  console.log(`\n[v3] shutting down...`);
  await server.close();
  process.exit(0);
});
