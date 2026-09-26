// Spec 716 — starting the workbench, from a checkout or from an installed package.
//
// This used to live in `scripts/workspace.mjs`, which `scripts/` keeps out of the npm
// tarball. Everything it needs — the HTTP server, the project resolver, the daemon
// resolver, the machine model, `ws` — ships; it was the orchestrator itself that did not,
// and the launchers `project_init` writes therefore ran `npm run workspace` in a directory
// with no `tsconfig.json`, no `scripts/` and no TypeScript. The workbench shipped and
// could not be started.
//
// So the logic moved here, into `dist/`, and both callers reach the same copy:
// `scripts/workspace.mjs` for the checkout, `c64re ui` for an install.
//
// `packageRoot` is computed from THIS module, not from a caller's cwd or a baked path:
// `dist/workspace-ui/launch.js` → two levels up is the package root in both shapes.

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A TCP listener, or not, within the timeout. */
function tcpUp(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolveTcp) => {
    const s = createConnection({ host, port });
    const done = (v: boolean) => { try { s.destroy(); } catch { /* already gone */ } resolveTcp(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => { clearTimeout(t); done(true); });
    s.once("error", () => { clearTimeout(t); done(false); });
  });
}

/** The running machine's model (`session/state.model`), or undefined — best effort. */
async function runningModel(host: string, port: number): Promise<string | undefined> {
  try {
    const { WebSocket } = await import("ws");
    return await new Promise((resolveModel) => {
      const ws = new WebSocket(`ws://${host}:${port}`);
      const done = (v: string | undefined) => { try { ws.close(); } catch { /* already gone */ } resolveModel(v); };
      const t = setTimeout(() => done(undefined), 2000);
      ws.once("error", () => { clearTimeout(t); done(undefined); });
      ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/state", params: {} })));
      ws.on("message", (data: unknown, isBinary: boolean) => {
        if (isBinary) return;
        let m: { id?: number; result?: { model?: unknown } };
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m.id !== 1) return;
        clearTimeout(t);
        done(typeof m.result?.model === "string" ? m.result.model : undefined);
      });
    });
  } catch {
    return undefined;
  }
}

