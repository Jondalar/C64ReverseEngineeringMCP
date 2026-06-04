// Spec 744.4c — runnable C64RE Runtime Daemon entry (source imports, so it runs
// both under tsx-from-src and from built dist). Boots the one process-stable
// runtime authority: runtimeSessions + the V3 runtime WS (UI + MCP transport) +
// one default session. `npm run runtime:daemon` runs this; the MCP also auto-spawns
// it (detached) when `C64RE_RUNTIME_ENDPOINT` is set but no daemon is up.
//
// Args: --project <dir> [--port 4312] [--dev-samples].

import { mkdirSync, appendFileSync } from "node:fs";
import { resolveProjectDir, hasDevSamples } from "../../../workspace-ui/resolve-project-dir.js";

export async function runDaemon(argv: string[]): Promise<void> {
  const { WsServer } = await import("../../../workspace-ui/ws-server.js");
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
  const server = new WsServer({ port, host, projectDir, devSamples });

  // Spec 744.4c — wait for the port to ACTUALLY bind before doing anything else.
  // Multiple start triggers (MCP eager + UI dev-server + lazy tool call) can race
  // to spawn a daemon; the OS port-bind is the single arbiter. A loser hits
  // EADDRINUSE here and exits cleanly (exit 0) — BEFORE creating any session — so
  // exactly one daemon owns the runtime and the losers leave no trace.
  try {
    await server.ready();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.log(`[daemon] :${port} already owned by another Runtime Daemon — exiting cleanly (the existing one is the shared authority).`);
      process.exit(0);
    }
    throw e;
  }

  // Create ONE default session (PAUSED, at cold reset — NOT pre-booted) so a
  // freshly-connecting UI has a machine to attach to. The first Run boots it to
  // BASIC ready; the MCP/LLM creates more, all visible to both surfaces.
  //
  // Spec 746.1 (OQ1 — producers on-by-default): build the default session WITH the
  // iec/drive/bus producers enabled. The producers are passive-proven (726 §2a:
  // byte-identical with/without, ~5.7% binary overhead) and are CONSTRUCTION-TIME
  // only — so enabling them here is the prerequisite for starting a FULL-domain
  // trace (iec/drive/memory) MID-SESSION on the running default session, from any of
  // the three control gates (UI / API / Monitor). Without this, only the CPU
  // firehose could be traced after the fact; iec/drive/memory would be empty.
  const { sessionId } = runtimeSessions.start({
    mode: "true-drive",
    driveDispatchMode,
    traceIec: true,
    traceDrive: true,
    enableBusAccessTrace: true,
  } as never);
  const session = getIntegratedSession(sessionId)!;
  session.resetCold("pal-default");
  console.log(`[daemon] default session ${sessionId}: pc=$${session.c64Cpu.pc.toString(16)} (paused at reset)`);

  console.log(`[daemon] runtime authority ready.`);
  console.log(`[daemon]   endpoint (UI + MCP): ws://${host}:${port}`);
  console.log(`[daemon]   MCP reconnect / browser reload do NOT reset sessions (the runtime lives in this process).`);

  // The daemon is a SHARED authority: a single unhandled error in one tool / the
  // trace-worker / a media swap must NOT kill the whole process (= the human's
  // "session/connection gone"). Without these, an uncaught throw from e.g. the
  // binary-trace-worker dying mid-swap takes the daemon down hard. Log the full
  // stack (so we can finally SEE the trace crash) but keep the process alive.
  const logDir = `${projectDir}/runtime`;
  const crashLog = `${logDir}/daemon-crash.log`;
  const recordCrash = (kind: string, e: unknown) => {
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const line = `\n[${kind}] (no-timestamp) ${stack}\n`;
    console.error(`[daemon] ${kind} (kept alive):`, e instanceof Error ? e.stack : e);
    try { mkdirSync(logDir, { recursive: true }); appendFileSync(crashLog, line); } catch { /* best effort */ }
  };
  process.on("uncaughtException", (e) => recordCrash("uncaughtException", e));
  process.on("unhandledRejection", (e) => recordCrash("unhandledRejection", e));

  const shutdown = async () => { try { await server.close(); } catch { /* noop */ } process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Direct execution (node dist/.../run.js OR tsx src/.../run.ts).
runDaemon(process.argv.slice(2)).catch((e) => {
  console.error(`[daemon] failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
