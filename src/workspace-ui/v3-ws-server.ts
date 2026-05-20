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
import { SidAudioRecorder, AudioExportSession } from "../runtime/headless/audio/sid-audio-recorder.js";
import { int16ToLeBytes, monoToStereoLR } from "../runtime/headless/audio/audio-buffer.js";
import { writeWav } from "../runtime/headless/audio/wav-writer.js";

export const V3_WS_PORT = 4312;
export const V3_WS_HOST = "127.0.0.1";

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
    "session/drive_power", "media/mount", "media/unmount", "media/swap",
    "runtime/call", "monitor/exec",
  ]);
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
    // Connectivity ping.
    this.on("ping", () => ({ pong: Date.now() }));

    // Session telemetry — used by UI status bar.
    this.on("session/state", ({ session_id }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const c = s.c64Cpu;
      const v = s.vic.regs;
      return {
        c64Cycles: c.cycles,
        driveCycles: s.drive.cpu.cycles,
        mode: s.mode,
        cpu: {
          pc: c.pc, a: c.a, x: c.x, y: c.y, sp: c.sp,
          flags: c.flags, cycles: c.cycles,
        },
        vic: {
          rasterLine: (s.vic as any).raster_y ?? 0,
          rasterCycle: (s.vic as any).raster_cycle ?? 0,
          mode: ((v[0x11] >> 5) & 3) | (((v[0x16] >> 4) & 1) << 2),
          bank: (s.cia2.pra & s.cia2.ddra & 0x03) ^ 0x03,
          screenPtr: ((v[0x18] >> 4) & 0xf) << 10,
          chargenPtr: ((v[0x18] >> 1) & 7) << 11,
          bitmapPtr: (v[0x18] & 8) ? 0x2000 : 0,
          border: v[0x20] & 0xf,
          background: v[0x21] & 0xf,
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
      s.renderToPng(path);
      const bytes = readFileSync(path);
      return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, bytes: bytes.length };
    });

    // Run with C64 CYCLE budget (not instructions). runFor's first
    // arg is instruction-count; we pass huge instr cap + tight
    // cycleBudget so live UI gets cycle-accurate pacing (1 PAL frame
    // = 19705 cycles default).
    this.on("session/run", async ({ session_id, cycles }) => {
      const s = getIntegratedSession(session_id);
      if (!s) throw new Error(`no session ${session_id}`);
      const cycleBudget = cycles ?? 19705;
      // Instruction cap must exceed cycle cap so cycleBudget always wins.
      // Min cycles per 6502 instruction = 2, so cycles/2 ≈ max instructions.
      s.runFor(Math.ceil(cycleBudget / 2) + 1000, { cycleBudget });
      return { c64Cycles: s.c64Cpu.cycles };
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
      if (mode === "soft") {
        // Reset button = HW RESET line. resetWarm re-inits CPU + chips +
        // drive and restores banking, so the $FFFC vector reads $FCE2 and
        // the KERNAL reset routine runs cleanly — recovering even from a
        // running/JAMmed game where $01 banked KERNAL out or a raster-IRQ
        // pointed into game code. RAM is preserved (unlike a power-cycle).
        // A bare "set PC=$FCE2" was insufficient: from a live game it left
        // chips/banking dirty → ran off into RAM (black screen).
        s.resetWarm(video ?? "pal-default");
        s.runFor(5_000_000, { cycleBudget: 5_000_000 });
        return { c64Cycles: s.c64Cpu.cycles, pc: s.c64Cpu.pc, mode: "soft" };
      }
      s.resetCold(video ?? "pal-default");
      // Run enough cycles for KERNAL to fully reach READY + BASIC input
      // poll. Anything < 3M cycles eats leading chars from typeText
      // (kbd buffer sees first key before BASIC polls). 5M is safe.
      s.runFor(5_000_000, { cycleBudget: 5_000_000 });
      return { c64Cycles: s.c64Cpu.cycles, pc: s.c64Cpu.pc, mode: "cold" };
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
      const drv = s.drive;
      // Spec 618 follow-up — in drive1541="vice" mode the legacy DriveCpu
      // (s.drive / s.headPosition / s.gcrShifter) is a co-resident stub
      // whose head + PC freeze after the initial bridged dir step. The
      // ACTIVE drive is the vice1541 facade. Read head + drive PC from it.
      const viceUnit = (s as any).kernel?.drive1541?.unit ?? (s as any).drive1541?.unit ?? null;
      const viceDrive0 = viceUnit?.drives?.[0] ?? null;
      const halfTrack = viceDrive0
        ? (viceDrive0.current_half_track ?? 0)
        : ((s.headPosition as any).trackHalf ?? 0);
      const motorOn = !!(s as any).gcrShifter?.motorOn;
      // VICE 1:1 LED model (drive.c:870-931): PWM duty cycle per UI poll.
      // Fast PB3 toggles average to brightness; DOS error blink oscillates
      // duty per poll; idle = 0. sqrt curve for human-eye perception.
      const { pwm: ledPwm, on: ledOn } = drv.bus.ledMonitor.sampleAndReset(drv.cpu.cycles);
      // Flash = duty between 20%..80% sustained across polls (= DOS error
      // ~2Hz blink shows up that way). UI treats ledPwm directly as
      // brightness; ledFlashing kept for backwards-compat tagging.
      const ledFlashing = ledPwm >= 200 && ledPwm <= 800;
      // VIA2 CB2 from PCR bits 5..7. PCR & 0xE0:
      //   0xC0 (110) = manual high  → R/W = read
      //   0xE0 (111) = manual high  → R/W = read
      //   0x80/0xA0 = pulse/handshake → treat as read default
      //   0x00..0x40 = manual low / pulse low → write
      const pcrCb2 = (drv.bus.via2 as any).pcr & 0xE0;
      const rwMode: "read" | "write" =
        (pcrCb2 === 0xC0 || pcrCb2 === 0xE0) ? "read" : "write";
      // V1: sector not derived from GCR pipeline (DOS-tracked at $80 in
      // drive RAM during BAM ops). Surface raw last-decoded sector header
      // when shifter exposes it; else 0. Follow-up spec to parse $1C00
      // GCR header bytes.
      // Sector: physical sector under the GCR read head (decoded from the
      // live GCR track) — loader-independent, matches VICE's indicator.
      // DOS job-sector ($07) was unreliable: only buffer-0, and custom
      // $0700 fastloaders bypass the DOS job queue entirely → always 0.
      let sector = (s as any).gcrShifter?.lastSectorHeader ?? 0;
      if (viceDrive0) {
        const sec = viceSectorUnderHead(viceDrive0);
        if (sec >= 0) sector = sec;
      }
      // Active drive PC: vice drive 6502 in vice mode, legacy otherwise.
      const drivePc = viceUnit
        ? (viceUnit.cpu?.cpu_regs?.pc ?? drv.cpu.pc)
        : drv.cpu.pc;
      // Track from halftrack: vice current_half_track is 2-based (ht 2 =
      // track 1) so track = ht/2; legacy headPosition is 0-based (+1).
      const track = viceDrive0
        ? Math.floor(halfTrack / 2)
        : Math.floor(halfTrack / 2) + 1;

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
    this.on("session/cart_status", ({ session_id: _ }) => {
      return null;
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
      // Legacy fallback: cold-reset the legacy DriveCpu.
      const drv = s.drive as any;
      if (drv && typeof drv.reset === "function") {
        drv.reset();
        return { device: 8, reinitialized: true, mode: "legacy" };
      }
      return { device: 8, reinitialized: false };
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
      const timer = setInterval(() => { // audit-ok: audio-stream wall-clock pump (~1024 samples @ 44.1kHz cadence). Not emulator timing — drains pre-rendered ResID buffer over WebSocket.
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
      return out.slice(0, 100);
    });

    // ---- Spec 268 — Snapshot tree + scenario registry WS handlers ----

    this.on("runtime/snapshot_tree", async ({ session_id }) => {
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: "", mode: "fast-trap" });
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
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: "", mode: "fast-trap" });
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
          const start = parseAddr(tokens[1]) ?? 0;
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
          return { output: lines.join("\n") };
        }
        // Disassembly: d [addr] [count]
        if (op === "d" || op === "disass") {
          const start = parseAddr(tokens[1]) ?? s.c64Cpu.pc;
          const count = parseInt(tokens[2] ?? "16", 10);
          // Minimal disasm: just dump byte + crude opcode hint
          const lines: string[] = [];
          for (let i = 0, a = start; i < count; i++, a = (a + 1) & 0xffff) {
            const op = s.c64Bus.ram[a] ?? 0;
            lines.push(`.C:${hex(a, 4)}  ${hex(op)}        ; opcode`);
          }
          return { output: lines.join("\n") + "\n(full disasm: TODO)" };
        }
        // Execute: g <addr>
        if (op === "g") {
          const addr = parseAddr(tokens[1]);
          if (addr !== null) s.c64Cpu.pc = addr;
          // Run a frame budget; user can pause via UI
          s.runFor(50_000, { cycleBudget: 50_000 });
          return { output: `running from $${hex(s.c64Cpu.pc, 4)} (frame budget consumed)` };
        }
        // Step: step | next
        if (op === "step" || op === "next" || op === "z") {
          const before = s.c64Cpu.cycles;
          s.runFor(1, { cycleBudget: 100 });
          return { output: `.C:${hex(s.c64Cpu.pc, 4)} (${s.c64Cpu.cycles - before} cyc)` };
        }
        // Reset
        if (op === "reset") {
          s.resetCold("pal-default");
          return { output: "reset" };
        }
        // Help
        if (op === "help" || op === "?") {
          return { output:
            "VICE-compat monitor (subset):\n" +
            "  r              registers\n" +
            "  m <a> [b]      memory dump\n" +
            "  d <a> [n]      disasm\n" +
            "  g <a>          go (PC = a, run 1 frame)\n" +
            "  step / next    one step\n" +
            "  reset          reset\n" +
            "  bk / break     breakpoints (TBD)\n" +
            "  load/save/...  file ops (TBD)" };
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
