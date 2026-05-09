# Spec 296 - VIC real-game stress corpus + x64sc parity bug register

**Sprint:** 145  **Status:** OPEN 2026-05-09  **Depends:** 280-295

## Goal

Specs 280-295 shipped many VIC features against synthetic smoke tests
(border, palette, BA/AEC, illegal modes, sprite quirks, IRQ FSM,
2-pass renderer, etc.). Real games now show visible combinations that
the smokes do not cover. This spec is the bug register and the cut line
for the next VIC work: every fix must be grounded against VICE x64sc,
not screenshots or guesses.

The target oracle is VICE C64SC (`x64sc`) PAL 6569 behavior first. Use
the C64SC source tree:

- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-fetch.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-draw-cycle.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-mem.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-chip-model.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-chip-model.h`

## VICE Findings

These are the relevant x64sc facts from the source review on 2026-05-09.

### Phi1 Fetch Is Not "Return $FF"

`vicii-cycle.c:130-163` dispatches one Phi1 fetch per VIC cycle:

- `FetchG` + display state: `vicii_fetch_graphics()`
- `FetchG` + idle state: `vicii_fetch_idle_gfx()`
- sprite pointer / sprite DMA / refresh fetches
- otherwise: `vicii_fetch_idle()`

`vicii-fetch.c:50-74` maps Phi1 addresses through VIC bank, char ROM
overlay, and Ultimax rules, then returns the real byte. `vicii_fetch_idle()`
reads `$3fff`. `vicii_fetch_idle_gfx()` reads `$3fff`, or `$39ff` when
ECM is active, and stores that byte into `vicii.gbuf`.

Therefore: do not implement "idle bus = $ff" as a blanket fix. `$ff`
appears in `vicii_fetch_matrix()` only for `prefetch_cycles`, where VICE
sets `vbuf[vmli] = 0xff`. Idle graphics fetch is a real Phi1 memory
fetch, not a constant.

### Display Uses A Two-Stage Pipe

`vicii-draw-cycle.c:65-86` has explicit pipe state:

- `gbuf_pipe0_reg`, `gbuf_pipe1_reg`, `gbuf_reg`
- `vbuf_pipe0_reg`, `vbuf_pipe1_reg`, `vbuf_reg`
- `cbuf_pipe0_reg`, `cbuf_pipe1_reg`, `cbuf_reg`
- `xscroll_pipe`, `vmode11_pipe`, `vmode16_pipe`, `vmode16_pipe2`

`draw_graphics()` loads new `gbuf/vbuf/cbuf` only when pixel offset
`i == xscroll_pipe`. `draw_graphics8()` then advances the two-stage pipe
and samples `$d016 & 7` into `xscroll_pipe` only when visible graphics
data enters pipe0. Mid-frame `$d016` behavior is therefore a pipeline
problem, not a simple "last register value wins for the current segment".

### Badline Matrix Data Is Latched

`vicii-cycle.c:594-602` calls `vicii_fetch_matrix()` on badline FetchC
cycles. `vicii-fetch.c:192-200` stores `vbuf[vmli]` and `cbuf[vmli]`.
Later drawing uses those buffered values through the pipe. CPU writes to
screen RAM after the matrix fetch must not alter already fetched cells.

### Collisions Are Pixel-Time Latches

`vicii-draw-cycle.c:342-430` computes sprite pixels per rendered pixel.
When any visible sprite pixel overlaps a foreground graphics pixel
(`pri_buffer[i] != 0`), VICE ORs that sprite mask into
`vicii.sprite_background_collisions` immediately. Sprite-sprite collision
is also ORed immediately when two or more sprite bits overlap.

`vicii-cycle.c:407-432` snapshots whether the latch was zero before draw,
draws the cycle, then raises the collision IRQ if the latch transitioned
from zero to non-zero. This is not a frame-end calculation.

`vicii-mem.c:537-558` reads `$d01f` by copying the latch into the register
and setting `clear_collisions = 0x1f`; `vicii-cycle.c:413-425` performs
the actual clear after the next draw cycle. Writes to `$d01e/$d01f` are
ignored.

## Bug Register

### Scramble Infinity (`.d64`)

| ID | Frame phase | Artifact | Suspected subsystem after VICE review |
|----|-------------|----------|---------------------------------------|
| 296-SI-1 | Title screen | INFINITY logo top-right = rainbow pixel scatter | Phi1 idle/graphics fetch and `gbuf` pipe parity. Specifically `$3fff/$39ff` real fetch plus display pipe, not constant `$ff`. |
| 296-SI-2 | Title screen | "infinity" background-text scattered noise | Same fetch/pipe path OR badline vbuf/cbuf latch race. |
| 296-SI-3 | Menu screen | Text glitches across frames (`got` -> `gatery` -> `gstery` -> `mystery`) | Matrix fetch latch timing: renderer must use fetched `vbuf/cbuf`, not live screen RAM after CPU writes. |
| 296-SI-4 | Gameplay | Raster splits visible but smearing | `$d016` / video-mode pipe timing, especially `xscroll_pipe` and mode latency. |
| 296-SI-5 | Gameplay | Sprite-bg collisions inactive; player walks through walls | `$d01f` latch/IRQ/read-clear is not VICE-time accurate; current renderer appears to OR collisions at frame end. |

### Impossible Mission II (`.d64`)

| ID | Frame phase | Artifact | Suspected subsystem |
|----|-------------|----------|---------------------|
| 296-IM2-1 | TBD: capture headless render | TBD | TBD after VICE/headless pair capture. |

### Last Ninja (`.d64`)

| ID | Frame phase | Artifact | Suspected subsystem |
|----|-------------|----------|---------------------|
| 296-LN-0 | Boot | Does not start at all | Not VIC. Loader/decompressor remains a separate spec. |

### Maniac Mansion / Murder on the Mississippi

Covered by the 1541/mount-swap work. Do not mix those drive/runtime bugs
into this VIC register unless a visual VIC regression is captured.

## Sub-Spec Backlog

### 296a - Cycle-Level Phi1 Fetch + Display Pipe

Implement the x64sc fetch/draw backbone for PAL 6569 first.

Required behavior:

- Port the `cycle_phi1_fetch()` dispatch shape from `viciisc/vicii-cycle.c`.
- Implement `fetchPhi1(addr)` with VIC bank + char ROM overlay parity.
- Implement `fetchIdle()` as real `$3fff` Phi1 read.
- Implement `fetchIdleGfx()` as real `$3fff` or ECM `$39ff` Phi1 read,
  and write the result to `gbuf`.
- Implement graphics fetch `g_fetch_addr()` behavior, including ECM
  `$39ff` mask and the 6569 char-ROM switch note in `vicii_fetch_graphics()`.
- Add `last_read_phi1` for monitor/trace parity.
- Add the draw-cycle pipe registers from `vicii-draw-cycle.c` and load
  `gbuf/vbuf/cbuf` only at `pixelOffset == xscroll_pipe`.

Acceptance:

- Synthetic test proves idle gfx fetch reads memory at `$3fff` and ECM
  reads `$39ff`, not `$ff`.
- Synthetic test proves changing `$d016` mid-line affects the same pixels
  as x64sc for at least one hand-authored raster line.
- Scramble Infinity title-logo scatter is reduced or moved to a narrower
  registered bug with a pixel diff.

### 296b - Badline Matrix Latch Parity

Fix the matrix data lifetime.

Required behavior:

- `vbuf/cbuf` are fetched on badline FetchC cycles and reused by drawing.
- CPU writes to screen RAM/color RAM after the fetch do not affect the
  current already fetched 8-pixel cell.
- `prefetch_cycles` matrix entries produce `vbuf = 0xff` and CBUF from
  the CPU PC low nibble, matching `vicii_fetch_matrix()`.
- `vmli`, `vc`, `vcbase`, `rc`, and `idle_state` transitions follow
  `vicii-cycle.c:541-563`.

Acceptance:

- A test writes screen RAM after the badline matrix fetch and verifies the
  current cell still renders from the old `vbuf`.
- Scramble Infinity menu text no longer mutates between plausible words
  because of live-RAM reads.

### 296c - Sprite Collision Latches + IRQ Timing

Move collisions from frame-end approximation to VICE pixel/cycle semantics.

Required behavior:

- During pixel draw, OR sprite-background mask when a non-transparent sprite
  pixel overlaps a foreground graphics pixel (`pri_buffer[i] != 0`).
- During pixel draw, OR sprite-sprite mask when two or more sprites overlap.
- If the relevant latch was zero before the draw cycle and becomes non-zero,
  raise the VICE collision IRQ source in that cycle.
- `$d01e/$d01f` reads return the latch and schedule clear through
  `clear_collisions`; do not clear immediately in the read method.
- Writes to `$d01e/$d01f` remain ignored.
- `peek`/debug reads must not clear.

Acceptance:

- Unit test for `$d01f` read: returned value is old latch; latch clears only
  on the following VIC cycle.
- Unit test for collision IRQ: IRQ raises when latch transitions zero ->
  non-zero, not repeatedly while already non-zero.
- Scramble Infinity gameplay collision polling sees wall collisions.

### 296d - `$d016` / Mode Latency Splits

Make raster splits use the same pipeline points as x64sc.

Required behavior:

- `xscroll_pipe = regs[$16] & 7` updates when visible `gbuf` enters pipe0.
- `vmode16_pipe` samples `$d016 & $10` at pixel 4 of the draw cycle.
- `vmode11_pipe` follows the 6569 color-latency branches in
  `draw_graphics8()`.
- Border/CSEL behavior follows the draw-cycle `draw_border8()` ordering.

Acceptance:

- Hand-authored raster split test with `$d016` writes at several cycles
  matches VICE pixel positions.
- Scramble Infinity gameplay split smear is either gone or narrowed to a
  registered residual bug.

### 296e - Real-Game Corpus Harness

Make the corpus useful for LLM and human debugging.

Required behavior:

- Capture pair per bug: identical input -> VICE x64sc PNG + headless PNG.
- Store under `samples/vic-corpus/<game>/<phase>/{vice,headless,diff}.png`.
- Add a small JSON sidecar with C64 PC, raster line/cycle, VIC register
  snapshot, and corpus command used to reproduce.
- Add an optional VIC event trace lane for fetch type, Phi1 addr/data,
  `gbuf/vbuf/cbuf`, `$d016`, `xscroll_pipe`, and collision latch changes.

Acceptance:

- CI can run the corpus and fail on pixel diff above a threshold.
- For each bug row, the sidecar names the sub-spec that owns the fix.

## Do Not Investigate In This Spec

- Do not patch game-specific pixels.
- Do not claim idle graphics fetch returns `$ff`; verify against
  `viciisc/vicii-fetch.c`.
- Do not mix 1541, mount-swap, CIA2 `$dd00`, or loader bugs into this spec.
- Do not treat Last Ninja boot failure as a VIC bug until a VIC frame diff
  proves it.
- Do not fix `$d016` by broad segment last-write-wins logic; x64sc uses the
  pipe timing above.

## Workflow Per Bug

1. Capture VICE/headless pair with identical media, model, seed, and input.
2. Pixel-diff the pair and crop the smallest stable artifact region.
3. Add the crop and sidecar to `samples/vic-corpus`.
4. Link the bug row to one focused sub-spec.
5. Implement against x64sc source parity plus a synthetic unit test.
6. Mark resolved only when the corpus diff closes or the residual is moved
   to a new bug row.

## Acceptance

- [ ] Bug register populated for at least three real games.
- [ ] Each bug has reproducible VICE/headless PNG pair and sidecar.
- [ ] Each fix has a sub-spec, a synthetic test, and corpus evidence.
- [ ] Scramble Infinity SI-1..SI-5 are resolved or narrowed with evidence.
- [ ] Collision reads/IRQs match x64sc timing, not frame-end approximation.
- [ ] CI corpus runs and reports pixel diff threshold failures.
