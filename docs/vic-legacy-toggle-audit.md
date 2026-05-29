# VIC / IEC legacy-toggle audit (Spec 723.5b)

**Date:** 2026-05-29. Audit-only — input for the 723.5c removal. Fork B: the
legacy VIC runtime path is deleted; no fidelity test keeps a second runtime path
alive.

## CORRECTION (2026-05-29, reading-first during 5c)

The first cut of this audit (below) mischaracterized two items as
"product-legacy". Reading the actual branches in integrated-session.ts /
vic-ii-vice.ts showed:

- **`computeLineSteal()` / `stealCpuCycles()`** are NOT the product bus-stealing
  path. The product per-cycle path folds BA-low into the CPU
  (`Cpu65xxVice.tick()` → `c64ViciiCycle` hook → `tickLitVic()`, Spec 425), so
  `computeLineSteal` only runs in the legacy batched `vic.tick(consumed)` branch
  (`useLiteralPortVicPerCycle=false`) AND via the debug-lockstep `VicCycled`
  wrapper.
- **`usePerCycleBusStealing` + `useLiteralPortVicStall`** are NOT product. Their
  entire wiring lives inside `if (this.useCycleLockstep)` — the debug-lockstep
  scheduler. `useCycleLockstep` defaults false (event-catchup is product, Spec
  622 §4.0), so neither is reachable on the product path.

**Scope split (user-approved, Option 1 "Narrow"):**
- **723.5c** removes only the *product* VIC toggles + their legacy off-states:
  `useLiteralPort{Renderer,VicPerCycle,VicReads,VicIrq,VicFb}`, the non-literal
  renderToPng fallback, the batched `vic.tick()` branch, the VicIIVice IO-read
  path.
- **723.7** (with the debug-lockstep prune) removes the lockstep-coupled
  residue: `computeLineSteal`/`stealCpuCycles`, `usePerCycleBusStealing`,
  `useLiteralPortVicStall`, the bus-owner-table wiring, and
  `smoke-bus-stealing` / `smoke-vic-302-{sprite,badline}-stall`.

These debug bits are not kept forever — they are deleted in 723.7, not retained.

## Toggles in scope (original 5b cut — see correction above)

Defined on `IntegratedSessionOptions` (integrated-session.ts):

| flag | default | product value | branch when off | 5c disposition |
|------|---------|---------------|-----------------|----------------|
| `useLiteralPortRenderer` | true | literal-port FB | non-literal snapshot renderer | **removed (5c)** |
| `useLiteralPortVicPerCycle` | true | per-cycle `tickLitVic()` | batched per-instruction `vic.tick(N)` | **removed (5c)** |
| `useLiteralPortVicReads` | = VicPerCycle | literal raster_y / reg reads | VicIIVice API reads | **removed (5c)** |
| `useLiteralPortVicIrq` | = VicReads | literal irq | (set but never read — vestigial) | **removed (5c)** |
| `useLiteralPortVicFb` | = VicReads | literal FB | (set but never read — vestigial) | **removed (5c)** |
| `useLiteralPortVicStall` | = VicReads | literal bus-steal | `VicIIVice.getBusStallForCycle()` | **kept → 723.7** (debug-lockstep only) |
| `usePerCycleBusStealing` | off unless lockstep | per-cycle steal | `computeLineSteal()` block accounting | **kept → 723.7** (debug-lockstep only) |

No public MCP/UI/agent input exposes any of these (probe check 11).

## Callsite classification (10 files, all in scripts/) — final disposition

| smoke | flags | slice | what happened |
|-------|-------|-------|----------------|
| smoke-vic-298k-integrated | product only | 5c.1 | dropped redundant flags |
| smoke-vic-301-raster-irq | product only | 5c.1 | dropped flags; literal IRQ authority, vice-side read informational |
| smoke-vic-303-basic-ready | product (+ stray lockstep) | 5c.1 | dropped all flags; renderToPng default-routes to literal |
| smoke-vic-301-irq-diff | Reads/Irq false | 5c.1 | **deleted** — pure VicIIVice-vs-literal IRQ diff |
| smoke-vic-299-d020-irq | percycle var | 5c.1 | **deleted** — alternating percycle on/off compare |
| smoke-vic-300-d012-poll | useLitReads var | 5c.1 | **rebuilt** — bus-sampled $D012 sweep (was RED at baseline: poll PRG ran off into KERNAL) |
| smoke-vic-299-d020-split | percycle var | 5c.1 | **rebuilt** — single product run + raster-band assertion (was print-only) |
| smoke-vic-302-sprite-stall | Stall/percycle/lockstep | → **723.7** | untouched (debug-lockstep) |
| smoke-vic-302-badline-stall | Stall/percycle/lockstep | → **723.7** | untouched (debug-lockstep) |
| smoke-bus-stealing | percycle/lockstep | → **723.7** | untouched (debug-lockstep) |

- **A (public input):** none.
- **D (external VICE oracle):** none here — real VICE comparison lives in the
  `vice_*` tools, which stay as an external oracle (not an internal runtime path).

## 5c — done (as built)

**5c.1** (commit `dfe9645`) — smoke migration, no runtime change. B drop-flags,
C-retire delete, C-rebuild on product golden (see table).

**5c.2** (commit `bad1bf6`) — runtime delete. In integrated-session.ts:
unconditional `installLiteralPortRenderer()` + `setC64ViciiCycle` hook + literal
reset; collapsed the per-cycle/legacy branch in `stepMicrocodedC64Instruction`;
removed the end-of-instruction batched `vic.tick()`; literal-only $D000-$D3FF
reads; `renderToPng` always → `renderLiteralPortToPng`. `useLiteralPortVicIrq` /
`VicFb` were set-but-never-read → deleted. probe-single-path 17/17 (1e now
checks the always-allocated literal FB; new check 12 = no removed toggle in src).

**5c.3** — this doc correction + Spec 723 update + runtime:proof.

Deferred to **723.7** (debug-lockstep prune): `computeLineSteal` /
`stealCpuCycles` (still reached via the lockstep `VicCycled` wrapper),
`usePerCycleBusStealing`, `useLiteralPortVicStall`, bus-owner-table wiring, the
three stall/bus-stealing smokes.
