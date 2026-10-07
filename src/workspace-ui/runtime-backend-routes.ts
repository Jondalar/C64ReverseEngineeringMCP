// Spec 889 §2 / §4 / §4c — the workbench's door to the runtime backend.
//
// The browser reaches the emulator directly (`/api/config` names its WS). A C64 Ultimate speaks
// no such WS, so with one selected this server is the runtime's face for the page:
//
//   GET  /api/runtime/backend              which backend is active, which URL the page connects to
//   GET|POST /api/runtime/devices          find + probe Ultimates (every answering device, with its reason)
//   POST /api/runtime/backend/select       choose emulator | c64u (asks first: 409 until `confirmed`)
//   POST /api/runtime/backend/start-monitor start trxmon on a device that has our core without it
//   WS   /runtime-relay                    JSON-RPC calls → the active backend, its notifications and the
//                                          device's picture/sound as the binary frames the page plays
//
// This process owns ITS OWN backend instance (backend.ts keeps the selection per process): the
// MCP server is another process with its own. A device serves ONE app connection and ONE stream
// target, so whichever process selects it first holds it; the other gets the device's refusal
// by name. REST passwords live in this process's memory only — never in a file, never in a reply.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  activeBackend, activeIdentity, listDevices, probeHost, selectBackend, startMonitorOn,
  type BackendIdentity, type DeviceRow,
} from "../runtime/backend.js";
import { BackendRefusal, C64UBackend } from "../runtime/c64u/c64u-backend.js";
import { RpcError } from "../runtime/c64u/rpc-link.js";
import { execMonitorWithNames, type MonitorWithNames } from "../symbols/monitor-names.js";

export const RELAY_PATH = "/runtime-relay";
/** A slow browser must not make the server buffer without bound: video is latest-frame-wins. */
const VIDEO_BACKLOG_LIMIT = 4 * 1024 * 1024;
const AUDIO_BACKLOG_LIMIT = 1024 * 1024;

