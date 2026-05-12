> **SUPERSEDED 2026-05-06 by Spec 216** (`specs/216-sid-1to1-register-state.md`).
> Sprint 113 aborted.

# Spec 151 — SID register state 1:1 VICE (B-level, no audio)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**:
- VICE 3.7.1 src/sid/sid.c (~600 LOC) — wrapper + register dispatch
- src/sid/fastsid.c — fast approximation (reference)
- src/sid/resid/* — bit-exact (reference, V3)
**Depends on**: none
**Refinement**: locked 2026-05-06

## Why

V1 explicitly excludes audio output but games still WRITE to SID
registers. Some games READ back oscillator state ($D41B osc3) or
ENV state ($D41C env3) for synchronization, randomization, or
copy-protection.

If our SID register read doesn't match VICE, games may fail.

## Refinement decisions

1. **Scope-Tiefe (this sprint, B-level)**:
   - All 29 register R/W match VICE.
   - Wave-shape-aware osc3 readback ($D41B): voice 3 oscillator
     phase advance per cycle, register-3 control bits (triangle/
     sawtooth/pulse/noise) determine returned waveform.
   - ADSR state machine 1:1: attack/decay/sustain/release
     transitions per voice match VICE rate tables.
   - env3 readback ($D41C): voice 3 envelope current 8-bit value.
   - Filter state placeholder: register R/W preserved, no actual
     filter sim (audio out of scope).
   - POT pin readback for paddles ($D419/$D41A) — already done
     via Sprint 108, verify still works.
   - **Excluded** at B-level: audio sample output, ring
     modulation, oscillator sync, filter audio, per-revision
     quirks (6581 vs 8580), exact resid bit-fidelity for non-osc3
     voices.
2. **V3 backlog**: full audio. Two paths (decision deferred to
   V3 sprint, notiert in PLAN.md):
   - resid 1:1 port (~3000 LOC C++ → TS, bit-exact).
   - fastsid 1:1 port (less accurate, much smaller, audio
     usable).
3. **Existing sid.ts handling**: parallel migration ending in
   single canonical filename.
   - Phase 1: write new B-level core in `sid-vice.ts`. Existing
     sid.ts retained.
   - Phase 2: switch callers.
   - Phase 3: delete old; rename `sid-vice.ts` → `sid.ts`.
   - Final: `sid.ts` = B-level VICE port.
4. **osc3/env3 advance (wave-shape-aware)**:
   - Per voice 3 (others optional skip — only voice 3 readback
     surfaces via $D41B/$D41C):
     - `phase: u24` advances by `freq` per cycle (`freq` = $D40E
       low + $D40F high).
     - Wave shape per $D412 control bits:
       - Triangle ($D412 bit 4): `tri_out = (phase >> 11) ^
         ((phase & 0x800000) ? 0xfff : 0)`, take high 8 bits.
       - Sawtooth (bit 5): `(phase >> 16) & 0xff`.
       - Pulse (bit 6): `(phase < (pulsewidth << 12)) ? 0xff :
         0` based on $D413/$D414.
       - Noise (bit 7): LFSR derived from phase advance.
     - Combined waves (multiple bits set): VICE returns AND of
       individual wave outputs (close approx; resid does it
       different but B-level ok).
   - ADSR state machine per voice:
     - States: ATTACK, DECAY, SUSTAIN, RELEASE.
     - Rate counters per VICE table (15 attack rates, 15
       decay/release rates).
     - Gate bit ($D404 bit 0): trigger ATTACK on rising,
       trigger RELEASE on falling.
     - env3 readback = voice-3 current envelope value.
   - Ring-mod + oscillator-sync: deferred to V3 backlog.
5. **Mirror Spec 145 patterns**: hybrid naming (intern VICE-style
   verbatim), uint helpers, per-function unit + chip-state-diff
   harness extended for SID, snapshot v2.

## Scope

### Point 18: SID register state
- All 29 register R/W match VICE.
- $D41B osc3 / $D41C env3 readback: VICE simulates oscillator
  + envelope advancement per cycle. Returns wave-shape-aware
  value based on SID state + clock.
- ADSR envelope state machine 1:1 (attack/decay/sustain/release
  rate tables).
- Filter state placeholder (no audio output but write/read state
  preserved).
- POT pin readback for paddles (verify Sprint 108 still works
  under new core).

### Out of scope (V3 spec)
- Audio sample output.
- Voice 1+2 full waveform generation (only voice 3 advances for
  osc3 readback at B-level).
- Ring modulation between voices.
- Oscillator hard sync.
- Filter audio cutoff/resonance/mode.
- Per-revision quirks (6581 vs 8580 ADSR-bug).

## Deliverables

1. `src/runtime/headless/util/uint.ts` — shared.
2. `src/runtime/headless/sid/sid-vice.ts` — new B-level core
   (becomes `sid.ts` after final rename).
3. `tests/unit/sid/*.test.ts` — per-VICE-function unit tests
   (register R/W, ADSR transitions, osc3 readback per
   wave-shape).
4. `scripts/chip-state-diff.mjs` — extended for SID register
   diff vs VICE.
5. Snapshot v2 schema bump (shared with 145/147/150).

## Acceptance

- All 29 SID register reads return same value as VICE for same
  input sequence.
- $D41B/$D41C readback matches VICE for triangle/sawtooth/pulse/
  noise wave shapes (per-voice-3 control bits).
- ADSR transitions match VICE rate tables (attack/decay/release
  cycle counts deterministic).
- POT pin readback preserved.
- Per-VICE-function unit tests pass.
- chip-state-diff harness shows zero SID register divergence vs
  VICE for game-RNG-style scenarios.
- New smoke `smoke:sid-fidelity` PASS.

## Process

1. uint helpers (shared with 145).
2. Read VICE sid/sid.c register R/W paths.
3. Read VICE fastsid.c voice-state advancement (reference for
   wave-shape arithmetic).
4. Audit existing sid.ts register handlers — note which paths
   re-use vs need new impl.
5. Write new B-level core in `sid-vice.ts`:
   - Register R/W table.
   - Voice-3 phase advance per cycle.
   - Wave-shape-aware osc3 calculation.
   - ADSR state machine + rate tables.
   - env3 readback.
   - Filter register state preservation (no sim).
6. Per-VICE-function unit tests.
7. Extend chip-state-diff for SID.
8. Switch callers; delete old; rename file.
9. Run smoke:sid-fidelity + regression.

## Estimated effort

0.5-1 session. B-level scope is small. ADSR rate tables + voice-3
wave-shape arithmetic are the main work. Most games don't depend
on exact SID readback so risk is low; this spec is insurance for
games that do.

## Cross-reference

- Spec 148: Reset state — SID register state byte-exact (SID
  unit reset test added there).
- V3 backlog (PLAN.md): resid 1:1 OR fastsid 1:1 audio port,
  decision in V3 sprint.
- Sprint 108: POT pin readback — keep functional under new core.

## Note on priority

Lower priority than 145/146/147 for game booting. Most games
don't depend on SID readback. Specific games (e.g. some demos
using osc3 for randomization, copy-protection schemes) need
this. Land after 145/146/147 stable.
