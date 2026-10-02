// Spec 812 — an ephemeral machine for point work, and the client that drives it.
//
// Doctrine, amended 2026-08-14: the session the human sees is exactly one, and it
// is never power-cycled for a test. For point work — a capture run, a comparison —
// a private machine may be spawned, and it is BORN WITH A BUDGET and ENDS ITSELF
// when the budget runs out, whether or not anyone is still listening.
//
// So this is deliberately NOT the shared daemon client in `src/runtime/`:
//   - that one is pinned to the shared endpoint and would drive the human's session;
//   - it spawns DETACHED, so its daemon outlives the caller — right for a session
//     someone co-drives, wrong for a machine that exists for one command.
//
// Here the daemon runs on its own port under a KEEPER — a few lines of node that are
// this process's child and the daemon's parent. The keeper holds the budget itself and
// watches this process: when the budget runs out, or this process is gone, the keeper
// ends the daemon and removes its scratch. A budget kept by a timer in THIS process ended
// nothing once the process died — a reel daemon outlived its MCP server by a day
// (2026-10-01, parent PID 1). So the machine dies with this object, on the budget, or
// with the process, and the last of the three no longer depends on this process.
//
// The machine is PAUSED for the whole run and advanced only by bounded runs. That
// is what makes a schedule reproducible over a socket: a round trip costs wall
// clock, but a paused machine does not move while it is in flight. Measured
// (BUG-050): with the machine left running, one recipe gave five different
// outcomes; paused and advanced in cycles, five for five identical.

import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDaemonSpawn } from "../runtime/resolve-daemon-spawn.js";
import { runtimeSetupRecipe } from "../runtime/setup-recipe.js";

const SESSION_ID = "integrated-1";
/** How long a sandbox may live before it ends itself, regardless of the caller. */
const DEFAULT_BUDGET_MS = 10 * 60_000;
/** The keeper waits this much past the budget, so the caller's own reaper — which can
 *  still say WHY the run ended — normally gets there first. */
const KEEPER_GRACE_MS = 5_000;

/**
 * The keeper (see the header), run as `node -e`. argv: a JSON of [parentPid, budgetMs,
 * scratchDir, cmd, ...args]. It reports the daemon's pid on stdout, passes the daemon's
 * stderr through, exits with the daemon, and forwards a SIGTERM/SIGINT. Parent gone is
 * asked two ways: a changed ppid (POSIX reparents an orphan) and `kill(parent, 0)`
 * failing (Windows does not reparent).
 */
