// Spec 889 §11 — the C64U bridge: the facade as a daemon of its own.
//
// A WebSocket server that speaks the TRX64 daemon's wire protocol — JSON-RPC 2.0 text frames, the
// same notifications, the binary A/V frames (`[type u8][seq u32 LE][payload]`, 0x01 VIC frame,
// 0x02 audio) — and answers it from a C64 Ultimate instead of an emulated machine. It holds the
// ONE device connection (trxmon serves one RPC client) and the UDP streams, and serves any number
// of clients: the MCP server, the browser, a CLI. Notifications go to all; picture and sound to the
// A/V subscribers (a client that did not connect with `?av=0`).
//
// Everything that talks to the device is `C64UBackend`'s: the routing table, the REST mapping, the
// refusals by name, the break_* wrappers, the re-read after REST, the trxmon-gone message, the
// capabilities check and the streams. This file adds only what a daemon has around that: the
// socket, the client set, `ping`, the project binding (`project/set`) the gate (§4b) reads, the
// idle clock (Spec 886/887) and the lifecycle.
//
// Bound to 127.0.0.1 only: the app's RPC port has no auth and this one must not widen it.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { BackendRefusal, C64UBackend, type ConnectReport, type StreamsConfig } from "../c64u/c64u-backend.js";
import { RpcError } from "../c64u/rpc-link.js";
import type { BackendNotification } from "../runtime-methods.js";
import { IdleClock } from "./idle-clock.js";

/** The protocol epoch a client hard-checks; the daemon's own (`setup-recipe.ts` pins the same). */
export const BRIDGE_RUNTIME_VERSION = "trx64-runtime/2";

/** A slow browser must not make the bridge buffer without bound: video is latest-frame-wins. */
const VIDEO_BACKLOG_LIMIT = 4 * 1024 * 1024;
const AUDIO_BACKLOG_LIMIT = 1024 * 1024;

export type BridgeState = "connecting" | "ready" | "failed";

export interface BridgeOptions {
  host: string;
  restPort?: number;
  rpcPort?: number;
  /** REST password; memory only. */
  password?: string;
  trxmonPath?: string;
  /** Start trxmon first when the ident says it is not running (§3a). */
  startMonitor?: boolean;
  /** Leave the machine paused after the connect. */
  paused?: boolean;
  /** Do not start the UDP streams at connect; `bridge/begin_streams` does (a switch from another device frees the fixed ports first). */
  deferStreams?: boolean;
  /** The project the gate looks in (the daemon's chain: `project/set`, else this, else `C64RE_PROJECT_DIR`). */
  projectDir?: string;
  streams?: false | StreamsConfig;
  /** TCP port; 0 = the OS's choice. */
  port: number;
  /** Idle exit in seconds, 0 = never. */
  idleExitSeconds?: number;
  /** Called once the port is listening, before the device connect begins (the registry entry is written here). */
  onListening?: (bridge: BridgeServer) => void;
  /** Called first thing when the bridge starts to end (the registry entry goes before anything slow, so nobody attaches to a bridge on its way out). */
  onStopping?: () => void;
  /** Called when the bridge ends itself (idle, `bridge/shutdown`, a failed connect). */
  onExit?: (reason: string, code: number) => void;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface Client {
  ws: WebSocket;
  av: boolean;
  audio: boolean;
  peer: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function productVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "..", "package.json"), "utf8")) as { version?: string };
    return `c64u-bridge ${pkg.version ?? "unknown"}`;
  } catch { return "c64u-bridge unknown"; }
}

const LOOPBACK_ORIGIN = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A browser page of another origin must not be able to drive the machine: a handshake that carries an Origin must carry a loopback one. */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // a non-browser client sends none
  try { return LOOPBACK_ORIGIN.has(new URL(origin).hostname); } catch { return false; }
}

export class BridgeServer {
  readonly backend: C64UBackend;
  private http?: Server;
  private wss?: WebSocketServer;
  private readonly clients = new Set<Client>();
  private connectPromise?: Promise<void>;
  private _state: BridgeState = "connecting";
  private _error: string | undefined;
  private _notes: string[] = [];
  private _project: string | undefined;
  private idle: IdleClock;
  private idleTimer?: ReturnType<typeof setInterval>;
  private unsubs: Array<() => void> = [];
  private stopping?: Promise<void>;
  private _port = 0;
  private readonly version = productVersion();
  private readonly startedAt = Date.now();

  constructor(private readonly opts: BridgeOptions) {
    this._project = opts.projectDir || process.env.C64RE_PROJECT_DIR || undefined;
    this.backend = new C64UBackend({
      host: opts.host, restPort: opts.restPort, rpcPort: opts.rpcPort, password: opts.password,
      trxmonPath: opts.trxmonPath, fetchImpl: opts.fetchImpl, streams: opts.streams, projectDir: this._project,
    });
    this.idle = new IdleClock(opts.idleExitSeconds ?? 0);
  }

