# Spec 298 — Literal VICE x64sc port (no abstractions)

**Sprint:** 147  **Status:** OPEN 2026-05-09  **Depends:** none (supersedes 297)

## Goal

Spec 297 shipped 13 sub-specs of "VICE-inspired" cycle-pumped
rendering. End-to-end test (= cycle-pumped renderer in real session)
proved the design DRIFTED from VICE despite synthetic smokes
passing. Root cause: I translated VICE source into "TS-idiomatic"
abstractions instead of porting it literally.

This spec establishes a **strict literal port** mandate for all VIC
chip code:

  - **Same file shape**: one TS module per VICE C file
    (`vicii-cycle.ts` ↔ `vicii-cycle.c`, etc.)
  - **Same function names** (snake_case preserved):
    `vicii_cycle()`, `fetch_phi1()`, `draw_graphics()`, etc.
  - **Same struct fields** (snake_case preserved):
    `vicii.raster_cycle`, `vicii.gbuf_pipe0_reg`, `vicii.vbuf[]`,
    `vicii.cbuf[]`, `vicii.vmli`, etc.
  - **Same control flow** (no refactoring):
    if-else chains in same order, switch dispatches in same order,
    loops with same iteration counts.
  - **Same magic numbers** (named with VICE's defines):
    `VICII_FETCH_CYCLE`, `VICII_RASTER_X(c)`, `VICII_BAD_LINE_START`,
    etc.
  - **Same comments** carried over (= VICE's `/* … */` becomes TS
    `// …`).

**Refactoring is FORBIDDEN until literal port passes gold-master
diff against VICE x64sc.** User has explicitly promised refactoring
afterward.

## Out of scope (= forbidden until 298 closes)

- Helper functions invented for "cleaner" TS API
- Renaming for "TS-idiomatic" style
- Inlining or extraction beyond what VICE does
- "Better" struct layouts
- Per-cycle phase splitting that VICE doesn't have
- Module boundaries that don't match VICE files

## In scope

  - viciisc/vicii-cycle.{c,h}        → src/runtime/headless/vic/literal/vicii-cycle.ts
  - viciisc/vicii-fetch.{c,h}        → vicii-fetch.ts
  - viciisc/vicii-draw-cycle.{c,h}   → vicii-draw-cycle.ts
  - viciisc/vicii-sprites.{c,h}      → vicii-sprites.ts
  - viciisc/vicii-mem.{c,h}          → vicii-mem.ts
  - viciisc/vicii-irq.{c,h}          → vicii-irq.ts
  - viciisc/vicii-chip-model.{c,h}   → vicii-chip-model.ts (= cycle_tab_pal already in 296a-2; reformat to literal layout)
  - viciisc/viciitypes.h             → vicii-types.ts (= struct vicii_t)
  - viciisc/vicii.{c,h} (init/reset) → vicii.ts

Drop-in replacement: existing VicIIVice + cycle-pumped-renderer +
sprite-cycle + border-state + display-pipe + cycle-pixel-composite
move to `src/runtime/headless/vic/legacy/` and stay only as
historical reference. New `vicii.ts` module exposes the equivalent
of VICE's `vicii_cycle()` per-cycle entry, called by the scheduler.

## Sub-spec backlog (literal port order)

### 298a — vicii-types.ts (struct vicii_t literal)

Port the `vicii_t` struct from viciitypes.h. Every field, in same
order, same C type → TS type:
  - `int` → `number`
  - `uint8_t *` → `Uint8Array`
  - `uint8_t buffer[N]` → `Uint8Array(N)`
  - `unsigned int` → `number`
  - struct fields nested → object type with same field names

Comments above each field carried over.

Acceptance: file compiles; all fields VICE has are present; no
extras.

### 298b — vicii-chip-model.ts (cycle_tab_pal literal)

Port `cycle_tab_pal[]` and the cycle_get_*/cycle_is_* inline helpers
from vicii-chip-model.{c,h}. Use exact bit-flag encoding (= the
VICE flag word, not my decoded struct).

Acceptance: cycle_get_xpos / cycle_is_fetch_g / etc. return exact
same values as VICE for cycles 1..63.

### 298c — vicii-fetch.ts (fetch primitives literal)

Port `fetch_phi1()`, `vicii_fetch_idle()`, `vicii_fetch_idle_gfx()`,
`vicii_fetch_graphics()`, `vicii_fetch_matrix()`,
`vicii_fetch_sprite_pointer()`, `vicii_fetch_sprite_dma()`. Exact
function names + signatures + side effects (= writes to
`vicii.gbuf` etc.).

Acceptance: each function signature matches VICE; produces same
return values + same vicii_t mutations for hand-authored inputs.

### 298d — vicii-draw-cycle.ts (per-pixel emit literal)

Port `vicii_draw_cycle()`, `draw_graphics()`, `draw_graphics8()`,
`draw_border8()`, `draw_idle8()`. Pipe register declarations
literal. Per-pixel inner loop literal. mc_flop semantics literal.

Acceptance: given identical vicii_t state, draw_graphics8 emits
same 8 pixels as VICE.

### 298e — vicii-sprites.ts (sprite engine literal)

Port sprite cycle handling, `sprite_dma_check`, `sprite_advance_dma`,
`sprite_check_dma`, sprite display state machine.

### 298f — vicii-mem.ts ($D000-$D02E read/write literal)

Port `vicii_store()`, `vicii_read()`, `vicii_peek()`. Exact reg
write side effects per VICE (collision clears, IRQ flag clears,
etc.).

### 298g — vicii-irq.ts (IRQ raise/clear literal)

Port `vicii_irq_set_line()`, `vicii_irq_alarm_handler()`, etc.

### 298h — vicii-cycle.ts (main per-cycle pump literal)

The big one. Port `vicii_cycle()` as a single function with same
control flow:
  - Phi2 sprite fetch
  - Phi1 fetch dispatch via cycle_flags
  - draw_cycle() call
  - State machine checks (UpdateVc, UpdateRc, sprite checks, border
    checks)
  - bad line detection
  - VSP bug emulation (stub if needed)
  - line wrap + raster_y advance + frame wrap

Acceptance: vicii_cycle() can be invoked in a loop and produces
byte-identical pixel output to VICE x64sc for a fixed reset profile
+ N cycles.

### 298i — vicii.ts (init/reset/wiring literal)

Port `vicii_init()`, `vicii_reset()`, `vicii_powerup()`, etc. Hook
into existing C64Bus + memory mapper.

### 298j — Gold-master verification

Capture VICE x64sc PNG at known reset state + cycles. Run identical
through literal port. Pixel-diff. Must be IDENTICAL (= zero diff).

If not identical, fix the literal port (= read VICE source again,
find what I deviated, restore). Repeat until clean.

### 298k — Replace VicIIVice + retire abstractions

Once 298a-j gold-master green, the literal port becomes the chip
core. The VicIIVice + 297 modules + 296a backbone modules move to
`src/runtime/headless/vic/legacy/` for historical reference only.

WS server / renderToPng / scheduler all switch to call
`vicii_cycle()` directly.

### 298l — Refactoring (= AFTER all above land green)

Once gold-master clean, user has authorized refactoring. Goals:
  - Rename to TS-idiomatic where it doesn't risk drift
  - Extract helpers ONLY where they don't change semantics
  - Bundle related state into objects ONLY where field-by-field
    access is verified preserved
  - Add types, doc, smoke ergonomics

Each refactor commit must keep gold-master green.

## Workflow per sub-spec

1. Open VICE source file in editor. Side-by-side with new TS file.
2. Port function-by-function, line-by-line.
3. Carry comments verbatim.
4. NO renaming, NO restructuring.
5. Add minimal smoke = same input → same output as VICE. If smoke
   would require building VICE, place a TODO + open the gold-master
   capture spec instead.
6. Commit per sub-spec only.
7. Each commit message must say "literal port of viciisc/<file>.c
   lines N..M" + "no abstractions added".

## Anti-pattern checklist (block self-edits matching these)

- "Refactor" / "cleaner API" / "TS-idiomatic" → STOP
- New helper function name not in VICE → STOP
- Inlining / extracting beyond VICE → STOP
- Removing or renaming fields → STOP
- Removing comments → STOP
- Module file boundary that doesn't match VICE → STOP

## Acceptance

- [ ] All 9 viciisc files literally ported to TS modules
- [ ] Gold-master diff: VICE x64sc vs literal port = ZERO pixel
      difference for KERNAL READY screen + 1 PAL frame
- [ ] Gold-master diff for motm boot title screen = ZERO pixel diff
      OR documented residuals with VICE-source line numbers
- [ ] Existing 280-296 + 297 smokes either pass via literal port
      OR explicitly retired with rationale
- [ ] vice-rasterized renderer retired
- [ ] cycle-pumped-renderer.ts + sprite-cycle.ts + border-state.ts
      + display-pipe.ts + cycle-pixel-composite.ts moved to legacy/
