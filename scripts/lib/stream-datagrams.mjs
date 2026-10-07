// Spec 889 §4c — synthetic UDP datagrams of a C64 Ultimate's video and audio streams, for the smokes.
// Layout as the device sends it (header `<HHHHBBH`, 768 bytes of 4-bit indices, left pixel in the LOW nibble;
// audio: seq u16le + 192 stereo s16le frames).

import { createSocket } from "node:dgram";

export const col = (frame, y, x) => (y * 7 + x + frame) & 15;

export class VideoGen {
  seq = 0;
  /** One frame's 780-byte datagrams in line order. */
  frame(no, height = 272) {
    const out = [];
    for (let line = 0; line < height; line += 4) {
      const b = Buffer.alloc(780);
      b.writeUInt16LE(this.seq++ & 0xffff, 0);
      b.writeUInt16LE(no & 0xffff, 2);
      b.writeUInt16LE(line | (line + 4 >= height ? 0x8000 : 0), 4);
      b.writeUInt16LE(384, 6); b[8] = 4; b[9] = 4; b.writeUInt16LE(0, 10);
      for (let l = 0; l < 4; l++) for (let i = 0; i < 192; i++) {
        b[12 + l * 192 + i] = col(no, line + l, 2 * i) | (col(no, line + l, 2 * i + 1) << 4);
      }
      out.push(b);
    }
    return out;
  }
}

export class AudioGen {
  seq = 0;
  /** One 770-byte packet; every sample is `value` (L) and `-value` (R). */
  packet(value = 1000) {
    const b = Buffer.alloc(770);
    b.writeUInt16LE(this.seq++ & 0xffff, 0);
    for (let i = 0; i < 192; i++) { b.writeInt16LE(value, 2 + i * 4); b.writeInt16LE(-value, 4 + i * 4); }
    return b;
  }
}

/** Send datagrams to 127.0.0.1:<port> from a socket bound to 127.0.0.1 (the fake device's address). */
export async function udpSender() {
  const s = createSocket("udp4");
  await new Promise((res, rej) => { s.once("error", rej); s.bind(0, "127.0.0.1", res); });
  return {
    send: (port, buf) => new Promise((res, rej) => s.send(buf, port, "127.0.0.1", (e) => (e ? rej(e) : res()))),
    close: () => new Promise((r) => s.close(() => r())),
  };
}
