# Spec 262 — VIC pixel-perfect renderer (1:1 VICE)

**Sprint:** 136
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Depends on:** existing Phase 65d/e (vic-renderer.ts, vic-ii-vice.ts)

## Goal

Strict 1:1 VICE pixel-equal rendering. Per-cycle reg-write log
within each scanline. FLI + NUFLI + sprite multiplexing + open
border + FLD all supported via single mechanism.

## Architecture

**Per-cycle reg-write log replaces per-scanline snapshot.**

```ts
interface ScanlineRegLog {
  rasterLine: number;
  // Sequence of writes to any VIC reg ($D000-$D02E) + CIA2 PA bank
  // change during this line. Indexed by cycleInLine (0..62 PAL).
  writes: Array<{
    cycleInLine: number;
    reg: number;          // $D0xx offset 0-2E, OR special: $80=cia2_pa_bank
    value: number;
  }>;
}
```

VicIIVice maintains: `currentLineLog: ScanlineRegLog`, plus a
ring of completed lines per frame (= 312 entries, cleared at
raster_y=0 wrap).

## Renderer

Per-pixel iteration (ineffizient aber simpel + correct):

```
for line 0..311:
  state = previousLineEndState
  for cycle 0..62:
    apply pending writes from log at this cycle
    fetch screen/chargen/bitmap byte (cycle-precise bus access)
    render 8 pixels (= one bus cycle = 8 VIC dot-clock cycles)
    handle sprite-DMA bus stealing
    handle bad-line stalls
```

Optimizations (post-correctness):
- Memoize state transitions per line if no log entries
- SIMD-style pixel batch where state is stable

## Sub-spec breakdown

| ID | Topic |
|----|-------|
| 262a | Per-cycle reg-write log infrastructure |
| 262b | CIA2 PA bank tracking in log |
| 262c | renderToPng frame-boundary sync (wait for vic_frame_start) |
| 262d | Per-scanline rendering loop replacing per-char-row |
| 262e | Sprite multiplexing via per-cycle sprite-pos |
| 262f | FLI / NUFLI sub-char-row $D018 toggle |
| 262g | Sprite-bg + sprite-sprite collision flags 1:1 |
| 262h | $D016 X-scroll + $D011 Y-scroll per-cycle |
| 262i | Open border / FLD via per-cycle DEN/RSEL/CSEL |

## Acceptance

- motm/MM/IM2/LNR title screens: pixel-equal hash with VICE
  baseline screenshot
- FLI demo (e.g. "Total Eclipse" intro): pixel-equal
- NUFLI demo: pixel-equal
- Edge of Disgrace open-border scroller: pixel-equal
- Sprite multiplexer test (8+ sprites per frame): all sprites
  rendered correctly
- regression baseline (Spec 250) screenshot diff = 0 bytes
- Render time: ≤20ms per frame on M1 (= 50fps achievable)

## Out of scope

- VICE-equivalent at sub-cycle precision for cycle-exact demos
  that abuse VIC bus model in undocumented ways (= "Krestage 3"-
  level. Defer if found.)
- Pixel-color analog filter (PAL composite emulation) — V3.x

## Open implementation question

OQ-262-1: per-pixel render perf budget on M1 — if <20ms not
achievable, fallback to per-line state (= less precise but
acceptable). Decide after first prototype.
