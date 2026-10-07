// Spec 889 §4c — the backend's FrameSource, over the stream receiver it owns.
//
// `C64UStreams.screenshot()` answers in the daemon's `session/screenshot` shape with what a
// device cannot hide (age, paused, complete, frame counter); this adapter hands the backend the
// same picture as a `FrameSnapshot` and carries the extra fields through `extra`, so the
// backend's answer keeps them. No frame yet is `null`, and `describe()` says why.

import type { C64UStreams } from "../c64u-streams/index.js";
import type { FrameSnapshot, FrameSource } from "./frame-source.js";

export class StreamsFrameSource implements FrameSource {
  constructor(private readonly streams: () => C64UStreams | null, private readonly why: () => string | undefined) {}

  async latest(): Promise<FrameSnapshot | null> {
    const s = this.streams();
    if (!s) return null;
    let a;
    try { a = s.screenshot(); } catch { return null; }
    const b64 = a.dataUrl.slice(a.dataUrl.indexOf(",") + 1);
    return {
      png: new Uint8Array(Buffer.from(b64, "base64")),
      width: a.width,
      height: a.height,
      receivedAt: Date.now() - a.ageMs,
      complete: a.complete,
      extra: { frame: a.frame, missingPackets: a.missingPackets, streamPaused: a.paused, source: a.source },
    };
  }

  describe(): string {
    const s = this.streams();
    const trouble = this.why();
    if (!s) return `the video stream of this device is not running here${trouble ? ` (${trouble})` : ""}`;
    const st = s.status();
    return `the device's video stream has delivered no frame yet (ports ${st.ports.video}/${st.ports.audio}, ` +
      `${st.receivedAnyVideo ? "datagrams arrived but no frame completed" : "no datagram arrived"}; ` +
      `video ${st.streams.video.phase}${st.streams.video.failure ? `: ${st.streams.video.failure.message}` : ""})`;
  }
}
