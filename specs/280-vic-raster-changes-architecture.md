# Spec 280 — VIC-II raster_changes architecture (1:1 VICE)

**Sprint:** 143 (V3.1 critical fix)
**Status:** PROPOSED 2026-05-09 — for review
**Replaces:** Spec 262 Phase B-E approach (= per-pixel renderer using
per-line snapshots — confirmed broken for raster-IRQ split-screens)
**Depends on:** Spec 262 Phase A (per-cycle reg-write log infra
already shipped, will be reused)

## Goal

Mirror VICE's `raster_changes` queue + `raster_line_emulate`
architecture. Replace our per-line snapshot model with cycle-precise
event queues consumed by a per-line renderer. Result: 1:1 VICE
pixel-equal output for **all** mid-line register effects (motm
ingame split-screen, FLI, NUFLI, sprite multiplexing, open border,
FLD).

## VICE architecture (source-derived)

### Files

```
/Users/alex/Development/C64/Tools/vice/vice/src/raster/
  raster-changes.h      ← queue types + inline add helpers
  raster-changes.c      ← apply + clear logic
  raster-line.c         ← raster_line_emulate (per-line driver)
  raster-modes.c        ← mode dispatch (text / bitmap / mc)

/Users/alex/Development/C64/Tools/vice/vice/src/vicii/
  vicii-mem.c           ← register store handlers — emit changes
  vicii-draw.c          ← per-line draw functions (text/bitmap/mc)
  vicii-fetch.c         ← matrix/bitmap DMA fetch (badline-aware)
  vicii-sprites.c       ← sprite render pass
  vicii.c               ← main loop
```

### Core data structure (raster-changes.h)

```c
struct raster_changes_action_s {
    int where;                  /* pixel position OR char position */
    raster_changes_type_t type; /* INT or PTR */
    union {
        { int *oldp; int newone; } integer;
        { void **oldp; void *newone; } ptr;
    } value;
};

struct raster_changes_s {
    unsigned int count;
    raster_changes_action_t actions[RASTER_CHANGES_MAX = 1024];
};

struct raster_changes_all_s {
    raster_changes_t *background;   /* bg/border-bg color, xsmooth */
    raster_changes_t *foreground;   /* matrix/chargen change at char pos */
    raster_changes_t *border;       /* border on/off, color */
    raster_changes_t *sprites;      /* sprite x/y/color/enable */
    raster_changes_t *next_line;    /* deferred to start-of-next-line */
    int have_on_this_line;          /* short-circuit when no changes */
};
```

### Register store pattern (vicii-mem.c)

Every reg store decides cycle-by-cycle whether to:
- apply immediately (= effect happens before next pixel emission this cycle)
- enqueue into appropriate `raster_changes_*` for current line
- enqueue into `next_line` for start-of-next-line application

Example (d016 CSEL — 38/40 column toggle):
```c
if (cycle <= 17) {
    raster->display_xstart = VICII_40COL_START_PIXEL;  // immediate
} else {
    raster_changes_next_line_add_int(raster,
        &raster->display_xstart, VICII_40COL_START_PIXEL);  // defer
}
```

Example (d018 — chargen/screen base):
```c
raster_changes_next_line_add_int(raster,
    &raster->video_mode_ptr, new_value);
```

(d018 changes apply at start of next line because the badline DMA
fetch is what reads d018, and that happens cycles 12..54 of bad
lines.)

Example (d020-d023 — colors mid-line):
```c
raster_changes_background_add_int(raster, x_pos,
    &raster->xsmooth_color, new_color);
```

### Render pattern (raster-line.c handle_visible_line_with_changes)

```c
for (xs = 0, i = 0; i < changes->background->count; i++) {
    int xe = changes->background->actions[i].where;
    if (xs < xe) {
        raster_modes_draw_background(modes, mode, xs, xe - 1);
        xs = xe;
    }
    raster_changes_apply(changes->background, i);   // apply change
}
// draw remainder
raster_modes_draw_background(modes, mode, xs, screen_width - 1);
```

So for each line: walk the change queue in `where` order, draw
pixels between consecutive change points, apply the change, repeat.

