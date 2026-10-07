// Spec 889 §4c — the C64 Ultimate's UDP stream wire formats, as constants.
//
// Ported from 1541ultimate/tests/e2e/lib/streams.py (header, sizes, rates). These are fixed
// by the device, not negotiated: a datagram that disagrees is not from this stream.

/** `<HHHHBBH`: seq, frame, line (bit 15 = last packet of the frame), width, lines/packet, bpp, encoding. */
export const VIDEO_HEADER_BYTES = 12;
export const VIDEO_WIDTH = 384;
export const VIDEO_LINES_PER_PACKET = 4;
export const VIDEO_BITS_PER_PIXEL = 4;
export const VIDEO_ENCODING = 0;
export const VIDEO_BYTES_PER_LINE = VIDEO_WIDTH / 2;
export const VIDEO_PAYLOAD_BYTES = VIDEO_LINES_PER_PACKET * VIDEO_BYTES_PER_LINE; // 768
export const VIDEO_PACKET_BYTES = VIDEO_HEADER_BYTES + VIDEO_PAYLOAD_BYTES; // 780
export const VIDEO_HEIGHT_PAL = 272;
export const VIDEO_HEIGHT_60HZ = 240;
export const VIDEO_LAST_PACKET_FLAG = 0x8000;
export const VIDEO_LINE_MASK = 0x7fff;

/** seq u16le, then 192 stereo s16le frames (L, R). */
export const AUDIO_HEADER_BYTES = 2;
export const AUDIO_FRAMES_PER_PACKET = 192;
export const AUDIO_FRAME_BYTES = 4;
export const AUDIO_PAYLOAD_BYTES = AUDIO_FRAMES_PER_PACKET * AUDIO_FRAME_BYTES; // 768
export const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_PAYLOAD_BYTES; // 770

/**
 * The sample rate on OUR core, in every video mode. (The Python reference's rate_for() has
 * stock's PAL 47,982.887 and NTSC 47,940.34; our core does not follow those.)
 */
export const AUDIO_RATE_HZ = 48003.07;

export interface VideoHeader {
  readonly seq: number;
  readonly frame: number;
  /** First line of the 4 this packet carries. */
  readonly line: number;
  readonly last: boolean;
  readonly width: number;
  readonly linesPerPacket: number;
  readonly bitsPerPixel: number;
  readonly encoding: number;
}

/** Header of a 780-byte datagram, or null when the datagram is not this stream's. */
export function parseVideoHeader(d: Uint8Array): VideoHeader | null {
  if (d.length !== VIDEO_PACKET_BYTES) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const lineAndFlag = dv.getUint16(4, true);
  const h: VideoHeader = {
    seq: dv.getUint16(0, true),
    frame: dv.getUint16(2, true),
    line: lineAndFlag & VIDEO_LINE_MASK,
    last: (lineAndFlag & VIDEO_LAST_PACKET_FLAG) !== 0,
    width: dv.getUint16(6, true),
    linesPerPacket: d[8]!,
    bitsPerPixel: d[9]!,
    encoding: dv.getUint16(10, true),
  };
  if (
    h.width !== VIDEO_WIDTH ||
    h.linesPerPacket !== VIDEO_LINES_PER_PACKET ||
    h.bitsPerPixel !== VIDEO_BITS_PER_PIXEL ||
    h.encoding !== VIDEO_ENCODING ||
    h.line + VIDEO_LINES_PER_PACKET > VIDEO_HEIGHT_PAL
  ) return null;
  return h;
}

/** Two 4-bit colour indices per byte, LEFT pixel in the LOW nibble, into one index per byte. */
export function unpackNibbles(packed: Uint8Array, out: Uint8Array, outOffset = 0): void {
  for (let i = 0; i < packed.length; i++) {
    const b = packed[i]!;
    out[outOffset + i * 2] = b & 0x0f;
    out[outOffset + i * 2 + 1] = b >> 4;
  }
}

/** Wrapping 16-bit counter: the signed distance from `previous` to `current`. */
export function wrappedGap(current: number, previous: number): number {
  return ((current - previous + 0x8000) & 0xffff) - 0x8000;
}
