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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";

/** The product Runtime Daemon always listens here unless overridden. The UI
 *  targets this directly even when the MCP env has no endpoint configured. */
export const DEFAULT_RUNTIME_ENDPOINT = "ws://127.0.0.1:4312";

export function runtimeEndpoint(): string | undefined {
  const e = process.env.C64RE_RUNTIME_ENDPOINT;
  return e && e.trim() ? e.trim() : undefined;
}

export function isDaemonMode(): boolean {
  return !!runtimeEndpoint();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Try one WS connection (resolves the socket or rejects with the ws error). */
function tryOpen(endpoint: string, timeoutMs = 2500): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("connect timeout")); }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
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
  // PERF (Spec 744.4c) — the daemon is a long-lived ~1MHz emulation loop. Under
  // tsx-from-src it runs ~12× SLOWER (measured: 80k vs 985k cyc/s = 4fps vs 50fps),
  // because tsx transpiles without V8's optimizing tiers warming the hot path the
  // same way. So ALWAYS prefer the built node/dist entry — EVEN when this MCP itself
  // runs under tsx (the MCP is I/O-bound, the daemon is CPU-bound; they need not match
  // runtimes). Fall back to tsx only if dist is absent, with a loud slow-mode warning.
  const distEntry = resolvePath(repo, "dist/runtime/headless/daemon/run.js");
  let cmd: string; let args: string[];
  if (existsSync(distEntry)) {
    cmd = process.execPath;
    args = [distEntry, "--project", projectDir, "--port", port];
  } else {
    const tsxBin = resolvePath(repo, "node_modules", ".bin", "tsx");
    const srcEntry = resolvePath(repo, "src/runtime/headless/daemon/run.ts");
    if (!existsSync(tsxBin) || !existsSync(srcEntry)) return false;
    console.error(`[c64-re mcp] WARNING: runtime daemon falling back to tsx-from-src — ~12× slower (≈4fps). Run \`npm run build:mcp\` for full-speed (50fps).`);
    cmd = tsxBin;
    args = [srcEntry, "--project", projectDir, "--port", port];
  }
  try {
    const child = spawn(cmd, args, {
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
    const endpoint = opts?.endpoint ?? runtimeEndpoint() ?? DEFAULT_RUNTIME_ENDPOINT;
    // already up? (cheap pre-check — avoids a redundant spawn in the common case)
    try { const ws = await tryOpen(endpoint, 800); ws.close(); return "already-up"; } catch { /* down */ }
    return spawnDaemonDetached(endpoint, opts?.projectDir) ? "spawned" : "failed";
  } catch {
    return "failed";
  }
}

class RuntimeDaemonClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private projectDir?: string;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** The MCP tool tells the client which project it resolved, so an auto-started
   *  daemon serves that project even when C64RE_PROJECT_DIR is not in the env. */
  setProjectDir(dir: string | undefined): void { if (dir) this.projectDir = dir; }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithAutostart();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  private async connectWithAutostart(): Promise<WebSocket> {
    const endpoint = runtimeEndpoint();
    if (!endpoint) throw new Error("C64RE_RUNTIME_ENDPOINT not set");
    // 1) already up?
    try { return this.wire(await tryOpen(endpoint)); } catch { /* not up yet */ }
    // 2) auto-start the daemon (detached, outlives this MCP) then poll for it.
    const spawned = spawnDaemonDetached(endpoint, this.projectDir);
    const deadlineMs = spawned ? 40_000 : 4_000; // booting the default session takes a few s
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      await sleep(400);
      try { return this.wire(await tryOpen(endpoint)); } catch { /* keep polling */ }
    }
    throw new Error(
      `Runtime daemon not reachable at ${endpoint}` +
      (spawned ? ` (auto-started it but it did not come up in time — check \`npm run runtime:daemon\`).`
               : `. Start it with \`npm run runtime:daemon\` (it owns the shared C64 runtime ` +
                 `the LLM and the UI both attach to — Spec 744.4c). ` +
                 (process.env.C64RE_PROJECT_DIR ? "" : "Also set C64RE_PROJECT_DIR.")),
    );
  }

  private wire(ws: WebSocket): WebSocket {
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => { this.ws = null; this.failAll(new Error("runtime daemon connection closed")); });
    ws.on("error", () => { /* surfaced per-call via timeouts / failAll */ });
    this.ws = ws;
    return ws;
  }

  private onMessage(raw: string): void {
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id == null) return; // notification (frame push etc.) — ignore on this client
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

  // -- typed wrappers over the V3 protocol (the acceptance-critical surface) --
  createSession(p: { disk_path?: string; device_id?: number; pal?: boolean; start_track?: number; write_protected?: boolean; trace_out?: string; trace_domains?: string[] }) {
    return this.call<{ sessionId: string; mode: string; diskPath: string; c64Cycles: number; pc: number; trace: unknown }>("session/create", p);
  }
  listSessions() { return this.call<Array<{ sessionId: string; mode: string; diskPath: string; c64Cycles: number }>>("session/list"); }
  state(sessionId: string) { return this.call<{ c64Cycles: number; mode: string; cpu: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number } }>("session/state", { session_id: sessionId }); }
  closeSession(sessionId: string) { return this.call<{ existed: boolean; released: string[] }>("session/close", { session_id: sessionId }); }
  /** Bounded run (cycles), tool-mode. The V3 session/run advances by a cycle budget. */
  run(sessionId: string, cycles: number) { return this.call<{ state: unknown }>("session/run", { session_id: sessionId, cycles }); }
  /** Live continuous run (UI Live mode). */
  runLive(sessionId: string, pacing?: unknown) { return this.call("debug/run", { session_id: sessionId, pacing }); }
  pause(sessionId: string) { return this.call("debug/pause", { session_id: sessionId }); }
  resume(sessionId: string) { return this.call("debug/continue", { session_id: sessionId }); }
  /** Returns { dataUrl } base64 PNG; caller writes to disk if a path is needed. */
  screenshot(sessionId: string) { return this.call<{ dataUrl?: string; width?: number; height?: number }>("session/screenshot", { session_id: sessionId }); }
  mark(sessionId: string, label: string) { return this.call("runtime/mark", { session_id: sessionId, label }); }

  /** Spec 744.4c slice 2 — invoke an AgentQueryApi method on the SHARED daemon
   *  session (monitor/step/breakpoint analysis). Returns the same value the
   *  in-process `createAgentQueryApi({session})[method](...args)` would, with
   *  TypedArrays normalized to plain arrays daemon-side. */
  apiCall<T = unknown>(sessionId: string, method: string, args: unknown[] = []) {
    return this.call<T>("api/call", { session_id: sessionId, method, args });
  }
}

/** Singleton client (one connection per MCP process). */
export const runtimeDaemon = new RuntimeDaemonClient();
