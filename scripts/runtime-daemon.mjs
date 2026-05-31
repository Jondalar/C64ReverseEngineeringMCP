#!/usr/bin/env node
// Spec 744.4c — C64RE Runtime Daemon. THE product-stable runtime authority.
//
// One long-lived process owns the C64 Headless Runtime (runtimeSessions +
// IntegratedSession(s) + media + trace + checkpoint ring). BOTH actors are clients:
//   - the human browser UI connects over the V3 runtime WS (this server);
//   - the LLM/MCP connects over the same WS as a client (C64RE_RUNTIME_ENDPOINT).
// Because the runtime lives in THIS process, an MCP reconnect or a browser reload
// does NOT reset sessions (binding rules §37/§38, docs/runtime-daemon-solution-design.md).
//
// Endpoint: ws://<host>:<port>  (default 127.0.0.1:4312). Put it in the project
// .mcp.json as C64RE_RUNTIME_ENDPOINT so MCP runtime tools attach here.
//
// Usage: npm run runtime:daemon -- --project <dir> [--port 4312] [--dev-samples]

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { V3WsServer } = await import(`${repoRoot}/dist/workspace-ui/v3-ws-server.js`);
const { resolveProjectDir, hasDevSamples } = await import(`${repoRoot}/dist/workspace-ui/resolve-project-dir.js`);
const { runtimeSessions } = await import(`${repoRoot}/dist/runtime/headless/runtime-session-service.js`);
const { getIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const argv = process.argv.slice(2);
const projectDir = resolveProjectDir(argv, process.env);
const devSamples = hasDevSamples(argv);
const portIdx = argv.indexOf("--port");
const port = Number(
  (portIdx >= 0 && argv[portIdx + 1]) ? argv[portIdx + 1]
    : (process.env.C64RE_RUNTIME_DAEMON_PORT ?? 4312),
) || 4312;
const host = "127.0.0.1";
const driveDispatchMode = process.env.C64RE_DRIVE_DISPATCH === "cycle-stepped" ? "cycle-stepped" : "vice-whole-instruction";

console.log(`[daemon] C64RE Runtime Daemon — project ${projectDir}${devSamples ? " (+dev-samples)" : ""}`);

// Boot ONE default session through the shared authority (no disk, to BASIC ready)
// so a freshly-connecting UI has a machine to attach to immediately. MCP and UI
// create more via session/create — all visible to both surfaces.
const { sessionId } = runtimeSessions.start({ mode: "true-drive", driveDispatchMode });
const session = getIntegratedSession(sessionId);
session.resetCold("pal-default");
session.runFor(2_000_000); // boot KERNAL to READY
console.log(`[daemon] default session ${sessionId}: cycle=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}`);

const server = new V3WsServer({ port, host, projectDir, devSamples });
console.log(`[daemon] runtime authority ready.`);
console.log(`[daemon]   endpoint (UI + MCP): ws://${host}:${port}`);
console.log(`[daemon]   put C64RE_RUNTIME_ENDPOINT=ws://${host}:${port} in the project .mcp.json so MCP attaches here.`);
console.log(`[daemon]   MCP reconnect / browser reload do NOT reset sessions (the runtime lives in this process).`);

process.on("SIGINT", async () => { console.log("\n[daemon] shutting down..."); await server.close(); process.exit(0); });
process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
