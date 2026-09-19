// Spec 863 C3 — the frozen frame's geometry, taken from the recorder's header.
//
// The VIC view (860) and the line strip (859) drew a PAL frame from literals: 63 cycles,
// 312 lines, a 384×272 window whose first row is raster line 16, blanking at cycles 1–14
// and 63. An NTSC frame is 65 × 263, its window is 247 rows and WRAPS — raster lines 0–11
// are drawn below line 262, at the bottom of the picture (VICE's vsync is at line 12).
// So every one of those numbers comes from the frame header (`vic/line_trace` and
// `vic/frame_map` → `frame`) and the frame map's `geometry.cycleX` now, and this module
// is the one place that turns them into rows and columns.
//
// Browser-safe (no node imports): ExploreOverlay and VicLineView import it, and the smoke
// feeds it a real NTSC header.

/** The recorder's frame header, as far as geometry goes. */
export interface FrameHeader {
  readonly model?: string;
  readonly chip?: string;
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  /** The raster line a displayed frame starts at (0 PAL; 12 NTSC — after the window). */
  readonly firstLine?: number;
  /** Where the canvas's top-left pixel sits in the framebuffer. */
  readonly fbOrigin: { readonly x: number; readonly y: number };
  readonly displayWindow: {
    readonly firstLine: number;
    readonly lastLine: number;
    readonly wraps: boolean;
    readonly width: number;
    readonly height: number;
  };
}

export interface FrameGeometry {
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  /** The canvas: the visible window, border included. */
  readonly width: number;
  readonly height: number;
  readonly fbOrigin: { readonly x: number; readonly y: number };
  readonly wraps: boolean;
  /** The raster line a canvas row shows. */
  lineOfRow(row: number): number;
  /** The canvas row a raster line is drawn on, or `null` when it is not on the canvas. */
  rowOfLine(line: number): number | null;
  /** The framebuffer row a raster line is drawn into (a wrapped window puts the lines
   *  before its first line BELOW the frame — the recorder's `fbLine` counts that way). */
  fbRowOfLine(line: number): number;
  /** The raster line drawn into a framebuffer row. */
  lineOfFbRow(fbRow: number): number;
  /** The cycles (1-based) that draw a pixel, first and last, from the frame map's
   *  `cycleX`; the cycles before and after are horizontal blanking. */
  readonly firstDrawn: number;
  readonly lastDrawn: number;
  readonly blankLeft: number;
  readonly blankRight: number;
}

/** The fields a header must carry — refused by name rather than guessed at. */
export function headerProblems(h: unknown): string[] {
  const x = (h ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["cyclesPerLine", "linesPerFrame"]) if (typeof x[k] !== "number") out.push(k);
  const o = x.fbOrigin as Record<string, unknown> | undefined;
  if (!o || typeof o.x !== "number" || typeof o.y !== "number") out.push("fbOrigin");
  const w = x.displayWindow as Record<string, unknown> | undefined;
  if (!w || typeof w.firstLine !== "number" || typeof w.width !== "number" || typeof w.height !== "number") {
    out.push("displayWindow");
  }
  return out;
}

/**
 * Geometry for one recorded frame. `cycleX` is the frame map's per-cycle canvas x
 * (`null` = the cycle draws no pixel); without it the drawn cycles are unknown and the
 * blanking counts are 0.
 */
export function frameGeometry(header: FrameHeader, cycleX?: readonly (number | null)[]): FrameGeometry {
  const bad = headerProblems(header);
  if (bad.length) {
    throw new Error(
      `the frame header does not carry ${bad.join(", ")} — the runtime predates C64 models, ` +
        `so the frame's geometry cannot be read from it`,
    );
  }
  const cpl = header.cyclesPerLine;
  const lines = header.linesPerFrame;
  const win = header.displayWindow;
  const first = win.firstLine;
  const wraps = !!win.wraps;
  const height = win.height;

  const fbRowOfLine = (line: number): number => (wraps && line < first ? line + lines : line);
  const lineOfFbRow = (fbRow: number): number => ((fbRow % lines) + lines) % lines;
  const lineOfRow = (row: number): number => lineOfFbRow(first + row);
  const rowOfLine = (line: number): number | null => {
    const r = fbRowOfLine(line) - first;
    return r >= 0 && r < height ? r : null;
  };

  let firstDrawn = 0;
  let lastDrawn = 0;
  if (cycleX && cycleX.length) {
    for (let c = 1; c <= Math.min(cpl, cycleX.length); c++) {
      if (cycleX[c - 1] == null) continue;
      if (!firstDrawn) firstDrawn = c;
      lastDrawn = c;
    }
  }
  return {
    cyclesPerLine: cpl,
    linesPerFrame: lines,
    width: win.width,
    height,
    fbOrigin: { x: header.fbOrigin.x, y: header.fbOrigin.y },
    wraps,
    lineOfRow,
    rowOfLine,
    fbRowOfLine,
    lineOfFbRow,
    firstDrawn,
    lastDrawn,
    blankLeft: firstDrawn ? firstDrawn - 1 : 0,
    blankRight: lastDrawn ? cpl - lastDrawn : 0,
  };
}

/**
 * Where cycle `c` sits across the grid, in canvas x: a drawn cycle is its 8 pixels; a
 * blanking cycle has none and is drawn beside the picture at `hbW` wide — the left
 * blanking to the left of x = 0, the right blanking past the right edge.
 */
export function cycleColumn(
  g: FrameGeometry,
  cycleX: readonly (number | null)[],
  c: number,
  hbW: number,
): { x: number; w: number } {
  const cx = cycleX[c - 1];
  if (cx != null) return { x: cx, w: 8 };
  if (!g.firstDrawn || c < g.firstDrawn) return { x: -(Math.max(g.firstDrawn, 1) - c) * hbW, w: hbW };
  return { x: g.width + (c - g.lastDrawn - 1) * hbW, w: hbW };
}
