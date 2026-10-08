// Spec 889 §2 / §4 / §11 — the workbench's door to the runtime backend.
//
// The browser reaches the runtime DIRECTLY, always: `/api/config` names the WS endpoint — the
// emulator daemon's, or the C64U bridge's when a C64 Ultimate is selected (the bridge speaks the
// same wire, so the page cannot tell the difference except by backend name and the audio rate).
// This server proxies nothing for the page; it only knows which endpoint is the selection, and
// offers the selection's API:
//
//   GET  /api/runtime/backend              which backend is active, which URL the page connects to
//   GET|POST /api/runtime/devices          find + probe Ultimates (every answering device, with its reason)
//   POST /api/runtime/backend/select       choose emulator | c64u (asks first: 409 until `confirmed`)
//   POST /api/runtime/backend/start-monitor start trxmon on a device that has our core without it
//
// The selection is the MACHINE's (backend.ts: one file every C64RE process follows), so a switch
// made by the assistant shows up here, and one made here is followed by the assistant. REST
// passwords live in this process's memory only — never in a file, never in a reply; a new bridge
// gets its password on stdin.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  activeBackend, activeIdentity, currentSelection, listDevices, probeHost, selectBackend, startMonitorOn,
  rememberPassword, type BackendIdentity, type DeviceRow,
} from "../runtime/backend.js";
import { bridgeCall, passwordFor } from "../runtime/c64u-bridge/launch.js";

// ---- HTTP routes -----------------------------------------------------------------------------------

export interface RouteContext {
  projectDir: string;
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

function remember(host: string, restPort: number, password: unknown): void { rememberPassword(host, restPort, password); }

/**
 * The endpoint a page connects to for the runtime, as the selection stands: what it always was with
 * the emulator, the bridge's with a C64 Ultimate. A bridge this process used that has ended (idle
 * exit) is started again here (the password is this process's memory), so the page never gets the
 * address of a dead one.
 */
export async function runtimeUrlFor(ctx: Pick<RouteContext, "emulatorWsUrl">): Promise<{ kind: "emulator" | "c64u"; runtimeWsUrl: string; key: string; error?: string; seq?: number; by?: string }> {
  let sel = currentSelection();
  if (sel.kind === "emulator") return { kind: "emulator", runtimeWsUrl: ctx.emulatorWsUrl, key: sel.key, error: sel.error, seq: sel.seq, by: sel.by };
  try { await activeBackend().call("ping", {}, 20000); sel = currentSelection(); }
  catch (e) { return { kind: "c64u", runtimeWsUrl: sel.endpoint ?? "", key: sel.key, error: e instanceof Error ? e.message : String(e), seq: sel.seq, by: sel.by }; }
  return { kind: "c64u", runtimeWsUrl: sel.endpoint ?? "", key: sel.key, seq: sel.seq, by: sel.by };
}

/** The page asks for this every couple of seconds (it is how it notices a switch): identity and stream state are read from the bridge at most every 3 s. */
let viewCache: { key: string; at: number; identity?: BackendIdentity; streams?: unknown } | undefined;

async function backendView(ctx: RouteContext): Promise<Record<string, unknown>> {
  const u = await runtimeUrlFor(ctx);
  if (!viewCache || viewCache.key !== u.key || Date.now() - viewCache.at > 3000) {
    let identity: BackendIdentity | undefined;
    try { identity = await activeIdentity(); } catch { identity = undefined; }
    let streams: unknown;
    if (u.kind === "c64u" && u.runtimeWsUrl && !u.error) {
      try { streams = (await bridgeCall<{ streams?: unknown }>(u.runtimeWsUrl, "bridge/status", {}, 4000)).streams; } catch { streams = undefined; }
    }
    viewCache = { key: u.key, at: Date.now(), identity, streams };
  }
  return {
    kind: u.kind,
    runtimeWsUrl: u.runtimeWsUrl,
    emulatorWsUrl: ctx.emulatorWsUrl,
    identity: viewCache.identity,
    selection: { key: u.key, seq: u.seq, by: u.by },
    streams: viewCache.streams,
    ...(u.error ? { envError: u.error } : {}),
  };
}

function sameTarget(spec: { kind: "emulator" } | { kind: "c64u"; host: string; restPort: number }): boolean {
  const sel = currentSelection();
  if (spec.kind === "emulator") return sel.kind === "emulator";
  return sel.kind === "c64u" && sel.host === spec.host && sel.restPort === spec.restPort;
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
    const pw = passwordFor(r.host, r.restPort);
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
      if (p === "/api/runtime/backend" && req.method === "GET") { sendJson(res, 200, await backendView(ctx)); return; }

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
        const pw = spec.kind === "c64u" ? passwordFor(spec.host, spec.restPort) : undefined;
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
        viewCache = undefined;
        const view = await backendView(ctx);
        sendJson(res, 200, { ok: true, notes: r.notes, ...view });
        return;
      }

      if (p === "/api/runtime/backend/start-monitor" && req.method === "POST") {
        const body = await readJsonBody(req);
        const host = str(body.host);
        if (!validHost(host)) { sendJson(res, 400, { error: "start-monitor needs `host`" }); return; }
        const restPort = num(body.restPort ?? body.rest_port) ?? 80;
        remember(host, restPort, body.password);
        const pw = passwordFor(host, restPort);
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
