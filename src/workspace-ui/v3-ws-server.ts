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
import { disasmLine } from "../runtime/headless/debug/disasm6502.js";
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
  dumpRuntimeSnapshot, undumpRuntimeSnapshot,
  formatDumpSummary, formatUndumpSummary, resolveSnapshotPath,
} from "../runtime/headless/kernel/snapshot-persistence.js";
import { validateTraceDefinition, slugTraceId } from "../runtime/headless/trace/trace-definition.js";
import { ingestMedia, type MediaIngressRequest } from "../runtime/headless/media/ingress.js";
import { readFileSync } from "node:fs";
import { int16ToLeBytes, monoToStereoLR } from "../runtime/headless/audio/audio-buffer.js";
import { writeWav } from "../runtime/headless/audio/wav-writer.js";

export const V3_WS_PORT = 4312;
export const V3_WS_HOST = "127.0.0.1";

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

export class V3WsServer {
  private wss: WebSocketServer;
  private handlers = new Map<string, RpcHandler>();
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

  /**
   * Spec 701 §7 — live VIC frame push with "latest frame wins": skip any
   * client whose send buffer already holds ~2 frames, so a slow consumer
   * never accumulates a WebSocket backlog (the next frame supersedes it).
   */
  broadcastFrame(seq: number, payload: Uint8Array): void {
    const buf = encodeBinaryFrame(BIN_TYPE_VIC_FRAME, seq, payload);
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
      console.error("[v3-ws] client error:", err.message);
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

    if (V3WsServer.SERIALIZED_METHODS.has(req.method)) {
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
      const header = new Uint8Array(10);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, f.width, true);
      dv.setUint16(2, f.height, true);
      header[4] = 1; // fmt 1 = palette-indexed
      header[5] = 0;
      dv.setUint32(6, sess.c64Cpu.cycles >>> 0, true);
      const payload = new Uint8Array(header.length + f.palette.length + f.indices.length);
      payload.set(header, 0);
      payload.set(f.palette, header.length);
      payload.set(f.indices, header.length + f.palette.length);
      this.broadcastFrame(frameNum >>> 0, payload);
      } catch { /* a transport error must never kill the loop */ }
    };
    const controllerFor = (session_id: string) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      return ensureRuntimeController(
        session_id, s,
        (m, p) => this.broadcast(m, p),
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
      const r = s.runFor(Math.ceil(cycleBudget / 2) + 1000, {
        cycleBudget,
        breakpoints: bps.size > 0 ? bps : undefined,
      });
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
    this.on("checkpoint/restore", async ({ session_id, id }) => {
      const c = ctrlFor(session_id);
      if (!id) throw new Error("checkpoint/restore: id required");
      const restored = await c.restoreCheckpoint(String(id));
      return { restored, state: c.state() };
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
    this.on("trace/run/stop", async ({ session_id }) => ({ run: await ctrlFor(session_id).traceRun.stop() }));
    this.on("trace/run/status", ({ session_id }) => ctrlFor(session_id).traceRun.status());
    this.on("trace/run/mark", ({ session_id, label }) => {
      const c = ctrlFor(session_id);
      if (!label) throw new Error("trace/run/mark: label required");
      c.traceRun.mark(String(label));
      return c.traceRun.status();
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
      const state = bus?.getCartridge?.()?.getState?.();
      // Spec 709.13 — the source filename is backend truth (from the attached
      // cartridge media), so every tab's CART display derives from here instead
      // of keeping its own per-tab local path that can diverge.
      const sourceName: string | undefined = bus?.getCartridgeMedia?.()?.name;
      return {
        type: info.cartridgeMapperType ?? "cartridge",
        bank: typeof state?.currentBank === "number" ? state.currentBank : 0,
        activity: "idle" as const,
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
        const { samples } = recorder.buffer.read(cursorId, ship);
        if (samples.length === 0) return;
        const stereo = monoToStereoLR(samples);
        this.broadcastAudio(state.seq++, int16ToLeBytes(stereo));
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
    const buildIngressRequest = (p: any): MediaIngressRequest => {
      const name: string = String(p.name ?? (p.path ? String(p.path).split("/").pop() : "media"));
      const bytes: Uint8Array | undefined = p.bytes_b64
        ? new Uint8Array(Buffer.from(String(p.bytes_b64), "base64"))
        : p.path ? new Uint8Array(readFileSync(String(p.path))) : undefined;
      if (p.kind === "eject") return { kind: "eject", role: p.role === "cartridge" ? "cartridge" : "drive8" };
      if (!bytes) throw new Error("media/ingress: bytes_b64 or path required");
      if (p.kind === "prg") return { kind: "prg", bytes, name, mode: p.mode === "inject-run" ? "inject-run" : "load", entry: p.entry };
      if (p.kind === "crt") return { kind: "crt", bytes, name, resetPolicy: p.resetPolicy === "reset" ? "reset" : "power-cycle" };
      return { kind: "disk", role: "drive8", bytes, name }; // default + explicit "disk"
    };
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
    // existing Media tab keeps working (Spec 709.9).
    const kindFromExt = (path: string): "disk" | "prg" | "crt" | "vsf" | "c64re" => {
      const e = path.toLowerCase().split(".").pop();
      if (e === "prg") return "prg";
      if (e === "crt") return "crt";
      if (e === "c64re") return "c64re";
      if (e === "vsf") return "vsf";
      return "disk";
    };
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
      return await ingestMedia(ctrlFor(session_id), { kind: "eject", role: ejectRole });
    });

    this.on("media/recent", async () => {
      const { getRecent } = await import("../runtime/headless/media/recent-files.js");
      const pmod = await import("node:path");
      const fsmod = await import("node:fs");

      const exts = [".d64", ".g64", ".crt", ".prg", ".vsf"];
      const seen = new Set<string>();
      const out: Array<{ path: string; name: string; type: string }> = [];

      // 1. Recents (existing only) first — preserves "recently used"
      //    ordering at top of picker.
      for (const r of getRecent() as any[]) {
        try { if (!fsmod.existsSync(r.path)) continue; } catch { continue; }
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        out.push({ ...r, name: r.name ?? pmod.basename(r.path) });
      }

      // 2. ALWAYS scan top-level samples/ + UNION (= picker shows
      //    all known disks, not just previously-mounted ones).
      const samplesDir = pmod.join(process.cwd(), "samples");
      if (fsmod.existsSync(samplesDir)) {
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

      // 3. $C64RE_PROJECT_DIR — depth-limited recursive scan for IMAGE media
      //    (.crt/.d64/.g64/.vsf only; skip .prg to avoid flooding the picker
      //    with analysis-dir PRGs). Surfaces e.g. ef_port/motm_ef.crt.
      const projDir = process.env["C64RE_PROJECT_DIR"];
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
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: "", mode: "true-drive" });
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
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: "", mode: "true-drive" });
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

    // Spec 352 — Monitor exec (VICE-compat subset).
    this.on("monitor/exec", async ({ session_id, command }) => {
      const s = getIntegratedSession(session_id);
      if (!s) return { error: `no session ${session_id}` };
      // Spec 701 — share the core-owned breakpoint store + halt the
      // autonomous loop before any synchronous monitor stepping (g/z/n) so
      // the manual step can't race the backend run-loop.
      const ctrl = controllerFor(session_id);
      const cmd = String(command ?? "").trim();
      if (!cmd) return { output: "" };
      const tokens = cmd.split(/\s+/);
      const op = tokens[0]!.toLowerCase();
      const hex = (n: number, w = 2) => n.toString(16).padStart(w, "0").toUpperCase();
      const parseAddr = (t?: string): number | null => {
        if (!t) return null;
        const v = parseInt(t.replace(/^\$/, ""), 16);
        return isNaN(v) ? null : v & 0xffff;
      };
      try {
        // Spec 707 / 623 §7 — native runtime snapshot persistence.
        // `dump "<path>"` / `undump "<path>"` (quoted, may contain spaces).
        // Both are one-shot: there is no cursor/repeat state, and a bare RETURN
        // returns "" above (line ~994), so a dump is never repeated by RETURN.
        if (op === "dump" || op === "undump") {
          const pm = cmd.match(/^\w+\s+"([^"]+)"/) ?? cmd.match(/^\w+\s+(\S+)/);
          const path = pm?.[1];
          if (!path) return { output: `${op}: usage: ${op} "<path.c64re>"` };
          if (op === "dump") {
            const r = await dumpRuntimeSnapshot(ctrl, path);
            return { output: formatDumpSummary(r) };
          }
          const r = await undumpRuntimeSnapshot(ctrl, path);
          monitorDisasmAddr.set(session_id, s.c64Cpu.pc); // bare `d` follows restored PC
          return { output: formatUndumpSummary(r) };
        }
        // Spec 708 / 623 §8 — declarative trace runs (one-shot; no RETURN repeat).
        //   tracedb start "<def-id>" ["<output>"] | stop | status | mark "<label>"
        if (op === "tracedb") {
          const sub = (tokens[1] ?? "").toLowerCase();
          const args = [...cmd.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
          if (sub === "stop") {
            const run = await ctrl.traceRun.stop();
            return { output: `tracedb stopped: ${run.runId}\n  events=${run.eventCount} bytes=${run.bytesWritten} cyc=${run.cycleStart}..${run.cycleEnd}\n  evidence: ${run.evidenceRef}` };
          }
          if (sub === "status") {
            const st = ctrl.traceRun.status();
            return { output: st.active
              ? `tracedb active: ${st.runId} def=${st.definitionId} events=${st.eventCount} marks=${st.marks}${st.capturing ? "" : " (capture stopped)"}`
              : "tracedb: no active run" };
          }
          if (sub === "start") {
            const defId = args[0];
            if (!defId) return { output: 'tracedb: usage: tracedb start "<definition-id>" ["<output>"]' };
            const def = ctrl.traceDefinitions.get(defId);
            if (!def) return { output: `tracedb: unknown definition "${defId}" (put it via trace/definition/put first)` };
            const outputPath = resolveSnapshotPath(args[1] ?? `traces/${def.id}_${Date.now().toString(36)}.duckdb`);
            const run = await ctrl.traceRun.start(def, { controller: ctrl, outputPath });
            return { output: `tracedb started: ${run.runId}\n  def=${def.id} domains=[${def.domains.join(",")}]\n  evidence: ${outputPath}` };
          }
          if (sub === "mark") {
            const label = args[0];
            if (!label) return { output: 'tracedb: usage: tracedb mark "<label>"' };
            ctrl.traceRun.mark(label);
            return { output: `tracedb mark: "${label}" @ cycle ${s.c64Cpu.cycles}` };
          }
          return { output: 'tracedb: start|stop|status|mark' };
        }
        // Registers
        if (op === "r" || op === "registers" || op === "cpu") {
          const c = s.c64Cpu;
          const flagsStr = "NV-BDIZC".split("").map((f, i) =>
            ((c.flags >> (7-i)) & 1) ? f : f.toLowerCase()).join("");
          return { output:
            `  ADDR AC XR YR SP NV-BDIZC\n` +
            `.;${hex(c.pc, 4)} ${hex(c.a)} ${hex(c.x)} ${hex(c.y)} ${hex(c.sp)} ${flagsStr}` };
        }
        // Memory dump: m [addr] [end]
        if (op === "m" || op === "mem") {
          // Bare `m` continues from where the previous `m` ended (VICE-style).
          const start = parseAddr(tokens[1]) ?? monitorMemAddr.get(session_id) ?? 0;
          const end = parseAddr(tokens[2]) ?? Math.min(0xffff, start + 0x7f);
          const lines: string[] = [];
          for (let a = start & ~0xf; a <= end; a += 16) {
            const bytes: string[] = []; const ascii: string[] = [];
            for (let i = 0; i < 16 && a+i <= end; i++) {
              const b = s.c64Bus.ram[a+i] ?? 0;
              bytes.push(hex(b));
              ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
            }
            lines.push(`>C:${hex(a, 4)}  ${bytes.join(" ").padEnd(48)}  ${ascii.join("")}`);
          }
          monitorMemAddr.set(session_id, (end + 1) & 0xffff); // next bare `m` resumes here
          return { output: lines.join("\n") };
        }
        // Disassembly: d [addr] [count]  — real 6502/6510 disasm.
        // Bare `d` continues from where the previous `d` ended (VICE-style).
        if (op === "d" || op === "disass") {
          const start = parseAddr(tokens[1]) ?? monitorDisasmAddr.get(session_id) ?? s.c64Cpu.pc;
          const count = parseInt(tokens[2] ?? "16", 10);
          const read = (a: number) => s.c64Bus.ram[a & 0xffff] ?? 0;
          const lines: string[] = [];
          let a = start & 0xffff;
          for (let i = 0; i < count; i++) {
            const { size, line } = disasmLine(read, a);
            const mark = (a === s.c64Cpu.pc) ? " <-- PC" : "";
            lines.push(line + mark);
            a = (a + size) & 0xffff;
          }
          monitorDisasmAddr.set(session_id, a); // next bare `d` resumes here
          return { output: lines.join("\n") };
        }
        // Breakpoints: bk | bk <addr> | bk -<addr> | bk clear
        if (op === "bk" || op === "break" || op === "b") {
          const t1 = tokens[1];
          if (!t1) {
            const list = ctrl.listBreakpoints();
            return { output: list.length
              ? "breakpoints:\n" + list.map(({ num, addr }) => `  #${num}  $${hex(addr, 4)}`).join("\n")
              : "no breakpoints (set: bk <addr>)" };
          }
          if (t1.toLowerCase() === "clear") { ctrl.clearBreakpoints(); return { output: "breakpoints cleared" }; }
          if (t1.startsWith("-")) { // bk -<addr> : delete by address
            const a = parseAddr(t1.slice(1));
            if (a === null) return { error: `bad address: ${t1}` };
            for (const { num, addr } of ctrl.listBreakpoints()) if (addr === a) ctrl.delBreakpoint(num);
            return { output: `removed bp $${hex(a, 4)} (${ctrl.listBreakpoints().length} left)` };
          }
          const addr = parseAddr(t1);
          if (addr === null) return { error: `bad address: ${t1}` };
          const num = ctrl.addBreakpoint(addr);
          return { output: `bk #${num} set at $${hex(addr, 4)} (${ctrl.listBreakpoints().length} total)` };
        }
        // Delete breakpoint(s): del | del <num> | del <num> ...  (VICE: del <checknum>)
        if (op === "del" || op === "delete") {
          if (!tokens[1]) { ctrl.clearBreakpoints(); return { output: "all breakpoints deleted" }; }
          const out: string[] = [];
          for (const t of tokens.slice(1)) {
            const num = parseInt(t, 10);
            if (isNaN(num)) { out.push(`bad checknum: ${t}`); continue; }
            if (ctrl.delBreakpoint(num)) out.push(`deleted #${num}`);
            else out.push(`no breakpoint #${num}`);
          }
          return { output: out.join("\n") };
        }
        // Go / continue: g [addr] — run until a breakpoint (cap 20M instr).
        // Halt the autonomous loop first so this synchronous run is the only
        // thing advancing the CPU.
        if (op === "g") {
          ctrl.pause();
          const addr = parseAddr(tokens[1]);
          if (addr !== null) s.c64Cpu.pc = addr & 0xffff;
          const bps = ctrl.bpAddrSet();
          if (bps.size === 0) {
            s.runFor(20_000);
            monitorDisasmAddr.set(session_id, s.c64Cpu.pc);
            return { output: `ran 1 frame -> .C:${hex(s.c64Cpu.pc, 4)} (no breakpoints; set with 'bk <addr>')` };
          }
          if (bps.has(s.c64Cpu.pc)) s.runFor(1); // clear the BP we're sitting on
          const startCyc = s.c64Cpu.cycles;
          const CAP = 20_000_000; let executed = 0; let hit = false;
          while (executed < CAP) {
            const r = s.runFor(Math.min(2_000_000, CAP - executed), { breakpoints: bps });
            executed += r.instructionsExecuted;
            if (r.aborted === "breakpoint") { hit = true; break; }
            if (r.instructionsExecuted === 0) break;
          }
          const cyc = s.c64Cpu.cycles - startCyc;
          monitorDisasmAddr.set(session_id, s.c64Cpu.pc);
          return { output: hit
            ? `BREAK at .C:${hex(s.c64Cpu.pc, 4)} (${executed} instr, ${cyc} cyc)`
            : `ran ${executed} instr (${cyc} cyc) — no breakpoint hit, pc=$${hex(s.c64Cpu.pc, 4)}` };
        }
        // Spec 623 §4.2/§4.3 — interrupt-aware stepping. Format the landing
        // line + a short tag for how the step ended (Spec 623 §4.2).
        const readRam = (a: number) => s.c64Bus.ram[a & 0xffff] ?? 0;
        const landLine = (stop: { reason: string; cyc: number }, tag: string) => {
          const flow = ctrl.flow.currentFlow();
          const flowTag = flow === "main" ? "" : ` [${flow}]`;
          const why =
            stop.reason === "user-bp" ? ", hit user bp" :
            stop.reason === "cap" ? ", CAP" :
            stop.reason === "focus-timeout" ? ", focus-timeout" : "";
          monitorDisasmAddr.set(session_id, s.c64Cpu.pc);
          return { output: `${disasmLine(readRam, s.c64Cpu.pc).line}${flowTag} (${tag}, ${stop.cyc} cyc${why})` };
        };
        // Step into: z | step | si — one instruction. May enter an IRQ/NMI
        // (VICE-correct, §4.2): a pending interrupt is taken before the next
        // main-flow opcode.
        if (op === "z" || op === "step" || op === "si") {
          ctrl.pause();
          const stop = ctrl.flow.stepInto(s as any);
          return landLine(stop, "step");
        }
        // Step over: n | next — VICE-faithful (§4.2). JSR subroutines AND
        // accepted IRQ/NMI are treated as nested flow run THROUGH; stops back
        // in the caller flow after one instruction. NOT "break at PC+len".
        if (op === "n" || op === "next" || op === "so") {
          ctrl.pause();
          const stop = ctrl.flow.stepOver(s as any, ctrl.bpAddrSet());
          return landLine(stop, "next");
        }
        // Return: ret | return — run until the current frame returns (RTS/RTI).
        if (op === "ret" || op === "return") {
          ctrl.pause();
          const stop = ctrl.flow.runReturn(s as any, ctrl.bpAddrSet());
          return landLine(stop, "return");
        }
        // Flow focus (C64RE extension, §4.3): focus [auto|main|irq|nmi|brk|clear]
        if (op === "focus") {
          const arg = (tokens[1] ?? "").toLowerCase();
          if (arg === "" ) {
            const f = ctrl.flow;
            const stackStr = f.stack.length
              ? f.stack.map((fr) => `  ${fr.kind}  enter=$${hex(fr.enteredAtPc, 4)} sp=$${hex(fr.stackSpAtEntry)}`).join("\n")
              : "  (main — no interrupt/trap frame active)";
            return { output: `focus = ${f.focus} (current flow: ${f.currentFlow()})\nflow stack:\n${stackStr}` };
          }
          if (["auto", "main", "irq", "nmi", "brk", "none", "clear"].includes(arg)) {
            ctrl.flow.focus = (arg === "clear" ? "none" : arg) as any;
            return { output: `focus = ${ctrl.flow.focus}` };
          }
          return { error: `focus: expected auto|main|irq|nmi|brk|clear, got '${arg}'` };
        }
        // stepf/sf — step into, stop only in the selected/current flow (§4.3).
        if (op === "sf" || op === "stepf") {
          ctrl.pause();
          const stop = ctrl.flow.stepFocus(s as any, ctrl.bpAddrSet());
          return landLine(stop, `stepf:${ctrl.flow.effectiveFocus()}`);
        }
        // nextf/nf — step over calls + foreign flows, stop in selected flow (§4.3).
        if (op === "nf" || op === "nextf") {
          ctrl.pause();
          const stop = ctrl.flow.nextFocus(s as any, ctrl.bpAddrSet());
          return landLine(stop, `nextf:${ctrl.flow.effectiveFocus()}`);
        }
        // Reset
        if (op === "reset") {
          ctrl.pause();
          s.resetCold("pal-default");
          return { output: "reset" };
        }
        // Help
        if (op === "help" || op === "?") {
          return { output:
            "VICE-compat monitor:\n" +
            "  r                registers\n" +
            "  m <a> [b]        memory dump\n" +
            "  d [a] [n]        disassemble (n instr from a, default PC)\n" +
            "  bk               list breakpoints (#num $addr)\n" +
            "  bk <a>           set breakpoint at a\n" +
            "  bk -<a>          remove breakpoint at address a\n" +
            "  del <n> [n..]    delete breakpoint(s) by #num\n" +
            "  del              delete all breakpoints\n" +
            "  bk clear         clear all breakpoints\n" +
            "  g [a]            go/continue (PC=a) until a breakpoint\n" +
            "  z / step         step into — may enter IRQ/NMI (VICE-correct)\n" +
            "  n / next         step over — skips JSR + runs THROUGH IRQ/NMI,\n" +
            "                   stops back in caller flow (VICE-faithful)\n" +
            "  ret / return     run until current frame returns (RTS/RTI)\n" +
            "  focus [m]        C64RE flow focus: auto|main|irq|nmi|brk|clear\n" +
            "  sf / stepf       step into, stop only in focused flow (C64RE)\n" +
            "  nf / nextf       step over, stop only in focused flow (C64RE)\n" +
            "  reset            cold reset" };
        }
        return { error: `unknown command: ${op}. Try 'help'.` };
      } catch (e: any) {
        return { error: `exec error: ${e.message ?? e}` };
      }
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
        projectDir: process.env.C64RE_PROJECT_DIR,
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
