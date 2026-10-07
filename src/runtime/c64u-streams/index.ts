// Spec 889 §4c — picture and sound from a C64 Ultimate, as the binary frames the UI plays.
//
// The C64U backend creates ONE `C64UStreams` per selected device and calls:
//
//   const streams = new C64UStreams({ rest, receiverHost, deviceHost, relay });
//   streams.startStreams()          // select: opens the UDP sockets, asks the device to send; returns a ticket AT ONCE
//   streams.rearm()                 // after a system reset (it clears the stream enable)
//   streams.screenshot()            // session/screenshot answer shape + ageMs/paused
//   streams.frameIndices()          // session/frame_indices answer shape
//   streams.audioFormat()           // put in the `audio/start` reply so the player runs at the device's rate
//   streams.status()                // ports, paused, last-frame age, loss counters, per-stream start state
//   await streams.stopStreams()     // deselect / shutdown: stop on the device, close the sockets
//
// `relay.video(msg)` / `relay.audio(msg)` receive complete binary WebSocket messages
// ([type:u8][seq:u32 LE][payload], relay.ts) to hand to every connected browser. The browser
// never talks to the device.

import { createSocket } from "node:dgram";
import { AUDIO_RATE_HZ } from "./wire.js";
import { StreamReceiver, type ReceiverStatus } from "./receiver.js";
import {
  StreamController, type RestCaller, type StartTicket, type StreamName, type StreamState,
} from "./control.js";
import { buildAudioMessage, buildVicFrameMessage } from "./relay.js";
import { streamFrameIndices, streamScreenshot, type FrameIndicesAnswer, type ScreenshotAnswer } from "./screenshot.js";

export * from "./wire.js";
export * from "./video.js";
export * from "./audio.js";
export * from "./relay.js";
export * from "./receiver.js";
export * from "./control.js";
export * from "./screenshot.js";

/** What the relay hands the browsers. */
export interface StreamRelaySink {
  video(message: Uint8Array): void;
  audio(message: Uint8Array): void;
  /** The video stream went quiet (paused: breakpoint, freeze, scrub) or came back. The last picture stays. */
  paused?(paused: boolean): void;
}

export interface C64UStreamsOptions {
  /** The device's REST, injected (the backend owns host + password). */
  readonly rest: RestCaller;
  /** This host's address as the device reaches it: the unicast destination in `ip=`. See `localAddressTowards`. */
  readonly receiverHost: string;
  /** Only datagrams from this sender count. Strongly advised: a second Ultimate on the segment is otherwise interleaved. */
  readonly deviceHost?: string;
  readonly relay: StreamRelaySink;
  readonly bindAddress?: string;
  /** 0 / absent = free ports. A fixed port survives a restart of this server, which a reconnecting device needs. */
  readonly videoPort?: number;
  readonly audioPort?: number;
  readonly pausedAfterMs?: number;
  readonly audioFillCapPackets?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly now?: () => number;
  /** Called with every start/stop state change. */
  readonly onStatus?: (s: Readonly<Record<StreamName, StreamState>>) => void;
}

export interface C64UStreamsStatus extends ReceiverStatus {
  readonly streams: Readonly<Record<StreamName, StreamState>>;
  readonly audioRateHz: number;
  readonly framesRelayed: number;
  readonly audioBuffersRelayed: number;
}

export class C64UStreams {
  private readonly rx: StreamReceiver;
  private readonly ctl: StreamController;
  private vSeq = 0;
  private aSeq = 0;
  private opened: Promise<void> | null = null;

  constructor(private readonly o: C64UStreamsOptions) {
    this.rx = new StreamReceiver({
      bindAddress: o.bindAddress,
      videoPort: o.videoPort,
      audioPort: o.audioPort,
      sourceAddress: o.deviceHost,
      pausedAfterMs: o.pausedAfterMs,
      audioFillCapPackets: o.audioFillCapPackets,
      now: o.now,
      onFrame: (f) => { o.relay.video(buildVicFrameMessage(this.vSeq++, f.width, f.height, f.indices)); },
      onAudio: (w) => { o.relay.audio(buildAudioMessage(this.aSeq++, w.pcm)); },
      onPausedChange: (p) => o.relay.paused?.(p),
    });
    this.ctl = new StreamController({
      rest: o.rest,
      receiverHost: o.receiverHost,
      ports: () => {
        const p = this.rx.ports;
        if (p.video === null || p.audio === null) throw new Error("C64UStreams: sockets are not open");
        return { video: p.video, audio: p.audio };
      },
      startTimeoutMs: o.startTimeoutMs,
      stopTimeoutMs: o.stopTimeoutMs,
      // A (re-)start ends the continuity of that stream: no fill, no loss counted across the gap.
      onRestart: (name) => this.rx.reanchor(`${name}-restart`, name),
      onStatus: o.onStatus,
    });
  }

  /** Open the sockets (once) and ask the device to send. Never blocks the caller on the device. */
  startStreams(): StartTicket {
    const settled = (async () => {
      this.opened ??= this.rx.open().then(() => undefined);
      try { await this.opened; } catch (e) { this.opened = null; throw e; }
      return this.ctl.start().settled;
    })();
    // A bind failure is the one thing that rejects; the ticket still never throws for device trouble.
    return { settled };
  }

  /** After a system reset: the device forgot the targets. Start again what was wanted. */
  rearm(): StartTicket { return this.ctl.rearm(); }

  async stopStreams(): Promise<Readonly<Record<StreamName, StreamState>>> {
    const s = await this.ctl.stop();
    this.rx.close();
    this.opened = null;
    return s;
  }

  screenshot(): ScreenshotAnswer { return streamScreenshot(this.rx); }
  frameIndices(): FrameIndicesAnswer { return streamFrameIndices(this.rx); }

  /** For the `audio/start` reply: the player resamples from this to its context rate. */
  audioFormat(): { readonly sampleRate: number; readonly channels: 2 } { return { sampleRate: AUDIO_RATE_HZ, channels: 2 }; }

  /** The receiver, for a caller that feeds recorded datagrams (replay) or reads ports. */
  get receiver(): StreamReceiver { return this.rx; }

  status(): C64UStreamsStatus {
    return { ...this.rx.status(), streams: this.ctl.status(), audioRateHz: AUDIO_RATE_HZ, framesRelayed: this.vSeq, audioBuffersRelayed: this.aSeq };
  }
}

/** The local address the OS would use to reach `host` (UDP connect sends nothing). */
export function localAddressTowards(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.once("error", (e) => { try { s.close(); } catch { /* */ } reject(e); });
    s.connect(9, host, () => {
      try { resolve(s.address().address); } catch (e) { reject(e); } finally { s.close(); }
    });
  });
}
