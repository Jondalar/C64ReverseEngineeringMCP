# Spec 286 — CIA2 PA VIC-bank switch cycle-exact

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 280

## Goal

VIC bank ($CIA2 PA bits 0-1) switch takes effect IMMEDIATELY at
write cycle, not at next-fetch / render-time. Today our renderer
applies bank changes at frame-render time using a per-line table
built from the log. Per-cycle scheduler should bind bank to the
cycle the write happened.

## VICE source

- `vicii-mem.c:160 vicii_local_store_vbank` — direct update of
  `vicii.vbank_phi1` / `vicii.vbank_phi2`. Active immediately for
  the next phi1/phi2 fetch on the same cycle.
- `vicii-fetch.c:385` — bank consumed on next fetch using current
  `vbank_phi1/2` value.

## Plan

- 286a: Move CIA2 PA bank update from render-time to write-time.
  Hook CIA2 PA writes via `headless-machine-kernel.ts` event so
  vic-ii-vice receives the new bank synchronously.
- 286b: Update `raster-state.vic_bank_base` from a "vic_bank" lane
  change exactly at cycle of write (Spec 262 log already captures
  CIA2 PA writes via VICII_LOG_CIA2_PA=0x80).

## OQs

- **OQ1:** Phi1 vs Phi2 split — VICE distinguishes. We currently
  collapse to single bank. (a) Match VICE phi1/phi2 separate, or
  (b) Keep collapsed (= correct for normal use, wrong for c128).
  Default (b) — VICII PHI1/PHI2 split addressed by Spec 287, not
  this one.
- **OQ2:** Test gate: (a) synthetic mid-frame bank flip render +
  (c) regression. Default both.
- **OQ3:** Bank change during VIC fetch cycle — does it tear?
  VICE: yes, the in-flight fetch sees the new bank. Mirror?
  Default yes (1:1 VICE).

## Acceptance

- [ ] CIA2 PA write at cycle N → bank effective from cycle N+1 fetch
- [ ] Split-screen tests with mid-frame bank switch render same
  as VICE
- [ ] All previous smokes still pass
