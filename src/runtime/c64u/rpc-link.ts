// Spec 889 §3 / §7 — the ONE app WebSocket to trxmon, held for as long as the C64U bridge runs.
//
// trxmon serves exactly one RPC client (a second is refused with -32001 "port N is held by
// <peer>" and close 1013; a plain HTTP client gets 503). So this link is opened once, kept, and
// REUSED — by calls, by the probe's `ping` and by the capability check — and a refusal for a
// held port is reported verbatim, never retried around.

import { WebSocket } from "ws";

export type RpcNotification = { method: string; params?: unknown };

/** The connection could not be had. `kind` says which of the §2/§3 stories it is. */
export class RpcLinkError extends Error {
  constructor(message: string, readonly kind: "gone" | "refused" | "unreachable" | "timeout" | "closed") { super(message); this.name = "RpcLinkError"; }
}

/** A JSON-RPC error answer, code kept: -32601 is how an older app says "not served". */
export class RpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); this.name = "RpcError"; }
}

export class RpcLink {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<(n: RpcNotification) => void>();
  /** Set when the device refused us (held port) or told us why it closed; reported verbatim. */
  private refusal: string | undefined;
  private closedLocally = false;

  constructor(readonly host: string, readonly port: number) {}

  get isOpen(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  onNotification(h: (n: RpcNotification) => void): () => void {
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }

  /** Open the connection. Rejects with RpcLinkError naming what the device answered. */
  async open(timeoutMs = 4000): Promise<void> {
    if (this.isOpen) return;
    this.refusal = undefined;
    this.closedLocally = false;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/?av=0`, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => { ws.terminate(); reject(new RpcLinkError(`C64 Ultimate ${this.host}: no answer on the app port ${this.port} within ${timeoutMs} ms`, "timeout")); }, timeoutMs + 500);
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => reject(new RpcLinkError(
          `C64 Ultimate ${this.host}: port ${this.port} answered HTTP ${res.statusCode}${body.trim() ? `: ${body.trim()}` : ""}`, "refused")));
        res.on("error", () => reject(new RpcLinkError(`C64 Ultimate ${this.host}: port ${this.port} answered HTTP ${res.statusCode}`, "refused")));
      });
      ws.once("error", (e: Error & { code?: string }) => {
        clearTimeout(timer);
        const refused = e.code === "ECONNREFUSED";
        reject(new RpcLinkError(
          refused ? this.goneMessage() : `C64 Ultimate ${this.host} unreachable on the app port ${this.port}: ${e.message}`,
          refused ? "gone" : "unreachable"));
      });
      ws.once("open", () => {
        clearTimeout(timer);
        ws.removeAllListeners("error");
        ws.on("message", (data) => this.onMessage(data.toString()));
        ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
        ws.on("error", () => { /* surfaced through close / pending */ });
        this.ws = ws;
        resolve();
      });
    });
  }

  goneMessage(): string {
    return `trxmon not running on ${this.host} — start it (runtime_backend action=start_monitor) or select the emulator`;
  }

  private onMessage(raw: string): void {
    let m: { id?: number | null; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id == null) {
      if (m.error) { // an unsolicited error is the device refusing the connection (held port)
        this.refusal = `C64 Ultimate ${this.host}: ${m.error.message ?? JSON.stringify(m.error)}`;
        return;
      }
      if (typeof m.method === "string") for (const h of this.handlers) { try { h({ method: m.method, params: m.params }); } catch { /* a listener must not break the link */ } }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new RpcError(m.error.message ?? JSON.stringify(m.error), m.error.code ?? -32603));
    else p.resolve(m.result);
  }

  private onClose(code: number, reason: string): void {
    this.ws = null;
    if (code === 1013 && reason) this.refusal = `C64 Ultimate ${this.host}: ${reason}`;
    const err = this.closedLocally
      ? new RpcLinkError("the connection to the C64 Ultimate was closed here", "closed")
      : this.refusal
        ? new RpcLinkError(this.refusal, "refused")
        : new RpcLinkError(this.goneMessage(), "gone");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    if (!this.isOpen) throw new RpcLinkError(this.refusal ?? this.goneMessage(), this.refusal ? "refused" : "gone");
    const ws = this.ws!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcLinkError(`C64 Ultimate ${this.host}: ${method} did not answer within ${timeoutMs} ms (a pending run carries a deadline; debug/pause ends it)`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(new RpcLinkError(`${this.goneMessage()} (${e instanceof Error ? e.message : String(e)})`, "gone")); }
    });
  }

  close(): void {
    this.closedLocally = true;
    try { this.ws?.close(1000); } catch { /* going away */ }
    this.ws = null;
    for (const { reject } of this.pending.values()) reject(new RpcLinkError("the connection to the C64 Ultimate was closed here", "closed"));
    this.pending.clear();
  }
}