After the line is drawn, `raster_changes_apply_all(next_line)`
flushes deferred changes for next line, queues are cleared.

## Our mapping

We already have (Spec 262 Phase A):
- `vic.frameLineLogs[lineIndex].writes[]` = `{ cycleInLine, reg, value }`
  per cycle per line. **This IS our raster_changes queue**, just
  not split by category.

What we need:

1. **Categorize writes** at append time into background/foreground/
   border/sprites/next_line lanes mirroring VICE.
2. **Per-line renderer** that consumes lane queues in `where`
   (cycle-in-line → pixel position) order.
3. **Cycle→pixel mapping**: each VIC cycle = 8 pixels. Cycle 12 of
   bad-line = first display char fetched. Pixel position = (cycle -
   12) × 8 + xsmooth offset.

## Implementation plan (sub-sprints)

### 280a: raster_changes lane infrastructure

`src/runtime/headless/vic/raster-changes.ts`:
```ts
export interface RasterChangeAction {
  where: number;         // pixel x OR char x within line
  reg: number;
  value: number;
  /** Snapshot of the field-level effect to apply (e.g. bgColor). */
  field: "d011" | "d016" | "d018" | "d020" | ...;
}

export interface RasterChangesPerLine {
  background: RasterChangeAction[];
  foreground: RasterChangeAction[];
  border: RasterChangeAction[];
  sprites: RasterChangeAction[];
  nextLine: RasterChangeAction[];  // applied at start of next line
  haveOnThisLine: boolean;
}
```

VicIIVice gains `currentLineChanges: RasterChangesPerLine` +
`frameChanges: RasterChangesPerLine[312]`. On reg store, classify
the write per VICE rules (read vicii-mem.c case-by-case to
mirror) and append to correct lane.

### 280b: cycle-to-pixel mapping helper

Per VICE: `VICII_RASTER_X(cycle) = (cycle - 17) * 8` (PAL standard
HBLANK). Verify with vicii.c constant.

### 280c: per-line renderer rewrite

`src/runtime/headless/peripherals/vic-renderer-rasterized.ts`
(NEW). Replace per-pixel and per-char-row paths.

For each visible line (raster_y in display range):
1. Apply nextLine queue from previous line (= now-current effective
   state)
2. Walk background queue: draw bg from xs to action.where, apply
3. Walk foreground queue: draw text/bitmap chars at char position
4. Walk sprite queue: update sprite pos/color/enable mid-line
5. Walk border queue: open/close border per pixel
6. Result: full line drawn into framebuffer

### 280d: sprite render with multiplexing

Per-line sprite pass, queue applied:
- For each sprite 0..7: if enabled at this line, fetch sprite-data
  pointer (= last byte of screen RAM + sprite index), read sprite
  bytes from VIC bank
- Draw sprite at current x/y (= state at this scanline from queue)
- Collision detection per pixel: track sprite-fg vs char-fg, set
  $D01E/$D01F bits

### 280e: badline DMA fetch (matrix + bitmap)

Bad-line cycles 12-54 fetch from screen RAM (= matrix) + chargen/
bitmap. Per VICE vicii-fetch.c. Latch screen-row + chargen-row at
bad-line entry.

### 280f: legacy renderer removal

OQ1 RESOLVED → DELETE per-char-row + per-pixel renderers entirely
once vice-rasterized passes acceptance. Single-source-of-truth.
Smoke tests get ported (vic-fidelity, visual-runtime, vic-cycle-log,
vic-pixel-perfect → consolidated into vic-rasterized smoke).

### 280g: per-cycle bus-stealing scheduler integration (OQ3) — SHIPPED 2026-05-09

Mirror vice/src/vicii/vicii-cycle.c + vicii-fetch.c per-cycle bus
owner table. Each PAL line cycle 0..62 marked CPU or VIC. VIC
steals: badline matrix fetch (cycles 11-54), sprite DMA fetch (3
cycles per active sprite at sprite Y match, cycles 58-15 wrap).

Scheduler change: c64 CPU step checks bus-owner for current cycle.
If VIC, advance master clock 1 cycle without CPU work. Drive lockstep
stays — drive sees real master clock progress.

