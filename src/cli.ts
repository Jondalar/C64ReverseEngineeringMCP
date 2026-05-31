#!/usr/bin/env node
import { startStdioServer } from "./server.js";

// Spec 044: subcommand router. `c64re setup <agent>` patches the
// CLAUDE.md / agent config; everything else (the default) launches
// the MCP stdio server.
const argv = process.argv.slice(2);
if (argv[0] === "setup") {
  await import("./setup-cli.js").then(async (mod) => {
    await mod.runSetup(argv.slice(1));
  }).catch((error: unknown) => {
    console.error(`[c64re setup] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else {
  // Keep the MCP stdio server alive across unhandled errors so a bug inside
  // one tool handler doesn't take the whole server down and disconnect the
  // client. Errors are logged to stderr (which is outside the JSON-RPC
  // channel on stdout) so the host can surface them.
  process.on("uncaughtException", (error) => {
    console.error("[c64-re mcp] uncaughtException:", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[c64-re mcp] unhandledRejection:", reason);
  });

  // Spec 744.4b — ONE product process for both surfaces. When C64RE_RUNTIME_WS is
  // set (a port, in the project .mcp.json), this MCP process ALSO hosts the Live
  // runtime WS server, so MCP tools and the WS adapter share the SAME
  // runtimeSessions singleton in THIS process — a human UI on the WS port and the
  // LLM on MCP stdio operate on the same session ids/frames. Logs to stderr only
  // (stdout is the JSON-RPC channel).
  await maybeHostRuntimeWs();

  startStdioServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function maybeHostRuntimeWs(): Promise<void> {
  const portEnv = process.env.C64RE_RUNTIME_WS;
  if (!portEnv) return;
  const port = Number(portEnv) || 4312;
  try {
    const { resolveProjectDir, hasDevSamples } = await import("./workspace-ui/resolve-project-dir.js");
    const { V3WsServer } = await import("./workspace-ui/v3-ws-server.js");
    const { runtimeSessions } = await import("./runtime/headless/runtime-session-service.js");
    const projectDir = resolveProjectDir([], process.env);
    const devSamples = hasDevSamples([]);
    const driveDispatchMode = process.env.C64RE_DRIVE_DISPATCH === "cycle-stepped"
      ? "cycle-stepped" : "vice-whole-instruction";
    // Boot ONE default session through the shared authority (no disk, to BASIC
    // ready) so the UI has something to attach to immediately; MCP tools create
    // more, all visible to both surfaces.
    const { sessionId, session } = runtimeSessions.start({ mode: "true-drive", driveDispatchMode });
    session.resetCold("pal-default");
    session.runFor(2_000_000);
    new V3WsServer({ port, host: "127.0.0.1", projectDir, devSamples });
    console.error(`[c64-re mcp] hosting Live runtime WS on ws://127.0.0.1:${port} (shared authority, session ${sessionId}, project ${projectDir})`);
  } catch (e) {
    console.error(`[c64-re mcp] could not host runtime WS:`, e instanceof Error ? e.message : e);
  }
}
