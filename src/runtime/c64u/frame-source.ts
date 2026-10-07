// Spec 889 §4c — where the C64U backend's screenshot gets its picture.
//
// The device sends the VIC picture as UDP datagrams (video stream, §4c); turning those into a
// frame is the stream relay's job, not the backend's. The backend asks an injectable source
// for "the last complete frame" and answers in the daemon's `session/screenshot` shape. Until
// the relay lands the default source says so, by name — a screenshot call never invents a
// picture and never falls back to the emulator's.

export interface FrameSnapshot {
  /** A PNG of the frame, in the palette the emulator path uses. */
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** `Date.now()`-style ms when the LAST packet of the frame arrived. */
  readonly receivedAt: number;
  /** False when the frame was shown with gaps (packets lost). */
  readonly complete: boolean;
}

export interface FrameSource {
  /** The newest frame, or null when none has arrived (stream not started, or nothing sent). */
  latest(): Promise<FrameSnapshot | null>;
  /** One line: what this source is, for the refusal and the status. */
  describe(): string;
}

/** The stub until the stream relay is attached. */
export class NoFrameSource implements FrameSource {
  async latest(): Promise<FrameSnapshot | null> { return null; }
  describe(): string { return "no video stream relay is attached to this backend yet (Spec 889 §4c)"; }
}
