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
import { gcr_find_sync, gcr_decode_block } from "../runtime/headless/vice1541/gcr.js";
import {
  buildVicInspectSnapshot, assembleInspectEvidence,
  resolveVisibleNodeAt, resolveVisibleRegion,
  VISIBLE_FRAME, DISPLAY_ORIGIN,
} from "../runtime/headless/inspect/vic-inspect.js";
import type { FrozenInspectEvidence } from "../runtime/headless/inspect/vic-inspect-types.js";
import { resolveVisualOrigin } from "../runtime/headless/inspect/asset-origin.js";
import { extractAssetCandidates } from "../runtime/headless/inspect/asset-extract.js";
import type { AssetCandidate } from "../runtime/headless/inspect/asset-join-types.js";
import type { RuntimeCheckpoint } from "../runtime/headless/kernel/runtime-checkpoint.js";
import {
  ensureRuntimeController,
  getRuntimeController,
  type RuntimePacingMode,
} from "../runtime/headless/debug/runtime-controller.js";
import { SidAudioRecorder, AudioExportSession, LIVE_RECORDER_BUFFER_SAMPLES } from "../runtime/headless/audio/sid-audio-recorder.js";
import {
  dumpRuntimeSnapshot, undumpRuntimeSnapshot, resolveSnapshotPath, dumpRecorderAnchorSnapshot,
} from "../runtime/headless/kernel/snapshot-persistence.js";
// Spec 754 — the one canonical monitor command processor (BUG-037).
import { runMonitorCommand } from "../runtime/headless/debug/monitor-shell.js";
import { validateTraceDefinition, slugTraceId } from "../runtime/headless/trace/trace-definition.js";
import { ingestMedia } from "../runtime/headless/media/ingress.js";
import { buildIngressRequest, kindFromExt } from "../runtime/headless/media/ingress-request.js";
import { readFileSync } from "node:fs";
import { int16ToLeBytes, monoToStereoLR } from "../runtime/headless/audio/audio-buffer.js";
import { writeWav } from "../runtime/headless/audio/wav-writer.js";

export const WS_PORT = 4312;
export const WS_HOST = "127.0.0.1";

// Spec 701 — breakpoints are CORE-owned now: the per-session
// RuntimeController holds the stable-checknum breakpoint store so the
// autonomous run-loop and the monitor (`bk`/`del`/`g`/`z`/`n`) share ONE
// source of truth. The server reaches them via getRuntimeController() /
// ensureRuntimeController() instead of a local map.

// VICE-style continue cursors: a bare `d` / `m` (no address) resumes from
// where the previous one left off. Keyed by session_id.
const monitorDisasmAddr = new Map<string, number>();
const monitorMemAddr = new Map<string, number>();

// Decode the physical sector under (or next approaching) the vice1541 GCR
// read head. Loader-independent (works for KERNAL + custom fastloaders) —
// reads the actual GCR track, scans from the head bit-position for the next
// sector header block, returns its sector number. Mirrors VICE's monitor
// sector indicator. Returns -1 if no header found (unformatted/empty track).
function viceSectorUnderHead(d0: any): number {
  const ht = d0?.current_half_track ?? 0;
  const raw = d0?.gcr?.tracks?.[ht - 2];
  if (!raw?.data || !raw.size) return -1;
  const bits = raw.size * 8;
  // GCR_head_offset is a BIT position (rotation.ts: byte = off >> 3).
  let p = (((d0.GCR_head_offset ?? 0) % bits) + bits) % bits;
  const header = new Uint8Array(4);
  let firstSync = -1;
  for (let guard = 0; guard < 64; guard++) {
    p = gcr_find_sync(raw, p, bits);
    if (p < 0) return -1;          // no sync = no header
    if (firstSync === p) return -1; // full revolution, no header block
    if (firstSync < 0) firstSync = p;
    gcr_decode_block(raw, p, header, 1);
    if (header[0] === 0x08) return header[2]; // 0x08 = header block; [2]=sector
    // not a header (e.g. 0x07 data block) — gcr_find_sync(p) advances to next.
  }
  return -1;
}

// Binary frame type codes.
export const BIN_TYPE_VIC_FRAME = 0x01;
export const BIN_TYPE_AUDIO_BUFFER = 0x02; // legacy PCM stream (export path only)
export const BIN_TYPE_TRACE_CHUNK = 0x03;
export const BIN_TYPE_ACK = 0x04;
// Spec 703 §8 — SID register-write stream. The browser runs reSID and renders;
// the backend only ships the $D400-$D41F writes (cycle-stamped) per frame.
// payload: baseCycle f64 | nowDelta u32 | count u16 | count×(delta u32, reg u8, val u8)
export const BIN_TYPE_SID_WRITES = 0x05;

// Spec 706.4 (Fix C) — live audio backpressure tunables (44.1 kHz stereo s16).
//   MAX_AUDIO_SHIP_SAMPLES: mono samples shipped per emulated frame. ~2 PAL
//     frames (882×2) of slack — steady state ships ~882; the bound only bites
//     during a catch-up burst, deferring (not dropping) the surplus.
//   AUDIO_WS_HIGH_WATER_BYTES: skip a client whose send buffer exceeds ~250 ms
//     of audio (0.25 s × 44100 × 2 ch × 2 B ≈ 44 KiB) — a genuinely stuck
//     socket only; bounds server memory.
export const MAX_AUDIO_SHIP_SAMPLES = 882 * 2;
export const AUDIO_WS_HIGH_WATER_BYTES = 44100;

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

/** Spec 744.4c slice 2 — make a value safe for JSON-RPC: TypedArrays → plain
 *  arrays (else JSON serializes them as index-keyed objects and the MCP side's
 *  Array.from() yields []), recursing through plain objects/arrays. */
function normalizeForJson(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(normalizeForJson);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeForJson(v);
  return out;
}

export class WsServer {
  private wss: WebSocketServer;
  // Spec 744.4c — resolves when the port is actually bound ("listening"), rejects
  // on bind failure ("error", e.g. EADDRINUSE). The daemon awaits this BEFORE
  // creating its default session, so a loser in a multi-start race exits cleanly
  // with zero side effects instead of constructing a session then crashing.
  private readonly readyPromise: Promise<void>;
  private handlers = new Map<string, RpcHandler>();
  /** BUG-042 — CART LED write detection: last seen writableGeneration per
   *  session + when it last advanced (flash/EEPROM program/erase). */
  private cartLedTrack = new Map<string, { gen: number; lastWriteAt: number }>();
  private clients = new Set<WebSocket>();
  // Single-session FIFO op chain. Node fires each ws "message" listener
  // without awaiting the previous, so two async handlers interleave at
  // their `await` points. A frame-stream session/run executing in that
  // gap while media/mount is mid-attach (or session/reset mid-re-init)
  // left the drive/CPU in a half-mutated state → UI freeze. Methods that
  // run or mutate the live session are serialized through this chain so
  // they execute atomically end-to-end, never interleaved.
  private opChain: Promise<unknown> = Promise.resolve();
  private static readonly SERIALIZED_METHODS = new Set<string>([
    "session/run", "session/reset", "session/screenshot",
    "session/type", "session/key_down", "session/key_up",
    "session/release_keys", "session/joystick_set", "session/joystick_clear",
    "session/drive_power", "media/mount", "media/unmount", "media/swap", "media/ingress",
    "runtime/call", "monitor/exec",
    // Spec 701 — loop/step commands mutate the live session; serialize them
    // behind any in-flight mount/reset so they execute atomically.
    "debug/run", "debug/pause", "debug/continue", "debug/step", "session/set_pacing",
    // Spec 744.4c slice 2 — the AgentQueryApi bridge can mutate the session
    // (stepInto/stepOver/breakpoints), so serialize it through the same op chain
    // so it never interleaves with a run/mount/reset.
    "api/call",
  ]);

  // Spec 744.4c slice 2 — AgentQueryApi methods reachable via the api/call bridge.
  // Extended per slice as each group is verified to round-trip + format identically.
  // Slice 2a = monitor read + single-step + breakpoints.
  private static readonly API_CALL_ALLOWLIST = new Set<string>([
    "monitorRegisters", "monitorMemory", "monitorDisasm",
    "stepInto", "stepOver",
    "addPcBreakpoint", "listBreakpoints", "removeBreakpoint",
    // Spec 744.4c slice 2c — session-attached run/introspection.
    "until", "status",
  ]);
  // Spec 703 §8 — per-session audio. reSID PCM is rendered on the backend in
  // the RuntimeController's per-frame hook (the SAME loop + cadence that pushes
  // video frames — so audio rides the steady frame clock that already makes
  // video smooth) and streamed as BIN_TYPE_AUDIO_BUFFER. The browser plays it
  // through an AudioWorklet ring.
  private audioStreams = new Map<string, {
    recorder: SidAudioRecorder;
    cursorId: string;
    seq: number;
  }>();

  // Spec 724.3 — the project this WS serves. Media scans read from here, NOT
  // from process.cwd(). Required (no cwd fallback).
  private readonly projectDir: string;
  // Spec 724.3 — opt-in repo `samples/` scan (dev only). Off in production.
  private readonly devSamples: boolean;

  // BUG-049 — pooled present-frame buffers. The live frame path is a linear,
  // synchronous single flow (pushFrame → broadcastFrame → ws.send), so reusing
  // buffers across frames removes ~206 KiB/frame of per-frame GC churn (fps dips).
  private _framePayload: Uint8Array | null = null;
  private _framePayloadDv: DataView | null = null;
  private _frameEncPool: Array<Uint8Array> = [];
  private _frameEncIdx = 0;
  // BUG-049 — pooled audio ship buffers: a reused mono-sample buffer + a 3-slot
  // rotating wire buffer (mono→stereo s16le built inline), so the per-frame audio
  // push allocates nothing.
  private _audioSamples: Int16Array | null = null;
  private _audioWirePool: Array<Uint8Array> = [];
  private _audioWireIdx = 0;

