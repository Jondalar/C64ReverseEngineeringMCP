// src/runtime/headless/inspect/vic-inspect.ts
//
// Spec 710.2 — checkpoint-bound VIC inspect resolver.
//
// PURE functions over a frozen RuntimeCheckpoint: derive the frame-wide VIC
// state and resolve display-area pixels to exact VIC/RAM provenance. NEVER
// advances execution — it only reads checkpoint state (regs, RAM, color RAM,
// sprites). The literal `viciisc` checkpoint is the visual authority; the
// `VicIIVice` model is NOT consulted (Spec 710 §2.1).
//
// Coordinates are C64 DISPLAY-area pixels: x in [0,320), y in [0,200);
// cell = (x>>3, y>>3), cellIndex = row*40 + col.

import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.js";
import type {
  MemoryRef, VisualNode, VicInspectSnapshot, VicInspectMode, VicFrameProvenance,
  FrozenInspectEvidence,
} from "./vic-inspect-types.js";

const reg = (cp: RuntimeCheckpoint, i: number): number => (cp.vic.regs[i] ?? 0) & 0xff;
const ram = (cp: RuntimeCheckpoint, addr: number): number => (cp.ram[addr & 0xffff] ?? 0) & 0xff;
const colorRam = (cp: RuntimeCheckpoint, idx: number): number => (cp.vic.color_ram[idx] ?? 0) & 0x0f;

/** PAL raster line of the first 25-row display line (DEN, $D011 RSEL=1). */
const FIRST_DISPLAY_RASTER = 51;

interface ModeBases {
  mode: VicInspectMode;
  bankBase: number;
  screenBase: number;
  charBase: number;
  charRomShadow: boolean;
  bitmapBase: number;
}

/** Derive display mode + memory bases from raw VIC regs + bank (shared by the
 *  frame snapshot and per-line raster/FLI provenance override). */
function deriveBases(d011: number, d016: number, d018: number, bankBase: number): ModeBases {
  const bmm = (d011 & 0x20) !== 0, ecm = (d011 & 0x40) !== 0, mcm = (d016 & 0x10) !== 0;
  const mode: VicInspectMode = bmm
    ? (mcm ? "multicolor_bitmap" : "hires_bitmap")
    : ecm ? "extended_bg_text" : mcm ? "multicolor_text" : "standard_text";
  const screenOffset = ((d018 & 0xf0) >> 4) * 0x400;
  const charOffset = ((d018 & 0x0e) >> 1) * 0x800;
  const bitmapOffset = (d018 & 0x08) ? 0x2000 : 0;
  // Char ROM is shadowed into the VIC at $1000-$1FFF only for banks based at
  // $0000 and $8000 (i.e. bankBase 0x0000 / 0x8000).
  const charRomShadow =
    (bankBase === 0x0000 || bankBase === 0x8000) && charOffset >= 0x1000 && charOffset < 0x2000;
  return {
    mode,
    bankBase,
    screenBase: bankBase + screenOffset,
    charBase: bankBase + charOffset,
    charRomShadow,
    bitmapBase: bankBase + bitmapOffset,
  };
}

const bankBaseOf = (cp: RuntimeCheckpoint): number => (3 - ((cp.cia2.c_cia?.[0] ?? 0) & 0x03)) * 0x4000;

/** Frame-wide VIC state from the checkpoint (mirrors integrated-session.renderDescriptor). */
export function buildVicInspectSnapshot(cp: RuntimeCheckpoint): VicInspectSnapshot {
  const b = deriveBases(reg(cp, 0x11), reg(cp, 0x16), reg(cp, 0x18), bankBaseOf(cp));
  return {
    ...b,
    colorBase: 0xd800,
    regs: Array.from({ length: 0x40 }, (_, i) => reg(cp, i)),
    border: reg(cp, 0x20) & 0x0f,
    background: reg(cp, 0x21) & 0x0f,
    displayWidth: 320,
    displayHeight: 200,
  };
}

