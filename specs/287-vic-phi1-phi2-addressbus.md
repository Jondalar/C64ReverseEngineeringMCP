# Spec 287 — VIC-II Φ1/Φ2 addressbus phase modeling

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 286

## Goal

Model phi1 vs phi2 address-bus phase split. Each cycle has 2
phases: Φ1 (= VIC drives bus) and Φ2 (= CPU drives bus). VIC
fetches happen on Φ1, CPU memory access on Φ2. Today we collapse
both into a single "cycle" — invisible for normal code, breaks
introspection / addrbus-aware features.

## VICE source

- `vicii.c` — `vbank_phi1` / `vbank_phi2`, `vaddr_chargen_mask_phi1/2`,
  `vaddr_chargen_value_phi1/2` separately.
- `vicii-fetch.c:385-453` — Φ1 vs Φ2 chargen-mask test per
  fetch.
- `vicii-phi1.c` — Φ1-specific ROM/IO mapping helpers.

## Plan

- 287a: Add `phi: "phi1" | "phi2"` to bus-trace events.
- 287b: Per-cycle scheduler emits 2 sub-events per cycle (phi1
  fetch + phi2 cpu access).
- 287c: vicRead in renderer uses phi1-specific bank (= same as
  current bank since we don't separate phi1/2 sources today).

## OQs

- **OQ1:** Backwards-compat: existing bus-trace consumers don't
  expect phi1/phi2. (a) Add as optional new field, (b) breaking
  change. Default (a) optional.
- **OQ2:** Phi1/Phi2 chargen-mask split — needed for CIO 8-bit
  fetch quirks? (a) Implement full split, (b) collapse (= rely
  on Spec 286 single-bank). Default (a) — full parity = ALLES.
- **OQ3:** Test gate: (a) synthetic phi-split unit, (c) regression.
  Default both.

## Acceptance

- [ ] Bus-trace events carry phi1/phi2 phase tag
- [ ] vbank_phi1 + vbank_phi2 separately tracked in vic state
- [ ] Vaddr chargen mask split per phase
- [ ] All previous smokes still pass
