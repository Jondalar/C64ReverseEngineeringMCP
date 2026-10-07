// Spec 889 §4c — the binary WebSocket messages the UI already plays.
//
// Envelope (both kinds): [type:u8][seq:u32 LE] then the payload; ws-client.ts onBinaryMessage
// reads exactly that. The TRX64 daemon builds the same bytes in streaming.rs (build_vic_frame,
// build_audio_msg); Live.tsx drawFrame and audio-player.ts parse them.
//
//  0x01 VIC frame, fmt 1 (palette-indexed):
//       [w:u16][h:u16][fmt:u8=1][rsvd:u8=0][cycle:u32] [48 B palette 16x(R,G,B)] [w*h indices, each & 0x0f]
//       palette at offset 10, indices at 58. `cycle` is the C64 cycle counter on the emulator;
//       the device stream carries none, so it is 0 here and the UI does not read it.
//  0x02 audio buffer: raw s16le interleaved STEREO PCM. The sample rate is NOT in the frame; the
//       player is told per connection (see `audio/start` in index.ts).

import { PALETTES } from "../../graphics-render/c64-decoders.js";

export const BIN_TYPE_VIC_FRAME = 0x01;
export const BIN_TYPE_AUDIO_BUFFER = 0x02;
export const VIC_FMT_INDEXED = 1;
export const VIC_PALETTE_OFFSET = 10;
export const VIC_INDICES_OFFSET = 58;

/** The palette the emulator path uses (colodore), as the 48 bytes the frame carries. */
export const PALETTE_RGB48: Uint8Array = (() => {
  const out = new Uint8Array(48);
  PALETTES.colodore!.forEach((c, i) => out.set(c, i * 3));
  return out;
})();

export function buildVicFrameMessage(seq: number, width: number, height: number, indices: Uint8Array): Uint8Array {
  if (indices.length !== width * height) throw new Error(`vic frame: ${indices.length} indices for ${width}x${height}`);
  const msg = new Uint8Array(5 + VIC_INDICES_OFFSET + indices.length);
  const dv = new DataView(msg.buffer);
  msg[0] = BIN_TYPE_VIC_FRAME;
  dv.setUint32(1, seq >>> 0, true);
  dv.setUint16(5, width, true);
  dv.setUint16(7, height, true);
  msg[9] = VIC_FMT_INDEXED;
  msg[10] = 0;
  dv.setUint32(11, 0, true);
  msg.set(PALETTE_RGB48, 5 + VIC_PALETTE_OFFSET);
  for (let i = 0; i < indices.length; i++) msg[5 + VIC_INDICES_OFFSET + i] = indices[i]! & 0x0f;
  return msg;
}

export function buildAudioMessage(seq: number, pcm: Uint8Array): Uint8Array {
  const msg = new Uint8Array(5 + pcm.length);
  msg[0] = BIN_TYPE_AUDIO_BUFFER;
  new DataView(msg.buffer).setUint32(1, seq >>> 0, true);
  msg.set(pcm, 5);
  return msg;
}