/** Bounding-box hit-test of enabled sprites, front-to-back (sprite 0 highest).
 *  Returns a `sprite_bounds` node: the pixel is within the sprite's on-screen
 *  box, with that sprite's pointer/data/register evidence. NOT pixel-exact (no
 *  transparency/priority resolution) — see VisualNode docs. */
function spriteBoundsAt(cp: RuntimeCheckpoint, snap: VicInspectSnapshot, x: number, y: number): VisualNode | null {
  const enable = reg(cp, 0x15);
  if (enable === 0) return null;
  const msbx = reg(cp, 0x10), xexp = reg(cp, 0x1d), yexp = reg(cp, 0x17);
  for (let i = 0; i < 8; i++) {
    if (!(enable & (1 << i))) continue;
    const sx = reg(cp, i * 2) | ((msbx & (1 << i)) ? 0x100 : 0);
    const sy = reg(cp, i * 2 + 1);
    const w = (xexp & (1 << i)) ? 48 : 24;
    const h = (yexp & (1 << i)) ? 42 : 21;
    const dx = sx - 24, dy = sy - 50; // VIC sprite coords → display-area origin
    if (x >= dx && x < dx + w && y >= dy && y < dy + h) {
      const ptrAddr = snap.screenBase + 0x3f8 + i;
      const ptr = ram(cp, ptrAddr);
      const refs: MemoryRef[] = [
        { kind: "sprite_ptr", addr: ptrAddr, length: 1, value: ptr, bank: snap.bankBase },
        { kind: "sprite_data", addr: snap.bankBase + ptr * 64, length: 63, bank: snap.bankBase, note: "bounding-box hit; not pixel-exact (no transparency/priority)" },
        { kind: "vic_reg", addr: 0xd000 + i * 2, length: 1, value: sx & 0xff, note: "sprite X" },
        { kind: "vic_reg", addr: 0xd001 + i * 2, length: 1, value: sy, note: "sprite Y" },
        { kind: "vic_reg", addr: 0xd027 + i, length: 1, value: reg(cp, 0x27 + i) & 0x0f, note: "sprite color" },
      ];
      return { type: "sprite_bounds", pixel: { x, y }, mode: snap.mode, value: i, colorIndex: reg(cp, 0x27 + i) & 0x0f, refs };
    }
  }
  return null;
}

/** Resolve a single display-area pixel to its exact VIC/RAM provenance.
 *  When `provenance` (Spec 710.4 same-frame sidecar) is supplied, the cell's
 *  mode + memory bases are taken from the per-raster-line record so raster
 *  splits / FLI resolve to the correct base for THAT line, not a frame-global
 *  guess. Sprites remain frame-global. */
export function resolveNodeAt(
  cp: RuntimeCheckpoint,
  x: number,
  y: number,
  provenance?: VicFrameProvenance | null,
): VisualNode {
  const snap = buildVicInspectSnapshot(cp);

  const sprite = spriteBoundsAt(cp, snap, x, y);
  if (sprite) return sprite;

  // Per-line raster/FLI override (710.4): map display y → raster line → record.
  let bases: ModeBases = snap;
  let raster: { line: number } | undefined;
  if (provenance?.lines && provenance.lines.length > 0) {
    const line = FIRST_DISPLAY_RASTER + y;
    const ln = provenance.lines.find((l) => l.line === line);
    if (ln) {
      bases = deriveBases(ln.d011, ln.d016, ln.d018, ln.bank);
      raster = { line };
    }
  }

  const col = Math.max(0, Math.min(39, x >> 3));
  const row = Math.max(0, Math.min(24, y >> 3));
  const index = row * 40 + col;
  const refs: MemoryRef[] = [];

  if (bases.mode === "hires_bitmap" || bases.mode === "multicolor_bitmap") {
    const screenAddr = bases.screenBase + index;
    refs.push({ kind: "screen_ram", addr: screenAddr, length: 1, value: ram(cp, screenAddr), bank: bases.bankBase, note: "fg/bg colour nibbles" });
    refs.push({ kind: "bitmap", addr: bases.bitmapBase + index * 8, length: 8, bank: bases.bankBase });
    if (bases.mode === "multicolor_bitmap") {
      refs.push({ kind: "color_ram", addr: 0xd800 + index, length: 1, value: colorRam(cp, index) });
    }
    refs.push({ kind: "vic_reg", addr: 0xd011, length: 1, value: reg(cp, 0x11) });
    refs.push({ kind: "vic_reg", addr: 0xd018, length: 1, value: reg(cp, 0x18) });
    return { type: "bitmap_cell", pixel: { x, y }, cell: { col, row, index }, raster, mode: bases.mode, refs };
  }

  // text modes
  const screenAddr = bases.screenBase + index;
  const code = ram(cp, screenAddr);
  const colorIndex = colorRam(cp, index);
  refs.push({ kind: "screen_ram", addr: screenAddr, length: 1, value: code, bank: bases.bankBase });
  refs.push({ kind: "color_ram", addr: 0xd800 + index, length: 1, value: colorIndex });
  refs.push({ kind: "charset", addr: bases.charBase + code * 8, length: 8, bank: bases.bankBase, note: bases.charRomShadow ? "char ROM shadow" : undefined });
  refs.push({ kind: "vic_reg", addr: 0xd018, length: 1, value: reg(cp, 0x18) });
  return { type: "text_cell", pixel: { x, y }, cell: { col, row, index }, raster, mode: bases.mode, value: code, colorIndex, refs };
}

