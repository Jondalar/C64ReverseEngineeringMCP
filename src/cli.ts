#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
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

  startStdioServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

  // Spec 744.4c — the product runtime is owned by a separate, process-stable
  // Runtime Daemon (the V3 runtime WS). The MCP `runtime_*` tools are CLIENTS of it
  // (env `C64RE_RUNTIME_ENDPOINT`), so a human UI and the LLM attach to the same
  // live session and an MCP reconnect does NOT reset the runtime. The MCP no longer
  // hosts the runtime itself (the 744.4b co-host reset sessions on reconnect — it is
  // retired). Logs to stderr only (stdout is the JSON-RPC channel).
  const endpoint = process.env.C64RE_RUNTIME_ENDPOINT;
  if (endpoint) {
    console.error(`[c64-re mcp] runtime tools are clients of the Runtime Daemon at ${endpoint} (Spec 744.4c).`);
    // Spec 744.4c (Trigger 1) — EAGER warm-start: bring the shared Runtime Daemon up
    // at MCP start (not just on the first tool call), so `/mcp reload` ALONE makes
    // :4312 available and the human can open the UI before the LLM acts. Detached +
    // fire-and-forget: MUST NOT block stdio startup (no await on readiness, no
    // pre-boot runFor). Idempotent + race-safe (loser daemons exit cleanly).
    {
      const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      let startupProjectDir: string | undefined;
      try {
        const { resolveProjectDir } = await import("./project-root.js");
        startupProjectDir = resolveProjectDir({ cwd: process.cwd(), repoDir });
      } catch {
        startupProjectDir = process.env.C64RE_PROJECT_DIR;
      }
      const { ensureDaemon } = await import("./server-tools/runtime-daemon-client.js");
      void ensureDaemon({ endpoint, projectDir: startupProjectDir }).then((r) => {
        if (r === "spawned") console.error(`[c64-re mcp] runtime daemon warm-started at ${endpoint}.`);
      });
    }
  } else if (process.env.C64RE_RUNTIME_WS) {
    console.error(`[c64-re mcp] C64RE_RUNTIME_WS (744.4b MCP co-host) is RETIRED — it reset sessions on MCP reconnect. Set C64RE_RUNTIME_ENDPOINT=ws://127.0.0.1:4312 and run \`npm run runtime:daemon\` (Spec 744.4c). Falling back to in-process runtime (no UI sharing).`);
  }
}