  constructor(opts: { port?: number; host?: string; projectDir: string; devSamples?: boolean }) {
    const port = opts.port ?? WS_PORT;
    const host = opts.host ?? WS_HOST;
    if (!opts.projectDir) {
      throw new Error("WsServer requires projectDir (Spec 724.3 — no cwd fallback).");
    }
    this.projectDir = opts.projectDir;
    this.devSamples = opts.devSamples ?? false;
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`[ws] WARNING: binding ${host}:${port} (not localhost). No auth — exposes session to network.`);
    }
    this.wss = new WebSocketServer({ port, host });
    // Spec 744.4c — track bind outcome. once("error") rejects readiness (the only
    // window EADDRINUSE matters); the persistent on("error") keeps any later socket
    // error from crashing the process as an unhandled 'error' event.
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.wss.once("listening", () => resolveReady());
      this.wss.once("error", (err) => rejectReady(err));
    });
    this.wss.on("error", (err) => {
      console.error(`[ws] server error:`, (err as NodeJS.ErrnoException)?.code ?? err);
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.registerBuiltinHandlers();
  }

  /** Spec 744.4c — resolves once the port is bound, rejects on bind failure
   *  (e.g. EADDRINUSE). Callers (the daemon entry) gate setup on this. */
  ready(): Promise<void> {
    return this.readyPromise;
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

  /**
   * Spec 701 §7 — live VIC frame push with "latest frame wins": skip any
   * client whose send buffer already holds ~2 frames, so a slow consumer
   * never accumulates a WebSocket backlog (the next frame supersedes it).
   */
  broadcastFrame(seq: number, payload: Uint8Array): void {
    // BUG-049 — encode into a 3-slot rotating pool instead of a fresh ~104 KiB
    // Uint8Array per frame (per-frame GC churn). A slot is reused only ~3 frames
    // (~60ms) later, after ws.send drained it on localhost (bufferedAmount≈0).
    const need = 5 + payload.length;
    let buf = this._frameEncPool[this._frameEncIdx];
    if (!buf || buf.length !== need) { buf = new Uint8Array(need); this._frameEncPool[this._frameEncIdx] = buf; }
    this._frameEncIdx = (this._frameEncIdx + 1) % 3;
    buf[0] = BIN_TYPE_VIC_FRAME & 0xff;
    buf[1] = seq & 0xff; buf[2] = (seq >> 8) & 0xff; buf[3] = (seq >> 16) & 0xff; buf[4] = (seq >>> 24) & 0xff;
    buf.set(payload, 5);
    const maxBuffered = payload.length * 2;
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > maxBuffered) continue; // backed up — drop this frame
      ws.send(buf, { binary: true });
    }
  }

  /**
   * Spec 706.4 (Fix C) — live audio binary push with a backpressure high-water.
   * Unlike video (`broadcastFrame`, latest-frame-wins → drops freely), audio
   * must not drop a packet under normal load (that is an audible gap). The
   * per-frame ship bound (`MAX_AUDIO_SHIP_SAMPLES`) keeps a HEALTHY client's
   * `bufferedAmount` near zero. This high-water is the last-resort guard for a
   * GENUINELY stuck socket (tab backgrounded, dead-slow link): only then do we
   * skip, to bound server memory rather than queue unboundedly. The client
   * worklet smooths the resulting gap (underrun → silence) and the governor
   * re-syncs on recovery.
   */
  broadcastAudio(seq: number, payload: Uint8Array): void {
    const buf = encodeBinaryFrame(BIN_TYPE_AUDIO_BUFFER, seq, payload);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > AUDIO_WS_HIGH_WATER_BYTES) continue; // stuck client
      ws.send(buf, { binary: true });
    }
  }

  /** BUG-049 — send a pre-encoded audio wire frame from a pooled buffer (no
   *  per-frame alloc). `wire[0..len)` is the full [type][seq][s16le payload]. */
  private broadcastAudioWire(wire: Uint8Array, len: number): void {
    const view = wire.subarray(0, len);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > AUDIO_WS_HIGH_WATER_BYTES) continue; // stuck client
      ws.send(view, { binary: true });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const [sessId, s] of this.audioStreams) {
        const c = getRuntimeController(sessId);
        if (c) c.onAudioFrame = undefined;
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
      // Spec 703/706 audio-restart fix: a UI reload closes the socket but the
      // backend audio stream lingered (audioStreams kept) → the reloaded UI's
      // audio/start hit `already_streaming` and never re-primed → silent until a
      // manual off/on. When no client remains, tear the stream down so the next
      // connection starts a fresh, primed stream.
      if (this.clients.size === 0) {
        for (const session_id of [...this.audioStreams.keys()]) this.stopAudioStream(session_id);
      }
    });
    ws.on("error", (err) => {
      console.error("[ws] client error:", err.message);
    });
  }

  /** Tear down a session's live audio stream (shared by audio/stop + socket
   *  close). Idempotent. */
  private stopAudioStream(session_id: string): boolean {
    const stream = this.audioStreams.get(session_id);
    if (!stream) return false;
    const c = getRuntimeController(session_id);
    if (c) c.onAudioFrame = undefined;
    try { stream.recorder.buffer.detach(stream.cursorId); } catch { /* ignore */ }
    try { stream.recorder.detach(); } catch { /* ignore */ }
    this.audioStreams.delete(session_id);
    return true;
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
    const exec = async () => {
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
    };

    if (WsServer.SERIALIZED_METHODS.has(req.method)) {
      // Queue behind any in-flight session op; keep the chain alive even
      // if a handler rejects (exec already swallows + reports errors).
      const link = this.opChain.then(exec, exec);
      this.opChain = link.catch(() => {});
      await link;
    } else {
      await exec();
    }
  }

  private registerBuiltinHandlers(): void {
    // Spec 701 — get-or-create the per-session RuntimeController, wired with
    // the JSON broadcast sink AND the live binary frame push (§7). Every
    // handler that touches loop/debug/breakpoint state goes through this so
    // the frame stream is always available once a session exists.
    const pushFrame = (sessionId: string, frameNum: number) => {
      try {
      const sess = getIntegratedSession(sessionId);
      if (!sess) return;
      // Palette-indexed (Spec 701 §7 preferred): ~4× less WS bandwidth than
      // raw RGBA, so a 50fps stream doesn't choke the browser socket.
      const f = sess.renderLiteralPortIndexed();
      if (!f) return;
      // header: [w:u16][h:u16][fmt:u8][rsvd:u8][c64cycle:u32], all LE.
      // fmt 1 = palette-indexed: header + 48-byte RGB palette + w*h indices.
      // BUG-049 — header inline into a pooled payload buffer (no per-frame
      // header/payload alloc). broadcastFrame copies it into a separately pooled
      // wire buffer, so reusing payload next frame is safe.
      const need = 10 + f.palette.length + f.indices.length;
      if (!this._framePayload || this._framePayload.length !== need) {
        this._framePayload = new Uint8Array(need);
        this._framePayloadDv = new DataView(this._framePayload.buffer);
      }
      const payload = this._framePayload;
      const dv = this._framePayloadDv!;
      dv.setUint16(0, f.width, true);
      dv.setUint16(2, f.height, true);
      payload[4] = 1; // fmt 1 = palette-indexed
      payload[5] = 0;
      dv.setUint32(6, sess.c64Cpu.cycles >>> 0, true);
      payload.set(f.palette, 10);
      payload.set(f.indices, 10 + f.palette.length);
      this.broadcastFrame(frameNum >>> 0, payload);
      } catch { /* a transport error must never kill the loop */ }
    };
    const controllerFor = (session_id: string) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      return ensureRuntimeController(
        session_id, s,
        (m, p) => {
          // Spec 754 — after an autonomous stop (breakpoint / observer / pause),
          // move the monitor's disasm cursor to the landing PC so a bare `d`
          // shows where `r` is. The step verbs (z/n/ret) + toolbar step already
          // do this; the run-loop stop was the gap (cursor stayed stale → `d`
          // disagreed with `r`). Only the disasm cursor — the `m` memory cursor
          // stays put (memory inspection is independent of the PC).
          const pc = typeof p?.pc === "number" ? p.pc
            : typeof p?.stop?.pc === "number" ? p.stop.pc : undefined;
          if (pc !== undefined && (m === "debug/breakpoint_hit" || m === "debug/observer_hit" || m === "debug/stopped" || m === "debug/paused")) {
            monitorDisasmAddr.set(session_id, pc & 0xffff);
          }
          this.broadcast(m, p);
        },
        (frameNum) => pushFrame(session_id, frameNum),
      );
    };

    // Connectivity ping.
    this.on("ping", () => ({ pong: Date.now() }));

    // Session telemetry — used by UI status bar.
    this.on("session/state", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const c = s.c64Cpu;
      const v = s.vic.regs;
      const raster = s.vicRaster(); // live literal-port raster (legacy raster_y stays 0)
      // Interrupt vectors (banked reads) so the UI can ALWAYS show where the
      // IRQ/NMI handlers enter, not only while stepping into them.
      const rd16 = (a: number) => (s.c64Bus.read(a) | (s.c64Bus.read((a + 1) & 0xffff) << 8)) & 0xffff;
      const vectors = {
        irq: rd16(0xfffe),   // hardware IRQ/BRK vector ($FFFE/$FFFF)
        nmi: rd16(0xfffa),   // hardware NMI vector ($FFFA/$FFFB)
        cinv: rd16(0x0314),  // KERNAL RAM IRQ vector (CINV) — common game hook
        cbinv: rd16(0x0318), // KERNAL RAM NMI vector (CBINV)
      };
      return {
        c64Cycles: c.cycles,
        driveCycles: s.driveDebug().drive_clk, // Spec 704 §11 R3 — vice drive clock
        mode: s.mode,
        // The controller's autonomous-loop run-state (running/paused). The UI
        // mirrors this on connect/poll so the Run/Pause button reflects the
        // DAEMON truth without ever commanding it back (no run-state echo loop).
        runState: getRuntimeController(session_id)?.runState ?? "running",
        // Spec 764 — why the loop last stopped ("jam"|"breakpoint"|…) so a UI
        // that (re)connects to an already-jammed machine can show the red
        // border without having seen the one-shot debug/stopped broadcast.
        stopReason: getRuntimeController(session_id)?.stopInfo?.reason,
        cpu: {
          pc: c.pc, a: c.a, x: c.x, y: c.y, sp: c.sp,
          flags: c.flags, cycles: c.cycles,
        },
        vic: {
          rasterLine: raster.line,
          rasterCycle: raster.cycle,
          mode: ((v[0x11] >> 5) & 3) | (((v[0x16] >> 4) & 1) << 2),
          bank: (s.cia2.pra & s.cia2.ddra & 0x03) ^ 0x03,
          screenPtr: ((v[0x18] >> 4) & 0xf) << 10,
          chargenPtr: ((v[0x18] >> 1) & 7) << 11,
          bitmapPtr: (v[0x18] & 8) ? 0x2000 : 0,
          border: v[0x20] & 0xf,
          background: v[0x21] & 0xf,
        },
        // Spec 623 §4.3 — control-flow stack (main/irq/nmi/brk) for the UI
        // FLOW panel. Populated while stepping (z/n/sf/nf); empty = main.
        flow: getRuntimeController(session_id)?.flow.flowState() ?? null,
        vectors,
        // Spec 703 §10 — SID register snapshot ($D400-$D418) + audio stream
        // state. The UI decodes per-voice waveform/gate/note + filter/volume.
        sid: {
          regs: Array.from(s.sid.regs.slice(0, 0x19)),
          streaming: this.audioStreams.has(session_id),
        },
      };
    });

    // List active sessions — UI auto-picks first on connect.
    this.on("session/list", async () => {
      const { listIntegratedSessions } = await import("../runtime/headless/integrated-session-manager.js");
      return listIntegratedSessions().map(({ sessionId, session }) => ({
        sessionId,
        mode: session.mode,
        diskPath: session.diskPath,
        c64Cycles: session.c64Cpu.cycles,
      }));
    });

    // Spec 744.4c — the daemon's authority API for CREATING/closing sessions.
    // The runtime is owned HERE (the daemon process); both the browser UI and the
    // MCP adapter create sessions through this one authority so they share state.
    // (The WsServer is otherwise stateless — it only operated on pre-existing
    // sessions; session/create+close make it the lifecycle owner for the daemon.)
    //
    // PROJECT-AGNOSTIC: the daemon may serve several projects at once, so the CLIENT
    // brings its context — disk_path and trace_out arrive already ABSOLUTE (resolved
    // against the caller's own project). resolveTraceOut passes absolute through, so
    // this.projectDir (the daemon's default-session/UI base) is NOT applied to a
    // self-describing MCP session. A bare relative path still falls back to the base.
    this.on("session/create", async ({ disk_path, device_id, pal, start_track, write_protected, trace_out, trace_domains }) => {
      const { runtimeSessions } = await import("../runtime/headless/runtime-session-service.js");
      const { producerOptsForDomains, startSessionTrace, resolveTraceOut, DEFAULT_TRACE_DOMAINS } =
        await import("../server-tools/runtime-trace-sink.js");
      const domains = trace_out ? (trace_domains ?? DEFAULT_TRACE_DOMAINS) : [];
      const tp = trace_out ? producerOptsForDomains(domains) : {};
      const { sessionId, session, attached } = runtimeSessions.start({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        startTrack: start_track, writeProtected: write_protected,
        traceIec: tp.traceIec, traceDrive: tp.traceDrive,
        enableBusAccessTrace: tp.enableBusAccessTrace,
      } as never);
      // One-machine-per-process: do NOT resetCold an ATTACHED session — that would
      // wipe the shared machine the human/LLM is already on. Only a freshly
      // constructed machine gets the cold boot. (runtime-session-service.start.)
      if (!attached) session.resetCold();
      let trace: unknown = null;
      if (trace_out) {
        const out = resolveTraceOut(trace_out, this.projectDir);
        trace = await startSessionTrace(sessionId, session, out, domains as never);
      }
      return {
        sessionId, mode: session.mode, diskPath: session.diskPath, attached,
        c64Cycles: session.c64Cpu.cycles, pc: session.c64Cpu.pc, trace,
      };
    });

    this.on("session/close", async ({ session_id }) => {
      const { runtimeSessions } = await import("../runtime/headless/runtime-session-service.js");
      const r = await runtimeSessions.close(session_id);
      // Leak fix: drop this session's ws-server-side per-session state (the VICE
      // continue cursors + the frozen-inspect evidence list), else entries
      // accumulate one set per closed session for the daemon's lifetime.
      monitorDisasmAddr.delete(session_id);
      monitorMemAddr.delete(session_id);
      inspectEvidence.delete(session_id);
      return r;
    });

    // Spec 744.4c slice 2 — generic AgentQueryApi bridge. The MCP `runtime_*`
    // analysis/debug tools (monitor_registers/memory/disasm, step_into/over,
    // breakpoint_add/list/remove, …) all go through `createAgentQueryApi({session})`.
    // Routing them one method at a time would be N near-identical handlers; instead
    // this ONE handler runs the SAME AgentQueryApi against the SHARED daemon session,
    // so the result is byte-identical to the in-process path and the LLM's debug
    // actions land on the machine the human is watching. An allowlist gates which
    // methods are exposed (extended per slice). Serialized via opChain above.
    this.on("api/call", async ({ session_id, method, args }) => {
      if (typeof method !== "string" || !WsServer.API_CALL_ALLOWLIST.has(method)) {
        throw new Error(`api/call: method not allowed: ${method}`);
      }
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { createAgentQueryApi } = await import("../runtime/headless/v2/agent-api.js");
      const api = createAgentQueryApi({ session }) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const fn = api[method];
      if (typeof fn !== "function") throw new Error(`api/call: unknown method ${method}`);
      const result = await fn.apply(api, Array.isArray(args) ? args : []);
      // Normalize TypedArrays (e.g. monitorMemory → Uint8Array) to plain arrays so
      // JSON-RPC round-trips them as arrays, not index-keyed objects.
      return normalizeForJson(result);
    });

    // Spec 744.4c slice 2c — bespoke session-attached ops that do NOT fit the
    // generic api/call bridge (own helpers / file IO / checkpoint ring). Each runs
    // the SAME logic the in-process MCP tool ran, now against the SHARED session.

    // media/persist — write the mounted disk's RAM image back to its host file
    // WITHOUT ejecting. CRITICAL: write-through (Spec 742) is preserved — the
    // backingPath threaded at mount time IS the caller's abs path (localhost), so
    // persisting daemon-side writes the caller's .d64/.g64.
    // role="cartridge" persists the programmed cartridge flash to its host .crt
    // instead (same persistCartridgeToFile the eject path runs, Spec 742 /
    // BUG-023-cart) — the only way to save flash AND keep playing, since eject
    // pulls the cart (resetCold).
    this.on("media/persist", async ({ session_id, slot, role }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      if (role === "cartridge") {
        const bus = (session.kernel as { c64Bus?: {
          getCartridge?(): import("../runtime/headless/media/persist-cartridge.js").CartLike | undefined;
        } }).c64Bus;
        const cartPath = (session as { cartPath?: string }).cartPath ?? "";
        const { persistCartridgeToFile } = await import("../runtime/headless/media/persist-cartridge.js");
        return persistCartridgeToFile(bus?.getCartridge?.(), cartPath);
      }
      const n = slot !== undefined ? Number(slot) : 8;
      if (n === 9) throw new Error("media/persist: drive 9 not supported (v1 drive8-only)");
      const { persistMountedDiskToFile } = await import("../runtime/headless/media/mount.js");
      return persistMountedDiskToFile(session);
    });

    // vsf/save + vsf/load — full session snapshot to/from a host path. The path is
    // abs-resolved on the MCP side (caller project); the daemon (localhost) reads/
    // writes that same file. Bytes never cross the wire (avoids the Uint8Array-arg
    // JSON-RPC problem) — the daemon owns the file IO.
    this.on("vsf/save", async ({ session_id, output_path }) => {
      if (typeof output_path !== "string" || !output_path) throw new Error("vsf/save: output_path required");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { saveSessionVsf } = await import("../runtime/headless/vsf/session-vsf.js");
      saveSessionVsf(session, output_path);
      const { statSync } = await import("node:fs");
      return { savedPath: output_path, bytes: statSync(output_path).size };
    });
    this.on("vsf/load", async ({ session_id, input_path }) => {
      if (typeof input_path !== "string" || !input_path) throw new Error("vsf/load: input_path required");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { loadSessionVsf } = await import("../runtime/headless/vsf/session-vsf.js");
      const { statSync } = await import("node:fs");
      const bytes = statSync(input_path).size;
      loadSessionVsf(session, input_path);
      return { loadedPath: input_path, bytes };
    });

    // debug/memory_access_map — per-region read/write liveness over a run window.
    this.on("debug/memory_access_map", async ({ session_id, cycles, classes, min_bytes }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const cyc = Number(cycles) || 2_000_000;
      const wantClasses: string[] = Array.isArray(classes) ? classes : ["dead", "unused"];
      const minB = Number(min_bytes) || 256;
      const { MemoryAccessTracker } = await import("../runtime/headless/debug/memory-access-map.js");
      const t = new MemoryAccessTracker(session.c64Bus);
      t.attach();
      session.runFor(cyc, { cycleBudget: cyc });
      const map = t.finish();
      const want = new Set(wantClasses);
      const tally = map.regions.reduce((a: Record<string, number>, r) => { a[r.cls] = (a[r.cls] || 0) + 1; return a; }, {});
      const regions = map.regions.filter((r) => want.has(r.cls) && (r.end - r.start + 1) >= minB);
      return { tally, regions, cycles: cyc, classes: wantClasses, minBytes: minB };
    });

    // BUG-028 — runtime/mark: stamp a phase marker into the shared session's active
    // trace. (The MCP runtime_mark had a daemon wrapper pointing here but the handler
    // did not exist → dead route; now real.)
    this.on("runtime/mark", ({ session_id, label }) => {
      const ctrl = getRuntimeController(session_id);
      if (!ctrl?.traceRun.isActive()) throw new Error(`No active trace on session ${session_id} (start one with runtime_session_start trace_out=...).`);
      ctrl.traceRun.mark(String(label ?? ""));
      const st = ctrl.traceRun.status();
      return { runId: st.runId, eventCount: st.eventCount, marks: st.marks, label };
    });

    // BUG-028 — session/load_prg: inject a PRG into the SHARED session's RAM. The
    // path is abs-resolved on the MCP (caller) side; the daemon (localhost) reads it.
    this.on("session/load_prg", ({ session_id, prg_path, load_address }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const r = s.loadPrgIntoRam(String(prg_path), load_address !== undefined ? Number(load_address) : undefined);
      return { loadAddress: r.loadAddress, endAddress: r.endAddress, bytesLoaded: r.bytesLoaded, path: prg_path };
    });

    // vic/inspect/at_capture — frozen-pixel provenance. Captures + pins a checkpoint
    // if none given (the in-process tool's behaviour), then resolves the node.
    this.on("vic/inspect/at_capture", async ({ session_id, x, y, checkpoint_id }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const { buildVicInspectSnapshot, resolveNodeAt } = await import("../runtime/headless/inspect/vic-inspect.js");
      const ctrl = ctrlFor(session_id);
      let id = checkpoint_id ? String(checkpoint_id) : undefined;
      if (!id) {
        if (ctrl.runState === "running") ctrl.pause();
        const ref = await ctrl.captureCheckpoint();
        ctrl.checkpointRing.pin(ref.id);
        id = ref.id;
      }
      const cp = ctrl.checkpointRing.restoreSnapshot(String(id))?.payload as any;
      if (!cp || !cp.vic || !cp.ram) throw new Error(`vic/inspect/at_capture: unknown checkpoint ${id}`);
      const frame = buildVicInspectSnapshot(cp);
      const provenance = cp.vicProvenance ?? undefined;
      const node = resolveNodeAt(cp, (Number(x) || 0) | 0, (Number(y) || 0) | 0, provenance);
      return { checkpointId: id, frame, node, hasProvenance: !!provenance };
    });

    // Render current frame as PNG → return base64 data URL.
    this.on("session/screenshot", async ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { readFileSync } = await import("node:fs");
      const path = join(tmpdir(), `c64re-frame-${session_id}-${Date.now()}.png`);
      // Spec 309: literal-port is sole renderer; opts.renderer dropped.
      // frameAligned:false — session/screenshot is a PASSIVE snapshot; it must
      // NOT advance the CPU. The default (frameAligned:true) calls
      // runUntilFrameReady() which runs the machine up to ~1 frame to reach a
      // raster boundary — that silently stepped the CPU PAST a breakpoint halt
      // (e.g. $0800 → into the IRQ at $10C1) every time the UI grabbed the
      // frozen frame. Renders the last completed frame (literalPortFbStable).
      s.renderToPng(path, { frameAligned: false });
      const bytes = readFileSync(path);
      return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, bytes: bytes.length };
    });

    // Run with C64 CYCLE budget (not instructions). runFor's first
    // arg is instruction-count; we pass huge instr cap + tight
    // cycleBudget so a caller gets cycle-accurate stepping (1 PAL frame
    // = 19705 cycles default).
    //
    // Spec 701: session/run is now a MANUAL/HEADLESS primitive only — it is
    // NOT the live UI clock anymore (that is the backend RuntimeController
    // loop, driven via debug/run). If the autonomous loop owns this session,
    // reject the manual step so the two clocks can't double-advance the CPU.
    this.on("session/run", async ({ session_id, cycles }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const ctrl = controllerFor(session_id);
      if (ctrl.runState === "running") {
        throw new Error("session is running under the autonomous loop; use debug/pause before manual session/run");
      }
      const cycleBudget = cycles ?? 19705;
      // Instruction cap must exceed cycle cap so cycleBudget always wins.
      // Min cycles per 6502 instruction = 2, so cycles/2 ≈ max instructions.
      const bps = ctrl.bpAddrSet();
      // If we're sitting ON a breakpoint (resumed from one), step past it
      // once so the run doesn't immediately re-trigger the same address.
      if (bps.size > 0 && bps.has(s.c64Cpu.pc)) s.runFor(1);
      const runSeg = (budget: number) => s.runFor(Math.ceil(budget / 2) + 1000, {
        cycleBudget: budget,
        breakpoints: bps.size > 0 ? bps : undefined,
      });
      // BUG-030 — when a trace is active, run in BOUNDED segments and drain the
      // trace sink between them, so a long firehose (a fastloader disk load emits
      // millions of events) feeds the writer incrementally instead of buffering
      // past the 256-chunk backpressure ceiling and aborting the whole trace. This
      // is the producer-side backpressure: the sim pauses per segment while the
      // worker writes. The worker (1 MiB chunks → SSD) easily keeps up at this cadence.
      let r: ReturnType<typeof runSeg>;
      const TRACE_DRAIN_CYCLES = 100_000;
      if (ctrl.traceRun.isActive() && cycleBudget > TRACE_DRAIN_CYCLES) {
        let remaining = cycleBudget;
        do {
          const seg = Math.min(TRACE_DRAIN_CYCLES, remaining);
          r = runSeg(seg);
          await ctrl.traceRun.drain(); // resilient: a sink failure aborts the trace, never throws here
          remaining -= seg;
        } while (remaining > 0 && r.aborted !== "breakpoint");
      } else {
        r = runSeg(cycleBudget);
        if (ctrl.traceRun.isActive()) await ctrl.traceRun.drain();
      }
      if (r.aborted === "breakpoint") {
        // Halt: report the hit so a manual caller can drop into the monitor,
        // print "BK reached" + registers, and focus the input.
        const hx = (n: number, w = 2) => n.toString(16).padStart(w, "0").toUpperCase();
        const c = s.c64Cpu;
        const flagsStr = "NV-BDIZC".split("").map((f, i) =>
          ((c.flags >> (7 - i)) & 1) ? f : f.toLowerCase()).join("");
        const num = ctrl.bpNumForAddr(r.lastPc);
        monitorDisasmAddr.set(session_id, r.lastPc); // bare `d` shows from the break
        return {
          c64Cycles: s.c64Cpu.cycles,
          breakpoint: {
            pc: r.lastPc,
            num,
            registers:
              `  ADDR AC XR YR SP NV-BDIZC\n` +
              `.;${hx(c.pc, 4)} ${hx(c.a)} ${hx(c.x)} ${hx(c.y)} ${hx(c.sp)} ${flagsStr}`,
          },
        };
      }
      return { c64Cycles: s.c64Cpu.cycles };
    });

    // Spec 744 §7.2 / BUG-027 — high-level disk-swap-and-continue: eject → run →
    // insert → run → confirm → run, so a game waiting on "Insert side N" senses the
    // change (atomic media/swap gives the drive no cycles to sense). Drives the
    // sequence synchronously; pauses the autonomous loop first, resumes after.
    this.on("runtime/swap_disk_and_continue", async ({ session_id, path, confirm_input, settle_cycles, post_cycles }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      if (typeof path !== "string" || !path) throw new Error("path required");
      const ctrl = controllerFor(session_id);
      const wasRunning = ctrl.runState === "running";
      if (wasRunning) ctrl.pause();
      const { swapDiskAndContinue } = await import("../runtime/headless/media/swap-and-continue.js");
      try {
        return await swapDiskAndContinue(ctrl, {
          path,
          confirmInput: confirm_input as string | undefined,
          settleCycles: settle_cycles as number | undefined,
          postCycles: post_cycles as number | undefined,
        });
      } finally {
        if (wasRunning) ctrl.continue();
      }
    });

    // ---- Spec 701 — autonomous runtime loop: debug/* command + state API.
    // The backend RuntimeController owns run/pause/pacing/breakpoints and
    // self-halts on a breakpoint. The UI sends commands and visualizes; it
    // does NOT drive the emulation clock.
    const ctrlFor = controllerFor; // Spec 701 §7 — same wiring (incl. frame push)
    const PACING_MODES: RuntimePacingMode[] = ["pal", "warp", "fixed-ratio"];

    this.on("debug/run", ({ session_id, pacing }) => {
      const ctrl = ctrlFor(session_id);
      const mode = pacing?.mode && PACING_MODES.includes(pacing.mode) ? pacing.mode : undefined;
      ctrl.run({ mode, ratio: pacing?.ratio });
      return ctrl.state();
    });
    this.on("debug/pause", ({ session_id }) => { const c = ctrlFor(session_id); c.freezeWithProvenance(); return c.state(); }); // 710.6c capture-on-freeze
    this.on("debug/continue", ({ session_id }) => { const c = ctrlFor(session_id); c.continue(); return c.state(); });
    this.on("debug/step", ({ session_id }) => {
      const c = ctrlFor(session_id);
      const stop = c.step();
      monitorDisasmAddr.set(session_id, stop.pc); // bare `d` follows the step
      return c.state();
    });
    this.on("debug/break_add", ({ session_id, pc }) => {
      const c = ctrlFor(session_id);
      if (typeof pc !== "number") throw new Error("debug/break_add: pc (number) required");
      const num = c.addBreakpoint(pc);
      return { num, breakpoints: c.listBreakpoints() };
    });
    this.on("debug/break_del", ({ session_id, id }) => {
      const c = ctrlFor(session_id);
      if (id === undefined || id === null) { c.clearBreakpoints(); return { breakpoints: [] }; }
      const ok = c.delBreakpoint(Number(id));
      return { deleted: ok, breakpoints: c.listBreakpoints() };
    });
    this.on("debug/break_list", ({ session_id }) => ({ breakpoints: ctrlFor(session_id).listBreakpoints() }));
    this.on("debug/state", ({ session_id }) => ctrlFor(session_id).state());

    // ---- Spec 705.B — always-on checkpoint ring + pin/restore lifecycle.
    // The RuntimeController owns an in-memory bounded ring (auto-captured every
    // ~0.5 s). list/pin/unpin are pure ring ops; capture/restore go through the
    // controller (instruction-boundary + runExclusive). Restore also fires the
    // 706.8 audio transport flush. No persistence here (dump/undump = later).
    this.on("checkpoint/list", ({ session_id }) => {
      const c = ctrlFor(session_id);
      return { checkpoints: c.checkpointRing.list(), stats: c.checkpointRing.stats() };
    });
    this.on("checkpoint/capture", async ({ session_id }) => {
      const c = ctrlFor(session_id);
      const ref = await c.captureCheckpoint();
      return { ref, stats: c.checkpointRing.stats() };
    });
    this.on("checkpoint/pin", ({ session_id, id }) => {
      const c = ctrlFor(session_id);
      if (!id) throw new Error("checkpoint/pin: id required");
      const ref = c.checkpointRing.pin(String(id));
      if (!ref) throw new Error(`checkpoint/pin: unknown id ${id}`);
      return { ref, stats: c.checkpointRing.stats() };
    });
    this.on("checkpoint/unpin", ({ session_id, id }) => {
      const c = ctrlFor(session_id);
      if (!id) throw new Error("checkpoint/unpin: id required");
      const ref = c.checkpointRing.unpin(String(id));
      if (!ref) throw new Error(`checkpoint/unpin: unknown id ${id}`);
      return { ref, stats: c.checkpointRing.stats() };
    });
    // Spec 761 — drop all ring anchors (UI power-off: the scrub bar must not
    // show snapshots from before the machine was switched off).
    this.on("checkpoint/clear", ({ session_id }) => {
      const c = ctrlFor(session_id);
      c.checkpointRing.clear();
      return { stats: c.checkpointRing.stats() };
    });
    this.on("checkpoint/restore", async ({ session_id, id, then }) => {
      const c = ctrlFor(session_id);
      if (!id) throw new Error("checkpoint/restore: id required");
      // Spec 761.1 — then: pause (scrub-and-look) | run (resume-from-X) | keep.
      const intent = then === "pause" || then === "run" || then === "keep" ? then : undefined;
      const restored = await c.restoreCheckpoint(String(id), { then: intent });
      return { restored, state: c.state() };
    });

    // ---- Spec 766.5 — shared-memory recorder (worker-store scrub history).
    // Separate from the 765 checkpoint ring above (which still serves live
    // scrub/inspect); these expose the off-thread recorder for dumping a past
    // anchor to .c64re (the recorder's unique value: minutes of cheap history).
    this.on("recorder/status", async ({ session_id }) => {
      const c = ctrlFor(session_id);
      if (!c.recorder) return { active: false };
      return { active: true, stats: await c.recorder.stats(), produced: c.recorder.produced, mediumShipped: c.recorder.mediumShipped };
    });
    this.on("recorder/list", async ({ session_id }) => {
      const c = ctrlFor(session_id);
      if (!c.recorder) return { active: false, anchors: [] };
      return { active: true, anchors: await c.recorder.list() };
    });
    this.on("recorder/dump", async ({ session_id, seq, path }) => {
      const c = ctrlFor(session_id);
      if (seq === undefined || seq === null) throw new Error("recorder/dump: seq required");
      if (!path) throw new Error("recorder/dump: path required");
      return await dumpRecorderAnchorSnapshot(c, Number(seq), String(path));
    });

    // ---- Spec 710 — frozen-VIC inspect on the checkpoint model.
    // Reads a retained checkpoint and resolves display-area pixels/regions to
    // exact VIC/RAM provenance WITHOUT advancing execution (Spec 710 §2.1/§2.2).
    // Opening pauses the backend and pins the inspected checkpoint; the returned
    // checkpointId + snapshot are the SHARED record 711/712 also bind to. The
    // literal viciisc checkpoint is the visual authority; VicIIVice is not read.
    // Spec 710.5 — promoted evidence records per session (the shared 710/711/712
    // record). In-memory for now; knowledge-store persistence is the UI/explore
    // wiring (710.3) on top of this assembled record.
    const inspectEvidence = new Map<string, FrozenInspectEvidence[]>();
    const cpForInspect = (c: ReturnType<typeof ctrlFor>, id: string | number) => {
      const snap = c.checkpointRing.restoreSnapshot(String(id));
      const cp = snap?.payload as RuntimeCheckpoint | undefined;
      if (!cp || !cp.vic || !cp.ram) throw new Error(`vic/inspect: unknown or empty checkpoint ${id}`);
      return cp;
    };
    // Spec 710.4 — toggle the same-frame provenance sidecar (raster/FLI).
    this.on("vic/inspect/provenance", ({ session_id, enabled }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`vic/inspect/provenance: no session ${session_id}`);
      s.setVicProvenanceCapture(enabled !== false);
      return { enabled: enabled !== false };
    });
    this.on("vic/inspect/open", async ({ session_id }) => {
      const c = ctrlFor(session_id);
      if (c.runState === "running") c.freezeWithProvenance(); // §2.2 + 710.6c capture-on-freeze
      const ref = await c.captureCheckpoint();
      c.checkpointRing.pin(ref.id);                      // §2.2: pin the inspected checkpoint
      const cp = cpForInspect(c, ref.id);
      // 710.4/710.5 — provenance rides the checkpoint payload (durable).
      const provenance = cp.vicProvenance ?? undefined;
      // 710.3 option 2 — backend owns coordinate geometry; UI sends raw
      // visible-frame px and gets the conversion contract here.
      return {
        checkpointId: ref.id, frame: buildVicInspectSnapshot(cp), provenance, runState: c.runState,
        geometry: { visible: VISIBLE_FRAME, displayOrigin: DISPLAY_ORIGIN, cell: { w: 8, h: 8, cols: 40, rows: 25 } },
      };
    });
    // x/y and region are VISIBLE-frame coords (0..384 × 0..272); the backend converts.
    this.on("vic/inspect/at", ({ session_id, checkpoint_id, x, y }) => {
      if (!checkpoint_id) throw new Error("vic/inspect/at: checkpoint_id required");
      const cp = cpForInspect(ctrlFor(session_id), checkpoint_id);
      return { node: resolveVisibleNodeAt(cp, Number(x) || 0, Number(y) || 0, cp.vicProvenance ?? undefined) };
    });
    this.on("vic/inspect/region", ({ session_id, checkpoint_id, region }) => {
      if (!checkpoint_id) throw new Error("vic/inspect/region: checkpoint_id required");
      if (!region) throw new Error("vic/inspect/region: region required");
      const cp = cpForInspect(ctrlFor(session_id), checkpoint_id);
      return { nodes: resolveVisibleRegion(cp, region, cp.vicProvenance ?? undefined) };
    });
    this.on("vic/inspect/close", ({ session_id, checkpoint_id }) => {
      const c = ctrlFor(session_id);
      if (checkpoint_id) c.checkpointRing.unpin(String(checkpoint_id));
      return { ok: true, stats: c.checkpointRing.stats() };
    });
    // Spec 710.5 — promote selected nodes to a shared evidence record (checkpoint
    // + media identity + optional trace mark + resolved nodes). Disk + EasyFlash
    // media are 714-complete, so their records are durable/replayable.
    this.on("vic/inspect/promote", ({ session_id, checkpoint_id, points, region, name, notes, trace_mark_id }) => {
      if (!checkpoint_id) throw new Error("vic/inspect/promote: checkpoint_id required");
      const c = ctrlFor(session_id);
      const cp = cpForInspect(c, checkpoint_id);
      // points/region are VISIBLE-frame coords; assembleInspectEvidence resolves
      // them border-aware (sprites/multiplexer) — same path as at/region.
      const evidence = assembleInspectEvidence(cp, String(checkpoint_id), {
        points, region, traceMarkId: trace_mark_id, provenance: cp.vicProvenance ?? undefined,
      });
      const tagged = { ...evidence, name: name ?? null, notes: notes ?? null, promotedAtMs: Date.now() };
      const list = inspectEvidence.get(session_id) ?? [];
      list.push(tagged);
      inspectEvidence.set(session_id, list);
      return { evidence: tagged, count: list.length };
    });
    this.on("vic/inspect/evidence", ({ session_id }) => ({ evidence: inspectEvidence.get(session_id) ?? [] }));

    // ---- Spec 721 — Live Visual-Origin Join. Resolve a frozen visible node to
    // its ORIGIN: extract AssetCandidates from the mounted medium, then exact-hash
    // match (→ exact_asset) or, with a trace source, the writer/depack chain
    // (→ derived_asset), else honest runtime_generated. Candidates per medium are
    // cached (keyed by size+kind) so a click does not re-scan the image.
    const originCandidateCache = new Map<string, AssetCandidate[]>();
    const mediumCandidates = (session_id: string): { candidates: AssetCandidate[]; mediumRef: string | null } => {
      const s = getIntegratedSession(session_id);
      const media = s?.kernel?.drive1541?.getAttachedMedia?.();
      if (!media?.bytes?.length) return { candidates: [], mediumRef: null };
      const mediumRef = media.kind;
      const key = `${mediumRef}:${media.bytes.length}`;
      let candidates = originCandidateCache.get(key);
      if (!candidates) {
        candidates = extractAssetCandidates(media.bytes, { artifactId: session_id, mediumRef });
        originCandidateCache.set(key, candidates);
      }
      return { candidates, mediumRef };
    };
    this.on("vic/inspect/origin", ({ session_id, checkpoint_id, x, y }) => {
      if (!checkpoint_id) throw new Error("vic/inspect/origin: checkpoint_id required");
      const cp = cpForInspect(ctrlFor(session_id), checkpoint_id);
      const node = resolveVisibleNodeAt(cp, Number(x) || 0, Number(y) || 0, cp.vicProvenance ?? undefined);
      const { candidates, mediumRef } = mediumCandidates(session_id);
      const origin = resolveVisualOrigin(cp, node, candidates, { artifactId: session_id });
      return {
        node, classification: origin.result.classification,
        result: origin.result, knowledge: origin.knowledge,
        medium: { ref: mediumRef, candidateCount: candidates.length },
      };
    });

    // ---- Spec 707 — native .c64re snapshot persistence (dump/undump).
    // The SAME backend the monitor `dump`/`undump` commands use, so UI/API
    // controls never re-implement serialization (Spec 707 §4).
    this.on("snapshot/dump", async ({ session_id, path }) => {
      if (!path) throw new Error("snapshot/dump: path required");
      return await dumpRuntimeSnapshot(ctrlFor(session_id), String(path));
    });
    this.on("snapshot/undump", async ({ session_id, path }) => {
      if (!path) throw new Error("snapshot/undump: path required");
      return await undumpRuntimeSnapshot(ctrlFor(session_id), String(path));
    });

    // ---- Spec 708 — declarative trace definitions + runs.
    // Definitions live per-session on the controller; runs tap the existing
    // kernel trace channels and write 708 evidence tables in DuckDB. Same
    // backend the monitor `tracedb` commands use.
    this.on("trace/definition/validate", ({ definition }) => validateTraceDefinition(definition));
    this.on("trace/definition/put", ({ session_id, definition }) => {
      const v = validateTraceDefinition(definition);
      if (!v.ok) return { ok: false, errors: v.errors };
      const def = { ...definition, id: definition.id || slugTraceId(definition.name) };
      ctrlFor(session_id).traceDefinitions.set(def.id, def);
      return { ok: true, id: def.id };
    });
    this.on("trace/definition/list", ({ session_id }) => ({
      definitions: [...ctrlFor(session_id).traceDefinitions.values()],
    }));
    this.on("trace/run/start", async ({ session_id, definition_id, output }) => {
      const c = ctrlFor(session_id);
      const def = c.traceDefinitions.get(String(definition_id));
      if (!def) throw new Error(`trace/run/start: unknown definition "${definition_id}"`);
      const outputPath = resolveSnapshotPath(
        output ? String(output) : `traces/${def.id}_${Date.now().toString(36)}.duckdb`,
      );
      const run = await c.traceRun.start(def, { controller: c, outputPath });
      return { run };
    });
    // Spec 746.2 — start a live trace by DOMAINS (no pre-registered definition).
    // Builds a captureAll definition for the requested domains and starts it on the
    // shared session. This is the single trace-control entry the three gates use
    // (UI button, runtime_trace_start MCP tool, Monitor `trace` command). The
    // default session is built producers-on (746.1) so iec/drive/memory have data.
    this.on("trace/start_domains", async ({ session_id, domains, output }) => {
      const c = ctrlFor(session_id);
      if (c.traceRun.isActive()) throw new Error(`trace already active on session ${session_id} — stop it first (trace/run/stop).`);
      const { captureAllDef } = await import("../server-tools/runtime-trace-sink.js");
      const doms = (Array.isArray(domains) && domains.length ? domains : ["c64-cpu", "memory"]) as never;
      const def = captureAllDef(doms);
      // Spec 746.6 — per-session persistence layout: <project>/runtime/<session>/.
      // .c64retrace (the kept authority, OQ2) sits next to the .duckdb index (the
      // discardable cache, rebuilt from the log) under a session-scoped dir.
      const outputPath = resolveSnapshotPath(
        output ? String(output) : `runtime/${session_id}/live_${Date.now().toString(36)}.duckdb`,
      );
      const run = await c.traceRun.start(def, { controller: c, outputPath });
      return { run, outputPath, domains: doms };
    });
    // Spec 746.x — ONE stop path. `wait_index` is a POLICY flag, not a second
    // method: the UI omits it (instant button — the index publishes in the
    // background) while the MCP/LLM passes it (block until the DuckDB store is
    // queryable, since the LLM's next step is a query). Either way the runtime
    // does the identical stop. (review #4) Guard isActive like the Monitor's
    // `trace off`: a SELF-ABORTED trace already cleared itself, so return its
    // status instead of throwing — else the UI button sticks visually 'on'.
    this.on("trace/run/stop", async ({ session_id, wait_index }) => {
      const c = ctrlFor(session_id);
      if (!c.traceRun.isActive()) return { run: null, status: c.traceRun.status() };
      const run = await c.traceRun.stop();
      if (wait_index) {
        // BUG-039 — bound the wait (a multi-GB index takes minutes and would trip
        // the MCP host's ~180s stall limit). On timeout the build keeps running;
        // the caller's NEXT query waits/errs via the bounded read path.
        const timeout = new Promise<"timeout">((res) => {
          const t = setTimeout(() => res("timeout"), 120_000);
          (t as { unref?: () => void }).unref?.();
        });
        const r = await Promise.race([c.traceRun.awaitIndex().then(() => "done"), timeout]);
        if (r === "timeout") return { run, indexPending: true };
      }
      return { run };
    });
    this.on("trace/run/status", ({ session_id }) => ctrlFor(session_id).traceRun.status());
    // Spec 746.10 — the session's current (active) or last-finalized trace store, so a
    // UI/LLM can read the swimlane without re-passing the path.
    this.on("trace/current", ({ session_id }) => ctrlFor(session_id).traceRun.currentStorePath() ?? { path: null });
    this.on("trace/run/mark", ({ session_id, label }) => {
      const c = ctrlFor(session_id);
      if (!label) throw new Error("trace/run/mark: label required");
      c.traceRun.mark(String(label));
      return c.traceRun.status();
    });

    // BUG-029 — read a trace store IN THE DAEMON PROCESS. A DuckDB read-write handle
    // takes a CROSS-PROCESS file lock, so an external reader (the MCP/tool process)
    // cannot open a store the daemon is touching. But a read-only open IN THE SAME
    // PROCESS as the writer is allowed — so the daemon reads its own store and returns
    // the result over WS. One generic op-dispatch (like slice-2c api/call) covers every
    // trace-store reader; the MCP trace-read tools route here in daemon mode. The path
    // arrives ABSOLUTE (caller-resolved, project-agnostic).
    this.on("trace/read", async ({ op, duckdb_path, args }) => {
      if (typeof duckdb_path !== "string" || !duckdb_path) throw new Error("trace/read: duckdb_path required");
      // Spec 746.x — LAZY-ON-READ in the daemon process that owns the index job:
      // wait for an in-flight build, or (re)build a missing index from the
      // .c64retrace authority, before reading. A read right after stop transparently
      // waits; an orphaned store (e.g. a multi-GB trace whose index never built) is
      // recovered here on first read. Throws the real reason if the build failed.
      // BUG-039 — BOUNDED (15s grace, then a clear retry-later error): this wait sat
      // inside an MCP tool call; minutes of index build tripped the host's ~180s
      // stall limit and dropped the whole stdio connection ("MCP disconnected").
      const { ensureIndexBounded } = await import("../runtime/headless/trace/background-indexer.js");
      await ensureIndexBounded(duckdb_path);
      const a = (args ?? {}) as Record<string, unknown>;

      // Spec 746.x — trace_store_* reader functions (queries.ts) routed IN the
      // daemon (their own READ_ONLY open, after the awaitIndex above), so the MCP
      // process never opens the store itself = ONE read path through the runtime.
      // BigInt cycle/seq columns are JSON-unsafe over WS; cycles/seq stay well
      // under 2^53, so down-cast to Number losslessly.
      if (String(op) === "store_fn") {
        const q = await import("../runtime/trace-store/queries.js");
        const fa = (a.args ?? {}) as Record<string, any>;
        const jsonSafe = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => typeof v === "bigint" ? Number(v) : v));
        let out: unknown;
        switch (String(a.fn)) {
          case "getInfo": out = await q.getInfo(duckdb_path); break;
          case "topPcs": out = await q.topPcs(duckdb_path, fa.cpu, fa.limit); break;
          case "findBusEvents": out = await q.findBusEvents(duckdb_path, Number(fa.addr), fa.limit); break;
          case "listAnchors": out = await q.listAnchors(duckdb_path); break;
          case "findAnchor": out = await q.findAnchor(duckdb_path, String(fa.name), fa.limit); break;
          case "safeQuery": out = await q.safeQuery(duckdb_path, String(fa.sql), fa.limit); break;
          default: throw new Error(`trace/read store_fn: unknown fn "${a.fn}"`);
        }
        return jsonSafe(out);
      }

      const { withDuckDb } = await import("../server-tools/runtime.js");
      return await withDuckDb(duckdb_path, async (conn: any, backend: any) => {
        switch (String(op)) {
          case "swimlane": {
            const { swimlaneSlice } = await import("../runtime/headless/v2/swimlane.js");
            return await swimlaneSlice(backend, {
              runId: a.run_id as string,
              cycleRange: [Number(a.cycle_start), Number(a.cycle_end)],
              compact: a.compact as boolean,
              // Spec 746.13 — flow-focus lane + filter.
              ...(a.focus ? { focus: a.focus as "main" | "irq" | "nmi" } : {}),
              ...(a.nmi_vector !== undefined ? { nmiVector: Number(a.nmi_vector) } : {}),
            });
          }
          case "query_events": {
            const { queryEvents } = await import("../runtime/headless/v2/query-events.js");
            return await queryEvents(backend, a as never);
          }
          case "follow_path": {
            const { followPath } = await import("../runtime/headless/v2/follow-path.js");
            return await followPath(backend, a as never);
          }
          case "taint": {
            const { traceTaint } = await import("../runtime/headless/v2/taint.js");
            return await traceTaint(backend, a as never);
          }
          case "profile_loader": {
            const { profileLoader } = await import("../runtime/headless/v2/loader-profile.js");
            return await profileLoader(backend, a.scenario_id as string, [Number(a.cycle_start), Number(a.cycle_end)]);
          }
          case "sql": {
            const reader = await conn.runAndReadAll(String(a.sql));
            const rows = reader.getRows().slice(0, Number(a.limit ?? 200));
            return { rows: rows.map((r: unknown[]) => r.map((c) => typeof c === "bigint" ? c.toString() : c)) };
          }
          default:
            throw new Error(`trace/read: unknown op "${op}"`);
        }
      });
    });
    this.on("session/set_pacing", ({ session_id, mode, ratio }) => {
      const c = ctrlFor(session_id);
      if (!PACING_MODES.includes(mode)) throw new Error(`bad pacing mode: ${mode}`);
      c.setPacing(mode, ratio);
      return c.state();
    });

    // Reset. mode="soft" (default for the UI Reset button) = SYS 64738:
    // jump the C64 CPU to its reset vector ($FFFC/$FFFD = $FCE2), the
    // KERNAL cold-start routine (SEI/IOINIT/RESTOR/RAMTAS + BASIC cold).
    // This is exactly what the physical RESET key / SuperReset does —
    // resets the C64 only, NOT the drive (the drive has its own power),
    // RAM preserved. mode="cold" = full emulator reset (resetCold), used
    // by Power-ON cold boot.
    this.on("session/reset", async ({ session_id, video, mode }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      // Spec 701: run the re-init ATOMICALLY w.r.t. the loop via runExclusive
      // — it cancels the pending tick, runs the reset, then resumes the loop
      // IFF it was running, WITHOUT broadcasting paused/running. The previous
      // `pause()` here broadcast debug/paused, which raced the UI Reset
      // button's setRunState("running") → the loop could end up paused while
      // the UI thought it was running → frozen screen after reset+disk-change.
      const ctrl = controllerFor(session_id);
      const doReset = () => {
        if (mode === "soft") {
          // Reset button = HW RESET line. resetWarm re-inits CPU + chips +
          // drive and restores banking, so the $FFFC vector reads $FCE2 and
          // the KERNAL reset routine runs cleanly — recovering even from a
          // running/JAMmed game where $01 banked KERNAL out or a raster-IRQ
          // pointed into game code. RAM is preserved (unlike a power-cycle).
          s.resetWarm(video ?? "pal-default");
          s.runFor(5_000_000, { cycleBudget: 5_000_000 });
          return { c64Cycles: s.c64Cpu.cycles, pc: s.c64Cpu.pc, mode: "soft" };
        }
        s.resetCold(video ?? "pal-default");
        // Spec 761 — a cold power-cycle is a new machine: the checkpoint ring's
        // anchors belong to the OLD timeline (pre-reset RAM/state), so scrubbing
        // back to them would jump into a defunct session. Drop the ring; it
        // refills from the fresh boot.
        ctrl.checkpointRing.clear();
        // Run enough cycles for KERNAL to fully reach READY + BASIC input poll.
        // < 3M cycles eats leading chars from typeText; 5M is safe.
        s.runFor(5_000_000, { cycleBudget: 5_000_000 });
        return { c64Cycles: s.c64Cpu.cycles, pc: s.c64Cpu.pc, mode: "cold" };
      };
      const result = await ctrl.runExclusive(doReset);
      // Audio-restart fix: a reset is a timeline discontinuity (reSID re-init +
      // a burst run outside the frame-paced ship). Flush the worklet ring + reset
      // the send epoch so audio re-syncs from the post-reset state — no manual
      // off/on needed (same mechanism as a checkpoint restore, Spec 706.8).
      const audio = this.audioStreams.get(session_id);
      if (audio) { audio.seq = 0; this.broadcast("audio/flush", { session_id }); }
      return result;
    });

    // Type text (PETSCII keyboard input).
    this.on("session/type", async ({ session_id, text, hold_cycles, gap_cycles }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      s.typeText(text ?? "", hold_cycles ?? 80_000, gap_cycles ?? 80_000);
      return { c64Cycles: s.c64Cpu.cycles, queued: text?.length ?? 0 };
    });

    // Spec 310 — live keyboard passthrough (browser keydown/keyup).
    this.on("session/key_down", ({ session_id, key }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      s.keyDown(key);
      return { ok: true, pressed: s.pressedKeys() };
    });
    this.on("session/key_up", ({ session_id, key }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      s.keyUp(key);
      return { ok: true, pressed: s.pressedKeys() };
    });
    this.on("session/release_keys", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      s.releaseAllKeys();
      // Also clear joystick state on release-all (= focus loss policy).
      s.setJoystick1({ up: false, down: false, left: false, right: false, fire: false });
      s.setJoystick2({ up: false, down: false, left: false, right: false, fire: false });
      return { ok: true };
    });

    // Spec 310 — virtual joystick state. UI maps WASD+Space → bits and
    // POSTs them here. Mode (off/port1/port2) is UI-side state; this
    // handler accepts the resolved port + bits.
    this.on("session/joystick_set", ({ session_id, port, up, down, left, right, fire }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const state = { up: !!up, down: !!down, left: !!left, right: !!right, fire: !!fire };
      if (port === 1) s.setJoystick1(state); else s.setJoystick2(state);
      return { ok: true };
    });
    this.on("session/joystick_clear", ({ session_id, port }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const cleared = { up: false, down: false, left: false, right: false, fire: false };
      if (port === 1 || port === undefined) s.setJoystick1(cleared);
      if (port === 2 || port === undefined) s.setJoystick2(cleared);
      return { ok: true };
    });

    // Spec 310 — input status (= UI inspector reads pressed keys + joy
    // bits; per-session, includes both ports so UI can mirror state).
    this.on("session/input_status", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      return {
        pressed: s.pressedKeys(),
        joystick1: { ...s.joystick1 },
        joystick2: { ...s.joystick2 },
      };
    });

    // Spec 424 — Drive status: LED + motor + R/W + flash + T/S + PC.
    // LED bit is VIA2 PB3 (not VIA1 — pre-424 was wrong VIA, latent
    // bug). R/W direction = VIA2 CB2 routed via PCR bits 5..7.
    this.on("session/drive_status", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      // Spec 704 §11 R3 — vice-only: read drive status from the vice1541
      // facade (driveDebug probe) + diskunit. Legacy DriveCpu/headPosition/
      // gcrShifter removed. Parity gaps vs the old legacy readout: LED-PWM
      // brightness curve, VIA2-PCR r/w indicator, and a precise motor flag
      // are not surfaced by the vice probe — approximated below.
      const dd = s.driveDebug();
      const viceUnit = (s as any).kernel?.drive1541?.unit ?? (s as any).drive1541?.unit ?? null;
      const viceDrive0 = viceUnit?.drives?.[0] ?? null;
      const halfTrack = (viceDrive0?.current_half_track ?? dd.head_halftrack) & 0xff;
      const ledOn = dd.led !== 0;
      const ledPwm = ledOn ? 1000 : 0;
      const ledFlashing = false;
      // Motor not exposed on the vice probe; DOS lights the LED while the
      // motor spins, so approximate motorOn from the LED.
      const motorOn = ledOn;
      // R/W mode: vice VIA2 PCR not surfaced on the probe; default read.
      const rwMode: "read" | "write" = "read";
      // Sector under the GCR read head (vice decode).
      let sector = 0;
      if (viceDrive0) {
        const sec = viceSectorUnderHead(viceDrive0);
        if (sec >= 0) sector = sec;
      }
      const drivePc = (viceUnit?.cpu?.cpu_regs?.pc ?? dd.drive_pc) & 0xffff;
      // vice current_half_track is 2-based (ht 2 = track 1) → track = ht/2.
      const track = Math.floor(halfTrack / 2);

      // Spec 424 follow-up — IEC bus snapshot + transfer-mode heuristic.
      // CIA2 PA ($DD00):
      //   bit 0..1 = VIC bank (output)
      //   bit 3    = ATN out (active LOW after inversion on bus)
      //   bit 4    = CLK out
      //   bit 5    = DATA out
      //   bit 6    = CLK in (read)
      //   bit 7    = DATA in (read)
      // We surface raw PA latch + DDR + composed read value.
      const cia2 = s.cia2 as any;
      const dd00pra = cia2.pra & 0xff;
      const dd00ddr = cia2.ddra & 0xff;

      // Transfer mode: sticky classifier. C64 PC during recent serial
      // bus activity. KERNAL serial routines live in $E000..$FFFF when
      // HIRAM=1 (= ROM banked in). Anything else driving the bus = CUSTOM.
      // Cheap heuristic: current PC. KERNAL bands:
      //   $ED00-$EE00 = main IEC routines (LISTEN/TALK/SECOND/etc.)
      //   $EE13-$EF00 = SEND/RECV bit-bang
      //   $F4A5-$F634 = LOAD path
      // Everything else is CUSTOM (or idle if bus has been quiescent).
      const c64pc = (s as any).c64Cpu?.pc ?? 0;
      const transferMode: "kernal" | "custom" | "idle" =
        c64pc >= 0xE000 && c64pc <= 0xFFFF ? "kernal" :
        c64pc >= 0xF400 && c64pc <= 0xF800 ? "kernal" :
        // Heuristic: if drive cpu is idle in $EBFD..$ECC0 wait-loop AND
        // C64 in BASIC ($A000..$BFFF) or RAM, classify as idle.
        (drivePc >= 0xEBFD && drivePc <= 0xECC0) ? "idle" :
        "custom";

      return {
        device: 8,
        ledOn,
        ledFlashing,
        ledPwm,
        motorOn,
        rwMode,
        halfTrack,
        track,
        sector,
        drivePc,
        // Spec 424 follow-up — IEC + transfer indicator
        dd00: { pra: dd00pra, ddr: dd00ddr },
        transferMode,
      };
    });

    // Spec 424 — cartridge status. IntegratedSession has no cart
    // plumbing yet (deferred to follow-up spec 425). Returns null.
    // Spec 709.9 — live cartridge status from the real attached cartridge, in
    // the shape the Live/Inspector UI consumes ({ type, bank, activity }; null
    // when no cart). Was hard-coded null after a real CRT attach (§10.2.4).
    this.on("session/cart_status", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const bus = (s.kernel as any).c64Bus;
      const info = bus?.getBankInfo?.();
      if (!info?.cartridgeAttached) return null;
      const cart = bus?.getCartridge?.();
      const state = cart?.getState?.();
      // Spec 709.13 — the source filename is backend truth (from the attached
      // cartridge media), so every tab's CART display derives from here instead
      // of keeping its own per-tab local path that can diverge.
      const sourceName: string | undefined = bus?.getCartridgeMedia?.()?.name;
      // BUG-042 — real LED signals (user direction 2026-06-11):
      //   write = writableGeneration advanced since the last poll (the BUG-040
      //           counter: every flash/EEPROM program/erase). Held 1.2s so the
      //           250ms UI poll renders a steady blink through a write burst.
      //   read  = cart currently mapped (EXROM and/or GAME asserted = "CART on").
      //   booted = last reset had the cart mapped into the boot path.
      const gen: number = cart?.writableGeneration?.() ?? 0;
      const tr = this.cartLedTrack.get(session_id) ?? { gen, lastWriteAt: 0 };
      if (gen !== tr.gen) { tr.gen = gen; tr.lastWriteAt = Date.now(); }
      this.cartLedTrack.set(session_id, tr);
      const mapped = info.cartridgeExrom === 0 || info.cartridgeGame === 0;
      const activity = (Date.now() - tr.lastWriteAt < 1200) ? "write" as const
        : mapped ? "read" as const : "idle" as const;
      return {
        type: info.cartridgeMapperType ?? "cartridge",
        bank: typeof state?.currentBank === "number" ? state.currentBank : 0,
        activity,
        booted: (s as unknown as { cartBootedFrom?: boolean }).cartBootedFrom === true,
        sourceName,
      };
    });

    // Sidequest 2026-05-20 — Drive 8 power-cycle / re-init button.
    // Single press = cold re-init of the active drive (drive 6502 PC
    // back to ROM reset vector, DOS re-runs its power-on init). In
    // vice mode this drives the vice1541 facade.reset("cold")
    // (= drivecpu_trigger_reset + drivecpu_reset).
    this.on("session/drive_power", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const facade = (s as any).kernel?.drive1541 ?? (s as any).drive1541 ?? null;
      if (facade && typeof facade.reset === "function") {
        facade.reset("cold");
        return { device: 8, reinitialized: true, mode: "vice" };
      }
      // Spec 704 §11 R3 — vice-only: no legacy drive fallback.
      return { device: 8, reinitialized: false };
    });

    // Spec 703 §8 — backend renders reSID PCM in the per-frame hook (same loop
    // + cadence as the video push) and streams it. Audio inherits the steady
    // frame clock that already makes video smooth.
    this.on("audio/start", ({ session_id }) => {
      const s = getIntegratedSession(session_id) as any;
      if (!s) throw new Error(`no session ${session_id}`);
      // Audio-restart fix: if a stream already exists (e.g. a reloaded UI whose
      // socket-close cleanup raced the reconnect), don't no-op — RE-PRIME the
      // (new) client: reset the send epoch + flush its worklet ring so it
      // re-prebuffers from the current reSID state instead of staying silent.
      const existing = this.audioStreams.get(session_id);
      if (existing) {
        existing.seq = 0;
        this.broadcast("audio/flush", { session_id });
        return { already_streaming: true, reprimed: true };
      }

      // Spec 706.2 (Fix A) — LIVE stream uses the small recorder buffer so a
      // catch-up flush drops stale excess at the source instead of banking
      // permanent latency. (Offline export keeps the large buffer.)
      const recorder = new SidAudioRecorder(s, {
        sampleRate: 44100, bufferSamples: LIVE_RECORDER_BUFFER_SAMPLES,
      });
      recorder.resid.ready?.().catch((e) => {
        console.warn(`[audio/start] reSID load failed for ${session_id}: ${e?.message ?? e}`);
      });
      const cursorId = `ws_${session_id}_${Date.now()}`;
      recorder.buffer.attach(cursorId);
      const state = { recorder, cursorId, seq: 0 };
      this.audioStreams.set(session_id, state);

      // Spec 706.8 — on a RuntimeCheckpoint restore the recorder flushes its PCM
      // ring (transport state) and fires this hook. Start a new stream epoch:
      // reset the send seq and tell the browser to flush its worklet ring +
      // re-prebuffer from the restored reSID state (no old-timeline playback).
      recorder.onRestore = () => {
        state.seq = 0;
        this.broadcast("audio/flush", { session_id });
      };

      const controller = ensureRuntimeController(
        session_id, s, (m, p) => this.broadcast(m, p), undefined,
      );
      // One PCM frame per completed emulated frame (~882 samples @ PAL) →
      // steady ~20ms delivery, locked to the video frame cadence.
      controller.onAudioFrame = () => {
        recorder.flush();
        const avail = recorder.buffer.available(cursorId);
        if (avail <= 0) return;
        // Spec 706.4 (Fix C) — bound how much we ship per frame to ~realtime+
        // slack. Steady state ships ~882; this only bites during a catch-up
        // burst, where shipping the whole backlog at once would flood the WS +
        // worklet (permanent latency). Unshipped samples stay in the recorder
        // ring; its small live cap (Fix A) then drops the STALE excess at the
        // source — so this defers without ever emitting a gap.
        const ship = Math.min(avail, MAX_AUDIO_SHIP_SAMPLES);
        // BUG-049 — read mono into a pooled buffer, build the [type][seq][stereo
        // s16le] wire frame inline into a 3-slot rotating buffer. No per-frame
        // alloc (was: read slice + monoToStereoLR + int16ToLeBytes + encode).
        if (!this._audioSamples) this._audioSamples = new Int16Array(MAX_AUDIO_SHIP_SAMPLES);
        const n = recorder.buffer.readInto(cursorId, ship, this._audioSamples);
        if (n === 0) return;
        const samples = this._audioSamples;
        const wireLen = 5 + n * 4; // n mono → n stereo frames → 4 bytes each (L,R s16le)
        let wire = this._audioWirePool[this._audioWireIdx];
        if (!wire || wire.length < wireLen) {
          wire = new Uint8Array(5 + MAX_AUDIO_SHIP_SAMPLES * 4);
          this._audioWirePool[this._audioWireIdx] = wire;
        }
        this._audioWireIdx = (this._audioWireIdx + 1) % 3;
        const seq = state.seq++;
        wire[0] = BIN_TYPE_AUDIO_BUFFER & 0xff;
        wire[1] = seq & 0xff; wire[2] = (seq >> 8) & 0xff; wire[3] = (seq >> 16) & 0xff; wire[4] = (seq >>> 24) & 0xff;
        for (let i = 0; i < n; i++) {
          const s = samples[i]!; const lo = s & 0xff, hi = (s >> 8) & 0xff; const o = 5 + i * 4;
          wire[o] = lo; wire[o + 1] = hi; wire[o + 2] = lo; wire[o + 3] = hi; // L, R
        }
        this.broadcastAudioWire(wire, wireLen);
      };
      return { streaming: true, sample_rate: recorder.resid.sampleRate };
    });

    this.on("audio/stop", ({ session_id }) => ({ stopped: this.stopAudioStream(session_id) }));

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

    // Spec 709 — single byte/hash/event media-ingress authority. The UI
    // drag/drop + file chooser send a typed request here (bytes as base64, or a
    // server-resolvable path); disk/prg/crt/eject all run through ingestMedia
    // with checkpoint-before/after + dirty-media + drive9 + .c64re guards.
    // Spec 744.4c slice 2b — buildIngressRequest + kindFromExt moved to the shared
    // media/ingress-request module so the MCP tools build byte-identical requests.
    this.on("media/ingress", async ({ session_id, ...rest }) => {
      const ctrl = ctrlFor(session_id);
      const ireq = buildIngressRequest(rest);
      // Spec 709.12 — a live CRT insert from a running session resumes after the
      // power-cycle so the cart actually executes (UX: "insert CRT → it runs").
      return await ingestMedia(ctrl, ireq, { resumeIfRunning: ireq.kind === "crt" });
    });

    // Legacy path-based routes — now thin adapters to the single ingress service
    // (Spec 709 §2.1). slot 9 + .c64re rejected. .vsf stays the legacy snapshot
    // path (not media). The adapter returns a MountResult-COMPATIBLE shape
    // ({ mountedPath, type, mapperType, slot } + the typed event/detail) so the
    // existing Media tab keeps working (Spec 709.9). kindFromExt: shared module.
    const adaptMount = async ({ session_id, slot, path }: any) => {
      if (typeof path !== "string") throw new Error("media/mount: path required");
      if (slot !== undefined && Number(slot) === 9) throw new Error("media/mount: drive 9 not supported (v1 drive8-only)");
      const k = kindFromExt(path);
      if (k === "c64re") {
        throw new Error("media/mount: .c64re is a runtime snapshot, not media — use snapshot/undump (Spec 707), not a media mount.");
      }
      if (k === "vsf") {
        const session = getIntegratedSession(session_id);
        if (!session) throw new Error(`no session ${session_id}`);
        const { mountMedia } = await import("../runtime/headless/media/mount.js");
        const ctrl = getRuntimeController(session_id);
        const doMount = () => mountMedia(session, 8, path);
        return ctrl ? ctrl.runExclusive(doMount) : doMount();
      }
      // Spec 709.12 — the Inspector CART dropdown mounts a .crt through this
      // same route (slot 0). A CRT insert from a running session resumes at PAL
      // pacing after the power-cycle so the cart executes; a disk mount keeps
      // the existing paused-after contract.
      const res = await ingestMedia(
        ctrlFor(session_id),
        buildIngressRequest({ kind: k, path, mode: "load" }),
        { resumeIfRunning: k === "crt" },
      );
      // MountResult-compatible projection for the existing UI + the typed event.
      return {
        mountedPath: String(path),
        type: res.event.format ?? k,
        mapperType: res.detail.mapperType,
        slot: k === "disk" ? 8 : undefined,
        sha256: res.event.sha256,
        event: res.event, detail: res.detail, paused: res.paused,
      };
    };
    this.on("media/mount", adaptMount);
    this.on("media/swap", adaptMount); // swap = ingest a new disk; service dirty-checks + checkpoints
    // Spec 709.8 — ordered media-event readback for replay/branch consumers (710-712).
    this.on("media/events", ({ session_id }) => ({ events: ctrlFor(session_id).mediaEvents }));
    // Spec 709.11 (Befund 3) — route eject by target. The UI sends slot 0 (or
    // role "cartridge") for a CART eject; slot 8 = drive 8; slot 9 rejected.
    // Previously this ignored slot and always ejected drive 8, so a CART eject
    // removed the disk in drive 8.
    this.on("media/unmount", async ({ session_id, slot, role }) => {
      const n = slot !== undefined ? Number(slot) : 8;
      if (n === 9) throw new Error("media/unmount: drive 9 not supported (v1 drive8-only)");
      const ejectRole: "cartridge" | "drive8" = (role === "cartridge" || n === 0) ? "cartridge" : "drive8";
      // A cartridge eject is a power-cycle (Spec 709.12, VICE-faithful) → resume
      // running after so it doesn't leave the machine stuck paused (yellow). A
      // disk eject is a live device op (never paused).
      return await ingestMedia(ctrlFor(session_id), { kind: "eject", role: ejectRole }, { resumeIfRunning: ejectRole === "cartridge" });
    });

    this.on("media/recent", async () => {
      const { getRecent } = await import("../runtime/headless/media/recent-files.js");
      const pmod = await import("node:path");
      const fsmod = await import("node:fs");

      const exts = [".d64", ".g64", ".crt", ".prg", ".vsf"];
      const seen = new Set<string>();
      const out: Array<{ path: string; name: string; type: string }> = [];

      // BUG-013 — the picker must show ONLY active-project media in product
      // mode. getRecent() is a GLOBAL store, so it carries media from prior
      // runs (incl. the repo gate corpus: motm.g64, POLARBEAR.d64, …). Gate
      // every recents path to inside the active project dir. (Outside paths are
      // only allowed under --dev-samples, handled in §2.)
      const projDirAbs = this.projectDir ? pmod.resolve(this.projectDir) : "";
      const insideProject = (p: string): boolean => {
        if (!projDirAbs) return false;
        const rel = pmod.relative(projDirAbs, pmod.resolve(p));
        return rel !== "" && !rel.startsWith("..") && !pmod.isAbsolute(rel);
      };

      // 1. Recents (existing AND inside the project) first — preserves
      //    "recently used" ordering at top of picker. In dev-samples mode,
      //    recents from anywhere are allowed (dev convenience).
      for (const r of getRecent() as any[]) {
        try { if (!fsmod.existsSync(r.path)) continue; } catch { continue; }
        if (seen.has(r.path)) continue;
        if (!this.devSamples && !insideProject(r.path)) continue;
        seen.add(r.path);
        out.push({ ...r, name: r.name ?? pmod.basename(r.path) });
      }

      // 2. Spec 724.3: repo `samples/` only under `--dev-samples` (dev
      //    convenience). Production media comes from the project dir (§3
      //    below), never a silent cwd fallback.
      const samplesDir = pmod.join(process.cwd(), "samples");
      if (this.devSamples && fsmod.existsSync(samplesDir)) {
        for (const entry of fsmod.readdirSync(samplesDir).sort()) {
          if (entry.startsWith(".") || entry === "node_modules") continue;
          const full = pmod.join(samplesDir, entry);
          let st;
          try { st = fsmod.statSync(full); } catch { continue; }
          if (st.isDirectory()) continue; // top-level only
          if (seen.has(full)) continue;
          const lower = entry.toLowerCase();
          const ext = exts.find((e) => lower.endsWith(e));
          if (!ext) continue;
          seen.add(full);
          out.push({ path: full, name: pmod.basename(full), type: ext.slice(1) });
        }
      }

      // 3. Spec 724.3: the project dir (this.projectDir, resolved once at
      //    startup — NOT process.env) — depth-limited recursive scan for IMAGE
      //    media (.crt/.d64/.g64/.vsf only; skip .prg to avoid flooding the
      //    picker with analysis-dir PRGs). Surfaces e.g. ef_port/motm_ef.crt.
      const projDir = this.projectDir;
      if (projDir && fsmod.existsSync(projDir)) {
        const imgExts = [".crt", ".d64", ".g64", ".vsf"];
        const walk = (dir: string, depth: number) => {
          if (depth > 3 || out.length >= 100) return;
          let entries: string[] = [];
          try { entries = fsmod.readdirSync(dir).sort(); } catch { return; }
          for (const entry of entries) {
            if (entry.startsWith(".") || entry === "node_modules" || entry === "knowledge") continue;
            const full = pmod.join(dir, entry);
            let st; try { st = fsmod.statSync(full); } catch { continue; }
            if (st.isDirectory()) { walk(full, depth + 1); continue; }
            if (seen.has(full)) continue;
            const ext = imgExts.find((e) => entry.toLowerCase().endsWith(e));
            if (!ext) continue;
            seen.add(full);
            out.push({ path: full, name: `${pmod.basename(dir)}/${pmod.basename(full)}`, type: ext.slice(1) });
          }
        };
        walk(projDir, 0);
      }
      return out.slice(0, 100);
    });

    // ---- Spec 268 — Snapshot tree + scenario registry WS handlers ----

    this.on("runtime/snapshot_tree", async ({ session_id }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      // Spec 723.2: the product path is true-drive; never bake a fast-trap
      // scenario into a promoted branch. (ScenarioMode has no debug modes;
      // the live session is true-drive.)
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: session.diskPath || session_id, mode: "true-drive" });
      const rm = api.beginRewindSession();
      const handle = rm.handle();
      const branches: Record<string, any> = {};
      for (const [k, v] of handle.branches) branches[k] = v;
      return {
        scenarioId: handle.scenarioId,
        rootBranchId: handle.rootBranchId,
        rootSnapshotId: handle.rootSnapshotId,
        ringSize: handle.ringSize,
        branches,
      };
    });

    this.on("runtime/promote_branch", async ({ session_id, branch_id }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      // Spec 723.2: the product path is true-drive; never bake a fast-trap
      // scenario into a promoted branch. (ScenarioMode has no debug modes;
      // the live session is true-drive.)
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: session.diskPath || session_id, mode: "true-drive" });
      const rm = api.beginRewindSession();
      return rm.promoteBranch(branch_id);
    });

    this.on("runtime/scenario_list", async () => {
      const { listScenarios } = await import("../runtime/headless/v2/scenario-registry.js");
      return listScenarios();
    });

    this.on("runtime/scenario_save", async ({ scenario }) => {
      if (!scenario || typeof scenario !== "object") throw new Error("scenario object required");
      const { saveScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      return saveScenario(scenario);
    });

    this.on("runtime/scenario_delete", async ({ id }) => {
      if (typeof id !== "string") throw new Error("id required");
      const { deleteScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const ok = deleteScenario(id);
      return { deleted: ok };
    });

    // Spec 352 / 754 — Monitor exec. Thin adapter: build the context and call
    // the ONE canonical command processor (BUG-037, monitor-shell.ts). All
    // command logic — lifecycle (g/x/until, BUG-036), bank-lens m/d (BUG-038),
    // stepping, breakpoints, trace, snapshots — lives in runMonitorCommand.
    this.on("monitor/exec", async ({ session_id, command }) => {
      const s = getIntegratedSession(session_id);
      if (!s) return { error: `no session ${session_id}` };
      const ctrl = controllerFor(session_id);
      // Spec 754 §3.3h — the trace-store read bridge (map/taint/swimlane). The WS
      // server owns the daemon trace readers + currentStorePath; monitor-shell
      // stays runtime-pure and calls ctx.traceRead. In-daemon read-only open
      // (BUG-029): no cross-process lock.
      const traceRead = async (mop: "map" | "taint" | "swimlane" | "chis", margs: Record<string, unknown>): Promise<string> => {
        // chis replay core — BUG-046: shared by `chis` AND the swimlane
        // fallback. Restores the newest ring checkpoint at/before winStart,
        // replays-with-capture to winEnd, renders the [winStart, winEnd]
        // swimlane. Generates its OWN store (does not read currentStorePath).
        // Non-destructive: save now, replay, restore now. History is
        // REGENERATED by deterministic replay — live inputs that originally
        // arrived inside the window are NOT re-injected (documented caveat).
        const chisReplay = async (winStart: number, winEnd: number): Promise<string> => {
          const nowCycles = s.c64Cpu.cycles;
          if (ctrl.traceRun.isActive()) throw new Error("a trace is active — `trace off` first");
          if (winEnd <= winStart) throw new Error(`window end must be > start (${winStart}..${winEnd})`);
          if (winEnd > nowCycles) throw new Error(`window end ${winEnd} is in the future (now=${nowCycles})`);
          const refs = ctrl.checkpointRing.list();
          if (!refs.length) throw new Error("no checkpoint in the ring yet — run the machine (it auto-captures while running)");
          let pick: (typeof refs)[number] | undefined;
          for (const r of refs) if (r.cycles <= winStart) pick = r; // refs ascend; keep the newest at/before start
          let partial = "";
          if (!pick) {
            const oldest = refs[0]!;
            if (oldest.cycles >= winEnd) {
              throw new Error(`window ${winStart}..${winEnd} lies before the oldest ring checkpoint (@cyc ${oldest.cycles}) — older history was evicted (128MiB ring)`);
            }
            pick = oldest; // window tail is still coverable
            partial = ` (partial: ring history starts @cyc ${oldest.cycles})`;
          }
          const nowRef = await ctrl.captureCheckpoint();
          try {
            await ctrl.restoreCheckpoint(pick.id);
            const fromCycles = s.c64Cpu.cycles;
            const toRun = winEnd - fromCycles;
            if (toRun <= 0) throw new Error("nearest checkpoint is at/after the window end — nothing to replay");
            const { captureAllDef } = await import("../server-tools/runtime-trace-sink.js");
            const { resolveSnapshotPath } = await import("../runtime/headless/kernel/snapshot-persistence.js");
            const def = captureAllDef(["c64-cpu", "iec", "memory"] as never);
            const outputPath = resolveSnapshotPath(`runtime/${session_id}/chis_${Date.now().toString(36)}.duckdb`);
            const run = await ctrl.traceRun.start(def, { controller: ctrl, outputPath });
            s.runFor(Math.ceil(toRun / 2) + 2000, { cycleBudget: toRun });
            const stopped = await ctrl.traceRun.stop();
            const storePath = stopped.evidenceRef ?? outputPath;
            const { ensureIndexBounded } = await import("../runtime/headless/trace/background-indexer.js");
            await ensureIndexBounded(storePath); // BUG-039 — bounded (inline trace is small; grace suffices)
            const { withDuckDb } = await import("../server-tools/runtime.js");
            const { swimlaneSlice } = await import("../runtime/headless/v2/swimlane.js");
            const { renderText } = await import("../runtime/headless/v2/swimlane-render.js");
            return await withDuckDb(storePath, async (_conn: any, backend: any) => {
              const slice = await swimlaneSlice(backend, { runId: stopped.runId ?? run.runId, cycleRange: [Math.max(winStart, fromCycles), winEnd], compact: true } as never);
              return `chis: replayed ${toRun} cyc from checkpoint @cyc ${fromCycles} (window ${winStart}..${winEnd})${partial}\n` + renderText(slice, { maxRows: 200 });
            });
          } finally {
            try { await ctrl.restoreCheckpoint(nowRef.id); } catch { /* best effort — machine may sit at replay-end */ }
          }
        };
        if (mop === "chis") {
          // Two window forms: {windowCycles} = last N cycles up to NOW (the
          // original chis), {cycleStart, cycleEnd} = arbitrary historical
          // window between two cycles (BUG-046, checkpoint-ring replay).
          const hasRange = Number.isFinite(Number(margs.cycleStart)) && Number.isFinite(Number(margs.cycleEnd));
          const nowCycles = s.c64Cpu.cycles;
          const winEnd = hasRange ? Number(margs.cycleEnd) : nowCycles;
          const winStart = hasRange ? Number(margs.cycleStart) : Math.max(0, nowCycles - Number(margs.windowCycles ?? 5000));
          return chisReplay(winStart, winEnd);
        }
        // swimlane — picks a TRACE (list / newest / by name) and renders its tail.
        // Separate from the currentStorePath block below: it can read ANY stored
        // trace, and its default window anchors to the STORE's own max(cycle), not
        // the live CPU clock (which runs past the captured range after `trace off`).
        if (mop === "swimlane") {
          const { resolveSnapshotPath } = await import("../runtime/headless/kernel/snapshot-persistence.js");
          const fs = await import("node:fs");
          const path = await import("node:path");
          const dir = path.dirname(resolveSnapshotPath(`runtime/${session_id}/x.duckdb`));
          const q = await import("../runtime/trace-store/queries.js");
          const listStores = (): { name: string; path: string; mtime: number }[] => {
            let ents: string[]; try { ents = fs.readdirSync(dir); } catch { return []; }
            return ents.filter((f) => f.endsWith(".duckdb")).map((f) => {
              const p = path.join(dir, f);
              let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch { /* gone */ }
              return { name: f.replace(/\.duckdb$/, ""), path: p, mtime };
            }).sort((x, y) => y.mtime - x.mtime);
          };
          if (margs.list) {
            const stores = listStores();
            if (!stores.length) return "swimlane list: no traces yet (run `trace on` … `trace off`)";
            const lines = ["traces (newest first) — `swimlane <name>`:"];
            for (const st of stores.slice(0, 30)) {
              try {
                const gi: any = await q.getInfo(st.path);
                const ev = Number(gi.tableCounts?.["events:total"] ?? 0);
                const mn = gi.masterClockRange ? Number(gi.masterClockRange.min) : 0;
                const mx = gi.masterClockRange ? Number(gi.masterClockRange.max) : 0;
                lines.push(`  ${st.name}  cyc ${mn}..${mx}  events=${ev}`);
              } catch { lines.push(`  ${st.name}  (index not built — read once to build)`); }
            }
            return lines.join("\n");
          }
          // BUG-046 — an explicit cycle window may name history no stored
          // trace covers. In that case (and only without an explicit trace
          // name) fall back to the checkpoint-ring replay (chis core).
          const wantS = Number(margs.cycleStart), wantE = Number(margs.cycleEnd);
          const explicitRange = Number.isFinite(wantS) && Number.isFinite(wantE) && !margs.name;
          let storePath: string | undefined;
          if (margs.name) {
            const nm = String(margs.name).replace(/\.duckdb$/, "");
            const cand = path.join(dir, nm + ".duckdb");
            if (fs.existsSync(cand)) storePath = cand;
            else return `swimlane: no trace named '${nm}' — try \`swimlane list\``;
          } else {
            storePath = listStores()[0]?.path ?? ctrl.traceRun.currentStorePath?.()?.path;
          }
          if (!storePath) {
            if (explicitRange) {
              return `swimlane: no trace store covers ${wantS}..${wantE} — checkpoint-ring replay:\n` + await chisReplay(wantS, wantE);
            }
            return "swimlane: no trace store — run `trace on` … `trace off` first";
          }
          const { ensureIndexBounded } = await import("../runtime/headless/trace/background-indexer.js");
          await ensureIndexBounded(storePath); // BUG-039 — bounded read-path wait
          const { withDuckDb } = await import("../server-tools/runtime.js");
          const { swimlaneSlice } = await import("../runtime/headless/v2/swimlane.js");
          const { renderText } = await import("../runtime/headless/v2/swimlane-render.js");
          const out = await withDuckDb(storePath, async (conn: any, backend: any): Promise<string | null> => {
            const rid = (await conn.runAndReadAll("SELECT run_id FROM trace_run LIMIT 1")).getRows()[0]?.[0];
            const runId = rid != null ? String(rid) : undefined;
            let cs = Number(margs.cycleStart);
            let ce = Number(margs.cycleEnd);
            if (!Number.isFinite(cs) || !Number.isFinite(ce)) {
              const span = Number(margs.lastCycles ?? 2000);
              const rg = (await conn.runAndReadAll("SELECT MIN(cycle), MAX(cycle) FROM trace_event WHERE cycle IS NOT NULL")).getRows()[0];
              const mn = Number(rg?.[0] ?? 0), mx = Number(rg?.[1] ?? 0);
              if (!Number.isFinite(ce)) ce = mx;
              if (!Number.isFinite(cs)) cs = Math.max(mn, ce - span);
            }
            const slice = await swimlaneSlice(backend, { runId, cycleRange: [cs, ce], compact: true } as never);
            if (!(slice as { rows: unknown[] }).rows.length && explicitRange) return null; // → ring replay below
            const stem = path.basename(storePath!).replace(/\.duckdb$/, "");
            return `# ${stem}\n` + renderText(slice, { maxRows: 200 });
          });
          if (out === null) {
            return `swimlane: stored traces have no events in ${wantS}..${wantE} — checkpoint-ring replay:\n` + await chisReplay(wantS, wantE);
          }
          return out;
        }
        const sp = ctrl.traceRun.currentStorePath?.();
        if (!sp?.path) throw new Error("no trace store — run `trace on` first");
        const { ensureIndexBounded } = await import("../runtime/headless/trace/background-indexer.js");
        await ensureIndexBounded(sp.path); // BUG-039 — bounded read-path wait
        const { withDuckDb } = await import("../server-tools/runtime.js");
        return withDuckDb(sp.path, async (conn: any, backend: any) => {
          if (mop === "map") {
            const runQuery = async (sql: string) =>
              (await conn.runAndReadAll(sql)).getRows().map((r: unknown[]) => r.map((c) => typeof c === "bigint" ? Number(c) : c));
            const { buildMemoryMapText } = await import("../server-tools/trace-memory-map.js");
            const r = await buildMemoryMapText(runQuery, { cpu: String(margs.cpu ?? "c64") });
            return r?.text ?? "map: empty (the trace captured no memory accesses — enable the memory domain)";
          }
          if (mop === "taint") {
            const { traceTaint } = await import("../runtime/headless/v2/taint.js");
            // Default cycle = the trace's own MAX(cycle) (NOT the live clock, which
            // runs past the capture after `trace off`) — same anchor as swimlane.
            let startCycle = Number(margs.startCycle);
            if (!Number.isFinite(startCycle)) {
              const rg = (await conn.runAndReadAll("SELECT MAX(cycle) FROM trace_event WHERE cycle IS NOT NULL")).getRows()[0];
              startCycle = Number(rg?.[0] ?? 0);
            }
            const g: any = await traceTaint(backend, { runId: sp.runId, startCycle, startAddr: Number(margs.startAddr) } as never);
            const ns: any[] = Object.values(g.nodes ?? {});
            const hx = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");
            if (!ns.length) return `taint: no contributing write found for $${hx(Number(margs.startAddr))} @cyc ${startCycle} (try an explicit cycle from \`swimlane\`/\`map\`)`;
            const lines = [`taint $${hx(Number(margs.startAddr))} @cyc ${startCycle} — ${ns.length} node(s)${g.truncated ? " (truncated)" : ""}:`];
            for (const n of ns.slice(0, 40)) lines.push(`  cyc ${n.cycle} pc=$${hx(n.pc ?? 0)} ${n.contribution} $${hx(n.addr ?? 0)}=$${(n.value ?? 0).toString(16).padStart(2, "0")}`);
            return lines.join("\n");
          }
          throw new Error(`trace read: unexpected op '${mop}' in store block`); // swimlane handled above
        });
      };
      // Spec 754 §3.3f/§3.6 (Q1) — read-only project-artifact bridge (inspect/xref):
      // scan C64RE_PROJECT_DIR for the _analysis.json whose mapping covers the
      // address, load its effective segments (annotation overlay, BUG-034-safe) +
      // its xrefs. The daemon reads the project files; no write, no reverse-RPC.
      const projectRead = async (pop: "inspect" | "xref" | "sym", pargs: Record<string, unknown>): Promise<string> => {
        const projectDir = process.env.C64RE_PROJECT_DIR;
        if (!projectDir) throw new Error("no C64RE_PROJECT_DIR");
        const addr = Number(pargs.addr) & 0xffff;
        const fs = await import("node:fs");
        const path = await import("node:path");
        const found: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 6) return;
          let ents: any[]; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (e.name === "node_modules" || e.name.startsWith(".")) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (e.name.endsWith("_analysis.json")) found.push(p);
          }
        };
        walk(projectDir, 0);
        const stem = pargs.stem ? String(pargs.stem) : undefined;
        const candidates = stem ? found.filter((p) => path.basename(p).startsWith(stem)) : found;
        // sym <name> — reverse lookup: scan the project analysis for a segment
        // labelled <name> → its address (the new value; addr→label is `inspect`).
        if (pop === "sym") {
          const name = String(pargs.query ?? "");
          if (!name) throw new Error("sym: a name is required");
          const { loadEffectiveSegments } = await import("../project-knowledge/effective-segments.js");
          for (const p of candidates) {
            let segs: any[]; try { segs = loadEffectiveSegments(p).segments; } catch { continue; }
            const m = segs.find((g) => g.label === name);
            if (m) return `sym ${name} = $${(m.start & 0xffff).toString(16).padStart(4, "0")}  (${path.basename(p).replace(/_analysis\.json$/, "")}, ${m.kind})`;
          }
          throw new Error(`no symbol named "${name}" in the project analysis`);
        }
        // Spec 759 P1b — PROJECT-WIDE resolution via the address/xref index
        // (was a single-file head-read scan, so a cross-file caller like
        // block3 → engine $0200 was invisible → empty `xref 0200`).
        const hx = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");
        const { resolveCrossArtifact, resolveXrefs, resolveAbi } = await import("../project-knowledge/address-index.js");
        const owners = resolveCrossArtifact(projectDir, addr);
        const { into, outof } = resolveXrefs(projectDir, addr);
        if (pop === "inspect") {
          const lines = [`inspect $${hx(addr)}`];
          if (owners.length === 0) lines.push("  (no analyzed artifact owns this address)");
          else for (const o of owners) lines.push(`  ${o.owner}: $${hx(o.start)}..$${hx(o.end)} ${o.kind}${o.label ? ` (${o.label})` : ""}`);
          if (owners.length > 1) lines.push(`  (${owners.length} owners — overlay/banking overlap)`);
          // Spec 759 P3 — if this is an ABI jumptable entry, show the JMP target.
          const abi = resolveAbi(projectDir, addr);
          if (abi?.targetAddr !== undefined) lines.push(`  ABI entry → $${hx(abi.targetAddr)}${abi.target?.label ? ` (${abi.target.label})` : ""}`);
          if (into.length) { lines.push(`  callers (${into.length}):`); for (const x of into.slice(0, 8)) lines.push(`    <- ${x.owner} $${hx(x.source)} ${x.type}`); }
          return lines.join("\n");
        }
        const lines = [`xref $${hx(addr)}  (in:${into.length} out:${outof.length}, project-wide)`];
        for (const x of into.slice(0, 16)) lines.push(`  <- ${x.owner} $${hx(x.source)} ${x.type}${x.operandText ? ` ${x.operandText}` : ""}`);
        for (const x of outof.slice(0, 16)) lines.push(`  -> $${hx(x.target)} ${x.type}`);
        if (!into.length && !outof.length) lines.push("  (no cross-references in any analyzed artifact)");
        return lines.join("\n");
      };
      // Spec 754 §3.3f (Block F) — user-label write bridge + addr→name index.
      // Monitor-shell stays runtime-pure; the knowledge mutations live here.
      const labelHx = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");
      const parseSymLine = (line: string): { addr: number; name: string } | null => {
        // VICE add-label:  `al C:0810 .setup`
        let m = line.match(/^\s*al\s+\w?:?([0-9a-fA-F]+)\s+\.?(\S+)/i);
        if (m) return { addr: parseInt(m[1]!, 16) & 0xffff, name: m[2]! };
        // KickAssembler:   `.label setup=$0810`  |  `label setup = $0810`
        m = line.match(/^\s*\.?label\s+(\S+?)\s*=\s*\$?([0-9a-fA-F]+)/i);
        if (m) return { addr: parseInt(m[2]!, 16) & 0xffff, name: m[1]! };
        // plain:           `setup = $0810`  |  `setup=$0810`
        m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*\$?([0-9a-fA-F]+)\s*$/);
        if (m) return { addr: parseInt(m[2]!, 16) & 0xffff, name: m[1]! };
        return null;
      };
      const projectLabels = async (pop: string, pargs: Record<string, unknown>): Promise<string> => {
        const dir = this.projectDir ?? process.env.C64RE_PROJECT_DIR;
        if (!dir) throw new Error("no project workspace");
        const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
        const svc = new ProjectKnowledgeService(dir);
        if (pop === "list") {
          const ls = svc.listUserLabels();
          if (!ls.length) return "no user labels yet — set one with: label <addr> <name>";
          return ls.map((l) => `$${labelHx(l.addressRange?.start ?? 0)}  ${l.label}${l.note ? `  ; ${l.note}` : ""}`).join("\n");
        }
        if (pop === "set") {
          const addr = Number(pargs.addr) & 0xffff;
          // Spec 754 §3.3f level-2 (bidirectional): a monitor label IS a knowledge
          // entity (kind memory-address) so it shows in the UI / entity lists /
          // xref, not just the monitor. The user-label store keeps the fast
          // addr→name index + links to the entity.
          const ent = svc.saveEntity({ kind: "memory-address", name: String(pargs.name), status: "active", addressRange: { start: addr, end: addr } });
          const r = svc.saveUserLabel({ label: String(pargs.name), address: addr, targetKind: "address", targetId: ent.id });
          return `label $${labelHx(addr)} = ${r.label}  (entity ${ent.id})`;
        }
        if (pop === "del") {
          const r = svc.removeUserLabel(String(pargs.key));
          return r ? `unlabeled ${r.label} ($${labelHx(r.addressRange?.start ?? 0)})` : `no label matching "${String(pargs.key)}"`;
        }
        if (pop === "note") {
          const addr = Number(pargs.addr) & 0xffff;
          const f = svc.saveFinding({
            kind: "observation",
            title: `note @ $${labelHx(addr)}`,
            summary: String(pargs.text),
            status: "active",
            addressRange: { start: addr, end: addr },
          });
          return `note saved @ $${labelHx(addr)} (finding ${f.id})`;
        }
        if (pop === "load") {
          const fs = await import("node:fs");
          let n = 0;
          for (const line of fs.readFileSync(String(pargs.file), "utf8").split(/\r?\n/)) {
            const p = parseSymLine(line);
            if (p && p.name) { svc.saveUserLabel({ label: p.name.replace(/^\./, ""), address: p.addr }); n += 1; }
          }
          return `loaded ${n} label(s) from ${String(pargs.file)}`;
        }
        if (pop === "save") {
          const fs = await import("node:fs");
          const ls = svc.listUserLabels().filter((l) => l.addressRange);
          fs.writeFileSync(String(pargs.file), ls.map((l) => `al C:${labelHx(l.addressRange!.start)} .${l.label}`).join("\n") + "\n");
          return `saved ${ls.length} label(s) to ${String(pargs.file)} (VICE label format)`;
        }
        throw new Error(`unknown label op ${pop}`);
      };
      const labelIndex = async (): Promise<Array<[number, string]>> => {
        const dir = this.projectDir ?? process.env.C64RE_PROJECT_DIR;
        if (!dir) return [];
        const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
        const map = new Map<number, string>();
        // Spec 754 §3.3f (Block F) level-2 read: layer the project's own analysis
        // labels (effective-segment labels, BUG-034-safe) UNDER the user labels —
        // so the disassembler shows the names the project already knows, and a
        // hand-set `label` wins. Bounded walk (like projectRead("inspect")).
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const { loadEffectiveSegments } = await import("../project-knowledge/effective-segments.js");
          const found: string[] = [];
          const walk = (d: string, depth: number) => {
            if (depth > 6 || found.length > 64) return;
            let ents: import("node:fs").Dirent[];
            try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              if (e.name === "node_modules" || e.name.startsWith(".")) continue;
              const p = path.join(d, e.name);
              if (e.isDirectory()) walk(p, depth + 1);
              else if (e.name.endsWith("_analysis.json")) found.push(p);
            }
          };
          walk(dir, 0);
          for (const p of found) {
            let segs: Array<{ start: number; label?: string }>;
            try { segs = loadEffectiveSegments(p).segments as Array<{ start: number; label?: string }>; } catch { continue; }
            for (const g of segs) if (g.label && !map.has(g.start & 0xffff)) map.set(g.start & 0xffff, g.label);
          }
        } catch { /* analysis labels are best-effort; user labels still apply */ }
        const svc = new ProjectKnowledgeService(dir);
        // Knowledge entities with an address surface as labels too (level-2 read).
        for (const e of svc.listEntities()) {
          if (e.addressRange && e.name) map.set(e.addressRange.start & 0xffff, e.name);
        }
        // User labels win (highest precedence).
        for (const [a, n] of svc.buildUserLabelIndex().entries()) map.set(a, n);
        return [...map.entries()];
      };
      return runMonitorCommand(
        { session: s, ctrl, sessionId: session_id, memCursors: monitorMemAddr, disasmCursors: monitorDisasmAddr, traceRead, projectRead, projectLabels, labelIndex, projectDir: this.projectDir },
        String(command ?? ""),
      );
    });

    this.on("runtime/scenario_load", async ({ id }) => {
      if (typeof id !== "string") throw new Error("id required");
      const { loadScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const s = loadScenario(id);
      if (!s) throw new Error(`scenario '${id}' not found`);
      return s;
    });

    this.on("runtime/scenario_run", async ({ id }) => {
      if (typeof id !== "string") throw new Error("id required");
      const { loadScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const { runScenario } = await import("../runtime/headless/v2/scenario.js");
      const s = loadScenario(id);
      if (!s) throw new Error(`scenario '${id}' not found`);
      const scenario: any = {
        ...s,
        startSnapshot: typeof s.startSnapshot === "string" && s.startSnapshot
          ? s.startSnapshot
          : Buffer.from(String(s.startSnapshot ?? ""), "base64"),
      };
      return runScenario(scenario);
    });

    // ---- Spec 271 — Parallel batch runner WS handlers ----

    this.on("batch/start", async ({ scenarioIds, workerCount }) => {
      if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
        throw new Error("scenarioIds must be a non-empty array");
      }
      const { WorkerPool, resolveWorkerCount } = await import("../runtime/headless/parallel/scenario-pool.js");
      const { createBatch, updateProgress, completeBatch, failBatch, serialiseBatch } = await import("../runtime/headless/parallel/batch-store.js");

      const n = resolveWorkerCount(scenarioIds.length, workerCount);
      const entry = createBatch(scenarioIds as string[], n);

      const pool = new WorkerPool({
        workerCount: n,
        projectDir: this.projectDir,
        onProgress: (completed, total, currentId) => {
          updateProgress(entry.batchId, completed);
          // Push progress notification to all connected clients.
          this.broadcast("batch/progress", {
            batchId: entry.batchId,
            completed,
            total,
            currentId,
          });
        },
      });

      pool.runBatch(scenarioIds as string[]).then(results => {
        completeBatch(entry.batchId, results);
        this.broadcast("batch/progress", {
          batchId: entry.batchId,
          completed: entry.total,
          total: entry.total,
          status: "done",
        });
      }).catch((e: Error) => {
        failBatch(entry.batchId, e.message ?? String(e));
        this.broadcast("batch/progress", {
          batchId: entry.batchId,
          status: "error",
          error: e.message,
        });
      });

      return serialiseBatch(entry);
    });

    this.on("batch/status", async ({ batchId }) => {
      if (typeof batchId !== "string") throw new Error("batchId required");
      const { getBatch, serialiseBatch } = await import("../runtime/headless/parallel/batch-store.js");
      const entry = getBatch(batchId);
      if (!entry) throw new Error(`batch '${batchId}' not found`);
      return serialiseBatch(entry);
    });

    this.on("batch/results", async ({ batchId }) => {
      if (typeof batchId !== "string") throw new Error("batchId required");
      const { getBatch, serialiseBatch, serialiseResults } = await import("../runtime/headless/parallel/batch-store.js");
      const entry = getBatch(batchId);
      if (!entry) throw new Error(`batch '${batchId}' not found`);
      return { batch: serialiseBatch(entry), results: serialiseResults(entry) };
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
