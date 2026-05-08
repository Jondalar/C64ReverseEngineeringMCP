# Spec 063 — Full headless C64 emulation for LLM-driven workflows

## Vision

Headless emulator becomes a **complete cycle-accurate C64 from the ground up, designed for LLM consumption**. No human in the loop, no GUI, no audio output, no input devices — but cycle-exact execution + scriptable rendering + queryable state at every level.

User's framing:

> "Im Grunde soll Headless einen kompletten C64 emulieren können, nur für LLMs halt. Von Grund auf. Stell Dir vor du kannst dann anhalten und den screen 'rendern' als PNG, cycle genau. Dann wird es auf einmal auch möglich, sauber Demo und Intro coding anzufangen sage ich voraus."

The leverage:

- **Pause-and-render as LLM affordance.** LLM runs code → calls `headless_render_screen()` → gets PNG → reads visually with multimodal model → decides next change. No human needed to verify "did the sprite move?".
- **Cycle-exact mid-frame raster effects.** Demo coding tradition is bending raster timing for visual tricks. LLM can write IRQ raster routines, render at exact line, verify visual outcome.
- **Demo / intro coding as RE workflow.** Iterative develop-trace-render-evaluate loop without VICE GUI dependency.
- **VICE becomes optional.** Reserved for: (a) sanity-checking complex audio output via VICE's SID engine, (b) interactive human play to capture interesting state for headless analysis (Spec 062 Sprint 64 VSF bridge), (c) edge cases where headless behaviour diverges from real hardware.

## Scope (what full headless covers)

| Subsystem | Headless models | Why |
|---|---|---|
| 6510 CPU | Already done (`cpu6510.ts`) | Foundation |
| 6502 CPU (drive) | Spec 062 Sprint 60 | Custom loaders |
| RAM / COLOR RAM | Already done | Foundation |
| KERNAL / BASIC ROMs | Already done | Standard boot |
| 1541 drive bus + GCR | Spec 062 Sprints 60-63 | Loader / DOS / save-game RE |
| **VIC video** | This spec | Demo coding, sprite RE, screen render to PNG |
| **SID audio (register-level)** | This spec | Music driver RE; output to WAV optional |
| **CIA1 / CIA2 timers** | This spec | Game-loop IRQ, raster IRQ, music driver timing |
| **CIA1 keyboard / joystick (input)** | This spec | Scriptable input source for demo / game testing |
| **VSF read + write** | Spec 062 Sprint 64 + grows here | Cross-emulator state transfer |
| **Cartridge handling** | Already done | Existing |

## Phased roadmap

This spec is **roadmap-form**, not implementation-ready. Each phase becomes its own concrete spec when picked up.

### Phase A — VIC video model + screen render to PNG (highest LLM-leverage)

**Goal:** `headless_render_screen()` returns a PNG of the current C64 display. Cycle-exact mid-frame: render reflects raster position at call time.

**Scope per spec-to-be:**
- VIC II model: $D000-$D02E registers (sprite coords, sprite enable, sprite multicolor, screen control, raster compare, scroll, character set pointer, screen memory pointer, border + background colors).
- Frame buffer: 320x200 + 24-pixel border each side + 6+6 lines border vertical = 504×312 pixel array (PAL standard).
- Cycle-to-pixel mapping: 63 cycles per scanline (PAL); each cycle paints 8 pixels.
- Char mode + multicolor char + bitmap mode + multicolor bitmap mode + extended-bg-color mode.
- Sprite rendering with collision detection ($D01E sprite-sprite, $D01F sprite-bg) for game-state queries.
- Raster IRQ ($D012 + $D019/$D01A) — already needed for game loops.
- Bad lines (cycle-stealing for char-data fetch) — important for cycle-exact demo timing.
- Screen render to PNG: PNG-encode current frame buffer + overlay current raster position marker.