/** Which backend this process reaches right now; an env value that does not parse is reported, never defaulted. */
export function selectedBackend(): { kind: "emulator" | "c64u"; backend?: C64UBackend; error?: string } {
  try {
    const b = activeBackend();
    return b instanceof C64UBackend ? { kind: "c64u", backend: b } : { kind: "emulator" };
  } catch (e) {
    return { kind: "emulator", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- passwords: memory only -------------------------------------------------------------------

const passwords = new Map<string, string>();
const pwKey = (host: string, restPort: number) => `${host}:${restPort}`;

// ---- the relay -----------------------------------------------------------------------------------

interface ClientState { audio: boolean }

export class RuntimeRelay {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly clients = new Map<WebSocket, ClientState>();
  private bound: C64UBackend | undefined;
  private unsubs: Array<() => void> = [];

  /** Handle WebSocket upgrades for the relay path; any other upgrade is refused. */
  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== RELAY_PATH) { socket.destroy(); return; }
      // A page of another origin must not be able to drive the machine: browsers send Origin on a
      // WebSocket handshake; a non-browser client sends none.
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
        if (!same) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  get clientCount(): number { return this.clients.size; }

  /** The selection changed: every page reconnects (to the relay or straight to the emulator, as `/api/config` then says). */
  rebind(): void {
    for (const u of this.unsubs) { try { u(); } catch { /* */ } }
    this.unsubs = [];
    this.bound = undefined;
    for (const ws of [...this.clients.keys()]) { try { ws.close(4001, "the runtime backend changed — reconnect"); } catch { /* */ } }
  }

  close(): void {
    this.rebind();
    this.wss.close();
  }

  private bind(b: C64UBackend): void {
    if (this.bound === b) return;
    for (const u of this.unsubs) { try { u(); } catch { /* */ } }
    this.bound = b;
    this.unsubs = [
      b.onNotification((n) => {
        const text = JSON.stringify({ jsonrpc: "2.0", method: n.method, params: n.params });
        for (const ws of this.clients.keys()) { try { ws.send(text); } catch { /* the socket is closing */ } }
      }),
      b.onBinary((m) => {
        for (const [ws, st] of this.clients) {
          if (m.kind === "audio" && !st.audio) continue;
          if (ws.bufferedAmount > (m.kind === "video" ? VIDEO_BACKLOG_LIMIT : AUDIO_BACKLOG_LIMIT)) continue;
          try { ws.send(m.data, { binary: true }); } catch { /* the socket is closing */ }
        }
      }),
    ];
  }

  private onConnection(ws: WebSocket): void {
    const sel = selectedBackend();
    if (!sel.backend) {
      ws.close(4400, "no C64 Ultimate is selected: the emulator is reached directly (see /api/config)");
      return;
    }
    const backend = sel.backend;
    this.bind(backend);
    const st: ClientState = { audio: false };
    this.clients.set(ws, st);
    ws.on("close", () => { this.clients.delete(ws); });
    ws.on("error", () => { this.clients.delete(ws); });
    // A page that connects while the machine is paused gets no video (none is sent): give it the
    // last picture and whether the stream is paused, so it shows what there is and says so.
    const paused = backend.pausedState();
    if (paused) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "stream/paused", params: paused }));
    const last = backend.lastVideo();
    if (last) ws.send(last, { binary: true });
    ws.on("message", (data, isBinary) => { if (!isBinary) void this.onMessage(ws, st, backend, data.toString()); });
  }

  private async onMessage(ws: WebSocket, st: ClientState, backend: C64UBackend, text: string): Promise<void> {
    const reply = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch { /* the socket is closing */ } };
    let m: { id?: number | string | null; method?: unknown; params?: unknown };
    try { m = JSON.parse(text); } catch { reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      reply({ jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "invalid request: a JSON-RPC call needs a string `method`" } });
      return;
    }
    if (m.id === undefined) return; // a notification from the page: nothing to answer
    const params = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};
    try {
      const result = await backend.call(m.method, params);
      if (m.method === "audio/start") st.audio = true;
      else if (m.method === "audio/stop") st.audio = false;
      reply({ jsonrpc: "2.0", id: m.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : e instanceof BackendRefusal ? -32601 : -32603;
      reply({ jsonrpc: "2.0", id: m.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}

// ---- the workbench monitor over the active backend -------------------------------------------------

/** `/api/monitor/exec` with a C64 Ultimate selected: the same names-in/names-out code, over the backend. */
export async function monitorExecViaBackend(input: { sessionId?: string; command: string }, projectDir: string): Promise<MonitorWithNames> {
  const b = activeBackend();
  return execMonitorWithNames({
    call: (method, params) => b.call(method, params as Record<string, unknown>),
    sessionId: input.sessionId, command: input.command, projectDir, tags: false,
  });
}

// ---- HTTP routes -----------------------------------------------------------------------------------

export interface RouteContext {
  projectDir: string;
  relay: RuntimeRelay;
  /** The emulator's WS as `/api/config` has always named it. */
  emulatorWsUrl: string;
}

const MAX_BODY = 64 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] ?? "");
    if (req.method === "POST" && !type.includes("application/json")) {
      reject(Object.assign(new Error("send application/json"), { status: 415 }));
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
      } catch { reject(Object.assign(new Error("body is not JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

/** A device address as the UI types it: a host name or IPv4/IPv6-less address, with no scheme, path or port. */
function validHost(h: string | undefined): h is string { return !!h && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h); }

function remember(host: string, restPort: number, password: unknown): void {
  if (typeof password === "string" && password) passwords.set(pwKey(host, restPort), password);
}

/** The URL a page connects to for the runtime, as it stands: the relay with a C64U selected, else what it always was. */
export function runtimeUrlFor(req: IncomingMessage, ctx: Pick<RouteContext, "emulatorWsUrl">): { kind: "emulator" | "c64u"; runtimeWsUrl: string; error?: string } {
  const sel = selectedBackend();
  if (sel.kind === "c64u") return { kind: "c64u", runtimeWsUrl: `ws://${req.headers.host ?? "127.0.0.1"}${RELAY_PATH}` };
  return { kind: "emulator", runtimeWsUrl: ctx.emulatorWsUrl, error: sel.error };
}

async function backendView(req: IncomingMessage, ctx: RouteContext): Promise<Record<string, unknown>> {
  const u = runtimeUrlFor(req, ctx);
  let identity: BackendIdentity | undefined;
  try { identity = await activeIdentity(); } catch { identity = undefined; }
  const sel = selectedBackend();
  return {
    kind: u.kind,
    runtimeWsUrl: u.runtimeWsUrl,
    emulatorWsUrl: ctx.emulatorWsUrl,
    identity,
    relayClients: ctx.relay.clientCount,
    streams: sel.backend?.streamStatus(),
    ...(u.error ? { envError: u.error } : {}),
  };
}

function sameTarget(spec: { kind: "emulator" } | { kind: "c64u"; host: string; restPort: number }): boolean {
  const sel = selectedBackend();
  if (spec.kind === "emulator") return sel.kind === "emulator";
  return sel.backend !== undefined && sel.backend.host === spec.host && sel.backend.restPort === spec.restPort;
}

async function listRows(body: Record<string, unknown>): Promise<DeviceRow[]> {
  const scan = body.scan !== false && body.scan !== "0" && body.scan !== 0;
  const broadcastAddr = str(body.broadcast) ?? "255.255.255.255";
  const hosts = (Array.isArray(body.hosts) ? body.hosts : typeof body.hosts === "string" ? body.hosts.split(",") : [])
    .map((h) => String(h).trim()).filter(Boolean)
    .map((h) => { const m = /^([^:]+)(?::(\d+))?$/.exec(h); return m ? { host: m[1]!, restPort: m[2] ? Number(m[2]) : undefined } : { host: h }; })
    .filter((h) => validHost(h.host));
  const host = str(body.host);
  if (validHost(host)) { remember(host, num(body.restPort) ?? 80, body.password); }
  const rows = await listDevices({
    discover: scan ? [{ address: broadcastAddr, port: num(body.ident_port) ?? 64, broadcast: broadcastAddr === "255.255.255.255" || broadcastAddr.endsWith(".255") }] : [],
    hosts,
    restPort: num(body.rest_port ?? body.restPort),
    discoverTimeoutMs: num(body.discover_timeout_ms),
  });
  // A device that said it wants its password and for which this session has one: ask again with it
  // (to that device only — a password is never offered to the other devices on the segment).
  return Promise.all(rows.map(async (r) => {
    const pw = passwords.get(pwKey(r.host, r.restPort));
    if (r.passwordProtected && pw && r.outcome === "unreachable") return probeHost({ host: r.host, restPort: r.restPort, password: pw });
    return r;
  }));
}

/** Handle `/api/runtime/...`. Returns true when the request was one of ours (the response is then in flight). */
export function handleRuntimeBackendRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): boolean {
  const p = url.pathname;
  if (!p.startsWith("/api/runtime/backend") && p !== "/api/runtime/devices") return false;

  const fail = (e: unknown, dflt = 502) => {
    const status = (e as { status?: number })?.status ?? dflt;
    sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
  };

  void (async () => {
    try {
      if (p === "/api/runtime/backend" && req.method === "GET") { sendJson(res, 200, await backendView(req, ctx)); return; }

      if (p === "/api/runtime/devices" && (req.method === "GET" || req.method === "POST")) {
        const body = req.method === "POST" ? await readJsonBody(req)
          : Object.fromEntries(url.searchParams);
        const active = await activeIdentity().catch(() => undefined);
        sendJson(res, 200, {
          active: active ? { kind: active.kind, label: active.label, host: active.device?.host } : undefined,
          emulator: { label: "TRX64 (emulator)", selectable: true, reason: "the default; sandboxes, reels and scenario runs always use it" },
          devices: await listRows(body),
        });
        return;
      }

      if (p === "/api/runtime/backend/select" && req.method === "POST") {
        const body = await readJsonBody(req);
        const which = str(body.backend);
        if (which !== "emulator" && which !== "c64u") { sendJson(res, 400, { error: "backend must be \"emulator\" or \"c64u\"" }); return; }
        let spec: { kind: "emulator" } | { kind: "c64u"; host: string; restPort: number };
        if (which === "emulator") spec = { kind: "emulator" };
        else {
          const host = str(body.host);
          if (!validHost(host)) { sendJson(res, 400, { error: "a C64 Ultimate needs `host` (an address or host name, without scheme or port)" }); return; }
          spec = { kind: "c64u", host, restPort: num(body.restPort ?? body.rest_port) ?? 80 };
        }
        if (!sameTarget(spec) && body.confirmed !== true) {
          const from = await activeIdentity().catch(() => undefined);
          sendJson(res, 409, {
            needsConfirm: true,
            from: from?.label ?? "the current runtime",
            to: spec.kind === "emulator" ? "TRX64 (emulator)" : `C64 Ultimate ${spec.host}`,
            error: "switching changes the machine: what is on screen is another machine's — send confirmed:true to switch",
          });
          return;
        }
        if (spec.kind === "c64u") remember(spec.host, spec.restPort, body.password);
        const pw = spec.kind === "c64u" ? passwords.get(pwKey(spec.host, spec.restPort)) : undefined;
        let r;
        try {
          r = await selectBackend(spec.kind === "emulator" ? { kind: "emulator" } : { kind: "c64u", host: spec.host, restPort: spec.restPort === 80 ? undefined : spec.restPort }, {
            password: pw,
            startMonitor: body.startMonitor === true || body.start_monitor === true,
            paused: body.paused === true,
            rpcPort: num(body.rpcPort ?? body.rpc_port),
            trxmonPath: str(body.trxmonPath ?? body.trxmon_path),
            projectDir: ctx.projectDir,
          });
        } catch (e) { fail(e, 502); return; }
        ctx.relay.rebind();
        const view = await backendView(req, ctx);
        sendJson(res, 200, { ok: true, notes: r.notes, ...view });
        return;
      }

      if (p === "/api/runtime/backend/start-monitor" && req.method === "POST") {
        const body = await readJsonBody(req);
        const host = str(body.host);
        if (!validHost(host)) { sendJson(res, 400, { error: "start-monitor needs `host`" }); return; }
        const restPort = num(body.restPort ?? body.rest_port) ?? 80;
        remember(host, restPort, body.password);
        const pw = passwords.get(pwKey(host, restPort));
        const via = body.via === "app" ? "app" : body.via === "run_file" ? "run_file" : undefined;
        const r = await startMonitorOn({ host, restPort, password: pw, trxmonPath: str(body.trxmonPath ?? body.trxmon_path), via });
        const row = await probeHost({ host, restPort, rpcPort: r.rpcPort, password: pw });
        sendJson(res, 200, { started: r.started, note: r.note, device: row });
        return;
      }

      sendJson(res, 405, { error: `${req.method} ${p}: not a runtime backend route` });
    } catch (e) { fail(e, 400); }
  })();
  return true;
}
