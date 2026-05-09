// Spec 269 — Video export (MP4 via ffmpeg subprocess).
//
// Drives a scenario session frame-by-frame at PAL 50fps, piping raw
// RGBA frames to ffmpeg fd-3 and s16le stereo audio to ffmpeg fd-4.
// ffmpeg produces an MP4 with H264+AAC at the output path.
//
// ffmpeg must be installed (e.g. `brew install ffmpeg`). If absent,
// the function throws with a clear message. Pass `skipFfmpegCheck:true`
// in tests to skip.

import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { startIntegratedSession } from "../integrated-session-manager.js";
import { loadSessionVsf } from "../vsf/session-vsf.js";
import { AudioExportSession } from "../audio/sid-audio-recorder.js";

const PAL_CYCLES_PER_SEC = 985248;
const PAL_FPS = 50;
const CYCLES_PER_FRAME = Math.floor(PAL_CYCLES_PER_SEC / PAL_FPS); // 19704
const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = Math.floor(SAMPLE_RATE / PAL_FPS); // 882

// Exported crop dimensions (matches renderToPng 392×272 crop).
const FRAME_W = 392;
const FRAME_H = 272;

export interface VideoOptions {
  duration?: number;  // seconds (default 5s)
  scale?: 1 | 2 | 4;
  skipFfmpegCheck?: boolean;
}

export interface VideoResult {
  out_path: string;
  bytes: number;
  frames: number;
  duration_sec: number;
}

/**
 * Export an MP4 video for the given scenario.
 *
 * Requires ffmpeg installed. Pipes RGBA frames + s16le audio through
 * named pipes (tmpfiles) to ffmpeg due to Node lacking fd-passing
 * to child processes. For each PAL frame (1/50s):
 *   1. Run session ~19704 cycles
 *   2. renderFrame() → crop RGBA → push to frame buffer
 *   3. pump audio recorder
 * Then calls ffmpeg once with two input files (raw video + raw audio).
 */
export async function exportVideo(
  scenarioId: string,
  outPath: string,
  opts: VideoOptions = {},
): Promise<VideoResult> {
  const { loadScenario } = await import("../v2/scenario-registry.js");
  const saved = loadScenario(scenarioId);
  if (!saved) throw new Error(`scenario '${scenarioId}' not found`);

  const scale = opts.scale ?? 1;
  const durationSec = opts.duration ?? 5;
  const skipFfmpegCheck = opts.skipFfmpegCheck ?? false;

  // Check ffmpeg availability.
  if (!skipFfmpegCheck) {
    const check = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (check.status !== 0 && check.error) {
      throw new Error(
        "ffmpeg not found. Install via: brew install ffmpeg (mac) or apt install ffmpeg (linux)",
      );
    }
  }

  // 1. Construct session.
  const { session } = startIntegratedSession({
    diskPath: saved.diskPath,
    mode: saved.mode,
    useMicrocodedCpu: saved.mode === "true-drive",
  });

  // 2. Restore startSnapshot if present.
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
      const tmpVsf = join(tmpDir, `${scenarioId}-vsf-${process.pid}.vsf`);
      writeFileSync(tmpVsf, snapshotBytes);
      loadSessionVsf(session, tmpVsf);
    }
  }

  // 3. Attach audio recorder.
  const audioExporter = new AudioExportSession(session, { sampleRate: SAMPLE_RATE });

  // 4. Render frames.
  const totalFrames = Math.floor(durationSec * PAL_FPS);
  const frameW = FRAME_W * scale;
  const frameH = FRAME_H * scale;
  const frameBytes = frameW * frameH * 4; // RGBA

  // Accumulate raw RGBA and s16le audio into buffers.
  // For large exports this could be swapped to streaming; for spec scope,
  // we buffer in memory (5s PAL = 250 frames × 392×272×4 = ~107 MB unscaled).
  const rawVideo = Buffer.alloc(totalFrames * frameBytes);
  const rawAudioChunks: Int16Array[] = [];

  const cropX = 0, cropY = 15, cropW = FRAME_W, cropH = FRAME_H;

  for (let f = 0; f < totalFrames; f++) {
    // Run one PAL frame of cycles.
    session.runFor(200_000, { cycleBudget: CYCLES_PER_FRAME });

    // Render frame into framebuffer.
    session.renderFrame();
    const fb = session.framebuffer;

    // Crop RGBA 392×272.
    const frameRgba = new Uint8Array(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      const srcRow = ((cropY + y) * fb.width + cropX) * 4;
      const dstRow = y * cropW * 4;
      frameRgba.set(fb.pixels.subarray(srcRow, srcRow + cropW * 4), dstRow);
    }

    // Upscale if needed.
    const finalRgba = scale === 1 ? frameRgba : nearestNeighbour(frameRgba, cropW, cropH, frameW, frameH);

    // Write into video buffer.
    rawVideo.set(finalRgba, f * frameBytes);

    // Pump audio.
    audioExporter.pump();
  }

  // Collect final audio.
  const stereoAudio = audioExporter.finishStereo();
  // Convert Int16Array to Buffer.
  const audioBuf = Buffer.from(stereoAudio.buffer, stereoAudio.byteOffset, stereoAudio.byteLength);

  // 5. Write temp files for ffmpeg.
  const tmpDir = join(tmpdir(), "c64re-export");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const videoFile = join(tmpDir, `${scenarioId}-video-${process.pid}.raw`);
  const audioFile = join(tmpDir, `${scenarioId}-audio-${process.pid}.raw`);
  writeFileSync(videoFile, rawVideo);
  writeFileSync(audioFile, audioBuf);

  // 6. Ensure output dir exists.
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // 7. Run ffmpeg.
  const ffmpegArgs = [
    "-y",
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${frameW}x${frameH}`,
    "-framerate", "50",
    "-i", videoFile,
    "-f", "s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "2",
    "-i", audioFile,
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ];

  const ffResult = spawnSync("ffmpeg", ffmpegArgs, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (ffResult.status !== 0) {
    const stderr = ffResult.stderr?.toString("utf8") ?? "";
    throw new Error(`ffmpeg exited with code ${ffResult.status}:\n${stderr.slice(-2000)}`);
  }

  const outStat = existsSync(outPath)
    ? (await import("node:fs")).statSync(outPath).size
    : 0;

  return {
    out_path: outPath,
    bytes: outStat,
    frames: totalFrames,
    duration_sec: durationSec,
  };
}

/** Nearest-neighbour RGBA upscale. */
function nearestNeighbour(
  src: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.floor(y * srcH / dstH);
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.floor(x * srcW / dstW);
      const si = (srcY * srcW + srcX) * 4;
      const di = (y * dstW + x) * 4;
      dst[di]     = src[si]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
  return dst;
}
