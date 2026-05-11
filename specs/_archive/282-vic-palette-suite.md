# Spec 282 — VIC-II palette suite (Pepto + per-revision + Colodore)

**Sprint:** 144 (V3.1 VICE-parity series)
**Status:** RESOLVED 2026-05-09 — OQs answered, ready to implement
**Depends on:** —
**Sister specs:** 281 (border geometry), 283..292 (full VICE parity series)

## Goal

100% palette parity with VICE: ship the same set of palette
variants VICE 3.7.1 supports, default to the same one VICE
defaults to (= measured-from-real-hardware 6569r3 / 8565r2).
Allow runtime selection per session.

## Why

Gap #4 in the parity audit. We currently hardcode ONE palette
(Colodore). VICE ships 6+ measured-from-real-hardware palettes
(per chip revision: 6567r56a, 6567r8, 6569r1, 6569r3, 8565r2,
plus computed Pepto/Colodore). For pixel-equal frame diffing
against VICE traces (Spec 205-B baselines), our palette must
match VICE's default exactly. Today our Colodore differs from
VICE's measured 6569r3 default by ±5% per channel — visible in
side-by-side comparisons.

## VICE source (canonical reference)

### Files

```
/Users/alex/Development/C64/Tools/vice/vice/src/vicii/
  vicii-color.c    ← all palette tables + selection logic
  vicii-color.h    ← header
```

### Palettes available (vicii-color.c lines 178-575)

| Name           | Source              | Use case          |
|----------------|---------------------|-------------------|
| `vicii_colors_old`     | Very old VIC-II (less luma) | legacy        |
| `vicii_colors`         | Pepto / Colodore (computed) | classic       |
| `vicii_colors_6567r56a`| Tobias-measured NTSC old    | NTSC ancient  |
| `vicii_colors_6567r8`  | Tobias-measured NTSC        | NTSC standard |
| `vicii_colors_6569r1`  | Tobias-measured PAL old     | PAL early     |
| `vicii_colors_6569r3`  | Tobias-measured PAL         | PAL standard ★|
| `vicii_colors_6569r5`  | Tobias-measured PAL r5      | PAL revision  |
| `vicii_colors_8565r2`  | Tobias-measured PAL HMOS    | PAL HMOS      |

★ = VICE default for PAL machines (= our default).

### Computed-vs-measured

VICE has **two compile-time modes**:
- `PEPTO_COLORS` / `COLODORE_COLORS`: compute palette from chroma
  angles + saturation (math only). Each chip revision uses
  `vicii_palette` (one synthetic palette).
- `TOBIAS_COLORS` (default in VICE 3.7.1): use measured-from-real-
  hardware tables. Each chip revision has its own table.

### Odd/even line variant

VICE has optional `SEPERATE_ODD_EVEN_COLORS` (default on for
TOBIAS_COLORS — vicii-color.c line 367+) which provides per-chip
`{name}_even` and `{name}_odd` 16-color tables. The video subsystem
chooses which based on raster Y. Visual effect: subtle scanline
chroma ripple, mostly invisible on modern LCD.

### Selection logic (vicii_color_update_palette, line 593)

```c
sync = MachineVideoStandard;  // PAL / NTSC / NTSCOLD / PALN
model = ...;                   // derived from sync + machine_class
switch (model) {
  case 6567R56A: cp = &vicii_palette_6567r56a; break;
  case 6567:     cp = &vicii_palette_6567r8;   break;
  case 6569R1:   cp = &vicii_palette_6569r1;   break;
  case 6569:     cp = &vicii_palette_6569r3;   break;  // ★ DEFAULT PAL
  case 8565:     cp = &vicii_palette_8565r2;   break;  // C128 PAL
  case 8562:     cp = &vicii_palette_8565r2;   break;  // C128 NTSC
}
```

## Our current state

### Where we are wrong