  get state(): BridgeState { return this._state; }
  get error(): string | undefined { return this._error; }
  get notes(): readonly string[] { return this._notes; }
  get port(): number { return this._port; }
  get endpoint(): string { return `ws://127.0.0.1:${this._port}`; }
  get project(): string | undefined { return this._project; }
  get clientCount(): number { return this.clients.size; }

  /** Listen, then connect to the device (in the background: `ping` answers `connecting` meanwhile). */
  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      // Plain HTTP on the port: say what this is, as the app's port does (426).
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("C64U bridge: this port speaks WebSocket JSON-RPC (the TRX64 daemon wire protocol)\n");
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.http.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (!originAllowed(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.opts.port, "127.0.0.1", () => {
        this._port = (this.http!.address() as { port: number }).port;
        resolve();
      });
    });

    this.opts.onListening?.(this);
    this.unsubs.push(this.backend.onNotification((n) => this.broadcast(n)));
    this.unsubs.push(this.backend.onBinary((m) => this.fanBinary(m.kind, m.data)));

    if ((this.opts.idleExitSeconds ?? 0) > 0) {
      this.idleTimer = setInterval(() => {
        this.idle.hold([...this.clients].some((c) => c.av) ? "subscriber" : null);
        if (this.idle.expired()) void this.shutdown(`idle for ${this.idle.armedSeconds} s`, 0);
      }, 1000);
      this.idleTimer.unref?.();
    }

    this.connectPromise = this.backend
      .connect({ startMonitor: this.opts.startMonitor, paused: this.opts.paused, deferStreams: this.opts.deferStreams })
      .then((r: ConnectReport) => {
        this._notes = r.notes;
        this._state = "ready";
        this.idle.touch();
      })
      .catch((e: unknown) => {
        this._error = e instanceof Error ? e.message : String(e);
        this._state = "failed";
        try { this.opts.onStopping?.(); } catch { /* */ }
      });
    void this.connectPromise.then(() => {
      // A failed connect holds nothing: the starter reads the verdict from `ping`, then the bridge goes.
      if (this._state === "failed") setTimeout(() => void this.shutdown(`connect failed: ${this._error}`, 1), 2500).unref?.();
    });
  }

  /** Resolves once the connect to the device has finished, either way (`state` then says which). */
  whenSettled(): Promise<void> { return this.connectPromise ?? Promise.resolve(); }

  /** Stop the streams (audio, then video), release the device's one connection, close every client. */
  shutdown(reason: string, code = 0): Promise<void> {
    this.stopping ??= (async () => {
      try { this.opts.onStopping?.(); } catch { /* */ }
      if (this.idleTimer) clearInterval(this.idleTimer);
      for (const u of this.unsubs) { try { u(); } catch { /* */ } }
      this.unsubs = [];
      try { await this.backend.closeAndWait(); } catch { /* the device is gone: the sockets are closed regardless */ }
      for (const c of this.clients) { try { c.ws.close(1001, `the C64U bridge ended (${reason})`); } catch { /* */ } }
      this.clients.clear();
      this.wss?.close();
      await new Promise<void>((r) => { if (!this.http) return r(); this.http.close(() => r()); setTimeout(r, 500).unref?.(); });
      this.opts.onExit?.(reason, code);
    })();
    return this.stopping;
  }

  // ---- clients -----------------------------------------------------------------------------------

  private broadcast(n: BackendNotification): void {
    const text = JSON.stringify({ jsonrpc: "2.0", method: n.method, params: n.params });
    for (const c of this.clients) { try { c.ws.send(text); } catch { /* the socket is closing */ } }
  }

  private fanBinary(kind: "video" | "audio", data: Uint8Array): void {
    for (const c of this.clients) {
      if (!c.av) continue;
      if (kind === "audio" && !c.audio) continue;
      if (c.ws.bufferedAmount > (kind === "video" ? VIDEO_BACKLOG_LIMIT : AUDIO_BACKLOG_LIMIT)) continue;
      try { c.ws.send(data, { binary: true }); } catch { /* the socket is closing */ }
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const avOff = url.searchParams.get("av") === "0" || url.searchParams.get("av") === "false";
    const client: Client = { ws, av: !avOff, audio: false, peer: `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}` };
    this.clients.add(client);
    this.idle.touch();
    ws.on("close", () => { this.clients.delete(client); });
    ws.on("error", () => { this.clients.delete(client); });
    // A page that connects while the machine is paused gets no video (none is sent): give it the
    // last picture and whether the stream is paused, so it shows what there is and says so.
    if (client.av) {
      const paused = this.backend.pausedState();
      try {
        if (paused) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "stream/paused", params: paused }));
        const last = this.backend.lastVideo();
        if (last) ws.send(last, { binary: true });
      } catch { /* the socket is closing */ }
    }
    ws.on("message", (data, isBinary) => { if (!isBinary) void this.onMessage(client, data.toString()); });
  }

  private async onMessage(client: Client, text: string): Promise<void> {
    this.idle.touch();
    const reply = (obj: unknown) => { try { client.ws.send(JSON.stringify(obj)); } catch { /* the socket is closing */ } };
    let m: { id?: number | string | null; method?: unknown; params?: unknown };
    try { m = JSON.parse(text); } catch { reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      reply({ jsonrpc: "2.0", id: (m as { id?: unknown } | null)?.id ?? null, error: { code: -32600, message: "invalid request: a JSON-RPC call needs a string `method`" } });
      return;
    }
    if (m.id === undefined) return; // a notification from the client: nothing to answer
    const params = isObj(m.params) ? m.params : {};
    try {
      const result = await this.dispatch(client, m.method, params);
      reply({ jsonrpc: "2.0", id: m.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : e instanceof BackendRefusal ? -32601 : e instanceof BridgeParamError ? -32602 : -32603;
      reply({ jsonrpc: "2.0", id: m.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  // ---- methods ---------------------------------------------------------------------------------------

  /** The bridge's own methods first; every other name is the backend's (routed, mapped, or refused by name). */
  private async dispatch(client: Client, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ping": return this.pingResult();
      case "daemon/keep_alive": return this.keepAlive(params);
      case "project/set": return this.projectSet(params);
      case "bridge/status": return this.status();
      case "bridge/probe": {
        await this.connectPromise;
        if (this._state === "failed") throw new Error(this._error);
        return this.backend.probeHeld();
      }
      case "bridge/begin_streams": {
        await this.connectPromise;
        return { notes: await this.backend.beginStreams() };
      }
      case "bridge/shutdown": {
        // Answered after the streams are stopped and the device's connection is released, so the
        // caller knows the fixed UDP ports and the app's one slot are free when this returns.
        await this.backend.closeAndWait();
        setTimeout(() => void this.shutdown("asked to by a client", 0), 100).unref?.();
        return { ok: true };
      }
      default: break;
    }
    await this.connectPromise;
    if (this._state === "failed") throw new Error(this._error);
    const result = await this.backend.call(method, params);
    if (method === "audio/start") client.audio = true;
    else if (method === "audio/stop") client.audio = false;
    if (method === "session/state" && isObj(result)) return { ...result, idleExit: this.idle.status() };
    return result;
  }

  private async pingResult(): Promise<Record<string, unknown>> {
    const identity = await this.backend.describe();
    return {
      runtime_version: BRIDGE_RUNTIME_VERSION,
      version: this.version,
      backend: "c64u",
      project: this._project ?? null,
      idleExit: this.idle.status(),
      device: identity.device ?? { host: this.opts.host, restPort: this.backend.restPort },
      label: identity.label,
      bridge: this.bridgeBlock(),
    };
  }

  private bridgeBlock(): Record<string, unknown> {
    return {
      state: this._state,
      ...(this._error ? { error: this._error } : {}),
      notes: this._notes,
      pid: process.pid,
      endpoint: this.endpoint,
      clients: this.clients.size,
      avClients: [...this.clients].filter((c) => c.av).length,
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    const identity = await this.backend.describe();
    return {
      ...(await this.pingResult()),
      identity,
      uptimeMs: Date.now() - this.startedAt,
      streams: this.backend.streamStatus(),
    };
  }

  private keepAlive(params: Record<string, unknown>): Record<string, unknown> {
    const raw = params.seconds;
    let seconds: number | null;
    if (raw === undefined || raw === null) seconds = null;
    else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) seconds = Math.ceil(raw);
    else throw new BridgeParamError("daemon/keep_alive: seconds must be a non-negative number or null");
    const armed = this.idle.armedSeconds > 0;
    if (armed) this.idle.keepAlive(seconds);
    return { ...this.idle.status(), armed };
  }

  /**
   * The project the gate looks in (§4b), as the daemon's `project/set` shapes it. `dry_run` (and the
   * same project) change nothing and say what is bound; otherwise the bridge moves, and every client
   * is told with `project/changed`. There is no machine to power-cycle and no media to persist:
   * what is on the device stays on the device.
   */
  private projectSet(params: Record<string, unknown>): Record<string, unknown> {
    const raw = typeof params.path === "string" ? params.path : "";
    if (!raw) throw new BridgeParamError("project/set: `path` is required");
    let requested: string;
    try {
      if (!existsSync(raw)) throw new Error("no such directory");
      requested = realpathSync(raw);
      if (!statSync(requested).isDirectory()) throw new BridgeParamError(`project/set: not a directory: ${raw}`);
    } catch (e) {
      if (e instanceof BridgeParamError) throw e;
      throw new BridgeParamError(`project/set: ${raw}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const previous = this._project && existsSync(this._project) ? realpathSync(this._project) : this._project ?? null;
    const same = previous === requested;
    if (params.dry_run === true || same) {
      return { changed: false, same, current: previous, requested, media: { disk: null, cart: null, blocked: null } };
    }
    this._project = requested;
    this.backend.setProjectDir(requested);
    this.broadcast({ method: "project/changed", params: { project: requested, previous } });
    return { changed: true, project: requested, previous, persisted: {} };
  }
}

/** A malformed call to one of the bridge's own methods: -32602. */
class BridgeParamError extends Error {
  constructor(message: string) { super(message); this.name = "BridgeParamError"; }
}
