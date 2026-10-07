// Spec 744.4c — MCP-side Runtime Daemon client.
//
// When `C64RE_RUNTIME_ENDPOINT` is set, the product MCP runtime tools become
// CLIENTS of the Runtime Daemon (they must NOT create a private IntegratedSession
// in the MCP process — binding rule §36). The daemon IS the V3 runtime WS server
// (the same WS the browser UI uses, port 4312) — we do NOT invent a second API.
// This thin client speaks that existing V3 JSON-RPC protocol; the LLM never sees
// it, it sees stable `runtime_*` tools (§124). MCP + UI thus hit ONE authority that
// outlives MCP reconnects and browser reloads (§37/§38).
//
// If the endpoint is set but the daemon is unreachable, calls fail with an
// actionable error (§236) — never a silent in-process fallback.

import { WebSocket } from "ws";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";
import { resolveDaemonSpawn } from "./resolve-daemon-spawn.js";
import { EXPECTED_RUNTIME_PROTOCOL, parseRuntimeProtocol, runtimeSetupRecipe } from "./setup-recipe.js";
import { idleExitSeconds, noteFreshRuntime } from "./idle-exit.js";
import { RuntimeMethods, type BackendIdentity, type BackendNotification } from "./runtime-methods.js";

/** The product Runtime Daemon always listens here unless overridden. The UI
 *  targets this directly even when the MCP env has no endpoint configured. */
export const DEFAULT_RUNTIME_ENDPOINT = "ws://127.0.0.1:4312";

export function runtimeEndpoint(): string {
  const e = process.env.C64RE_RUNTIME_ENDPOINT;
  if (e && e.trim()) return e.trim();
  // Spec 806: there is exactly one runtime and it is a separate daemon process, so this
  // never returns undefined. The in-process opt-out (C64RE_ALLOW_INPROC_RUNTIME=1) went
  // with the TS emulator — there is no second machine to fall back to, and "no endpoint"
  // would only produce a tool that silently does nothing.
  return DEFAULT_RUNTIME_ENDPOINT;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Try one WS connection (resolves the socket or rejects with the ws error). */
/**
 * This client's socket speaks RPC only. Without `?av=0` the daemon pushes it every frame
 * and the audio it will never read, and counts it as a viewer — which holds the idle
 * clock (TRX64 887) for as long as the MCP lives, so an open Claude window kept a
 * machine up forever. A daemon that does not know the parameter ignores it.
 */
function rpcOnly(endpoint: string): string {
  return endpoint + (endpoint.includes("?") ? "&" : "?") + "av=0";
}

function tryOpen(endpoint: string, timeoutMs = 2500): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("connect timeout")); }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Spec 746.x — LIVENESS check: a TCP connect (`open`) is NOT enough. A hung daemon
 * (100% CPU, dead event loop — the BUG-027-B3 idle-free-run zombie) still holds the
 * port + may even accept the socket, but never answers. So we open AND round-trip a
 * `ping` (the `{pong}` handler). Returns:
 *   "healthy"  — connected + got pong within timeout
 *   "stall"    — connected (port held) but NO pong → a wedged daemon
 *   "down"     — could not connect at all (no daemon)
 */
/** Product build seen by the last successful liveness ping (the pong carries it). Lets the
 *  health probe report WHICH daemon build answered without opening a second connection. */
let lastProbedBuild: string | undefined;

