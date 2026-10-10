// Spec 902 D6 — C64RE's own way of asking a process it started to end.
//
// POSIX ends a process with a signal. Windows has none that a program can handle, so there the
// request goes through the process's own channel first: `daemon/shutdown` to a daemon, a sandbox
// or a C64U bridge (the TRX64 wire), a local-only shutdown request to the workspace's HTTP server
// and to the UI dev server. Only after the grace does the platform layer stop what is left.

import { request } from "node:http";
import { WebSocket } from "ws";
import type { ProcessRecord } from "./process-ledger.js";

/** The header a shutdown request must carry: a browser cannot add it to a cross-origin request without a preflight, which the servers refuse. */
export const SHUTDOWN_HEADER = "x-c64re-shutdown";
export const UI_SHUTDOWN_PATH = "/api/shutdown";
export const DEV_SHUTDOWN_PATH = "/__c64re/shutdown";

export interface WsShutdownAnswer {
  /** The process answered the request. */
  accepted: boolean;
  /** The runtime has no such method (it predates TRX64 902). */
  unsupported?: boolean;
  /** What a daemon says it wrote back. */
  persisted?: { cartridge: string | null; disks: string[] };
  trace?: string | null;
  error?: string;
}

/** One JSON-RPC request on a short connection to a daemon or bridge; resolves with its answer or the reason there is none. */
export function wsShutdown(port: number, method = "daemon/shutdown", timeoutMs = 4000): Promise<WsShutdownAnswer> {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?av=0`, { handshakeTimeout: Math.min(timeoutMs, 3000) });
    const finish = (a: WsShutdownAnswer) => { if (done) return; done = true; clearTimeout(timer); try { ws.terminate(); } catch { /* */ } resolve(a); };
    const timer = setTimeout(() => finish({ accepted: false, error: `no answer to ${method} within ${timeoutMs} ms` }), timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })));
    ws.once("error", (e) => finish({ accepted: false, error: e instanceof Error ? e.message : String(e) }));
    ws.once("close", () => finish({ accepted: false, error: "closed before it answered" }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      let m: { id?: number; result?: { persisted?: { cartridge?: string | null; disks?: string[] }; trace?: string | null }; error?: { code?: number; message?: string } };
      try { m = JSON.parse(String(d)); } catch { return; }
      if (m.id !== 1) return;
      if (m.error) finish({ accepted: false, unsupported: m.error.code === -32601, error: m.error.message ?? `error ${m.error.code}` });
      else finish({ accepted: true, persisted: m.result?.persisted ? { cartridge: m.result.persisted.cartridge ?? null, disks: m.result.persisted.disks ?? [] } : undefined, trace: m.result?.trace });
    });
  });
}

/** POST a shutdown request to a local HTTP server (the workspace server, the UI dev server). */
export function httpShutdown(port: number, path: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST", timeout: timeoutMs,
      headers: { [SHUTDOWN_HEADER]: "1", "content-length": "0" },
    }, (res) => { res.resume(); res.on("end", () => resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)); });
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.once("error", () => resolve(false));
    req.end();
  });
}

export interface AskResult { accepted: boolean; note?: string; answer?: WsShutdownAnswer }

/** Ask the process of this record to end through its own channel. The launcher is asked through its HTTP server: when that ends, the launcher ends what it started and itself. */
export async function askToEnd(rec: ProcessRecord): Promise<AskResult> {
  if (!rec.port) return { accepted: false, note: "no port recorded to ask on" };
  if (rec.kind === "ui" || rec.kind === "ui-server") return { accepted: await httpShutdown(rec.port, UI_SHUTDOWN_PATH) };
  if (rec.kind === "ui-dev") return { accepted: await httpShutdown(rec.port, DEV_SHUTDOWN_PATH) };
  let a = await wsShutdown(rec.port);
  // A bridge from before daemon/shutdown knows only its own name for it.
  if (!a.accepted && rec.kind === "bridge") {
    const b = await wsShutdown(rec.port, "bridge/shutdown", 15_000);
    if (b.accepted) a = b;
  }
  return { accepted: a.accepted, answer: a, note: a.unsupported ? "this runtime has no daemon/shutdown (it predates TRX64 902)" : undefined };
}
