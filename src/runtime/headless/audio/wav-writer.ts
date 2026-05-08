// Spec 263 — WAV (RIFF/PCM) writer.
//
// Standard 44-byte header + interleaved s16le PCM payload. Default:
// stereo @ 44.1kHz. Mono helper variant available.
//
// Format ref: http://soundfile.sapp.org/doc/WaveFormat/

import { writeFileSync, readFileSync } from "node:fs";

export interface WavOptions {
  sampleRate?: number;
  channels?: 1 | 2;
}

/** Build a complete WAV byte buffer from interleaved Int16 PCM samples. */
export function buildWav(samples: Int16Array, opts: WavOptions = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 44100;
  const channels = opts.channels ?? 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = samples.length * 2;
  const fileSize = 36 + dataBytes;
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  // RIFF header
  writeAscii(buf, 0, "RIFF");
  dv.setUint32(4, fileSize, true);
  writeAscii(buf, 8, "WAVE");
  // fmt chunk
  writeAscii(buf, 12, "fmt ");
  dv.setUint32(16, 16, true);          // chunk size (PCM = 16)
  dv.setUint16(20, 1, true);           // audio format = 1 (PCM)
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  // data chunk
  writeAscii(buf, 36, "data");
  dv.setUint32(40, dataBytes, true);
  // PCM payload (s16le)
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(44 + i * 2, samples[i]!, true);
  }
  return buf;
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

export function writeWav(path: string, samples: Int16Array, opts: WavOptions = {}): void {
  const buf = buildWav(samples, opts);
  writeFileSync(path, buf);
}

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array;
}

/** Read a WAV file (s16le PCM only). */
export function readWav(path: string): ParsedWav {
  const buf = readFileSync(path);
  return parseWav(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

export function parseWav(buf: Uint8Array): ParsedWav {
  if (buf.length < 44) throw new Error("WAV too short");
  if (readAscii(buf, 0, 4) !== "RIFF") throw new Error("missing RIFF magic");
  if (readAscii(buf, 8, 4) !== "WAVE") throw new Error("missing WAVE magic");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Walk chunks (simple — assumes fmt then data, the layout buildWav writes).
  const fmtId = readAscii(buf, 12, 4);
  if (fmtId !== "fmt ") throw new Error(`expected fmt chunk, got ${fmtId}`);
  const fmt = dv.getUint16(20, true);
  if (fmt !== 1) throw new Error(`only PCM (fmt=1) supported, got ${fmt}`);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  if (bitsPerSample !== 16) throw new Error(`only 16-bit PCM supported, got ${bitsPerSample}`);
  const dataId = readAscii(buf, 36, 4);
  if (dataId !== "data") throw new Error(`expected data chunk, got ${dataId}`);
  const dataBytes = dv.getUint32(40, true);
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = dv.getInt16(44 + i * 2, true);
  }
  return { sampleRate, channels, bitsPerSample, samples };
}

function readAscii(buf: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]!);
  return s;
}
