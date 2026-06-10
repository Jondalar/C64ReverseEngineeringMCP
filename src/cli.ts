#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { startStdioServer } from "./server.js";

// MCP lifecycle forensics — the stdio server "disconnects" in the field with
// no trace of WHO killed it (signal? stdin EOF from the host? crash? OOM?).
// Every lifecycle event appends one JSON line to ~/.c64re/mcp-lifecycle.log
// (NEVER stdout — that is the JSON-RPC channel; not stderr either — the host
// records every stderr line as an "error" entry, which reads as breakage).
// A death with NO entry here = SIGKILL/OOM (uncatchable) → check the OS log.
const LIFECYCLE_LOG = `${homedir()}/.c64re/mcp-lifecycle.log`;
function lifecycle(event: string, detail?: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LIFECYCLE_LOG), { recursive: true });
    appendFileSync(
      LIFECYCLE_LOG,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...detail }) + "\n",
    );
  } catch { /* logging must never harm the server */ }
}

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
  // stdout-Wache: stdout is EXCLUSIVELY the JSON-RPC framing channel. One stray
  // console.log from any (lazily) imported module corrupts a frame and the host
  // drops the connection ("MCP disconnected"). Re-route every console.log to
  // stderr for the whole process lifetime.
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => { console.error(...args); };

  lifecycle("start", {
    ppid: process.ppid,
    node: process.version,
    cwd: process.cwd(),
    endpoint: process.env.C64RE_RUNTIME_ENDPOINT ?? null,
    argv: process.argv.slice(2),
  });
  process.on("exit", (code) => lifecycle("exit", { code }));
  process.on("beforeExit", (code) => lifecycle("beforeExit", { code }));
  // Signal handlers preserve the default die-on-signal semantics (128+n) but
  // record WHICH signal arrived first. SIGTERM/SIGINT = the host shutting us
  // down; SIGHUP = controlling terminal/parent went away.
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
    process.on(sig, () => { lifecycle("signal", { sig }); process.exit(code); });
  }
  // stdin EOF/close = the host closed our pipe (its deliberate way of ending a
  // stdio MCP server). Distinguishes "Claude Code closed us" from "we died".
  process.stdin.on("end", () => lifecycle("stdin-end"));
  process.stdin.on("close", () => lifecycle("stdin-close"));

  // Keep the MCP stdio server alive across unhandled errors so a bug inside
  // one tool handler doesn't take the whole server down and disconnect the
  // client. Errors are logged to stderr (which is outside the JSON-RPC
  // channel on stdout) so the host can surface them.
  process.on("uncaughtException", (error) => {
    lifecycle("uncaughtException", { message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    console.error("[c64-re mcp] uncaughtException:", error);
  });
  process.on("unhandledRejection", (reason) => {
    lifecycle("unhandledRejection", { message: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
    console.error("[c64-re mcp] unhandledRejection:", reason);
  });

  startStdioServer().catch((error: unknown) => {
    lifecycle("startStdioServer-failed", { message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
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
    // stderr-Hygiene: this banner is informational, but the host records every
    // stderr line as an "error" log entry (and tints the /mcp panel) — so it
    // goes to the lifecycle log, keeping stderr = real problems only.
    lifecycle("daemon-endpoint", { endpoint });
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
        lifecycle("ensure-daemon", { result: r, endpoint });
      });
    }
  } else if (process.env.C64RE_RUNTIME_WS) {
    console.error(`[c64-re mcp] C64RE_RUNTIME_WS (744.4b MCP co-host) is RETIRED — it reset sessions on MCP reconnect. Set C64RE_RUNTIME_ENDPOINT=ws://127.0.0.1:4312 and run \`npm run runtime:daemon\` (Spec 744.4c). Falling back to in-process runtime (no UI sharing).`);
  }
}
