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
// The machine is the same daemon as the shared one (Spec 910): it free-runs from the moment it starts, and
// the clock is taken by stops, not by a machine that does not move — see `reel/session-boot.ts`. It is
// started with `--scratch <its own dir>`: the daemon opens every medium it is handed from a copy in that
// directory and writes only the copy, whatever method hands it over and however it ends, so no file of the
// project is ever changed by it. `start` checks that `session/state` reports it (`noWriteback`) and refuses
// to hand out a machine that does not.

import { WebSocket } from "ws";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDaemonSpawn } from "../runtime/resolve-daemon-spawn.js";
import { runtimeSetupRecipe } from "../runtime/setup-recipe.js";
import { platformProc, spawnHidden } from "../runtime/platform-proc.js";
import { wsShutdown } from "../runtime/process-end.js";
import { childEnv, registerProcess, unregisterProcess } from "../runtime/process-ledger.js";

const SESSION_ID = "integrated-1";
/** How long a sandbox may live before it ends itself, regardless of the caller. */
const DEFAULT_BUDGET_MS = 10 * 60_000;
/** The keeper waits this much past the budget, so the caller's own reaper — which can
 *  still say WHY the run ended — normally gets there first. */
const KEEPER_GRACE_MS = 5_000;

/**
 * The keeper (see the header), run as `node -e`. argv: a JSON of [parentPid, budgetMs, scratchDir, endModuleUrl, cmd,
 * ...args]. It reports the daemon's pid on stdout, passes the daemon's stderr through, exits with the daemon, and
 * forwards a SIGTERM/SIGINT. Parent gone is asked two ways: a changed ppid (POSIX reparents an orphan) and
 * `kill(parent, 0)` failing (Windows does not reparent).
 *
 * The keeper has NO end of its own (Spec 910 D5). A sandbox SESSION (it has a record) is ended by `endFromKeeper` of
 * `runtime/sandbox-end.js` — the very function the owner's end runs: finalize a recording trace, record the outcome,
 * stop the daemon, remove the scratch. A daemon without a record (the trace reader) is a plain child: it is signalled
 * and its scratch removed once its owner is gone.
 */
