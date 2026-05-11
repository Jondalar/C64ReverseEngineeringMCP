# Visual Runtime Notes (Sprint 106 / Specs 117-121) — v1

Sprint 106 wraps the visual-side V1 contract: framebuffer
descriptor, VIC timing baseline, screen-state JSON, input macros,
visual acceptance.

## v1 status

| Spec | Status     | Where                                                          |
|------|------------|----------------------------------------------------------------|
| 117 M4.1 framebuffer API | **Covered** | `session.renderDescriptor()` — { width, height, mode, ranges } |
| 118 M4.2 VIC timing baseline | **Doc-only** | This file lists guarantees + gaps; tests live with Spec 105 |
| 119 M4.3 screen-state query | **Covered** | `screen-state.ts:captureScreenState()` — text grid, color grid, sprites, hash |
| 120 M4.4 input macros | **Covered** | scenario-player extended with `joystickScript` composite |
| 121 M4.5 visual acceptance | **Covered** | `visual-acceptance.ts:assertVisualState()` — hash-primary, snippet fallback |

`npm run smoke:visual-runtime` — 18/18 pass.

## VIC timing baseline (Spec 118)

Documented guarantees:

- **Raster counter**: ticks per CPU cycle on the cycle-lockstep
  scheduler. PAL: 312 lines × 63 cyc/line = 19656 cyc/frame.
  NTSC: 263 lines × 65 cyc/line = 17095 cyc/frame.
- **Bad-line cycle stealing**: not modeled per-cycle. Approximated
  in scheduler. v2 needs RDY pin tie-in (Spec 105 v2 follow-up).
- **Sprite DMA**: not cycle-stealing-modeled.
- **IRQ delivery jitter**: ≤ 7 cycles target — currently variable
  depending on scheduler granularity. Documented as v2 work.
- **Border state**: `fillBorderPerScanline` honours per-scanline
  `$D020` snapshots (Sprint 86 + Spec 105 v1).
- **Mid-frame register writes**: per-char-row dispatch (Spec 105 v1).
  Sub-char-row mid-cell mode toggles (FLI-style) deferred to v2.
- **PAL vs NTSC**: `maxRasterLine`/`cyclesPerLine` differ; profile
  selection via `vic.setNtsc()`.

These are the lines drawn by V1; everything beyond becomes V2 work.

## Screen-state shape (Spec 119)

```ts
{
  textGrid: string[],          // 25 rows × 40 chars (PETSCII)
  colorGrid: number[][],       // 25 × 40 low-nibble color RAM
  sprites: SpriteState[8],     // pos, active, color, flags
  bitmapHash?: string,         // FNV-1a of 8000-byte bitmap when in BMM
  vicMode: "text" | "multicolor-text" | "ecm-text" | "bitmap" | "multicolor-bitmap",
  vicBank: 0..3,
  borderColor: 0..15,
  bgColor: 0..15,
  rasterLine: number
}
```

PETSCII decoding: simple uppercase-letters + digits + common
punctuation map. Graphics chars render as `?` placeholders.

## Input macros (Spec 120)

Existing scenario-player (Spec 107) extended with `joystickScript`:

```ts
{
  atFrame: 60,
  kind: "joystickScript",
  port: 2,
  sequence: [
    { state: { up: true },              durationFrames: 30 },
    { state: { up: false, fire: true }, durationFrames: 5 },
    { state: { fire: false },           durationFrames: 1 },
  ]
}
```

Inline replay during `tick()` — sequence runs immediately,
session.runFor advanced per durationFrames. Other steps stay
schedule-driven.

YAML scenario format still deferred (Spec 124 / M5.4 absorbs).

## Visual acceptance (Spec 121)

Compare current screen state against a stored fixture:

```ts
const fixture = loadVisualFixture("mm", "title");  // null if not present
if (fixture) {
  const r = assertVisualState(session, fixture);
  if (!r.pass) console.error(r.reason);
}
```

Hash primary: `screenStateHash` = FNV-1a over textGrid + colorGrid +
sprite-state + (optional) bitmapHash + colors + bank.

Soft-fail: when hash mismatches but `textSnippet` matches, treat as
soft-pass (rendering may differ slightly cross-machine; text content
tells you the boot phase is right).

Hard-fail: hash + snippet both mismatch.

Fixture format `samples/visual-acceptance/<game>/<phase>.json`:

```json
{
  "game": "mm",
  "phase": "title",
  "stateHash": "abc12345",
  "textSnippet": "MANIAC",
  "vicMode": "multicolor-text",
  "pngPath": "title.png"
}
```

PNG path optional — V1 doesn't compare pixels (cross-machine
flakiness); v2 may add tolerance-based PNG diff.

## Files

- `src/runtime/headless/c64/screen-state.ts`
- `src/runtime/headless/regress/visual-acceptance.ts`
- `src/runtime/headless/integrated-session.ts` — `renderDescriptor()`
- `src/runtime/headless/input/scenario-player.ts` — `joystickScript`
- `src/runtime/headless/c64/visual-runtime-tests.ts` — 4 suites, 18 checks
- `scripts/smoke-visual-runtime.mjs` + `npm run smoke:visual-runtime`