```ts
// src/runtime/headless/peripherals/vic-renderer.ts:42
// Single hardcoded Colodore palette. Loosely matches VICE's
// PEPTO/COLODORE compile-time variant, NOT the measured TOBIAS
// 6569r3 default that VICE 3.7.1 ships with.
export const VIC_PALETTE: ReadonlyArray<[number, number, number]> = [
  [0x00, 0x00, 0x00], // 0  black
  [0xff, 0xff, 0xff], // 1  white
  // ... 14 more
];
```

### What's missing

- 6 additional palette tables (6567r56a, 6567r8, 6569r1, 6569r3,
  6569r5, 8565r2)
- Pepto-computed variant (existing Colodore is similar but not
  identical to VICE Pepto)
- Per-revision selection at session creation time
- Odd/even line variants (Spec 288 covers this — palette suite
  here just exposes the data; renderer integration in 288)

## Plan

### Phase 282a — Palette table port

New file `src/runtime/headless/vic/palettes.ts`:

```ts
export type RGB = readonly [number, number, number];
export type Palette16 = ReadonlyArray<RGB>;  // length 16

export const PALETTES: Record<string, Palette16> = {
  "pepto":      PEPTO_TABLE,        // VICE Pepto-computed (legacy)
  "colodore":   COLODORE_TABLE,     // VICE COLODORE-computed
  "6567r56a":   T_6567R56A_TABLE,   // Tobias NTSC ancient
  "6567r8":     T_6567R8_TABLE,     // Tobias NTSC standard
  "6569r1":     T_6569R1_TABLE,     // Tobias PAL old
  "6569r3":     T_6569R3_TABLE,     // Tobias PAL standard (DEFAULT)
  "6569r5":     T_6569R5_TABLE,     // Tobias PAL r5
  "8565r2":     T_8565R2_TABLE,     // Tobias PAL HMOS (C128)
};

export const DEFAULT_PALETTE_KEY = "colodore";  // OQ1 = (b)
export type PaletteKey = keyof typeof PALETTES;
```

Each table direct-port from vicii-color.c lines 178+ / 245+ /
265+ / etc. Float-to-byte conversion verified against VICE's
`video_color_palette_internal` to handle gamma / brightness /
contrast (set to neutral in VICE default).

### Phase 282b — Per-session palette selection

Add to `IntegratedSessionOptions`:

```ts
palette?: PaletteKey;  // default: "6569r3"
```

Pipe into `IntegratedSession.palette` (= active palette ref),
default `PALETTES[DEFAULT_PALETTE_KEY]`. Passed into renderer
context.

### Phase 282c — Renderer wire-up

Replace static `VIC_PALETTE` import in renderer files with
`session.palette`. Each render call uses the session-bound
palette, not the global. Removes the hardcoded import in
`vic-renderer.ts`, `vic-renderer-rasterized.ts`,
`sprite-render.ts`.

### Phase 282d — Tests

1. **Palette identity smoke** (`scripts/smoke-palettes.mjs`):
   - For each palette key, dump 16-RGB array
   - Compare bytes to known VICE output (extracted from VICE
     dump or hardcoded reference values)
   - PASS if 16/16 colors match within ±0 (exact byte equal)

2. **Default-frame diff vs VICE baseline**:
   - Render BASIC ready frame with `palette: "6569r3"`
   - Compare against pre-captured VICE PNG (= same palette)
   - PASS if pixel-exact match for default `D020/D021` colors

3. **Regression**: existing Spec 281 static-border baseline must
   be re-captured with new default palette. (Old baseline used
   our Colodore.)

## Open Questions — RESOLVED

### OQ1 — Default palette  ✅ (b) Colodore

VICE 3.7.1 default = Tobias-measured `6569r3` (PAL standard chip).
Today we ship a Colodore-style palette. Switching default:
- (a) Match VICE: default `6569r3`
- (b) Keep Colodore as default (= modern, brighter)
- (c) Default `pepto` (= computed Pepto, classic look)

If (a): existing Spec 281 baselines + any frame diff against
prior renders will FAIL on first run after switch (= one-time
breakage, then stable).

**Resolved:** (b) — Colodore stays default. All VICE measured
palettes (6567r56a, 6567r8, 6569r1, 6569r3, 6569r5, 8565r2) +
Pepto-computed are exposed as opt-in selectables for VICE-diff
regression testing. Default user view = brighter modern look;
parity tests use `palette: "6569r3"` opt-in.

