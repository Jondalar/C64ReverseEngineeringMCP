// Spec 263 — one-shot audio export driver.
//
// Drives a session for `durationSec` PAL seconds, harvesting Resid PCM
// into a stereo WAV file. Used by `audio/export` WS handler and the
// `runtime_audio_export` MCP tool.

import { AudioExportSession } from "./sid-audio-recorder.js";
import { writeWav } from "./wav-writer.js";

const PAL_CYCLES_PER_SEC = 985248;

export interface ExportableSession {
  c64Cpu: { cycles: number };
  sid: any;
  runFor(maxC64Instructions: number, opts?: { cycleBudget?: number }): unknown;
}

export interface ExportResult {
  out_path: string;
  duration_sec: number;
  sample_rate: number;
  samples: number;
  bytes: number;
}

/**
 * Run the session for `durationSec` PAL seconds, capture audio via the
 * provided AudioExportSession, write WAV to `outPath`. Returns metadata.
 *
 * The session is driven in slices of ~1024 samples worth of cycles to
 * keep the AudioRingBuffer from overflowing.
 */
export function exportSessionAudio(
  session: ExportableSession,
  exporter: AudioExportSession,
  outPath: string,
  durationSec: number,
): ExportResult {
  const totalCycles = Math.floor(durationSec * PAL_CYCLES_PER_SEC);
  const sliceCycles = Math.floor(1024 * PAL_CYCLES_PER_SEC / exporter.sampleRate);
  let consumed = 0;
  while (consumed < totalCycles) {
    const want = Math.min(sliceCycles, totalCycles - consumed);
    // Run instructions until we've consumed `want` cycles. Cap at
    // 200_000 instructions per slice as safety.
    session.runFor(200_000, { cycleBudget: want });
    exporter.pump();
    consumed += want;
  }
  const stereo = exporter.finishStereo();
  writeWav(outPath, stereo, { sampleRate: exporter.sampleRate, channels: 2 });
  return {
    out_path: outPath,
    duration_sec: durationSec,
    sample_rate: exporter.sampleRate,
    samples: stereo.length / 2,
    bytes: 44 + stereo.length * 2,
  };
}
