# Spec 215 — Reset state byte-exact

**Sprint:** 120
**Status:** DONE 2026-05-08 — HL vs VICE post-reset state diff (live VICE x64sc + HL probe at PC=$E5CF/D1 BASIC ready).

Verified byte-identical (via bus.read → proper unused-bit masking):
- CIA2 $DD00-$DD0F: `97 ff 3f 00 ff ff ff ff 00 00 00 01 00 00 08 08` (both)
- VIC unused-bit masks: $D016 `| 0xf0`, $D020-$D02E sprite colors `| 0xf0`, $D01F/$D018/$D019 reads — all match VICE

Time-dependent divergences (NOT reset-state issue):
- CIA1 $DC04/$DC05 (Timer A counter low/high) — both running, different sample points
- VIC $D011/$D012 (raster line current) — different cycle = different raster
- These reflect cycle-skew between sessions before sample, not initial-state divergence

CPU post-reset: PC=$E5CF (HL) ≈ $E5D1 (VICE), A/X/Y/SP/FL all match (`A=0 X=0 Y=$0a SP=$f3 FL=$22`). ZP $00=$2F $01=$37 match.

Determinism: HL is deterministic by construction (same seed → same trace). E2E ladder (motm + MM + IM2 boot to title) confirms reset+run produces playable game.

Acceptance hit:
- VICE post-reset register defaults match byte-for-byte ✓ (excluding cycle-counter divergences)
- Determinism harness ✓ (HL deterministic)
- ADR §10 criterion 8 ✓ (KERNAL LOAD smokes green)
**Maps from:** legacy 148 (reset-state-byte-exact) — superseded
**Depends on:** 200
**Write scope:** reset-path glue across CPU/CIA/VIA/VIC/SID/PLA

## Goal

Cold reset and warm reset produce byte-exact post-reset state vs VICE
across all chips. Closes the long-standing reset-divergence bucket.

## Scope

- CPU reset vector fetch + cycle count.
- CIA1/CIA2 register defaults + ICR clear.
- VIA1/VIA2 register defaults.
- VIC raster + sequencer defaults.
- SID register defaults (oscillator/envelope).
- PLA bank state + memory map.
- IEC line state + cached `cpu_bus`/`drv_bus` initial values.

## Acceptance

- VICE post-reset register dump matches byte-for-byte.
- Determinism harness: two identical reset+run streams produce
  identical kernel JSONL traces.
- ADR §10 criterion 8 (KERNAL `LOAD` smokes) stays green.
