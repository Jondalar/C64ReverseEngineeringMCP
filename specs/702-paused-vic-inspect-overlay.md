# Spec 702 — Paused VIC Inspect Overlay

Status: SUPERSEDED (2026-05-30) — Superseded by Spec 710 (Frozen VIC Inspect on the
Checkpoint/Evidence base, DONE). Prior header: "DRAFT — production integration
refined by Spec 710."
Created: 2026-05-21 CEST  
Owner: v3 UI / runtime / knowledge

## 1. Goal

When the emulator is paused, the C64 screen becomes a reverse-engineering
surface similar to browser DevTools element inspection.

The user can hover, select, and label visible screen regions. The backend
returns structured VIC/RAM evidence for the selected pixel or region, and the
UI can persist that selection as a C64RE knowledge reference.

This is not a renderer rewrite. The literal VIC output remains the visual
authority.

## 2. Current Hooks

The current runtime already has most of the required foundation:

- `IntegratedSession.renderLiteralPortIndexed()` exposes the stable literal VIC
  frame as `384x272` palette-indexed pixels for the Spec 701 live canvas stream.
- `IntegratedSession.vicRaster()` exposes the literal VIC raster/cycle position.
- `session/state` already reports CPU and coarse VIC status.
- `ui/src/v3/components/ExploreOverlay.tsx` already implements paused
  click-drag selection over the live canvas and calls `explore/create_artifact`.
- Archived Spec 354 described the original "Frozen Explore" UX, but it did not
  define a concrete paused inspect data model.

Spec 702 turns that skeleton into a deterministic API and knowledge contract.
Spec 710 binds this design to retained native checkpoints, trace references and
reproducible media identity after Specs 705-709.

## 3. Non-Goals

- Do not instrument the hot VIC draw loop for every pixel just for UI
  inspection.
- Do not add heuristic "visual recognition" as the first step.
- Do not advance emulation while inspecting a paused frame.
- Do not store raw anonymous rectangles without runtime/VIC/memory evidence.
- Do not treat screenshots as the source of truth when VIC state and RAM can
  explain the region.

## 4. Inspect Snapshot

On pause or debugger stop, the backend exposes a stable inspect snapshot.

Important: this is not reverse-engineering from final pixels alone. The final
literal frame contains only 4-bit colour indices. That is not enough to explain
FLI, raster bars, sprite priority, covered background pixels, badline timing, or
mid-frame `D011/D016/D018` changes.

The inspect snapshot therefore has two layers:

- the stable literal frame pixels;
- a compact provenance sidecar captured while the literal VIC produced the
  frame.

```ts
interface VicInspectSnapshot {
  sessionId: string;
  frameNo: number;
  c64Cycle: number;
  visibleFrame: { width: 384; height: 272; format: "palette-indexed" };
  vic: {
    mode: "text" | "bitmap" | "multicolor" | "ecm" | "invalid";
    bankBase: number;
    screenBase: number;
    colorBase: 0xd800;
    charsetBase?: number;
    bitmapBase?: number;
    d011: number;
    d016: number;
    d018: number;
    d020: number;
    d021: number;
    rasterLine: number;
    rasterCycle: number;
  };
  media?: { drive8?: string; cartridge?: string };
}
```

The snapshot is computed from the same literal VIC / C64 RAM state that
produced the frame. It must not use stale legacy renderer state as authority.

## 4.1 Provenance Sidecar

The literal VIC draw pipeline already composes the visible result in the right
order:

```text
graphics/background -> sprites -> border -> colour-register resolution -> dbuf
```

The sidecar records only enough evidence to explain a paused frame. It is kept
for the last stable frame, not as an unbounded trace.

```ts
interface VicFrameProvenance {
  frameNo: number;
  c64CycleStart: number;
  c64CycleEnd: number;
  lines: VicLineProvenance[];
  sprites: SpriteProvenance[];
}

interface VicLineProvenance {
  y: number;
  rasterLine: number;
  chunks: VicChunkProvenance[];
}

interface VicChunkProvenance {
  // Visible-canvas coordinates. One chunk is normally 8 pixels, matching one
  // VIC draw cycle, but the API may split it when a raster trick changes state.
  x: number;
  w: number;
  cycle: number;
  modeBits: number;       // delayed D011/D016 mode bits actually used
  d011: number;
  d016: number;
  d018: number;
  d020: number;
  d021: number;
  d022: number;
  d023: number;
  d024: number;
  vc: number;
  rc: number;
  vmli: number;
  dmli: number;
  vbuf?: number;
  cbuf?: number;
  gbuf?: number;
  screenRef?: MemoryRef;
  colorRef?: MemoryRef;
  glyphOrBitmapRef?: MemoryRef;
  border: boolean;
  spriteMask: number;     // sprites contributing in this 8-pixel region
  finalSource: "border" | "background" | "graphics" | "sprite";
}
```

