# Spec 216 — SID 1:1 register state

**Sprint:** 120
**Status:** PROPOSED (parallel-eligible)
**Maps from:** legacy 151 (sid-register-state-1to1) — superseded
**Depends on:** 200
**Write scope:** `src/runtime/headless/sid/*` only

## Goal

Software-visible SID behavior matches VICE register-readback fixtures.
No audible output (V1 boundary, ADR §4.7).

## Scope

- Register R/W including write-only quirks.
- Oscillator counter advance (osc3 readback).
- Envelope state machine (env3 readback).
- Filter no-op preserved; configuration registers honored for
  readback semantics.
- Write trace event in 205 stream.

## Acceptance

- M2.6 + M7.1-3 tests stay green.
- VICE register-trace fixtures pass byte-exact.
- No-audio boundary lint stays green (ADR §4.7).
- V3 audio path (resid or fastsid) can plug in as kernel client
  later without changing this surface.
