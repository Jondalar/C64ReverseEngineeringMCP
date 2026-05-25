// src/runtime/headless/inspect/vic-inspect-types.ts
//
// Spec 710 — frozen-VIC inspect types (builds on the Spec 702 model).
//
// These types are the SHARED checkpoint/evidence record: Spec 711 (code-overlay
// intervention branches) and Spec 712 (rewind/replay branch diffs) bind to the
// same `checkpointId` and `FrozenInspectEvidence`. 710 must produce them as a
// common substrate, not an inspect-private structure.
//
// All inspect coordinates are in the C64 DISPLAY area (40x25 cells = 320x200
// pixels): x in [0,320), y in [0,200), cell = (x>>3, y>>3). The bordered visible
// frame → display-area translation is a UI (710.3) concern; the backend resolver
// works in display space so it is unambiguous and renderer-independent.

/** A named address-range fact backing a visual node. */
export interface MemoryRef {
  kind:
    | "screen_ram"
    | "color_ram"
    | "charset"
    | "bitmap"
    | "sprite_ptr"
    | "sprite_data"
    | "vic_reg";
  /** Absolute C64 address. */
  addr: number;
  /** Byte length of the fact. */
  length: number;
  /** Current byte value(s) read from the checkpoint, when small/fixed. */
  value?: number;
  /** VIC bank base this ref resolves within (screen/char/bitmap/sprite). */
  bank?: number;
  /** e.g. "char ROM shadow" when the VIC fetches ROM not RAM at this addr. */
  note?: string;
}

export type VicInspectMode =
  | "standard_text"
  | "multicolor_text"
  | "extended_bg_text"
  | "hires_bitmap"
  | "multicolor_bitmap";

/** One resolved screen element from the frozen checkpoint.
 *  NOTE: `sprite_bounds` is a bounding-box hit (the pixel lies within sprite N's
 *  on-screen box) plus that sprite's pointer/data/register evidence — it is NOT
 *  a pixel-exact, transparency/priority-resolved sprite pixel. Pixel-exact
 *  sprite resolution (mask bit + priority vs foreground) is a later refinement. */
export interface VisualNode {
  type: "text_cell" | "bitmap_cell" | "sprite_bounds" | "border" | "background";
  /** Display-area pixel the query resolved (0..319, 0..199). */
  pixel: { x: number; y: number };
  /** Character grid cell, for text/bitmap nodes. */
  cell?: { col: number; row: number; index: number };
  /** Raster context (line/cycle) where supported by provenance (710.4). */
  raster?: { line: number; cycle?: number };
  mode: VicInspectMode;
  /** Screen code (text), or sprite number (sprite). */
  value?: number;
  /** Resolved foreground/sprite colour index (0..15) when unambiguous. */
  colorIndex?: number;
  /** The exact memory facts that produced this element. */
  refs: MemoryRef[];
}

/** Frame-wide VIC state derived from the checkpoint (no execution advance). */
export interface VicInspectSnapshot {
  mode: VicInspectMode;
  /** VIC 16K bank base ($0000/$4000/$8000/$C000). */
  bankBase: number;
  /** Absolute video-matrix (screen RAM) base. */
  screenBase: number;
  /** Absolute charset base (text modes); char-ROM-shadowed where noted. */
  charBase: number;
  /** Whether charBase falls in the $1000-$1FFF char-ROM shadow (bank 0/2). */
  charRomShadow: boolean;
  /** Absolute bitmap base (bitmap modes). */
  bitmapBase: number;
  /** Color RAM is always $D800. */
  colorBase: 0xd800;
  /** $D000-$D03F register file at the checkpoint. */
  regs: number[];
  /** $D020 border color index. */
  border: number;
  /** $D021 background color index. */
  background: number;
  /** Display origin within the standard 320x200 area (always {0,0} here). */
  displayWidth: 320;
  displayHeight: 200;
}

/**
 * Optional bounded same-frame provenance sidecar (Spec 710.4 — raster/FLI/sprite
 * priority). Populated only when same-frame capture is enabled; absent here in
 * the 710.1/710.2 slice. Associated with the SAME completed frame/checkpoint.
 */
export interface VicFrameProvenance {
  /** Per-display-line VIC mode + key register values, when captured. */
  lines?: Array<{ line: number; d011: number; d016: number; d018: number; bank: number }>;
}

/**
 * The shared frozen-inspect evidence record (Spec 710 §3). Specs 711/712 bind to
 * the same `checkpointId` + record.
 */
export interface FrozenInspectEvidence {
  checkpointId: string;
  snapshotRef?: string;
  experimentId?: string;
  /** Media identity at the checkpoint (Spec 709). */
  mediaState?: unknown;
  /** Currently-proven trace mark reference (Spec 708), when present. */
  traceMarkId?: string;
  frame: VicInspectSnapshot;
  provenance?: VicFrameProvenance;
  selectedNodes: VisualNode[];
}
