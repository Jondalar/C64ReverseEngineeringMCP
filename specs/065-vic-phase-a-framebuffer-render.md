# Spec 065 — VIC Phase A: framebuffer + render PNG + optional WebSocket stream

Status: **SUPERSEDED 2026-05-04.** Substance landed in Sprint 73 (VIC modes — multicolor text + bitmap + ECM), Sprint 74 (sprites + collision), Sprint 78 (raster IRQ); `headless_render_screen` MCP tool live in `src/server-tools/headless.ts`. Remaining open sub-stories (framebuffer API formalization + visual acceptance ladder) reorganized into Sprint 104 / Spec 105 (M2.3 VIC-II per-cycle fidelity) and Sprint 106 / Specs 117-121 (M4.1-5 visual runtime) in current V1.0 roadmap. No further work needed under the 065 umbrella.

## Problem

Spec 063 set the long-term vision: full headless C64 for LLM-driven workflows. Phase A is the highest-leverage piece — `headless_render_screen()` returns a PNG of the current display. With real KERNAL running (Spec 064), the VIC raster IRQ source plus the framebuffer make demo coding + game-state introspection possible without VICE.

This spec concretizes Phase A from roadmap form into implementation.

## Decision

Cycle-exact VIC II ($D000-$D02E) with full register model + 504×312 PAL framebuffer (per spec — NTSC 504×263 also supported via session option). Per-cycle pixel painting so paused PNG renders capture mid-frame raster effects faithfully. PNG export via `headless_render_screen` MCP tool. Optional WebSocket stream to the workspace UI for live-preview during long traces.

SID intentionally omitted — confirmed not needed for headless RE/dev workflows.

## Scope

### VIC register model

`src/runtime/headless/peripherals/vic-ii.ts`. Implements all 47 VIC registers $D000-$D02E:

- $D000-$D00F: sprite X/Y coords (8 sprites)
- $D010: sprite X-MSB
- $D011: control 1 (Y-scroll, RSEL, DEN, BMM, ECM, raster bit 8 read)
- $D012: raster line low (read = current, write = compare register)
- $D013-$D014: light pen X/Y (rarely used; stub)
- $D015: sprite enable
- $D016: control 2 (X-scroll, CSEL, MCM, RES)
- $D017: sprite Y-expand
- $D018: memory pointers (screen RAM + char ROM/bitmap base)
- $D019: IRQ status (bit 0 raster, bit 1 sprite-bg coll, bit 2 sprite-sprite coll, bit 3 light pen)
- $D01A: IRQ mask
- $D01B: sprite-data priority
- $D01C: sprite multicolor
- $D01D: sprite X-expand
- $D01E: sprite-sprite collision (read clears)
- $D01F: sprite-bg collision (read clears)
- $D020: border color
- $D021: background color 0
- $D022-$D024: background color 1-3 (multicolor / extended-bg modes)
- $D025-$D026: sprite multicolor 1-2
- $D027-$D02E: sprite color 0-7

### Framebuffer

- 504×312 pixel RGBA buffer (PAL); 504×263 NTSC.
- Resolution chosen to include full border. Visible area 320×200 inset at (24, 51).
- VIC palette = standard C64 16 colors (RGB tuples; we use the well-known Pepto palette by default).
- `headless_render_screen(path?)` writes PNG via `node-canvas` or `sharp`. If pure-JS fallback wanted, use `pngjs` (no native deps).

### Cycle-exact rendering

Per Φ2 cycle, VIC paints 8 pixels (per real chip behavior). Pixel position derived from the current raster line + horizontal cycle counter:
- 63 cycles per scanline (PAL) / 65 cycles (NTSC).
- Cycle 0-9 = left border, 10-58 = visible 320 px, 59-62 = right border.
- After cycle 62, raster line wraps; line counter increments. After line 311 (PAL) / 262 (NTSC), wraps to 0 → frame complete.

Modes implemented per phase:

