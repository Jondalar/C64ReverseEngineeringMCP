// Spec 272 — V3 WebSocket protocol server.
//
// Hybrid encoding:
//   text frames  → JSON-RPC 2.0 (commands + responses + notifications)
//   binary frames → [type:u8][seq:u32 LE][payload...]
//
// Bind: ws://127.0.0.1:4312 (single-user, localhost-only, no auth).

import { WebSocketServer, WebSocket } from "ws";
import { createAgentQueryApi, type AgentQueryApi } from "../runtime/headless/v2/agent-api.js";
import { getIntegratedSession } from "../runtime/headless/integrated-session-manager.js";
import { SidAudioRecorder, AudioExportSession } from "../runtime/headless/audio/sid-audio-recorder.js";
import { int16ToLeBytes, monoToStereoLR } from "../runtime/headless/audio/audio-buffer.js";
import { writeWav } from "../runtime/headless/audio/wav-writer.js";

export const V3_WS_PORT = 4312;
export const V3_WS_HOST = "127.0.0.1";

// Binary frame type codes.
export const BIN_TYPE_VIC_FRAME = 0x01;
export const BIN_TYPE_AUDIO_BUFFER = 0x02;
export const BIN_TYPE_TRACE_CHUNK = 0x03;
export const BIN_TYPE_ACK = 0x04;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id?: number | string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: any;
  error?: { code: number; message: string; data?: any };
  id: number | string | null;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export type RpcHandler = (params: any, ctx: ClientContext) => Promise<any> | any;

export interface ClientContext {
  ws: WebSocket;
  send: (msg: JsonRpcResponse | JsonRpcNotification) => void;
  sendBinary: (type: number, seq: number, payload: Uint8Array) => void;
}

export class V3WsServer {
  private wss: WebSocketServer;
  private handlers = new Map<string, RpcHandler>();
  private clients = new Set<WebSocket>();
  // Spec 263 — per-session audio streamers. Pumped on a fixed cadence
  // and flushed via session_state ticks. Keyed by session_id.
  private audioStreams = new Map<string, {
    recorder: SidAudioRecorder;
    cursorId: string;
    timer: ReturnType<typeof setInterval>;
    seq: number;
  }>();

