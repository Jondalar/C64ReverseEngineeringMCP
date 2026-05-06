# Spec 215 — Reset state byte-exact

**Sprint:** 120
**Status:** PROPOSED (parallel-eligible)
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
