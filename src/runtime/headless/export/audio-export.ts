// Spec 269 — Audio export re-export shim.
//
// The core audio export logic lives in Spec 263 (audio/export.ts).
// This module re-exports it from the canonical export/ directory and
// adds a scenario-aware wrapper that handles session construction and
// snapshot restore before driving the audio recorder.

export {
  exportSessionAudio,
  type ExportableSession,
  type ExportResult,
} from "../audio/export.js";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { startIntegratedSession } from "../integrated-session-manager.js";
import { loadSessionVsf } from "../vsf/session-vsf.js";
import { AudioExportSession } from "../audio/sid-audio-recorder.js";
import { writeWav } from "../audio/wav-writer.js";

const PAL_CYCLES_PER_SEC = 985248;

export interface ScenarioAudioOptions {
  duration?: number;    // seconds (default 5)
  format?: "wav";       // only WAV for now
  sampleRate?: number;  // default 44100
}

export interface ScenarioAudioResult {
  out_path: string;
  duration_sec: number;
  sample_rate: number;
  samples: number;
  bytes: number;
}

/**
 * Export audio for a named scenario: constructs a fresh session,
 * restores the start snapshot, drives the session for `duration`
 * seconds of PAL time, and writes a WAV file to `outPath`.
 */
export async function exportScenarioAudio(
  scenarioId: string,
  outPath: string,
  opts: ScenarioAudioOptions = {},
): Promise<ScenarioAudioResult> {
  const { loadScenario } = await import("../v2/scenario-registry.js");
  const saved = loadScenario(scenarioId);
  if (!saved) throw new Error(`scenario '${scenarioId}' not found`);

  const durationSec = opts.duration ?? 5;
  const sampleRate = opts.sampleRate ?? 44100;

  // 1. Construct session.
  const { session } = startIntegratedSession({
    diskPath: saved.diskPath,
    mode: saved.mode,
  });

  // 2. Restore snapshot.
  if (saved.startSnapshot) {
    let snapshotBytes: Uint8Array | undefined;
    if (typeof saved.startSnapshot === "string" && saved.startSnapshot.length > 0) {
      if (existsSync(saved.startSnapshot)) {
        snapshotBytes = new Uint8Array(readFileSync(saved.startSnapshot));
      } else {
        snapshotBytes = new Uint8Array(Buffer.from(saved.startSnapshot as string, "base64"));
      }
    } else if (saved.startSnapshot instanceof Uint8Array) {
      snapshotBytes = saved.startSnapshot;
    }
    if (snapshotBytes) {
      const tmpDir = join(tmpdir(), "c64re-export");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tmpVsf = join(tmpDir, `${scenarioId}-audio-vsf-${process.pid}.vsf`);
      writeFileSync(tmpVsf, snapshotBytes);
      loadSessionVsf(session, tmpVsf);
    }
  }

  // 3. Drive session and collect audio.
  const exporter = new AudioExportSession(session, { sampleRate });
  const totalCycles = Math.floor(durationSec * PAL_CYCLES_PER_SEC);
  const sliceCycles = Math.floor(1024 * PAL_CYCLES_PER_SEC / sampleRate);
  let consumed = 0;
  while (consumed < totalCycles) {
    const want = Math.min(sliceCycles, totalCycles - consumed);
    session.runFor(200_000, { cycleBudget: want });
    exporter.pump();
    consumed += want;
  }
  const stereo = exporter.finishStereo();

  // 4. Write output.
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeWav(outPath, stereo, { sampleRate, channels: 2 });
  const bytes = 44 + stereo.length * 2;

  return {
    out_path: outPath,
    duration_sec: durationSec,
    sample_rate: sampleRate,
    samples: stereo.length / 2,
    bytes,
  };
}
