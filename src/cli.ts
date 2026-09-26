#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { startStdioServer } from "./server.js";
import { createRequire } from "node:module";

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
// Spec 716.1 — the one prerequisite that is not a version number.
//
// The knowledge graph and the platform KB are `node:sqlite`, which arrived during the
// Node 22 line. Declaring `engines.node` is a warning at install time and nothing at run
// time, and picking the exact 22.x that first carried the module unflagged would be a
// number guessed rather than measured. So the requirement is checked as what it actually
// is — can this Node import the module — and the failure says the Node in play, not a
// stack trace from somewhere deep in the graph.
try {
  createRequire(import.meta.url)("node:sqlite");
} catch {
  console.error(
    `c64re needs a Node with the built-in SQLite module; this is Node ${process.version}, which does not have it.\n`
    + "Install Node 22 LTS or newer and start c64re with that one. Nothing else about the install changes.",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);

// Spec 716 — `--help` and `--version` answer, rather than starting a server that waits on
// a stdin nobody is going to write to. INSTALL.md offers `--help` as the check that an
// install worked, and until this existed that check printed nothing at all and exited 0,
// which is the worst of both: it looks fine and tells you nothing.
if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  console.log([
    "c64re — MCP server for Commodore 64 reverse engineering",
    "",
    "Usually you do not run this by hand. An MCP host starts it and speaks the protocol",
    "over stdin and stdout; with no arguments that is exactly what it does.",
    "",
    "  c64re                        run the MCP server on stdio (what a host does)",
    "  c64re runtime install        fetch the TRX64 runtime daemon for this machine",
    "  c64re graph <verb>           query a project's knowledge graph",
    "  c64re doc lint|check|index   the document checks, as a hook or CI can call them",
    "  c64re setup                  write an MCP host configuration",
    "  c64re --version",
    "",
    "C64RE_PROJECT_DIR points at the project. Setup, host configuration and",
    "troubleshooting: INSTALL.md, https://github.com/Jondalar/C64ReverseEngineeringMCP",
  ].join("\n"));
  process.exit(0);
}

if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V") {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as { version?: string };
  console.log(pkg.version ?? "unknown");
  process.exit(0);
}

if (argv[0] === "graph") {
  // Spec 818 D8: `c64re graph <verb>` — the CLI over the knowledge-graph query
  // API. Stdout is the answer (one JSON document with --json), stderr the errors.
  await import("./knowledge-graph/cli.js").then(async (mod) => {
    await mod.runGraphCli(argv.slice(1));
  }).catch((error: unknown) => {
    console.error(`[c64re graph] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else if (argv[0] === "doc") {
  // Spec 847 D7: `c64re doc lint|check|index`. The logic a write hook calls, kept HERE
  // and not in the hook, because a hook lives in the harness and the harness is not the
  // product — a pre-commit hook, CI or a person gets the identical answer.
  await import("./docs/cli.js").then(async (mod) => {
    await mod.runDocCli(argv.slice(1));
  }).catch((error: unknown) => {
    console.error(`[c64re doc] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else if (argv[0] === "runtime" && argv[1] === "install") {
  // Spec 716.3: `npx @trex64/c64re runtime install`. The same code the `runtime_install` tool
  // runs, reachable without a harness — someone setting up an MCP host has no session yet
  // in which to call a tool, which is exactly the moment they need the daemon.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error([
      "c64re runtime install [--force]",
      "",
      "  Fetches the TRX64 runtime daemon this C64RE is pinned to, verifies the checksum",
      "  published beside it, and unpacks it into a per-version cache directory. Nothing is",
      "  installed into the system and an existing daemon is never touched.",
      "",
      "  --force   re-download even when the pinned version is already in the cache",
      "",
      "  ROMs are separate and are yours to supply: point C64RE_ROOT at a directory whose",
      "  resources/roms holds them.",
    ].join("\n"));
  } else {
  await import("./runtime/install-daemon.js").then(async (mod) => {
    const force = argv.includes("--force");
    const r = await mod.installDaemon({ force });
    console.error(r.alreadyPresent
      ? `trx64-daemon ${r.version} is already here: ${r.path}`
      : `trx64-daemon ${r.version} installed: ${r.path} (${(r.bytes / 1024 / 1024).toFixed(1)} MB, sha256 verified)`);
  }).catch((error: unknown) => {
    console.error(`[c64re runtime install] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  }
} else if (argv[0] === "setup") {
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
      const { ensureDaemon } = await import("./runtime/daemon-client.js");
      void ensureDaemon({ endpoint, projectDir: startupProjectDir }).then((r) => {
        lifecycle("ensure-daemon", { result: r, endpoint });
      });
    }
  } else if (process.env.C64RE_RUNTIME_WS) {
    console.error(`[c64-re mcp] C64RE_RUNTIME_WS (744.4b MCP co-host) is RETIRED — it reset sessions on MCP reconnect. Set C64RE_RUNTIME_ENDPOINT=ws://127.0.0.1:4312 and run \`npm run runtime:daemon\` (Spec 744.4c). Falling back to in-process runtime (no UI sharing).`);
  }
}