Acceptance for 280g: bus-stealing-precision smoke (synthetic — set
sprite enable + verify CPU cycle count drops by exactly N per
sprite). Cycle-exact demos (= Krestage 3 if vendored, otherwise FLI
test from samples/vice-testprogs).

## Acceptance

1. **motm ingame**: render at cycle 90M (= "select game" screen)
   matches VICE byte-equal:
   - Top bitmap (steamboat) visible
   - Bottom text menu visible
   - Hand sprite at correct position, no flicker
2. **MM character select** screen renders correctly
3. **IM2 ingame** (= split-screen warehouse + status panel)
   renders correctly
4. **FLI demo** (synthetic test): each line different chargen
5. **Sprite multiplexer** (synthetic): 16+ sprites per frame
6. **Open border** demo: top/bottom border opened
7. **All existing smoke** stays green: vic-fidelity, visual-runtime,
   vic-cycle-log, e2e-integration
8. **CIA fidelity** stays green (no change to CIA path)

## Out of scope

- Sub-cycle-precision pixel effects (= Krestage-3 demo level —
  defer to V3.2)
- PAL composite analog filter (cosmetic, V3.2)
- VICE cache_enabled fast-path optimization (= correctness first)

## Open questions for review

- **OQ1 [RESOLVED 2026-05-09]:** DELETE per-char-row + per-pixel.
  Forward-only. vice-rasterized = single renderer. Legacy egal.
  Smoke tests get ported or dropped.
- **OQ2 [RESOLVED 2026-05-09]:** Mirror VICE — nextLine queue carries
  across frame wrap. Applied at start of line 0 next frame. Per-frame
  `frameChanges[312]` arrays cleared on wrap; nextLine queue NOT
  cleared until applied.
- **OQ3 [RESOLVED 2026-05-09]:** Per-cycle bus stealing — 1:1 VICE.
  Sprite DMA cycles + badline matrix fetch + sprite-pointer fetch
  all cycle-precise. Scheduler integration: when VIC steals cycle X
  of line Y, c64 CPU stalls that cycle. Drive-cpu lockstep stays
  consistent (= drive sees real c64-clock progress, just CPU doesn't
  advance during stall).
  Adds scope to 280: sub-spec 280g (NEW) — bus-stealing scheduler
  integration. Reads vice/src/vicii/vicii-cycle.c + vicii-fetch.c
  for cycle-by-cycle bus owner table.
- **OQ4 [RESOLVED 2026-05-09]:** Atomic flip gate — minimal 3
  criteria:
  1. **LNR** ingame renders pixel-equal vs VICE
  2. **MotM** ingame split-screen renders pixel-equal
  3. **MM** character-select renders pixel-equal
  When all 3 pass → atomic commit: delete legacy renderers, no
  flag, vice-rasterized = only path. Forward from there with more
  demos/images/games as regression corpus grows.
- **OQ5 [RESOLVED 2026-05-09]:** DEFER V3.2. Pure perf optimization
  — pixel output identical to non-cached path. Cache invalidation
  complexity not worth it until we hit perf wall. M1 handles
  ~7.85M pixel-emits/sec easily; uncached fine for V3.1.

## References to study before impl

1. `vice/src/raster/raster-changes.h` — queue types + inline adders
2. `vice/src/raster/raster-line.c handle_visible_line_with_changes`
   (line 449+)
3. `vice/src/vicii/vicii-mem.c` — every reg store handler (= which
   lane each reg goes to, and which cycle-conditions apply
   immediately vs deferred). **Most labor-intensive read** — every
   reg has its own rules.
4. `vice/src/vicii/vicii-draw.c draw_std_text/draw_std_bitmap` —
   per-line pixel emission inner loop
5. `vice/src/vicii/vicii-fetch.c fetch_matrix` — bad-line DMA
6. `vice/src/vicii/vicii-sprites.c` — sprite render + collision

## Effort estimate

5-7 days focused work. Largest part = vicii-mem.c port (each reg
case-by-case mirror). Renderer itself is ~300 LOC straightforward
queue-walk.
