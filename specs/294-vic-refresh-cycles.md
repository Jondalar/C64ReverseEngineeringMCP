# Spec 294 — VIC-II refresh cycles 11..15 explicit modeling

**Sprint:** 144  **Status:** RESOLVED 2026-05-09  **Depends:** 280g

**Resolved:** Explicit r-access events; test = bus-trace inspect +
regression.

## Goal

Emit 5 explicit "refresh" bus events per line at cycles 11..15
(VIC's r-access slots). Currently sandwiched in badline DMA
accounting; visible to the bus-owner table but not separately
labeled. Required for trace fidelity (V3 timeline + Spec 287 phi
phase tracking).

## VICE source

- `vicii-fetch.c` — r-access slot positions inside the DMA window.

## Plan

- 294a: Add `r-access` event type to bus-trace.
- 294b: Per-cycle scheduler emits r-access event for cycles 11..15
  every line (badline OR not).
- 294c: Bus-owner table marks 11..15 as VIC-owned regardless of
  badline (= VIC drives addrbus for refresh even on non-badlines).

## Acceptance

- [ ] 5 r-access events per line in bus-trace
- [ ] r-access cycles owned by VIC even on non-badline
- [ ] All previous smokes pass