  constructor(opts: { port?: number; host?: string } = {}) {
    const port = opts.port ?? V3_WS_PORT;
    const host = opts.host ?? V3_WS_HOST;
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`[v3-ws] WARNING: binding ${host}:${port} (not localhost). No auth — exposes session to network.`);
    }
    this.wss = new WebSocketServer({ port, host });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.registerBuiltinHandlers();
  }

  /** Register a JSON-RPC method handler. */
  on(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Send notification to all connected clients. */
  broadcast(method: string, params?: any): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /** Send binary frame to all connected clients. */
  broadcastBinary(type: number, seq: number, payload: Uint8Array): void {
    const buf = encodeBinaryFrame(type, seq, payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const [, s] of this.audioStreams) {
        clearInterval(s.timer);
        try { s.recorder.buffer.detach(s.cursorId); } catch {}
        try { s.recorder.detach(); } catch {}
      }
      this.audioStreams.clear();
      for (const ws of this.clients) ws.close();
      this.wss.close(() => resolve());
    });
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    const ctx: ClientContext = {
      ws,
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      sendBinary: (type, seq, payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeBinaryFrame(type, seq, payload), { binary: true });
        }
      },
    };
    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        // Client→server binary frames not used in v3.0 (commands are JSON).
        return;
      }
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch (e) {
        ctx.send({
          jsonrpc: "2.0",
          error: { code: -32700, message: `parse error: ${(e as Error).message}` },
          id: null,
        });
        return;
      }
      await this.dispatch(req, ctx);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
    });
    ws.on("error", (err) => {
      console.error("[v3-ws] client error:", err.message);
    });
  }

  private async dispatch(req: JsonRpcRequest, ctx: ClientContext): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      if (req.id !== undefined) {
        ctx.send({
          jsonrpc: "2.0",
          error: { code: -32601, message: `method not found: ${req.method}` },
          id: req.id,
        });
      }
      return;
    }
    try {
      const result = await handler(req.params ?? {}, ctx);
      if (req.id !== undefined) {
        ctx.send({ jsonrpc: "2.0", result, id: req.id });
      }
    } catch (e) {
      if (req.id !== undefined) {
        ctx.send({
          jsonrpc: "2.0",
          error: { code: -32000, message: (e as Error).message },
          id: req.id,
        });
      }
    }
  }

  private registerBuiltinHandlers(): void {
    // Connectivity ping.
    this.on("ping", () => ({ pong: Date.now() }));

    // Session telemetry — used by UI status bar.
    this.on("session/state", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      return {
        c64Cycles: s.c64Cpu.cycles,
        driveCycles: s.drive.cpu.cycles,
        mode: s.mode,
      };
    });

    // Spec 263 — audio streaming.
    this.on("audio/start", ({ session_id, sample_rate, chunk_samples }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      if (this.audioStreams.has(session_id)) {
        return { already_streaming: true };
      }
      const recorder = new SidAudioRecorder(s as any, {
        sampleRate: sample_rate ?? 44100,
        bufferSamples: 65536,
      });
      const cursorId = `ws_${session_id}_${Date.now()}`;
      recorder.buffer.attach(cursorId);
      const chunk = chunk_samples ?? 1024;
      let seq = 0;
      const timer = setInterval(() => {
        recorder.flush();
        while (recorder.buffer.available(cursorId) >= chunk) {
          const { samples } = recorder.buffer.read(cursorId, chunk);
          const stereo = monoToStereoLR(samples);
          this.broadcastBinary(BIN_TYPE_AUDIO_BUFFER, seq++, int16ToLeBytes(stereo));
        }
      }, 23); // ~1024 samples @ 44.1kHz
      this.audioStreams.set(session_id, { recorder, cursorId, timer, seq });
      return { streaming: true, sample_rate: recorder.resid.sampleRate };
    });

    this.on("audio/stop", ({ session_id }) => {
      const stream = this.audioStreams.get(session_id);
      if (!stream) return { stopped: false };
      clearInterval(stream.timer);
      try { stream.recorder.buffer.detach(stream.cursorId); } catch {}
      try { stream.recorder.detach(); } catch {}
      this.audioStreams.delete(session_id);
      return { stopped: true };
    });

    this.on("audio/export", async ({ session_id, out_path, duration_sec }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const sec = Number(duration_sec);
      if (!Number.isFinite(sec) || sec <= 0) throw new Error(`bad duration_sec: ${duration_sec}`);
      const exp = new AudioExportSession(session as any, { sampleRate: 44100 });
      const { exportSessionAudio } = await import("../runtime/headless/audio/export.js");
      const result = exportSessionAudio(session as any, exp, out_path, sec);
      return result;
    });

    // AgentQueryApi facade — single dispatch for V2/V3 runtime ops.
    // Method name: "runtime/<op>" → calls api.<op>(params).
    this.on("runtime/call", async ({ session_id, op, args }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const api = createAgentQueryApi({ session });
      const fn = (api as any)[op];
      if (typeof fn !== "function") throw new Error(`unknown runtime op: ${op}`);
      return await fn.call(api, ...(args ?? []));
    });

    // Spec 265 — media browser + mount/unmount/swap handlers.
    this.on("media/list_paths", async () => {
      const { listFsRoots } = await import("../runtime/headless/media/fs-browser.js");
      return listFsRoots();
    });

    this.on("media/browse", async ({ path }) => {
      if (typeof path !== "string") throw new Error("media/browse: path required");
      const { browseDir } = await import("../runtime/headless/media/fs-browser.js");
      return browseDir(path);
    });

    this.on("media/mount", async ({ session_id, slot, path }) => {
      if (typeof path !== "string") throw new Error("media/mount: path required");
      const s = slot !== undefined ? Number(slot) : 8;
      if (s !== 8 && s !== 9) throw new Error(`media/mount: slot must be 8 or 9, got ${s}`);
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { mountMedia } = await import("../runtime/headless/media/mount.js");
      return mountMedia(session, s as 8 | 9, path);
    });

    this.on("media/unmount", async ({ session_id, slot }) => {
      const s = slot !== undefined ? Number(slot) : 8;
      if (s !== 8 && s !== 9) throw new Error(`media/unmount: slot must be 8 or 9, got ${s}`);
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { unmountMedia } = await import("../runtime/headless/media/mount.js");
      return unmountMedia(session, s as 8 | 9);
    });

    this.on("media/swap", async ({ session_id, slot, path }) => {
      if (typeof path !== "string") throw new Error("media/swap: path required");
      const s = slot !== undefined ? Number(slot) : 8;
      if (s !== 8 && s !== 9) throw new Error(`media/swap: slot must be 8 or 9, got ${s}`);
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { swapDisk } = await import("../runtime/headless/media/mount.js");
      return swapDisk(session, s as 8 | 9, path);
    });

    this.on("media/recent", async () => {
      const { getRecent } = await import("../runtime/headless/media/recent-files.js");
      return getRecent();
    });
  }
}

/** Encode binary frame: [type:u8][seq:u32 LE][payload...] */
export function encodeBinaryFrame(type: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type & 0xff;
  out[1] = seq & 0xff;
  out[2] = (seq >> 8) & 0xff;
  out[3] = (seq >> 16) & 0xff;
  out[4] = (seq >> 24) & 0xff;
  out.set(payload, 5);
  return out;
}

export function decodeBinaryFrame(buf: Uint8Array): { type: number; seq: number; payload: Uint8Array } {
  if (buf.length < 5) throw new Error("binary frame too short");
  const type = buf[0]!;
  const seq = (buf[1]! | (buf[2]! << 8) | (buf[3]! << 16) | (buf[4]! << 24)) >>> 0;
  return { type, seq, payload: buf.slice(5) };
}
