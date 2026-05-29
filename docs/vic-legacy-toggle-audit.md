# VIC / IEC legacy-toggle audit (Spec 723.5b)

**Date:** 2026-05-29. Audit-only — input for the 723.5c removal. Fork B: the
legacy VIC runtime path is deleted; no fidelity test keeps a second runtime path
alive.

## Toggles in scope

Defined on `IntegratedSessionOptions` (integrated-session.ts), all defaulting to
the product path:

| flag | default | product value | legacy branch when off |
|------|---------|---------------|------------------------|
| `useLiteralPortRenderer` | true | literal-port FB | non-literal snapshot renderer |
| `useLiteralPortVicPerCycle` | true | per-cycle `tickLitVic()` | batched per-instruction `vic.tick(N)` |
| `useLiteralPortVicReads` | = VicPerCycle | literal raster_y / reg reads | VicIIVice API reads |
| `useLiteralPortVicIrq` | = VicReads | literal irq | `VicIIVice.irqAsserted()` |
| `useLiteralPortVicStall` | = VicReads | literal bus-steal | `computeLineSteal()` block path |
| `useLiteralPortVicFb` | = VicReads | literal FB | snapshot FB |
| `usePerCycleBusStealing` | (lockstep) | per-cycle steal | `computeLineSteal()` block accounting |

No public MCP/UI/agent input exposes any of these (probe check 11). The legacy
VIC code reached when they are off: `vic-ii-vice.ts` `computeLineSteal()` (block
accounting) + the non-literal snapshot renderer path.

## Callsite classification (10 files, all in scripts/)

| smoke | flags | class | 5c disposition |
|-------|-------|-------|----------------|
| smoke-vic-298k-integrated | all true | **B** | drop redundant flags (rely on default) |
| smoke-vic-301-raster-irq | all true | **B** | drop redundant flags |
| smoke-vic-303-basic-ready | all true | **B** | drop redundant flags |
| smoke-vic-301-irq-diff | Reads/Irq false | **C-retire** | pure "irqAsserted vs literal" diff — obsolete with one path |
| smoke-vic-299-d020-irq | percycle var | **C-retire** | "alternating compare" of percycle on/off |
| smoke-vic-300-d012-poll | useLitReads var | **C-rebuild** | real D012-poll behavior — assert on product flags |
| smoke-vic-302-sprite-stall | Reads/Irq false | **C-rebuild** | sprite-DMA stall — assert with product literal stall |
| smoke-vic-302-badline-stall | Reads/Irq false, Stall var | **C-rebuild** | badline stall — assert on product |
| smoke-vic-299-d020-split | percycle var | **C-rebuild** | $D020 raster split — assert on product |
| smoke-bus-stealing | true + false | **C-rebuild** | keep per-cycle-steal assertions, drop the off-case |

- **A (public input):** none.
- **D (external VICE oracle):** none here — real VICE comparison lives in the
  `vice_*` tools, which stay as an external oracle (not an internal runtime path).

## 5c plan (the actual delete)

1. Make `useLiteralPort*` + `usePerCycleBusStealing` unconditional (remove the
   opts + `?? true` defaults; the product path is the only path).
2. `vic-ii-vice.ts`: delete the `computeLineSteal()` block-accounting default
   path + the non-literal snapshot renderer branch; keep per-cycle literal.
3. Smokes: B → drop redundant flags; C-retire → delete; C-rebuild → rebuild to
   assert the product behavior (no flag flipping, assert the per-cycle/literal
   result, like a product golden).
4. Gates: build + probe-single-path + the rebuilt VIC smokes + runtime:proof
   once (VIC is execution-internal).

⚠️ 5c is the riskiest slice of Spec 723 (VIC execution-internals + 10 smoke
files). Tackle deliberately, not as a tail-end of a long session.