const KEEPER = `
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
const [parent, budget, scratch, cmd, ...args] = JSON.parse(process.argv[1]);
const d = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
process.stdout.write(String(d.pid) + "\\n");
let orphaned = false;
const parentGone = () => {
  if (process.ppid !== parent) return true;
  try { process.kill(parent, 0); return false; } catch { return true; }
};
const end = (sig) => { try { d.kill(sig); } catch {} setTimeout(() => { try { d.kill("SIGKILL"); } catch {} }, 1000).unref(); };
d.on("exit", (code) => {
  // Asked again here, not only by the poll: measured, the daemon could be gone before
  // the poll had noticed the caller was, and its scratch stayed behind.
  if ((orphaned || parentGone()) && scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
  process.exit(code ?? 1);
});
d.on("error", () => process.exit(127));
setTimeout(() => end("SIGTERM"), budget);
setInterval(() => {
  if (!orphaned && parentGone()) { orphaned = true; end("SIGTERM"); }
}, 500);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => end("SIGTERM"));
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function repoRoot(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Ask the OS for a port nobody is using, then let go of it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export interface SandboxOptions {
  /** Wall-clock ceiling; the sandbox ends itself at this age. Default 10 minutes. */
  budgetMs?: number;
  /** Where the daemon keeps its project scratch. A temp dir by default, removed on close. */
  projectDir?: string;
  /** Spec 863 — which C64 the machine is (a row of the runtime's model table, e.g.
   *  `c64-ntsc`). Omitted: the runtime's default. A name it cannot run is refused by the
   *  runtime at startup, and that refusal is what `start` throws. */
  model?: string;
}

export class SandboxSession {
  private ws: WebSocket | null = null;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private ownTmp: string | null = null;
  private reaper: NodeJS.Timeout | null = null;
  private closed = false;
  private endedBecause: string | null = null;
  /** The daemon itself, as the keeper reported it — killed directly on close, so a
   *  platform where killing the keeper cannot forward the signal still ends it. */
  private daemonPid: number | null = null;

  private constructor(readonly port: number) {}

  static async start(opts: SandboxOptions = {}): Promise<SandboxSession> {
    const port = await freePort();
    const s = new SandboxSession(port);
    const projectDir = opts.projectDir ?? (s.ownTmp = mkdtempSync(join(tmpdir(), "c64re-reel-")));

    const plan = resolveDaemonSpawn({ repoRoot: repoRoot(), projectDir, port: String(port), model: opts.model });
    if (plan.mode === "none") {
      throw new Error(runtimeSetupRecipe("no runtime binary available for an isolated capture run"));
    }

    const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    // The keeper is the child; the daemon is ITS child. Not detached either way: neither
    // may survive this command, and the keeper makes sure of it when this process cannot.
    s.child = spawn(process.execPath, [
      "-e", KEEPER,
      JSON.stringify([process.pid, budget + KEEPER_GRACE_MS, s.ownTmp ?? "", plan.cmd, ...plan.args]),
    ], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: String(port) },
    });
    s.child.stdout?.once("data", (b: Buffer) => {
      const pid = Number.parseInt(b.toString(), 10);
      if (Number.isFinite(pid)) s.daemonPid = pid;
    });
    let stderr = "";
    let exited = false;
    s.child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    s.child.once("exit", (code) => {
      exited = true;
      if (!s.closed) s.endedBecause = `the runtime exited with code ${code}`;
      s.failAllPending(new Error(s.endedBecause ?? "the runtime exited"));
    });

    s.reaper = setTimeout(() => {
      s.endedBecause = `the sandbox reached its ${Math.round(budget / 1000)}s budget`;
      void s.close();
    }, budget);
    s.reaper.unref?.();

    // Wait for it to answer, not merely to hold the port.
    const deadline = Date.now() + 40_000;
    for (;;) {
      // A runtime that refused to start (Spec 863: a model it cannot run, named) has
      // already said why — say it now instead of waiting out the deadline.
      if (exited) {
        await s.close();
        throw new Error(
          `the isolated runtime did not start` +
            (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ` (${s.endedBecause ?? "it exited"})`),
        );
      }
      if (Date.now() > deadline) {
        await s.close();
        throw new Error(
          `the isolated runtime on port ${port} did not answer within 40 s` +
            (stderr.trim() ? `\n${stderr.trim().split("\n").slice(-5).join("\n")}` : ""),
        );
      }
      try {
        await s.open();
        await s.call("ping", {}, 3000);
        break;
      } catch {
        await sleep(250);
      }
    }
    return s;
  }

  private open(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const fail = (e: Error): void => { ws.removeAllListeners(); reject(e); };
      ws.once("error", fail);
      ws.once("open", () => {
        ws.removeListener("error", fail);
        ws.on("message", (buf: Buffer) => this.onMessage(buf));
        ws.on("close", () => this.failAllPending(new Error(this.endedBecause ?? "the runtime closed the connection")));
        ws.on("error", () => { /* surfaced through the pending calls */ });
        this.ws = ws;
        resolve();
      });
    });
  }

  private onMessage(buf: Buffer): void {
    // The daemon also pushes binary A/V frames; only JSON with an id is ours.
    let m: { id?: number; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
    else p.resolve(m.result);
  }

  private failAllPending(e: Error): void {
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<T> {
    if (this.closed) throw new Error(this.endedBecause ?? "the sandbox is closed");
    await this.open();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: SESSION_ID, ...params } }));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reaper) clearTimeout(this.reaper);
    try { this.ws?.close(); } catch { /* going away anyway */ }
    this.ws = null;
    if (this.daemonPid) { try { process.kill(this.daemonPid, "SIGTERM"); } catch { /* already gone */ } }
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      for (let i = 0; i < 20 && this.child.exitCode === null; i++) await sleep(50);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    this.child = null;
    if (this.ownTmp) {
      try { rmSync(this.ownTmp, { recursive: true, force: true }); } catch { /* best effort */ }
      this.ownTmp = null;
    }
  }

  /** Why the sandbox went away, when it did so on its own. */
  get ended(): string | null { return this.endedBecause; }
}
