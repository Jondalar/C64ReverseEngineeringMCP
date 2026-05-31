// Spec 744.4c — runnable C64RE Runtime Daemon entry (source imports, so it runs
// both under tsx-from-src and from built dist). Boots the one process-stable
// runtime authority: runtimeSessions + the V3 runtime WS (UI + MCP transport) +
// one default session. `npm run runtime:daemon` runs this; the MCP also auto-spawns
// it (detached) when `C64RE_RUNTIME_ENDPOINT` is set but no daemon is up.
//
// Args: --project <dir> [--port 4312] [--dev-samples].

import { resolveProjectDir, hasDevSamples } from "../../../workspace-ui/resolve-project-dir.js";

export async function runDaemon(argv: string[]): Promise<void> {
  const { V3WsServer } = await import("../../../workspace-ui/v3-ws-server.js");
  const { runtimeSessions } = await import("../runtime-session-service.js");
  const { getIntegratedSession } = await import("../integrated-session-manager.js");

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

  // Start the WS FIRST so the endpoint opens immediately — clients (and the MCP
  // auto-start poll) must not wait on any boot. A synchronous pre-boot here
  // (runFor 2M) would block the event loop (seconds under tsx) and stall the port.
  const server = new V3WsServer({ port, host, projectDir, devSamples });

  // Create ONE default session (PAUSED, at cold reset — NOT pre-booted) so a
  // freshly-connecting UI has a machine to attach to. The first Run boots it to
  // BASIC ready; the MCP/LLM creates more, all visible to both surfaces.
  const { sessionId } = runtimeSessions.start({ mode: "true-drive", driveDispatchMode } as never);
  const session = getIntegratedSession(sessionId)!;
  session.resetCold("pal-default");
  console.log(`[daemon] default session ${sessionId}: pc=$${session.c64Cpu.pc.toString(16)} (paused at reset)`);

  console.log(`[daemon] runtime authority ready.`);
  console.log(`[daemon]   endpoint (UI + MCP): ws://${host}:${port}`);
  console.log(`[daemon]   MCP reconnect / browser reload do NOT reset sessions (the runtime lives in this process).`);

  const shutdown = async () => { try { await server.close(); } catch { /* noop */ } process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Direct execution (node dist/.../run.js OR tsx src/.../run.ts).
runDaemon(process.argv.slice(2)).catch((e) => {
  console.error(`[daemon] failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
