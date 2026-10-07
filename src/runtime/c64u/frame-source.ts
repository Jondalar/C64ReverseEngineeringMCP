// Spec 889 §4c — where the C64U backend's screenshot gets its picture.
//
// The device sends the VIC picture as UDP datagrams (video stream, §4c); turning those into a
// frame is the stream receiver's job, not the backend's. The backend asks a source for "the last
// complete frame" and answers in the daemon's `session/screenshot` shape. The default source is
// `StreamsFrameSource` over the receiver the backend owns; a test injects its own. A source never
// invents a picture and never falls back to the emulator's.

export interface FrameSnapshot {
  /** A PNG of the frame, in the palette the emulator path uses. */
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** `Date.now()`-style ms when the LAST packet of the frame arrived. */
  readonly receivedAt: number;
  /** False when the frame was shown with gaps (packets lost). */
  readonly complete: boolean;
  /** Fields a source adds to the screenshot answer (frame counter, lost packets …). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface FrameSource {
  /** The newest frame, or null when none has arrived (stream not started, or nothing sent). */
  latest(): Promise<FrameSnapshot | null>;
  /** One line: what this source is, for the refusal and the status. */
  describe(): string;
}

/** The source of a backend built with `streams: false`: there is no stream to take a picture from. */
export class NoFrameSource implements FrameSource {
  async latest(): Promise<FrameSnapshot | null> { return null; }
  describe(): string { return "this backend was built without the device's video stream (streams: false), so there is no video stream to take a picture from"; }
}