const KEEPER = `
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
const [parent, budget, scratch, endUrl, cmd, ...args] = JSON.parse(process.argv[1]);
const record = process.env.C64RE_KEEPER_RECORD;
const port = process.env.C64RE_KEEPER_PORT;
// The daemon's stderr goes THROUGH the keeper, not past it: handed the owner's pipe directly, the daemon
// wrote its log lines into a pipe whose reader had died with the owner, and a Rust daemon panics on a
// failed write to stderr — it died with the owner, in the same instant, with its trace unflushed. The
// keeper keeps reading for as long as the daemon lives and passes the lines on while anyone is listening.
const d = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
process.stderr.on("error", () => {});
d.stderr.on("data", (b) => { try { process.stderr.write(b); } catch {} });
process.stdout.on("error", () => {});
process.stdout.write(String(d.pid) + "\\n");
let orphaned = false;
let exited = false;
let why = null;
let ending = null;
const parentGone = () => {
  if (process.ppid !== parent) return true;
  try { process.kill(parent, 0); return false; } catch { return true; }
};
const kill = (sig) => { try { d.kill(sig); } catch {} };
const modP = record && port && endUrl
  ? import(endUrl).catch((e) => { process.stderr.write("keeper: cannot load the shared end (" + endUrl + "): " + e.message + "\\n"); return null; })
  : Promise.resolve(null);
// The daemon goes away: the polite request has been sent by the end; wait for it, then the signal, then the hard one.
const stopDaemon = () => new Promise((resolve) => {
  if (exited) return resolve();
  d.once("exit", () => resolve());
  setTimeout(() => kill("SIGTERM"), 3000).unref();
  setTimeout(() => kill("SIGKILL"), 4500).unref();
});
const end = (reason) => {
  why = why || reason;
  if (ending) return ending;
  ending = (async () => {
    const mod = await modP;
    if (mod) {
      try { await mod.endFromKeeper({ recordPath: record, port: Number(port), reason: why, scratchDir: scratch, stopDaemon }); }
      catch (e) { process.stderr.write("keeper: the end failed: " + e.message + "\\n"); kill("SIGTERM"); }
      return;
    }
    kill("SIGTERM");
    await stopDaemon();
    if (reason === "owner gone" && scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
  })();
  return ending;
};
d.on("exit", async (code) => {
  exited = true;
  // Asked again here, not only by the poll: measured, the daemon could be gone before the poll had noticed the caller was.
  if (!ending && (orphaned || parentGone())) { orphaned = true; await end("owner gone"); }
  else if (ending) await ending;
  process.exit(code ?? 1);
});
d.on("error", () => process.exit(127));
setTimeout(() => { void end("budget"); }, budget);
setInterval(() => {
  if (!orphaned && parentGone()) { orphaned = true; void end("owner gone"); }
}, 500);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => kill("SIGTERM"));
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The shared end (`runtime/sandbox-end.js`) as a URL a plain `node -e` keeper can import: the built module beside this one. */
function endModuleUrl(): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "sandbox-end.js")).href;
}

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
  /** Where the daemon keeps its project scratch. A temp dir by default, removed on close. The sandbox's own
   *  scratch — the copies of every medium mounted in it — is a temp dir either way, never this one. */
  projectDir?: string;
  /** Spec 863 — which C64 the machine is (a row of the runtime's model table, e.g.
   *  `c64-ntsc`). Omitted: the runtime's default. A name it cannot run is refused by the
   *  runtime at startup, and that refusal is what `start` throws. */
  model?: string;
  /** Spec 906 — the record file of a sandbox SESSION (`runtime_sandbox_start`). When set, the keeper ends the
   *  daemon the polite way (the runtime's own shutdown request, so a recording trace is finished) and writes
   *  why into this record if its owner has not already: "budget" or "owner gone". */
  recordFile?: string;
  /** Spec 906 — told when the daemon exits by itself (a crash, a runtime that quit), not when `close` ended it. */
  onExit?: (why: string) => void;
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
  private registered: Promise<unknown> = Promise.resolve();

  /** The daemon's `--scratch` dir: its copies of every medium it is handed. Inside the sandbox's own temp dir. */
  private scratch = "";

  private constructor(readonly port: number) {}

  static async start(opts: SandboxOptions = {}): Promise<SandboxSession> {
    const port = await freePort();
    const s = new SandboxSession(port);
    // The scratch exists whether or not the daemon is given a project dir: it holds the copies of every
    // medium handed to this machine (`--scratch`), and goes when the daemon is gone.
    s.ownTmp = mkdtempSync(join(tmpdir(), "c64re-reel-"));
    s.scratch = join(s.ownTmp, "scratch");
    const projectDir = opts.projectDir ?? s.ownTmp;

    const plan = resolveDaemonSpawn({ repoRoot: repoRoot(), projectDir, port: String(port), model: opts.model, scratch: s.scratch });
    if (plan.mode === "none") {
      throw new Error(runtimeSetupRecipe("no runtime binary available for an isolated capture run"));
    }

    const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    // The keeper is the child; the daemon is ITS child. Neither may survive this command, and
    // the keeper makes sure of it when this process cannot. On POSIX it is not detached. On
    // Windows it must be: libuv puts every attached child into a job object that kills it the
    // instant this process is killed hard, so the keeper died with its owner and never ended the
    // daemon the polite way (trace unfinalized, scratch left, record never "owner gone").
    // Detached, it outlives the owner just long enough to do that; the daemon stays attached
    // to the keeper, so it still cannot outlive the keeper.
    s.child = spawnHidden(process.execPath, [
      "-e", KEEPER,
      JSON.stringify([process.pid, budget + KEEPER_GRACE_MS, s.ownTmp ?? "", opts.recordFile ? endModuleUrl() : "", plan.cmd, ...plan.args]),
    ], {
      detached: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childEnv("sandbox"), C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: String(port),
        ...(opts.recordFile ? { C64RE_KEEPER_RECORD: opts.recordFile, C64RE_KEEPER_PORT: String(port) } : {}),
      },
    });
    s.child.stdout?.once("data", (b: Buffer) => {
      const pid = Number.parseInt(b.toString(), 10);
      if (Number.isFinite(pid)) {
        s.daemonPid = pid;
        // Spec 902 D1 — a sandbox is in the ledger too, so `c64re down` ends it. It is never held
        // back by the hold (D3): it has a budget and ends itself.
        s.registered = registerProcess({ pid, kind: "sandbox", port, project: projectDir, startedBy: "sandbox", owner: process.pid });
      }
    });
    let stderr = "";
    let exited = false;
    s.child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    s.child.once("exit", (code) => {
      exited = true;
      if (!s.closed) {
        s.endedBecause = `the runtime exited with code ${code}`;
        opts.onExit?.(s.endedBecause);
      }
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
    // The daemon must say it took `--scratch`: a runtime that ignores the option (an older pin) would write a
    // medium back into the file it was handed, and a sandbox that can do that is not handed out.
    try {
      const st = await s.call<{ noWriteback?: boolean }>("session/state", {}, 10_000);
      if (st?.noWriteback !== true) {
        throw new Error(
          "the runtime did not report `noWriteback` after `--scratch`: it would write a mounted disk or cartridge back into the " +
          "file it was opened from, so no sandbox was started. Update the runtime (c64re runtime install).");
      }
    } catch (e) {
      await s.close();
      throw e;
    }
    // In the ledger before anyone gets it: a `down` right after the start must find it. Reading
    // the OS identity is slow on Windows (PowerShell), so this is awaited, not left to race.
    await s.registered.catch(() => undefined);
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
      // The session is the daemon's own, whatever name the caller's tool call carried (a session
      // id `sb-…` names THIS object; the machine inside it is `integrated-1`): it is set last.
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, session_id: SESSION_ID } }));
    });
  }

  /** The daemon goes away (the polite request first, then the signal) and its keeper with it. The scratch stays: see `removeScratch`. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reaper) clearTimeout(this.reaper);
    try { this.ws?.close(); } catch { /* going away anyway */ }
    this.ws = null;
    if (this.daemonPid) {
      const pid = this.daemonPid;
      await this.registered;
      // Spec 902 D6: through the platform layer — SIGTERM on POSIX, the runtime's own shutdown request on Windows.
      await platformProc.end(pid, { graceMs: 3000, ask: async () => (await wsShutdown(this.port)).accepted });
      unregisterProcess(pid);
    }
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      for (let i = 0; i < 20 && this.child.exitCode === null; i++) await sleep(50);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    this.child = null;
  }

  /** The temp dir (the daemon's `--scratch` and, unless a project dir was given, its project dir) is removed. Only after `stop`: the daemon's exit work writes into it. */
  removeScratch(): void {
    if (!this.ownTmp) return;
    try { rmSync(this.ownTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    this.ownTmp = null;
  }

  /** `stop`, then `removeScratch`. */
  async close(): Promise<void> {
    await this.stop();
    this.removeScratch();
  }

  /** Why the sandbox went away, when it did so on its own. */
  get ended(): string | null { return this.endedBecause; }

  /** The sandbox's temp dir: the daemon's `--scratch` dir (its copies of every medium it was handed) and, unless a project dir was given, its project dir. Removed on close. */
  get scratchDir(): string | null { return this.ownTmp; }
}
