// Spec 889 §4c — the UDP side: two sockets (video, audio) feeding the assembler and the
// timeline. Bind address and ports are injected (0 = a free port; `ports` says which). The
// datagram feeds (`feedVideo` / `feedAudio`) are public so a test, or a replay of recorded
// datagrams, goes through the same path as the socket.
//
// Paused: the device's video is driven by the VIC counters and stops with the C64 clock
// (breakpoint, freeze, Timewarp scrub, pause), so "no video packets" means paused, not broken.
// The receiver keeps the last frame and says paused once no video datagram has arrived for
// `pausedAfterMs`. (One PAL frame is 20 ms; 250 ms is a dozen missed frames, well past the
// jitter the packets show and far below anything a person notices as a freeze.)

import { createSocket, type Socket } from "node:dgram";
import { AudioTimeline, type AudioCounts, type Written } from "./audio.js";
import { FrameAssembler, type Frame, type VideoCounts } from "./video.js";

export interface ReceiverOptions {
  /** Interface to bind; default all. */
  readonly bindAddress?: string;
  /** 0 or absent = a free port (read it from `ports` after `open`). */
  readonly videoPort?: number;
  readonly audioPort?: number;
  /** When set, datagrams from any other sender are counted and dropped (a second device, a stray host). */
  readonly sourceAddress?: string;
  readonly pausedAfterMs?: number;
  readonly audioFillCapPackets?: number;
  readonly now?: () => number;
  readonly onFrame?: (frame: Frame) => void;
  readonly onAudio?: (written: Written) => void;
  readonly onPausedChange?: (paused: boolean) => void;
}

export interface ReceiverStatus {
  readonly open: boolean;
  readonly ports: { readonly video: number | null; readonly audio: number | null };
  /** No video datagram for pausedAfterMs (or none yet; see `receivedAnyVideo`). */
  readonly paused: boolean;
  readonly receivedAnyVideo: boolean;
  readonly lastFrameAgeMs: number | null;
  readonly lastFrameComplete: boolean | null;
  readonly foreignDatagrams: number;
  readonly video: VideoCounts;
  readonly audio: AudioCounts;
}

export const DEFAULT_PAUSED_AFTER_MS = 250;

export class StreamReceiver {
  private vSock: Socket | null = null;
  private aSock: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly assembler = new FrameAssembler();
  private readonly timeline: AudioTimeline;
  private readonly now: () => number;
  private readonly pausedAfterMs: number;
  private last: Frame | null = null;
  private lastFrameAt = 0;
  private lastVideoPacketAt: number | null = null;
  private lastPaused = true;
  private foreign = 0;

  constructor(private readonly opt: ReceiverOptions = {}) {
    this.now = opt.now ?? Date.now;
    this.pausedAfterMs = opt.pausedAfterMs ?? DEFAULT_PAUSED_AFTER_MS;
    this.timeline = new AudioTimeline(opt.audioFillCapPackets);
  }

  /** Bind both sockets. Rejects when a port is taken (the error names it). */
  async open(): Promise<{ video: number; audio: number }> {
    if (this.vSock || this.aSock) throw new Error("StreamReceiver already open");
    const bind = this.opt.bindAddress ?? "0.0.0.0";
    const mk = async (port: number, feed: (d: Uint8Array) => void, what: string): Promise<Socket> => {
      const s = createSocket({ type: "udp4", reuseAddr: false });
      s.on("message", (msg, rinfo) => {
        if (this.opt.sourceAddress && rinfo.address !== this.opt.sourceAddress) { this.foreign++; return; }
        feed(msg);
      });
      await new Promise<void>((resolve, reject) => {
        s.once("error", (e) => reject(new Error(`${what} stream: cannot bind ${bind}:${port}: ${e.message}`)));
        s.bind(port, bind, () => { s.removeAllListeners("error"); s.on("error", () => { /* a socket error after bind never kills the server */ }); resolve(); });
      });
      return s;
    };
    try {
      this.vSock = await mk(this.opt.videoPort ?? 0, (d) => this.feedVideo(d), "video");
      this.aSock = await mk(this.opt.audioPort ?? 0, (d) => this.feedAudio(d), "audio");
    } catch (e) {
      this.close();
      throw e;
    }
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.floor(this.pausedAfterMs / 4)));
    this.timer.unref();
    return this.ports as { video: number; audio: number };
  }

  get ports(): { video: number | null; audio: number | null } {
    return { video: this.vSock ? this.vSock.address().port : null, audio: this.aSock ? this.aSock.address().port : null };
  }

  feedVideo(datagram: Uint8Array): void {
    const t = this.now();
    this.lastVideoPacketAt = t;
    this.setPaused(false);
    for (const f of this.assembler.push(datagram)) {
      this.last = f;
      this.lastFrameAt = t;
      this.opt.onFrame?.(f);
    }
  }

  feedAudio(datagram: Uint8Array): void {
    const w = this.timeline.push(datagram);
    if (w.pcm.length > 0) this.opt.onAudio?.(w);
  }

  /** The stream's continuity ended (re-armed after a system reset, restarted): no fill, no loss counted across it. */
  reanchor(reason: string, which: "video" | "audio" | "both" = "both"): void {
    if (which !== "audio") this.assembler.reanchor(reason);
    if (which !== "video") this.timeline.reanchor(reason);
  }

  /** The last frame that was handed out (complete, or gap-filled when its successor started). */
  lastFrame(): { readonly frame: Frame; readonly ageMs: number; readonly paused: boolean } | null {
    if (!this.last) return null;
    return { frame: this.last, ageMs: this.now() - this.lastFrameAt, paused: this.isPaused() };
  }

  isPaused(): boolean {
    if (this.lastVideoPacketAt === null) return true;
    return this.now() - this.lastVideoPacketAt > this.pausedAfterMs;
  }

  status(): ReceiverStatus {
    return {
      open: this.vSock !== null,
      ports: this.ports,
      paused: this.isPaused(),
      receivedAnyVideo: this.lastVideoPacketAt !== null,
      lastFrameAgeMs: this.last ? this.now() - this.lastFrameAt : null,
      lastFrameComplete: this.last ? this.last.complete : null,
      foreignDatagrams: this.foreign,
      video: this.assembler.counts(),
      audio: this.timeline.counts(),
    };
  }

  /** Evaluate the paused signal now (the interval does this; tests with a fake clock call it). */
  tick(): void { this.setPaused(this.isPaused()); }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of [this.vSock, this.aSock]) { try { s?.close(); } catch { /* already closed */ } }
    this.vSock = null;
    this.aSock = null;
  }

  private setPaused(p: boolean): void {
    if (p === this.lastPaused) return;
    this.lastPaused = p;
    this.opt.onPausedChange?.(p);
  }
}
