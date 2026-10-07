// Spec 889 §5 — the screenshot the app refuses and REST does not have: the last frame from the
// video stream, in the daemon's answer shapes.
//
//  session/screenshot     -> { dataUrl: "data:image/png;base64,…", width, height }   (render_screenshot in main.rs)
//  session/frame_indices  -> { width, height, palette: b64(48), indices: b64(w*h) }   (Spec 812)
//
// plus what a device cannot hide: `ageMs` (how old the frame is), `paused` (no video arriving —
// a paused machine's screenshot is the last frame, not a fresh one), `complete` (false: lines
// of a lost packet carry what they showed before) and `frame` (the device's frame counter).
// No frame yet is an error that says why and how to get one, never a black picture.

import { encodePng } from "../../graphics-render/png-encoder.js";
import { PALETTE_RGB48 } from "./relay.js";
import type { StreamReceiver } from "./receiver.js";

export interface StreamPictureInfo {
  readonly ageMs: number;
  readonly paused: boolean;
  readonly complete: boolean;
  readonly missingPackets: number;
  readonly frame: number;
  readonly source: "c64u-video-stream";
}

export interface ScreenshotAnswer extends StreamPictureInfo {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface FrameIndicesAnswer extends StreamPictureInfo {
  readonly width: number;
  readonly height: number;
  readonly palette: string;
  readonly indices: string;
}

function lastOrThrow(rx: StreamReceiver) {
  const l = rx.lastFrame();
  if (!l) {
    throw new Error(
      "no video frame received from the C64 Ultimate yet — the video stream is not delivering (not started, " +
      "blocked from reaching this host, or the machine is paused before its first frame). Check the stream status; " +
      "a paused machine shows its last frame once one has arrived.",
    );
  }
  return l;
}

const info = (l: NonNullable<ReturnType<StreamReceiver["lastFrame"]>>): StreamPictureInfo => ({
  ageMs: l.ageMs, paused: l.paused, complete: l.frame.complete, missingPackets: l.frame.missingPackets,
  frame: l.frame.number, source: "c64u-video-stream",
});

export function streamScreenshot(rx: StreamReceiver): ScreenshotAnswer {
  const l = lastOrThrow(rx);
  const { width, height, indices } = l.frame;
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < indices.length; p++) {
    const c = (indices[p]! & 0x0f) * 3;
    rgba[p * 4] = PALETTE_RGB48[c]!;
    rgba[p * 4 + 1] = PALETTE_RGB48[c + 1]!;
    rgba[p * 4 + 2] = PALETTE_RGB48[c + 2]!;
    rgba[p * 4 + 3] = 0xff;
  }
  const png = encodePng(rgba, width, height);
  return { dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, width, height, ...info(l) };
}

export function streamFrameIndices(rx: StreamReceiver): FrameIndicesAnswer {
  const l = lastOrThrow(rx);
  return {
    width: l.frame.width,
    height: l.frame.height,
    palette: Buffer.from(PALETTE_RGB48).toString("base64"),
    indices: Buffer.from(l.frame.indices).toString("base64"),
    ...info(l),
  };
}