/**
 * Spec 710.5 — assemble the SHARED frozen-inspect evidence record from a pinned
 * checkpoint + selected points/region. This is the common substrate Specs 711
 * (code-overlay) and 712 (rewind/replay) bind to: it names the checkpoint, the
 * media identity at that checkpoint (Spec 709, already in `cp.media`), an
 * optional trace mark (Spec 708), and the exact resolved visual nodes. PURE —
 * no execution advance, no knowledge-store side effect (persistence is the
 * caller's concern).
 */
export function assembleInspectEvidence(
  cp: RuntimeCheckpoint,
  checkpointId: string,
  opts: {
    points?: Array<{ x: number; y: number }>;
    region?: { x: number; y: number; width: number; height: number };
    traceMarkId?: string;
    snapshotRef?: string;
    experimentId?: string;
    provenance?: VicFrameProvenance | null;
  } = {},
): FrozenInspectEvidence {
  // Points/region are VISIBLE-frame coords (UI space) → border-aware resolve.
  const selectedNodes: VisualNode[] = [];
  for (const p of opts.points ?? []) {
    selectedNodes.push(resolveVisibleNodeAt(cp, p.x, p.y, opts.provenance));
  }
  if (opts.region) selectedNodes.push(...resolveVisibleRegion(cp, opts.region, opts.provenance));
  return {
    checkpointId,
    snapshotRef: opts.snapshotRef,
    experimentId: opts.experimentId,
    mediaState: cp.media,
    traceMarkId: opts.traceMarkId,
    frame: buildVicInspectSnapshot(cp),
    provenance: opts.provenance ?? undefined,
    selectedNodes,
  };
}

// ---- visible-frame → display-area geometry (Spec 710.3 option 2) ------------
// The UI sends RAW visible-frame coords (the rendered 384x272 VICE PAL window);
// the backend owns the conversion to the C64 display area, so the UI carries no
// magic offsets. Geometry is derived from the literal renderer crop
// (renderLiteralPortRgba: CANVAS_X0=104 with balanced 32px L/R borders →
// display X starts 32px into the visible frame; CANVAS_Y0=16 and the first
// 25-row display raster line is FIRST_DISPLAY_RASTER=51 → Y starts at 51-16=35).
export const VISIBLE_FRAME = { width: 384, height: 272 } as const;
const CANVAS_Y0 = 16; // literal renderer crop: first visible raster line (fb Y0)
export const DISPLAY_ORIGIN = { x: 32, y: FIRST_DISPLAY_RASTER - CANVAS_Y0 } as const; // { x:32, y:35 }