function parseEndpoint(url: string | undefined): { host: string; port: number } | null {
  const m = /^wss?:\/\/([^/:]+):(\d+)/.exec(url || "");
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

/**
 * Start the workbench: the HTTP knowledge API and UI on 4310, and the runtime daemon on
 * 4312 unless something is already answering there.
 *
 * Resolves only when the workspace shuts down, so a caller can `await` it.
 */
export async function launchWorkspace(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { resolveProjectDir, hasDevSamples } = await import(
    pathToFileURL(`${packageRoot}/dist/workspace-ui/resolve-project-dir.js`).href
  ) as { resolveProjectDir: (a: string[], e: NodeJS.ProcessEnv) => string; hasDevSamples: (a: string[]) => boolean };

  // Resolve once (throws with a clear message if no --project / C64RE_PROJECT_DIR).
  const projectDir = resolveProjectDir(argv, env);
  const devSamples = hasDevSamples(argv);
  const httpPortIdx = argv.indexOf("--port");
  const httpPort = httpPortIdx >= 0 && argv[httpPortIdx + 1] ? argv[httpPortIdx + 1] : "4310";

  console.log(`[workspace] projectDir = ${projectDir}${devSamples ? " (+dev-samples)" : ""}`);
  console.log(`[workspace] HTTP :${httpPort}  WS :4312`);

  // Both children get the SAME resolved absolute projectDir via --project, so the HTTP
  // knowledge API and the WS runtime can never drift to different projects.
  const childArgs = ["--project", projectDir, ...(devSamples ? ["--dev-samples"] : [])];

  const children: ChildProcess[] = [];
  let shuttingDown = false;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => { done = r; });

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) { try { c.kill("SIGINT"); } catch { /* already gone */ } }
    setTimeout(done, 500);
  }

  function start(label: string, cmd: string, args: string[]): void {
    const c = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd: packageRoot });
    c.stdout?.on("data", (b: Buffer) => process.stdout.write(`[${label}] ${b}`));
    c.stderr?.on("data", (b: Buffer) => process.stderr.write(`[${label}] ${b}`));
    c.on("exit", (code) => {
      console.error(`[workspace] ${label} exited (code ${code}) — shutting down`);
      shutdown();
    });
    children.push(c);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  start("http", process.execPath, [`${packageRoot}/dist/workspace-ui/server.js`, "--port", httpPort, ...childArgs]);

  const explicitEndpoint = env.C64RE_RUNTIME_ENDPOINT || env.C64RE_RUNTIME_WS;
  const wsEndpoint = parseEndpoint(explicitEndpoint) ?? { host: "127.0.0.1", port: 4312 };
  const wsIsLocal = wsEndpoint.host === "127.0.0.1" || wsEndpoint.host === "localhost";

  if (!wsIsLocal) {
    // Explicit remote endpoint: nothing to spawn here, just trust it.
    console.log(`[workspace] Live runtime WS is the Runtime Daemon (${explicitEndpoint}); not starting a standalone WS.`);
  } else if (await tcpUp(wsEndpoint.host, wsEndpoint.port)) {
    // Spec 744.4c — product shared authority: a daemon is already listening (an MCP
    // session started it, or a previous workspace run). Do NOT also spawn a second one:
    // that is a SECOND runtime authority in a separate process, and it panics on the port
    // conflict.
    console.log(`[workspace] Live runtime WS: reusing daemon already listening on ${wsEndpoint.host}:${wsEndpoint.port}; not starting a second one.`);
    // Spec 863 — a reused daemon was started by someone else, maybe as another C64 than
    // this project is. Say so; switching it is the Live tab's decision, not a launcher's.
    const { projectMachineModel } = await import(
      pathToFileURL(`${packageRoot}/dist/project-knowledge/machine-model.js`).href
    ) as { projectMachineModel: (d: string) => string | undefined };
    const want = projectMachineModel(projectDir);
    if (want) {
      const running = await runningModel(wsEndpoint.host, wsEndpoint.port);
      if (running && running !== want) {
        console.warn(
          `[workspace] this project is ${want}, but the running machine is ${running} — `
          + `switch it in the Live tab (model selector), or stop the runtime and start the workspace again.`,
        );
      }
    }
  } else {
    // Nothing answering — start one so the Live tab works without a manual daemon step.
    // Spec 757 — ONE WS-start path. Spec 771.1 — the shared resolver locates the binary
    // (C64RE_RUNTIME_BIN / C64RE_TRX64_BIN / the cache `runtime_install` fills / PATH /
    // the sibling build). Spec 806: there is no second tier, so `mode === "none"` means
    // "no daemon anywhere" and the run stops saying so.
    const { resolveDaemonSpawn } = await import(
      pathToFileURL(`${packageRoot}/dist/runtime/resolve-daemon-spawn.js`).href
    ) as { resolveDaemonSpawn: (o: { repoRoot: string; projectDir: string; port: string }) => {
      cmd: string; args: string[]; mode: string; warn?: string; model?: string; modelFrom?: string } };
    const plan = resolveDaemonSpawn({ repoRoot: packageRoot, projectDir, port: String(wsEndpoint.port) });
    if (plan.warn) console.warn(`[workspace] ${plan.warn}`);
    if (plan.mode === "none") {
      console.error("[workspace] no runtime daemon found — run `c64re runtime install`, or set C64RE_TRX64_BIN.");
      shutdown();
    } else {
      console.log(`[workspace] WS backend = ${plan.mode} (starting fresh on :${wsEndpoint.port})`);
      // Spec 863 — which C64 it starts as, and why.
      console.log(
        plan.model
          ? `[workspace] machine = ${plan.model} (${plan.modelFrom === "project" ? "knowledge/project.json → machine.model" : plan.modelFrom === "args" ? "C64RE_RUNTIME_BIN_ARGS" : "requested"})`
          : "[workspace] machine = the runtime's default (the project names no machine.model)",
      );
      start("ws", plan.cmd, plan.args);
    }
  }

  await finished;
}