This keeps FLI and other raster tricks explainable because `D011/D016/D018`,
colour registers, mode bits, `vbuf/cbuf/gbuf`, and memory refs are captured at
the moment they were actually used.

The implementation must make provenance capture optional and cheap:

- enabled for paused/live-debug sessions;
- one or two stable frames retained as a ring buffer;
- no DuckDB-style long trace unless explicitly requested;
- no per-frame JSON allocation in the hot path. Use typed arrays internally and
  materialize JSON only when `vic/inspect_*` is called.

## 5. Visual Nodes

The backend returns "visual nodes". These are not DOM elements; they are
hardware-backed C64 visual structures.

```ts
interface VisualNode {
  id: string;
  kind:
    | "frame"
    | "border"
    | "text-cell"
    | "bitmap-cell"
    | "sprite"
    | "charset-glyph"
    | "raster-line"
    | "selection";
  label: string;
  screenRegion: { x: number; y: number; w: number; h: number };
  confidence: "exact" | "derived" | "heuristic";
  memoryRefs: MemoryRef[];
  vicRefs: string[];
}

interface MemoryRef {
  space: "c64";
  address: number;
  length: number;
  role:
    | "screen-ram"
    | "color-ram"
    | "charset"
    | "bitmap"
    | "sprite-pointer"
    | "sprite-data"
    | "vic-register";
}
```

Required first-pass nodes:

- text/charset mode: 40x25 text cells with screen RAM, color RAM, character
  glyph address, and visible cell box;
- bitmap mode: 40x25 bitmap cells with bitmap/screen/color memory refs;
- sprites: boxes from `D000-D00F`, `D010`, `D015`, `D017`, `D01B`, `D01C`,
  `D01D`, `D027-D02E`, plus sprite pointers at `screenBase + $3f8`;
- border/background: coarse regions with `D020/D021` refs;
- raster marker: current raster line/cycle for debugger context.

For FLI and raster-split screens, nodes are derived from the provenance sidecar,
not from a single end-of-frame `D018` or colour-register value.

## 6. API

Add paused-only WS calls:

```text
vic/inspect_snapshot { session_id }
vic/inspect_at       { session_id, x, y }
vic/inspect_region   { session_id, screenRegion }
explore/create_artifact {
  session_id,
  kind,
  name,
  screenRegion,
  inspectNodeIds?,
  notes?
}
```

`vic/inspect_at` returns the node stack under the pixel, ordered from most
specific to broadest, for example `sprite -> text-cell -> frame`.

`vic/inspect_region` returns all intersecting nodes plus a summary of memory
refs covered by the rectangle.

If the session is running, these calls either reject with `session-running` or
ask the Spec 701 controller to pause first. They must never silently sample a
moving frame.

## 7. UI Behavior

The paused screen uses the existing `ExploreOverlay` as the base:

- hover highlights the node under the cursor;
- click selects the top exact node;
- drag creates a rectangular selection;
- side inspector shows node kind, coordinates, VIC mode, registers, memory refs,
  and a small crop preview;
- keyboard focus stays in monitor/debug UI while paused;
- resume/run hides the overlay and restores C64 keyboard focus per Spec 623/701.

The overlay should be SVG or absolutely positioned HTML over the canvas. It
must not modify the C64 frame pixels.

## 8. Knowledge Contract

Creating an artifact writes a stable reference into the C64RE knowledge layer:

```ts
interface VisualKnowledgeRef {
  kind: "visual-region";
  semanticKind: "logo" | "text" | "sprite" | "charset" | "bitmap" | "unknown";
  name: string;
  source: "runtime-vic-inspect";
  sessionId: string;
  frameNo: number;
  c64Cycle: number;
  screenRegion: { x: number; y: number; w: number; h: number };
  vic: VicInspectSnapshot["vic"];
  memoryRefs: MemoryRef[];
  media?: { drive8?: string; cartridge?: string };
  snapshotId?: string;
  traceDbMarkId?: string;
}
```

The important rule: a user annotation must carry enough evidence to later
re-find the relevant bytes, not just a screenshot crop.

Allowed knowledge writes:

- artifact: screenshot crop or frame reference;
- entity: named visual object, e.g. `Maniac Mansion title logo`;
- relation: visual entity uses memory refs / appears at cycle / belongs to media;
- finding: if the user marks a bug or visual mismatch.

## 9. Acceptance

- Pausing at BASIC `READY.` and hovering a text character returns exact
  `text-cell`, screen RAM, color RAM, and charset refs.
- Pausing on a sprite scene returns sprite boxes and pointer/data refs for
  enabled sprites.
- Selecting a title logo region creates a knowledge artifact with VIC context
  and memory refs.
- Inspect calls do not advance CPU cycles, raster position, CIA timers, or
  drive state.
- Resume hides inspect overlays and the machine continues through the Spec 701
  controller.