**LLM tools:**
- `headless_render_screen(path?)` — writes PNG of current frame state, returns path
- `headless_vic_state()` — register snapshot + raster position + collision flags
- `headless_vic_advance_to_raster(line)` — step until $D012 == line, useful for IRQ-debug

**Acceptance:**
- Run a 4-line demo: PHA / TXA / PHA / TYA / PHA / LDA #color / STA $D020 / RTI on a raster IRQ at line 50 → render screen → PNG shows border color change at line 50.
- Standard C64 `READY.` screen with cursor renders identical to VICE PNG export (pixel-equal modulo timing-jitter tolerance).
- Sprite sprite-collision detected when two sprites overlap at known coords.

### Phase B — CIA1 / CIA2 full timers

**Goal:** Game-loop IRQ + music driver timing (timer A → IRQ at 50/60Hz) work correctly.

**Scope:**
- CIA1 ($DC00-$DC0F): 2× 16-bit timers (one-shot + continuous), TOD clock, ICR/IMR, serial port (rare game use).
- CIA2 ($DD00-$DD0F): same plus VIC bank select bits ($DD00 PA bits 0-1) — critical for non-default VIC bank.
- IRQ assertion on timer underflow → 6510 IRQ line.
- TOD clock used by some demos for precision timing.

**Acceptance:**
- A 50Hz timer-IRQ ROM increments a counter — after 50 frames, counter = 50.
- VIC bank switching ($DD00 PA bits 0-1) reflected in next character-data fetch.

### Phase C — CIA1 keyboard / joystick input as scriptable source

**Goal:** Inject keystrokes / joystick movements programmatically. Game-loops that wait on input proceed.

**Scope:**
- Scriptable input queue: timed sequence of (cycle, port, value) events.
- $DC00 PA + $DC01 PB matrix scan returns scripted state.
- Joystick port 1 = $DC01 lower bits, port 2 = $DC00 lower bits (standard C64 wiring).
- Pre-canned macros: `headless_input_press_key("RUN/STOP")`, `headless_input_joy(port, "up"|"down"|...|"fire")`.
- Recording mode: capture all port reads → emit as test fixture replay.

**LLM tools:**
- `headless_input_queue([{ cycle, port, value }, ...])` — programmatic sequence
- `headless_input_press_key(name, holdMs?)` — convenience wrapper
- `headless_input_joy(port, direction, holdMs?)` — joystick wrapper

**Acceptance:**
- BASIC prompt → press SHIFT+RUN/STOP → boots first program from disk.
- Game title screen → joy fire pressed → game starts.

### Phase D — SID register-level model

**Goal:** SID register writes are captured + replayable. Optional WAV-render of audio output.

**Scope (minimum):**
- SID ($D400-$D7FF): 3 voices, 4-octave waveform select, ADSR envelope params, filter cutoff/resonance.
- Register-write log: every store to $D4xx with timestamp. RE music drivers by analyzing the write pattern.
- Frame-tick capture: record register state at each video frame for music-driver step analysis.

**Scope (extended, optional):**
- Audio synthesis: implement reSID-style oscillators + envelopes + filter for actual waveform output. Render to WAV file.
- License consideration: reSID is GPL — clean-room implementation needed if we want WAV output without copyleft taint. Or: route to VICE for actual audio render via existing `vice_*` tools.

**LLM tools:**
- `headless_sid_register_log(fromCycle, toCycle)` — query write log
- `headless_sid_state()` — current register snapshot
- `headless_sid_render_wav(path, durationFrames)` — optional, generates WAV (only if audio synth landed)

**Acceptance:**
- A music driver that writes $D404, $D405, $D406 (voice 1 attack/decay) at frame N is captured in the register-write log.
- Frame-tick capture shows envelope progression matches expected music-data table.

### Phase E — Cycle-exact mid-frame raster effects + demo workflow

**Goal:** Demo coding feedback loop: write raster IRQ code → render → see effect → iterate.

