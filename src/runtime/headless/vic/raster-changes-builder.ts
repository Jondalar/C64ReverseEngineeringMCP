// Spec 280c — bridge from VicIIVice.frameLineLogs (per-cycle reg writes
// captured under Spec 262 Phase A) → per-line raster_changes lane sets.
//
// Each scanline's reg-write log is walked in cycle order; each entry is
// classified via REG_MAPPING and pushed onto the appropriate lane via
// the cycle-precise add helpers. CIA2 PA bank changes (logged with
// reg=VICII_LOG_CIA2_PA = 0x80) are routed to the next_line lane.

import {
  REG_MAPPING,
  addBackgroundChange,
  addBorderChange,
  addForegroundChange,
  addNextLineChange,
  addSpriteChange,
  newFrameRasterChanges,
  sortLaneByWhere,
  type FrameRasterChanges,
  type RasterChangesPerLine,
} from "./raster-changes.js";
import { VICII_LOG_CIA2_PA, type ScanlineRegLog } from "./vic-ii-vice.js";

interface VicLikeForBuilder {
  frameLineLogs?: ScanlineRegLog[];
  /** PAL = 312, NTSC = 263. */
  screen_height?: number;
}

/**
 * Build per-line lane sets from the captured per-cycle reg-write log.
 * Result has 312 (PAL) or 263 (NTSC) entries; each entry's lanes are
 * sorted ascending by `where` so the renderer can walk them in one
 * pass.
 *
 * Note: foreground lane is currently unused — REG_MAPPING does not
 * route any reg there (text/bitmap pixels come from DMA fetch, not
 * direct reg writes), but the lane stays in the type for parity with
 * VICE.
 */
export function buildPerLineLanesFromFrameLog(
  vic: VicLikeForBuilder,
  _initialCia2PaByte: number,
): FrameRasterChanges {
  const lineCount = vic.screen_height ?? 312;
  const frame = newFrameRasterChanges(lineCount);

  const logs = vic.frameLineLogs;
  if (!Array.isArray(logs)) return frame;

  for (const lineEntry of logs) {
    const rl = lineEntry.rasterLine | 0;
    if (rl < 0 || rl >= lineCount) continue;
    const lane = frame.perLine[rl];
    if (!lane) continue;
    if (!Array.isArray(lineEntry.writes)) continue;

    for (const w of lineEntry.writes) {
      const reg = w.reg & 0xff;
      const cycle = w.cycleInLine | 0;
      const value = w.value & 0xff;

      // Special: CIA2 PA bank change → next_line lane (vic_bank field).
      if (reg === VICII_LOG_CIA2_PA) {
        addNextLineChange(lane, "vic_bank", value);
        continue;
      }

      // Special d011/d016: route via "video_mode" field but tag spriteIndex
      // (0=d011, 1=d016) so applyAction knows which decoder to run.
      if (reg === 0x11) {
        // d011 → next_line per VICE (mode change affects fetch next line)
        lane.nextLine.push({ where: 0, field: "video_mode", value, spriteIndex: 0 });
        continue;
      }
      if (reg === 0x16) {
        // d016 → next_line per VICE (csel & xsmooth deferred)
        lane.nextLine.push({ where: 0, field: "video_mode", value, spriteIndex: 1 });
        continue;
      }

      const mapping = REG_MAPPING[reg];
      if (!mapping) continue;

      switch (mapping.lane) {
        case "background":
          addBackgroundChange(lane, cycle, mapping.field, value);
          break;
        case "foreground":
          addForegroundChange(lane, cycle, mapping.field, value);
          break;
        case "border":
          addBorderChange(lane, cycle, mapping.field, value);
          break;
        case "sprites":
          addSpriteChange(lane, cycle, mapping.field, value, mapping.spriteIndex);
          break;
        case "next_line":
          addNextLineChange(lane, mapping.field, value, mapping.spriteIndex);
          break;
      }
    }

    // Sort per-line lanes for deterministic walk order.
    sortLaneByWhere(lane.background);
    sortLaneByWhere(lane.foreground);
    sortLaneByWhere(lane.border);
    sortLaneByWhere(lane.sprites);
    if (lane.background.length || lane.foreground.length ||
        lane.border.length || lane.sprites.length || lane.nextLine.length) {
      lane.haveOnThisLine = true;
    }
  }

  return frame;
}

// Re-export for convenience so renderer can grab via single import.
export type { RasterChangesPerLine };
