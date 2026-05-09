# Spec 296 — VIC real-game stress corpus + bug register

**Sprint:** 145  **Status:** OPEN 2026-05-09  **Depends:** 280-295

## Goal

Specs 280-295 ship VIC features against synthetic smoke tests
(border, palette, BA/AEC, illegal modes, sprite quirks, IRQ FSM,
2-pass renderer, etc.). Real games stress *combinations* of these
features that smoke tests don't reach. Visible bugs in UI
verification (2026-05-09) prove smokes-pass ≠ game-pass.

This spec opens a real-game bug register: per game, per artifact,
which VIC subsystem, fix-spec. Closes once every artifact in the
corpus renders byte-identical to VICE x64sc reference.

## Bug register (initial, from 2026-05-09 UI screenshots)

### Scramble Infinity (.d64)

| ID | Frame phase | Artifact | Suspected subsystem |
|----|-------------|----------|---------------------|
| 296-SI-1 | Title screen | INFINITY logo top-right = rainbow pixel scatter | VIC idle bus reads ($3FFF) — probable: phi1 idle-fetch returns RAM bytes instead of $FF |
| 296-SI-2 | Title screen | "infinity" background-text scattered noise | Same as -1 OR badline vbuf race |
| 296-SI-3 | Menu screen | Text glitches across frames ("got" → "gatery" → "gstery" → "mystery") | Char-fetch race: badline fetches happening while CPU writes screen RAM mid-row |
| 296-SI-4 | Gameplay | Raster splits visible but smearing | Mid-frame $D016 XSCROLL writes not cycle-exact |
| 296-SI-5 | Gameplay | Sprite-bg collisions inactive (player walks through walls) | $D01F sprite-bg latch not set (Spec 291 OQ4) |

### Impossible Mission II (.d64) — vice-reference 21.14.52

| ID | Frame phase | Artifact | Suspected subsystem |
|----|-------------|----------|---------------------|
| 296-IM2-1 | TBD: capture headless render | TBD | TBD |

### Last Ninja (.d64)

| ID | Frame phase | Artifact | Suspected subsystem |
|----|-------------|----------|---------------------|
| 296-LN-0 | Boot | Does NOT start at all | NOT VIC — loader/decompressor (separate spec) |

### Maniac Mansion / Murder on the Mississippi

| Already covered by Spec 81 + mount-swap fix (2026-05-09 commits 7bc3fa7 + e84b802) |

## Workflow per bug

1. **Capture pair**: identical input → VICE x64sc reference frame +
   headless frame. Store as `samples/vic-corpus/<game>/<phase>/{vice,headless}.png`.
2. **Diff** pixel-wise. Localize artifact area.
3. **Identify subsystem** via raster_changes log + scanline snapshots.
4. **Open sub-spec** (296a, 296b, ...) for the specific fix. Link
   bug-register row.
5. **Fix + smoke**: per-bug regression smoke captured into corpus.
6. **Mark resolved** in register with commit ref.

## Sub-spec backlog (priority order — likely impact)

- **296a**: VIC idle bus reads — Φ1 cycles return $FF (or last
  fetched byte) per VICE `vicii-fetch.c` conventions, not RAM.
  → Fixes 296-SI-1, -SI-2.
- **296b**: Sprite-bg collision latch ($D01F) — pixel-by-pixel
  fgMask AND with sprite mask sets per-sprite bit.
  → Fixes 296-SI-5.
- **296c**: Mid-frame $D016 XSCROLL cycle-exact apply via
  raster_changes lane.
  → Fixes 296-SI-4.
- **296d**: Char-fetch race — badline vbuf fetch must be
  cycle-pinned at line %8 == YSCROLL within DEN window. Verify
  CPU writes between fetch and render don't disturb vbuf.
  → Fixes 296-SI-3.

## Out of scope

- Last Ninja loader (separate non-VIC spec).
- Performance: corpus may run slow first; optimize after parity.

## Acceptance

- [ ] Bug register populated for ≥3 games
- [ ] Each bug has reproducer pair (vice + headless PNG) checked in
- [ ] Each fix lands as sub-spec with smoke regression
- [ ] All listed bugs resolved or downgraded with rationale
- [ ] CI corpus runs every game, fails on pixel diff > threshold