Implication: existing Spec 281 baselines remain valid (no
re-capture). VICE pixel-diff requires explicit palette opt-in.

### OQ2 — Pepto palette source  ✅ (a) embed pre-computed

The "Pepto" palette in VICE is COMPUTED at compile time from
chroma angles. We could either:
- (a) Pre-compute the Pepto table once and embed as a static
  16-RGB array (same approach as Tobias measured tables)
- (b) Implement the chroma-angle computation in TypeScript so
  users can tweak saturation/phase

**Resolved:** (a) — pre-compute Pepto once and embed as static
16-RGB table. Mirrors Tobias-table approach. Renderer-config
saturation/phase tweaking deferred (out of parity scope).

### OQ3 — Odd/even line palette split  ✅ (b) all in Spec 288

Spec 288 covers full odd/even split (= per-line palette
alternation). In Spec 282 we only ship the DATA tables (= each
palette has optional `_even` and `_odd` 16-RGB arrays). Renderer
consumes single (not split) palette by default; per-line split
left to 288.

- (a) Ship even/odd data now, leave renderer single-table until 288
- (b) Skip even/odd data here; add in Spec 288

**Resolved:** (b) — Spec 282 ships only single-table palettes. Spec
288 adds both even/odd data tables AND renderer per-line
alternation as one cohesive change.

### OQ4 — User-facing toggle  ✅ (a) session option only

Where to expose palette selection?
- (a) Session option only (programmatic): `palette: "6569r3"` in
  startIntegratedSession opts
- (b) Session option + UI control (V3 Live tab dropdown)
- (c) Session option + MCP tool (`runtime_set_palette`)

UI wait per "UI machen wir wenn VICE + Render passt". MCP tool
optional convenience.

**Resolved:** (a) — session option only. UI control + MCP tool
deferred to V3.1 backlog.

### OQ5 — Test corpus for gate  ✅ (a) + (b)

What proves palette parity?
- (a) Per-color byte-exact comparison against extracted VICE
  output (programmatic — 16 RGB triples per palette)
- (b) Frame-diff against VICE-rendered PNG of BASIC ready
- (c) Frame-diff against VICE-rendered PNG of motm title (in-game)
- (d) all of the above

**Resolved:** (a) + (b).
- (a) Per-color byte-exact comparison: each of 6+ palettes ships
  16-RGB triple; smoke compares vs hardcoded VICE reference
  values (extracted from VICE 3.7.1 vicii-color.c).
- (b) Frame-diff vs VICE-rendered PNG of BASIC ready (using
  `palette: "6569r3"` opt-in).
- (c) In-game motm/MM/LNR title diff deferred to parity-suite
  follow-up spec.

## Acceptance criteria (gate)

- [ ] All 16 colors of every shipped palette match VICE byte-exact
- [ ] 6+ palettes ship as named tables: `colodore` (default),
  `pepto`, `6567r56a`, `6567r8`, `6569r1`, `6569r3`, `6569r5`,
  `8565r2`
- [ ] `IntegratedSessionOptions.palette` works; default = `colodore`
- [ ] BASIC ready frame pixel-exact vs VICE PNG when invoked with
  `palette: "6569r3"` opt-in
- [ ] Spec 281 static-border baselines remain valid (no re-capture
  needed since default unchanged)

## Files touched

- `src/runtime/headless/vic/palettes.ts` — new (palette suite +
  selection)
- `src/runtime/headless/peripherals/vic-renderer.ts` — remove
  hardcoded VIC_PALETTE export, add re-export from palettes.ts
  for back-compat
- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts` —
  use session.palette (passed via render ctx)
- `src/runtime/headless/vic/sprite-render.ts` — use ctx palette
- `src/runtime/headless/integrated-session.ts` — add `palette`
  option, propagate to render calls
- `scripts/smoke-palettes.mjs` — new (per-color byte-equal vs VICE)
- `samples/baselines/vic-static-border-281/` — regenerated with
  new default