async function probeLiveness(endpoint: string, pingTimeoutMs = 3000): Promise<"healthy" | "stall" | "down"> {
  let ws: WebSocket;
  try { ws = await tryOpen(endpoint, Math.min(1500, pingTimeoutMs)); }
  catch { return "down"; }
  try {
    const pong = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), pingTimeoutMs);
      const id = 999999;
      const onMsg = (data: unknown) => {
        try {
          const m = JSON.parse(String(data));
          if (m.id === id) {
            // The pong carries the daemon's product build (and its protocol epoch) — keep
            // the build so the health probe can name it. Compatibility is gated elsewhere.
            const v = m?.result?.version;
            if (typeof v === "string" && v) lastProbedBuild = v;
            clearTimeout(timer); ws.off("message", onMsg as never); resolve(true);
          }
        } catch { /* ignore */ }
      };
      ws.on("message", onMsg as never);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: {} }));
    });
    return pong ? "healthy" : "stall";
  } catch {
    return "stall";
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

/** Spec 746.x — kill whatever process is LISTENing on the endpoint's port (the
 *  wedged daemon). Best-effort, localhost only. Uses lsof + kill -9. */
function killStalledDaemon(endpoint: string): boolean {
  const m = endpoint.match(/^wss?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
  if (!m) return false; // only self-heal a localhost daemon
  const port = m[1];
  try {
    // NB: top-level ESM import of execSync — `require()` is undefined in this ESM
    // module (package.json type:module), so the old require() form threw + the kill
    // silently never happened (the zombie survived). This is the real BUG.
    execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec 744.4c — auto-start the Runtime Daemon (detached) so the human never has to
 * launch the backend by hand. Detached + unref'd → it OUTLIVES this MCP process, so
 * an MCP reconnect attaches to the same running daemon (sessions are not reset). A
 * second MCP racing to spawn just loses the port bind and its client retries onto
 * the winner. Disable with C64RE_RUNTIME_AUTOSTART=0.
 */
function spawnDaemonDetached(endpoint: string, projectDirArg?: string): boolean {
  if (process.env.C64RE_RUNTIME_AUTOSTART === "0") return false;
  // Spec 744.4c (fix A) — prefer the project the MCP tool resolved (config-agnostic:
  // works whether C64RE_PROJECT_DIR is in the env or derived from the MCP context),
  // falling back to the env. The daemon is per-project, so it must know which one.
  const projectDir = projectDirArg ?? process.env.C64RE_PROJECT_DIR;
  if (!projectDir) return false;
  const m = endpoint.match(/^wss?:\/\/[^/:]+:(\d+)/);
  const port = m ? m[1] : "4312";
  // Repo root from this module: <repo>/{src|dist}/server-tools/runtime-daemon-client.{ts|js}
  const here = fileURLToPath(import.meta.url);
  const repo = resolvePath(dirname(here), "..", "..");
  // Spec 771.1 — ONE resolver picks the binary (C64RE_RUNTIME_BIN, the install cache,
  // PATH, the sibling build); Spec 806 left no second backend to fall back to.
  const plan = resolveDaemonSpawn({ repoRoot: repo, projectDir, port });
  if (plan.mode === "none") return false;
  if (plan.warn) console.error(`[c64-re mcp] WARNING: ${plan.warn}`);
  // Spec 886 — detached, so it survives a reconnect; and therefore it ends ITSELF after
  // the idle window (TRX64 887), or nothing ever would.
  const idle = idleExitSeconds();
  const args = idle > 0 ? [...plan.args, "--idle-exit", String(idle)] : plan.args;
  try {
    const child = spawn(plan.cmd, args, {
      cwd: repo, detached: true, stdio: "ignore",
      env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: port },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec 744.4c — idempotent, fire-and-forget "make sure the daemon is up".
 * The ONE helper behind all three start triggers — MCP eager start (cli.ts),
 * the UI dev-server (vite plugin), and the lazy first-tool-call path. Whoever
 * is first (human opening the UI, or the LLM calling a runtime tool) brings the
 * shared runtime up; the rest see it already running. Never throws. Race-safe:
 * if several callers spawn at once, the OS port-bind picks exactly one winner and
 * the loser daemons exit cleanly (run.ts EADDRINUSE → exit 0).
 */
export async function ensureDaemon(
  opts?: { endpoint?: string; projectDir?: string },
): Promise<"already-up" | "spawned" | "skipped" | "failed"> {
  try {
    if (process.env.C64RE_RUNTIME_AUTOSTART === "0") return "skipped";
    const endpoint = opts?.endpoint ?? runtimeEndpoint();
    // Spec 746.x — LIVENESS, not just port-open. A wedged daemon (100% CPU, dead
    // event loop) holds the port but never answers → before, eager-spawn saw the
    // port held and gave up, so the zombie stayed forever and no session came up.
    const health = await probeLiveness(endpoint);
    if (health === "healthy") return "already-up";
    if (health === "stall") {
      // self-heal: kill the wedged daemon, then spawn a fresh one onto the freed port.
      console.error(`[c64-re mcp] runtime daemon at ${endpoint} is STALLED (no pong) — killing it + respawning.`);
      killStalledDaemon(endpoint);
      // wait for the port to actually release (kill -9 + socket teardown is not instant)
      // before spawning, else the fresh daemon hits EADDRINUSE and exits as a race loser.
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        if ((await probeLiveness(endpoint, 500)) === "down") break;
      }
    }
    return spawnDaemonDetached(endpoint, opts?.projectDir) ? "spawned" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Spec 889 — the EMULATOR implementation of the runtime backend: the TRX64 daemon, exactly as
 * before. `call` sends the method name to the daemon unchanged; nothing is routed, refused or
 * gated here. The C64 Ultimate is the other implementation (`c64u-backend.ts`); which one the
 * tools reach is decided in `backend.ts`, by an explicit choice and never by fallback.
 */
export class RuntimeDaemonClient extends RuntimeMethods {
  readonly kind = "emulator" as const;
  private readonly noteHandlers = new Set<(n: BackendNotification) => void>();
  /** Notifications the daemon pushes on this client's socket (it speaks RPC only, `av=0`). */
  onNotification(handler: (n: BackendNotification) => void): () => void {
    this.noteHandlers.add(handler);
    return () => { this.noteHandlers.delete(handler); };
  }
  /** Names the emulator and where it lives; never connects (a status line must not start a daemon). */
  async describe(): Promise<BackendIdentity> {
    return { kind: "emulator", label: "Emulator (the default runtime)", endpoint: runtimeEndpoint(), version: this.runtimeBuild };
  }
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private projectDir?: string;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** The MCP tool tells the client which project it resolved, so an auto-started
   *  daemon serves that project even when C64RE_PROJECT_DIR is not in the env. */
  setProjectDir(dir: string | undefined): void { if (dir) this.projectDir = dir; }

  private protocolOk = false;
  /** Spec 886 D4 — whether this process has had a daemon, so a later spawn is a RE-spawn. */
  private everConnected = false;
  /** Product build reported by the connected daemon (see handshakeProtocol). */
  private runtimeBuild: string | undefined;

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithAutostart();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  private async connectWithAutostart(): Promise<WebSocket> {
    const endpoint = runtimeEndpoint();
    // 1) already up AND alive? (liveness, not just port-open — a wedged daemon holds
    //    the port but never answers; ping it before trusting the connection.)
    const health = await probeLiveness(endpoint);
    if (health === "healthy") {
      let ws: WebSocket | null = null;
      try { ws = this.wire(await tryOpen(rpcOnly(endpoint))); } catch { /* fall through to respawn */ }
      if (ws) { await this.handshakeProtocol(); return ws; }
    } else if (health === "stall") {
      console.error(`[c64-re mcp] runtime daemon at ${endpoint} is STALLED — killing it + respawning.`);
      killStalledDaemon(endpoint);
      for (let i = 0; i < 20; i++) { await sleep(150); if ((await probeLiveness(endpoint, 500)) === "down") break; }
    }
    // 2) auto-start the daemon (detached, outlives this MCP) then poll for it.
    const spawned = spawnDaemonDetached(endpoint, this.projectDir);
    // Spec 886 D4 — this process had a machine and it is gone: the daemon ended itself
    // when idle (or was stopped). Say so in the next answer; its state does not come back.
    if (spawned && this.everConnected) {
      noteFreshRuntime(
        "NOTE: the runtime had ended — it ends itself after being idle — so this call started a fresh " +
          "machine. Its sessions, mounted media, checkpoints and rewind history are gone; mount and load " +
          "again. runtime_keep_alive keeps a runtime that has to stay up.",
      );
    }
    const deadlineMs = spawned ? 40_000 : 4_000; // booting the default session takes a few s
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      await sleep(400);
      let ws: WebSocket | null = null;
      try { ws = this.wire(await tryOpen(rpcOnly(endpoint))); } catch { /* keep polling */ }
      if (ws) { await this.handshakeProtocol(); return ws; }
    }
    throw new Error(runtimeSetupRecipe(
      `no runtime daemon reachable at ${endpoint}` +
      (spawned ? " (auto-start was attempted but it did not come up in time)" : "")));
  }

  /** Spec 800 §D — verify the daemon speaks our exact protocol epoch, once per connection.
   *  A confirmed mismatch hard-fails with the setup recipe; a daemon that reports no version
   *  (predates the handshake, same wire epoch) is tolerated. */
  private async handshakeProtocol(): Promise<void> {
    if (this.protocolOk) return;
    let pong: { runtime_version?: string; version?: string } | undefined;
    try { pong = await this.call<{ runtime_version?: string; version?: string }>("ping", {}, 5000); }
    catch { return; } // liveness already confirmed; do not block on a flaky ping
    // The daemon reports TWO independent numbers: the wire-protocol epoch (hard-checked)
    // and its PRODUCT build version (informational). Two builds can share an epoch and
    // still differ, so surface the build — it answers "is this an ancient daemon?".
    this.runtimeBuild = pong?.version;
    const got = parseRuntimeProtocol(pong?.runtime_version);
    if (got == null) { this.protocolOk = true; return; }
    if (got !== EXPECTED_RUNTIME_PROTOCOL) {
      throw new Error(runtimeSetupRecipe(
        `runtime protocol mismatch — the daemon (build ${pong?.version ?? "unknown"}) speaks ` +
        `trx64-runtime/${got}, but this C64RE needs trx64-runtime/${EXPECTED_RUNTIME_PROTOCOL}. ` +
        `Rebuild/restart the runtime.`));
    }
    this.protocolOk = true;
  }

  /** The connected daemon's PRODUCT build (e.g. "0.1.0"), or undefined if it predates the
   *  handshake. Informational — the epoch is what gates compatibility. */
  get runtimeBuildVersion(): string | undefined { return this.runtimeBuild; }

  private wire(ws: WebSocket): WebSocket {
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => { this.ws = null; this.protocolOk = false; this.failAll(new Error("runtime daemon connection closed")); });
    ws.on("error", () => { /* surfaced per-call via timeouts / failAll */ });
    this.ws = ws;
    this.everConnected = true;
    return ws;
  }

  private onMessage(raw: string): void {
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id == null) { // notification: hand it to whoever listens; the client itself ignores it
      const n = m as unknown as { method?: string; params?: unknown };
      if (typeof n.method === "string") for (const h of this.noteHandlers) { try { h({ method: n.method, params: n.params }); } catch { /* a listener must not break the socket */ } }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }

  private failAll(e: Error): void {
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  /** One V3 JSON-RPC 2.0 request → response. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    const ws = await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`runtime daemon timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // The typed wrappers over the method names live on RuntimeMethods (runtime-methods.ts).
}

/** Singleton emulator client (one connection per MCP process). Tools do NOT import this:
 *  they reach `runtimeDaemon` in `backend.ts`, which is whichever backend is selected. */
export const emulatorDaemon = new RuntimeDaemonClient();

/**
 * Spec 800 §C — a software-owned runtime availability probe for the setup boundary
 * (agent_onboard, first-run). Warm-starts a daemon if one can be started; reports
 * "unavailable" + the per-OS setup recipe ONLY when nothing is reachable and nothing can be
 * started. Never throws. The RE-agent relays the recipe to the user — it is the one place the
 * runtime backend is named.
 */
export async function runtimeHealth(): Promise<
  { ok: true; build?: string } | { ok: false; reason: string; recipe: string }
> {
  const endpoint = runtimeEndpoint();
  let ensured: string;
  try { ensured = await ensureDaemon({ endpoint }); }
  catch { ensured = "failed"; }
  // `build` = the daemon's PRODUCT version, learned during the ping handshake (undefined
  // for a daemon that predates it). Informational: compatibility is gated on the epoch.
  if (ensured === "already-up" || ensured === "spawned") return { ok: true, build: emulatorDaemon.runtimeBuildVersion ?? lastProbedBuild };
  if ((await probeLiveness(endpoint, 1500)) === "healthy") return { ok: true, build: emulatorDaemon.runtimeBuildVersion ?? lastProbedBuild };
  const reason = `no runtime daemon reachable at ${endpoint} and none could be started`;
  return { ok: false, reason, recipe: runtimeSetupRecipe(reason) };
}