**Scope:**
- Pause emulation at any cycle (already possible) → render current frame buffer including partial scanline → PNG.
- Render shows the raster position cursor as a 1-pixel red line.
- `headless_advance_cycles(n)` + render combo gives cycle-resolution visual feedback.
- Documentation: example workflow "Write a 4-line raster IRQ demo, render at 5 different cycle-points, see border color change progression."

**Acceptance:**
- Classic FLI (Flexible Line Interpretation) demo runs → headless render matches VICE export at same cycle position.
- Raster bar at line 100, 150, 200 colored differently → render PNG shows three distinct color stripes in border.

### Phase F — VSF coverage expansion

Each of A/B/C/D adds modules to VSF (Spec 062 Sprint 64 framework). When all phases land, headless VSF round-trips with VICE for the entire modeled C64 state.

## Architecture extensibility hooks (built into Spec 062)

Spec 062's design pre-allocates expansion seams:
- **Memory bus** (`memory-bus.ts`) is already a region-mapped read/write dispatcher. Adding VIC ($D000-$D02E), SID ($D400-$D7FF), CIA1 ($DC00-$DC0F), CIA2 ($DD00-$DD0F) handlers is local — no core refactor.
- **Step loop** (`session-manager.ts`) has the cycle accumulator pattern. Adding peripherals that need per-cycle ticking (VIC for cycle-exact pixel painting, CIA timers for IRQ assertion) plugs in beside the drive accumulator.
- **Trace tag system** (Spec 062 Q6.A) — the `cpu` tag generalizes to `source: "c64" | "drive" | "vic" | "cia1" | "sid"` if we want per-peripheral trace breakouts later.
- **MCP tool naming** — the `headless_<subsystem>_<verb>` pattern (e.g. `headless_drive_status`) extends naturally to `headless_vic_state`, `headless_cia1_status`, etc.

This means Spec 063 phases land as pure additions, not refactors. Estimated cost per phase:
- Phase A (VIC + render): 4-6 sprints. Largest payoff.
- Phase B (CIA timers): 1-2 sprints.
- Phase C (input): 1 sprint.
- Phase D (SID register-level): 1 sprint. SID synth WAV: +2-3 sprints if needed.
- Phase E (cycle-exact mid-frame + demo workflow): 1 sprint after Phase A.
- Phase F (VSF expansion): tracked per-phase as part of that phase's work.

Total: ~10-15 sprints to full headless C64. Phase A alone is sufficient for the largest LLM-leverage gain (visual feedback).

## Out of scope (long-term or never)

- **Tape (datasette) emulation:** few games use it post-1985; never a primary load path.
- **REU / GeoRAM / 1764 expansion RAM:** specialised; can be added later if a project needs it.
- **CPM / Z80 cartridge:** historical curiosity.
- **Hardware bugs cycle-exact emulation (e.g. VIC sprite-pointer fetch glitches):** acceptable approximation; document deviations.
- **Color-emulation accuracy (PAL phase encoding, color-bleeding):** PNG render uses standard 16-color palette. Not for art-faithful screenshots.

## Cross-reference

- Spec 062 — R28 L3 drive emulation. Foundation peripheral; this spec extends to full C64.
- VICE source — algorithmic reference for VIC, SID, CIA. License posture (research-with-references, MIT-preserving) per Spec 062.
- Demo-scene examples (CSDb) — acceptance test source for Phase A/E. Pick 3-5 short well-known demos as PNG-equality fixtures.
- Existing `vice_session_*` + `vice_trace_*` MCP tools remain available for: (a) audio playback / human listening, (b) edge cases where headless diverges from real hardware, (c) interactive setup capture → VSF → headless analysis.

## When to start Phase A

After Spec 062 Sprints 60-64 complete. Drive emulation foundation + cross-emulator VSF bridge land first; then the VIC/render work on top of stable lower layers.
