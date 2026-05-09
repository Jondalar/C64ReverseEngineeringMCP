// Spec 269 — Screenshot export.
//
// exportScreenshot: runs a scenario from start, optionally advances to
// a specific cycle, then calls renderToPng. Supports 1x/2x/4x scaling
// via nearest-neighbour RGBA upscale applied before PNG encoding.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { startIntegratedSession } from "../integrated-session-manager.js";
import { loadSessionVsf } from "../vsf/session-vsf.js";
import { rgbaToPng } from "../peripherals/png-writer.js";
import { tmpdir } from "node:os";
import { writeFileSync as wf, readFileSync } from "node:fs";

export interface ScreenshotOptions {
  scale?: 1 | 2 | 4;
  /** Run until this many cycles into the scenario before snapping. Default: run full cycleBudget. */
  atCycle?: number;
}

export interface ScreenshotResult {
  out_path: string;
  width: number;
  height: number;
  bytes: number;
  cycles_ran: number;
}

/**
 * Export a single PNG screenshot for the given scenario.
 *
 * 1. Loads scenario from registry.
 * 2. Constructs a fresh integrated session.
 * 3. Restores the startSnapshot (if any).
 * 4. Runs until `atCycle` cycles from snapshot start (or full cycleBudget).
 * 5. Calls renderToPng (produces 392×272 crop).
 * 6. If scale > 1, nearest-neighbour upscales the PNG RGBA data.
 * 7. Writes final PNG to outPath.
 */
export async function exportScreenshot(
  scenarioId: string,
  outPath: string,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const { loadScenario } = await import("../v2/scenario-registry.js");
  const saved = loadScenario(scenarioId);
  if (!saved) throw new Error(`scenario '${scenarioId}' not found`);

  const scale = opts.scale ?? 1;

  // 1. Construct session.
  const { session } = startIntegratedSession({
    diskPath: saved.diskPath,
    mode: saved.mode,
    useMicrocodedCpu: saved.mode === "true-drive",
  });

  // 2. Restore startSnapshot if present.
  if (saved.startSnapshot) {
    let snapshotBytes: Uint8Array;
    if (typeof saved.startSnapshot === "string" && saved.startSnapshot.length > 0) {
      if (existsSync(saved.startSnapshot)) {
        snapshotBytes = new Uint8Array(readFileSync(saved.startSnapshot));
      } else {
        // Treat as base64.
        snapshotBytes = new Uint8Array(Buffer.from(saved.startSnapshot as string, "base64"));
      }
      const tmpDir = join(tmpdir(), "c64re-export");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tmpVsf = join(tmpDir, `${scenarioId}-${process.pid}.vsf`);
      writeFileSync(tmpVsf, snapshotBytes);
      loadSessionVsf(session, tmpVsf);
    }
  }

  // 3. Run to cycle target.
  const startCycle = session.c64Cpu.cycles;
  const budget = opts.atCycle !== undefined
    ? Math.min(opts.atCycle, saved.cycleBudget)
    : saved.cycleBudget;
  if (budget > 0) {
    session.runFor(500_000, { cycleBudget: budget });
  }
  const cyclesRan = session.c64Cpu.cycles - startCycle;

  // 4. Render to a temp PNG (392×272) then upscale if needed.
  if (scale === 1) {
    // Direct output path.
    ensureDir(outPath);
    const r = session.renderToPng(outPath);
    return { out_path: outPath, width: r.width, height: r.height, bytes: r.bytes, cycles_ran: cyclesRan };
  }

  // Scale > 1: render to temp, read RGBA back, upscale, write final.
  const tmpDir = join(tmpdir(), "c64re-export");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tmpPng = join(tmpDir, `${scenarioId}-snap-${process.pid}.png`);
  const { width: srcW, height: srcH } = session.renderToPng(tmpPng);

  // Re-render directly to RGBA via framebuffer (avoid double-file).
  const fb = session.framebuffer;
  // Reuse the exact crop logic from renderToPng.
  const cropX = 0, cropY = 15, cropW = 392, cropH = 272;
  const srcRgba = new Uint8Array(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const srcRow = ((cropY + y) * fb.width + cropX) * 4;
    const dstRow = y * cropW * 4;
    srcRgba.set(fb.pixels.subarray(srcRow, srcRow + cropW * 4), dstRow);
  }

  const dstW = cropW * scale;
  const dstH = cropH * scale;
  const dstRgba = nearestNeighbour(srcRgba, cropW, cropH, dstW, dstH);
  const png = rgbaToPng(dstW, dstH, dstRgba);
  ensureDir(outPath);
  writeFileSync(outPath, png);
  return { out_path: outPath, width: dstW, height: dstH, bytes: png.length, cycles_ran: cyclesRan };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