/** Build a `sprite_bounds` node. Spec 710.6a/b. */
function makeSpriteNode(
  i: number, sx: number, sy: number, ptr: number, color: number,
  ptrAddr: number, bankBase: number, mode: VicInspectMode, vx: number, vy: number, multiplexed: boolean,
): VisualNode {
  const inBorder = vy < DISPLAY_ORIGIN.y || vy >= DISPLAY_ORIGIN.y + 200;
  const refs: MemoryRef[] = [
    { kind: "sprite_ptr", addr: ptrAddr, length: 1, value: ptr, bank: bankBase },
    { kind: "sprite_data", addr: bankBase + ptr * 64, length: 63, bank: bankBase, note: `bounding-box; not pixel-exact${multiplexed ? "; MULTIPLEXED (per-raster)" : ""}${inBorder ? "; OPEN BORDER" : ""}` },
    { kind: "vic_reg", addr: 0xd000 + i * 2, length: 1, value: sx & 0xff, note: "sprite X" },
    { kind: "vic_reg", addr: 0xd001 + i * 2, length: 1, value: sy, note: "sprite Y (raster)" },
    { kind: "vic_reg", addr: 0xd027 + i, length: 1, value: color & 0x0f, note: "sprite color" },
  ];
  return { type: "sprite_bounds", pixel: { x: Math.round(vx), y: Math.round(vy) }, raster: { line: Math.round(vy) + CANVAS_Y0 }, mode, value: i, colorIndex: color & 0x0f, refs };
}

/**
 * Spec 710.6a/b — sprite hit-test in VISIBLE-frame coords across the WHOLE frame
 * (incl. the open border, where sprites still render — e.g. a logo above the
 * display window). When same-frame provenance carries per-raster sprites
 * (710.6b multiplexer: sprite regs change per line via IRQs → >8 sprites/frame),
 * the click's raster uses THOSE sprites; otherwise the frozen 8 hardware regs.
 * Visible box: x = spriteX-24+DISPLAY_ORIGIN.x; y = spriteY-CANVAS_Y0 (sprite Y
 * register is a raster line).
 */
function spriteBoundsAtVisible(
  cp: RuntimeCheckpoint, snap: VicInspectSnapshot, vx: number, vy: number, provenance?: VicFrameProvenance | null,
): VisualNode | null {
  const raster = Math.round(vy) + CANVAS_Y0;

  // Multiplexer: per-raster sprite state is authoritative for THIS line.
  const ln = provenance?.lines?.find((l) => l.line === raster);
  if (ln) {
    for (const s of ln.sprites ?? []) {
      const bx = s.x - 24 + DISPLAY_ORIGIN.x, by = s.y - CANVAS_Y0;
      if (vx >= bx && vx < bx + s.w && vy >= by && vy < by + s.h) {
        const lbank = ln.bank ?? snap.bankBase;
        const lscreen = lbank + ((ln.d018 & 0xf0) >> 4) * 0x400;
        return makeSpriteNode(s.i, s.x, s.y, s.ptr, s.color, lscreen + 0x3f8 + s.i, lbank, snap.mode, vx, vy, true);
      }
    }
    return null; // per-raster state known → no sprite covers this pixel
  }

  // No provenance for this raster → frozen 8 hardware sprite registers.
  const enable = reg(cp, 0x15);
  if (enable === 0) return null;
  const msbx = reg(cp, 0x10), xexp = reg(cp, 0x1d), yexp = reg(cp, 0x17);
  for (let i = 0; i < 8; i++) {
    if (!(enable & (1 << i))) continue;
    const sx = reg(cp, i * 2) | ((msbx & (1 << i)) ? 0x100 : 0);
    const sy = reg(cp, i * 2 + 1);
    const w = (xexp & (1 << i)) ? 48 : 24;
    const h = (yexp & (1 << i)) ? 42 : 21;
    const bx = sx - 24 + DISPLAY_ORIGIN.x, by = sy - CANVAS_Y0;
    if (vx >= bx && vx < bx + w && vy >= by && vy < by + h) {
      const ptrAddr = snap.screenBase + 0x3f8 + i;
      return makeSpriteNode(i, sx, sy, ram(cp, ptrAddr), reg(cp, 0x27 + i), ptrAddr, snap.bankBase, snap.mode, vx, vy, false);
    }
  }
  return null;
}