- **Phase 65a**: register model + screen-RAM read + char-ROM read. No rendering yet — just the data plumbing. Acceptance: probe shows correct character at (col, row).
- **Phase 65b**: text mode (40×25 chars, standard + multicolor). Renders to framebuffer.
- **Phase 65c**: raster counter + raster IRQ source ($D019 bit 0 set on $D012 match, IRQ asserted via $D01A mask). Wires through to C64 6510 IRQ line (joining CIA1 IRQ from Spec 064).
- **Phase 65d**: bitmap mode (320×200 standard + multicolor) + extended bg color mode.
- **Phase 65e**: sprites — 8 hardware sprites, 24×21 px, multicolor optional, expand X/Y, sprite-bg + sprite-sprite collision detection.
- **Phase 65f**: PNG export `headless_render_screen` MCP tool.
- **Phase 65g**: WebSocket live-preview stream to workspace UI.

### MCP tools

- `headless_render_screen(session_id, path?)` — PNG of current frame. Returns path + frame-counter + raster-line-at-render.
- `headless_vic_state(session_id)` — registers $D000-$D02E + current raster + framebuffer hash.
- `headless_vic_advance_to_raster(session_id, line)` — convenience: step until $D012 == line. Useful for raster-IRQ-debug.
- `headless_vic_stream_start(session_id, ws_path?)` — start WebSocket stream of frames at 50/60Hz to ws://localhost:<port>/<path>. Workspace UI subscribes; renders in a `<canvas>` panel.

### Architecture extensibility hooks (for Spec 063 future phases)

- VIC tick API mirrors CIA + VIA (`tick(cycles: number)`). Drops cleanly into the IntegratedSession step loop alongside the others.
- Framebuffer kept as plain typed array. Future: PNG dump via WASM-based encoder if `node-canvas` deps cause friction; or send raw RGB to the WebSocket and let the browser canvas handle it.
- VIC bank-switching via CIA2 PA bits 0-1 (already wired into iec-bus path; VIC reads its current bank via that signal).

## Acceptance criteria

Per phase:

- 65a: VIC register reads/writes round-trip; screen-RAM read by VIC matches CPU view at $0400.
- 65b: KERNAL banner "**** COMMODORE 64 BASIC V2 ****" rendered to framebuffer matches a VICE screenshot (pixel-equal modulo timing-jitter tolerance — accept ~1% pixel diff).
- 65c: A 4-line raster IRQ ROM (set $D012=50, set $D01A bit 0, IRQ handler changes $D020 = blue) — render PNG → top 50 lines border = default, lines 50-200 border = blue.
- 65d: A bitmap demo screen renders pixel-near to VICE export.
- 65e: Two sprites overlapping → $D01E sprite-sprite collision flag set; sprite-bg collision works on a known scene.
- 65f: `headless_render_screen` writes valid PNG that opens in any viewer.
- 65g: Workspace UI live-preview shows the running emulator at 50Hz with <100ms latency on local loopback.

Full Phase A acceptance: a sample game's title screen (Maniac Mansion intro) renders identifiable in PNG.

## Sprint plan

Each phase = one sprint (sprints 70-76):
- Sprint 70 (65a): registers + screen-RAM/char-ROM plumbing
- Sprint 71 (65b): text mode + framebuffer
- Sprint 72 (65c): raster counter + raster IRQ
- Sprint 73 (65d): bitmap modes
- Sprint 74 (65e): sprites + collision
- Sprint 75 (65f): PNG export MCP tool
- Sprint 76 (65g): WebSocket live-preview

Total ~7 sprints. Phase A alone delivers the core LLM-leverage gain (visual feedback). Subsequent Spec 063 phases (CIA timer extras, scriptable input, optional SID register-log) follow.

## Out of scope

- Cycle-exact bad-line cycle stealing modeling (the 40 char fetches that steal cycles from CPU). Approximation: just paint pixels per cycle without stealing CPU cycles. Demos that depend on bad-line timing will diverge.
- Hardware bug fidelity (sprite-pointer-fetch glitches, $D01E read-clear race). Document deviations.
- Color-emulation accuracy (PAL phase encoding, color bleeding). Default Pepto palette renders cleanly.
- VSF support for VIC state (added per phase to module-mapping; full VIC state in VSF after Sprint 76).

## Cross-reference

- Spec 063 — full-headless-C64 vision. Phase A is the first concrete chunk.
- Spec 064 — Full KERNAL prerequisite. VIC raster IRQ feeds into the same IRQ handler dispatch path that CIA1 uses.
- VICE source `src/vicii/vicii.c` + `src/vicii/vicii-cycle.c` — algorithmic reference for VIC pixel pipeline. Project stays MIT.
- Pepto VIC palette: `https://www.pepto.de/projects/colorvic/` — standard reference.