/** Visible-frame pixel → display-area pixel (0..319, 0..199 clamped). */
export function visibleToDisplay(vx: number, vy: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(319, Math.round(vx) - DISPLAY_ORIGIN.x)),
    y: Math.max(0, Math.min(199, Math.round(vy) - DISPLAY_ORIGIN.y)),
  };
}

/** Visible-frame region → display-area region (clamped, non-negative). */
export function visibleRegionToDisplay(
  r: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const tl = visibleToDisplay(r.x, r.y);
  const br = visibleToDisplay(r.x + r.width, r.y + r.height);
  return { x: tl.x, y: tl.y, width: Math.max(0, br.x - tl.x), height: Math.max(0, br.y - tl.y) };
}

/** Resolve a VISIBLE-frame pixel (UI coords). Sprite-first + border-aware:
 *  sprites render in the open border too, so a click anywhere in the frame is
 *  hit-tested against sprites first (710.6a); inside the display window it falls
 *  through to the text/bitmap cell; in the border with no sprite it reports the
 *  border colour. */
export function resolveVisibleNodeAt(
  cp: RuntimeCheckpoint, vx: number, vy: number, provenance?: VicFrameProvenance | null,
): VisualNode {
  const snap = buildVicInspectSnapshot(cp);
  const sprite = spriteBoundsAtVisible(cp, snap, vx, vy, provenance);
  if (sprite) return sprite;

  const inDisplay = vx >= DISPLAY_ORIGIN.x && vx < DISPLAY_ORIGIN.x + 320
    && vy >= DISPLAY_ORIGIN.y && vy < DISPLAY_ORIGIN.y + 200;
  if (inDisplay) {
    const d = visibleToDisplay(vx, vy);
    return resolveNodeAt(cp, d.x, d.y, provenance);
  }
  // open border, no sprite → border colour ($D020)
  return {
    type: "border", pixel: { x: Math.round(vx), y: Math.round(vy) }, mode: snap.mode,
    colorIndex: snap.border,
    refs: [{ kind: "vic_reg", addr: 0xd020, length: 1, value: snap.border, note: "border colour" }],
  };
}

/** Resolve a VISIBLE-frame region (UI coords). Samples in VISIBLE space and uses
 *  the border-aware + sprite/multiplexer resolver per point, so an open-border
 *  sprite region resolves as sprites (not display-clamped bitmap cells). */
export function resolveVisibleRegion(
  cp: RuntimeCheckpoint,
  region: { x: number; y: number; width: number; height: number },
  provenance?: VicFrameProvenance | null,
): VisualNode[] {
  const nodes: VisualNode[] = [];
  const seen = new Set<string>();
  const x1 = region.x + region.width, y1 = region.y + region.height;
  for (let vy = region.y; vy < y1; vy += 8) {
    for (let vx = region.x; vx < x1; vx += 8) {
      const n = resolveVisibleNodeAt(cp, vx, vy, provenance);
      const key = `${n.type}:${n.value ?? ""}:${n.cell?.index ?? ""}:${n.raster?.line ?? ""}`;
      if (!seen.has(key)) { seen.add(key); nodes.push(n); }
    }
  }
  return nodes;
}

/** Resolve every distinct element under a display-area region. Threads the same
 *  same-frame provenance as point-resolve so raster/FLI cells in the region use
 *  the correct per-line base (key includes the resolved raster line). */
export function resolveRegion(
  cp: RuntimeCheckpoint,
  region: { x: number; y: number; width: number; height: number },
  provenance?: VicFrameProvenance | null,
): VisualNode[] {
  const nodes: VisualNode[] = [];
  const seen = new Set<string>();
  const x1 = region.x + region.width, y1 = region.y + region.height;
  for (let cy = region.y; cy < y1; cy += 8) {
    for (let cx = region.x; cx < x1; cx += 8) {
      const n = resolveNodeAt(cp, cx, cy, provenance);
      const key = `${n.type}:${n.cell?.index ?? n.value}:${n.raster?.line ?? ""}`;
      if (!seen.has(key)) { seen.add(key); nodes.push(n); }
    }
  }
  return nodes;
}
