# Spec 139 — Kernel Synchronization Architecture

**Sprint**: 112 (core sync refactor)
**Phase**: architecture (design only — no large code changes)
**Status**: proposed
**Depends on**: Spec 137 (arc42), Spec 142 (trace), Spec 143 (diff). Spec 138 probe result feeds into the design.
**Sequenced after**: 142 → 143 → 138 (probe)
**Sequenced before**: 140, 141, 144

## Why

The arc42 deep-dive (Spec 137) cataloged 9 local divergences between
VICE and our headless. Sprint 111 attempted to patch each in
isolation — unsuccessfully, because they share an architectural
root: the runtime is a hybrid of cycle-lockstep + push-flush + live
getters + rescue hooks. No single component "owns time"; behavior
emerges from the order of object callbacks.

Spec 139 is the **design-only** spec that defines the central
machine-kernel contract before any further IEC behavior change
lands. The actual code migration is split across 140/141/144.

## Scope

**In scope** (deliverable = design doc + API sketch + migration map):

- Define clock domains: `c64Clock`, `driveClock`. Both monotonic,
  both owned by the kernel, both observable via stable accessors.
- Define ownership boundaries:
  - kernel owns time advancement
  - chips do not advance their own clock
  - chips do not advance peer clocks
  - I/O hooks (CIA2 PA write, drive VIA1 PB read) call into the
    kernel for catch-up, never directly into a peer chip
- Define hot-path bus access contract:
  - every read/write of `$DD00`, `$1800`, `$1C00`, CIA, VIA, GCR
    receives a `BusAccessContext { side, clock, pc, opcode, phase }`
  - bus implementations may inspect or stamp the context but never
    advance time directly
- Define the `MachineKernel` interface — a single coordinator that
  scheduler+session+chip-wiring all flow through.
- Migration map from current code:
  - `IntegratedSession` → kernel client (no longer wires chips
    directly)
  - `CycleLockstepSchedulerImpl` → kernel internals
  - `IecBus` → kernel-aware (receives BusAccessContext, no longer
    has private `beforeC64Read` hook)
  - `DriveCpu.executeToClock` → kernel-driven only (chip can't
    self-advance)
  - `Via6522`/`CiaCore` → IRQ assertion via kernel-stamped events
- Identify code paths that will be deprecated:
  - direct `IecBus.attachDriveRam(ram)` $7C poke pathway
  - `IecBus.beforeC64Read` opt-in hook
  - Sprint 66 `reevaluateCa1Level` retroactive trigger

**Out of scope**:

- Implementing the kernel (covered by 140, 141, 144)
- VIC frame timing (separate spec; VIC already dispatches
  per-character-row in Sprint 104)
- Multi-instance / multi-machine (single C64 + single drive)

## Deliverable

`docs/headless-machine-kernel-architecture.md` (≈2000-3000 words +
1-2 mermaid diagrams). Sections:

### 1. Clock domains and time ownership

Single `MachineKernel` advances time. Drive lags C64 by 0..N drive
cycles between bus events; kernel guarantees drive-flush before any
externally observable bus mutation or read on the C64 side. Symmetric
for c64-flush before drive-side observable bus events (= drive read
of $1800).

### 2. `MachineKernel` interface

```ts
export interface MachineKernel {
  // Time accessors
  c64Cycle(): number;
  driveCycle(): number;

  // Stepping
  runCycles(n: number): void;
  runInstructions(n: number, opts?: RunOpts): RunResult;
  step(): void;

  // Bus event entry points (called from chip wrappers, NOT from
  // CPU). Chips must call these for any access that touches a peer
  // chip's state.
  onC64BusRead(addr: number, ctx: BusAccessContext): number;
  onC64BusWrite(addr: number, value: number, ctx: BusAccessContext): void;
  onDriveBusRead(addr: number, ctx: BusAccessContext): number;
  onDriveBusWrite(addr: number, value: number, ctx: BusAccessContext): void;

  // Diagnostics
  // Mode locked to "hybrid" (per Sprint 112 Q4 decision):
  // lockstep tick stays + push-flush at IEC access points layered
  // on top. Pure-lockstep and pure-push-flush kept as compile-time
  // options for ablation/regress, not as user-facing mode selector.
  getKernelMode(): "hybrid" | "lockstep-only" | "push-flush-only";
  getActiveCompatibilityHooks(): string[];   // for Spec 144

  // Trace
  attachTraceProducer(p: BusAccessTraceProducer): void;
}

export interface BusAccessContext {
  side: "c64" | "drive";
  clock: number;             // c64 cycle for c64 side, drive cycle for drive
  pc: number;
  opcode: number;
  phase: string;
  rmw: boolean;
}
```

### 3. Bus access contract

For each address range, document who handles it:

| Range | Side | Implementation |
|---|---|---|
| $0000-$0001 | c64 | CPU port (c64 CPU local) |
| $D000-$D3FF | c64 | VIC |
| $D400-$D7FF | c64 | SID |
| $DC00-$DCFF | c64 | CIA1 |
| $DD00-$DDFF | c64 | CIA2 → IecBus on PA |
| ... | ... | ... |
| Drive $0000-$07FF | drive | Drive RAM |
| Drive $1800-$1BFF | drive | VIA1 → IecBus on PB |
| Drive $1C00-$1FFF | drive | VIA2 → GCR |
| Drive $C000-$FFFF | drive | DOS ROM |

For each, specify: does access go through the kernel? Or stay
local? (RAM stays local; I/O goes through kernel.)

### 4. Migration map

Field-by-field migration of:

- `IntegratedSession` (772 lines today): retain as a high-level
  scenario host; delegate scheduling to kernel.
- `CycleLockstepSchedulerImpl` (133 lines): becomes one of two
  kernel modes (lockstep or push-flush). User selects via session
  option.
- `IecBus` (300 lines): keeps state, gains BusAccessContext-aware
  read/write methods. Loses `beforeC64Read` hook.
- `Via6522` (392 lines): ATN edge propagation routes through kernel
  with timestamp.
- `DriveCpu` (224 lines): retains `executeToClock` but called only
  by kernel.

### 5. Invariants future specs must preserve

1. No chip may call another chip's tick/step method.
2. Every observable bus event has a single, monotonic `clock` stamp.
3. Compatibility hooks are explicit, mode-guarded, and reported.
4. Kernel can be queried for "what just happened on the bus"
   (Spec 142 hook).
5. Kernel mode default = `"hybrid"` (Sprint 112 Q4 decision):
   per-cycle lockstep tick + push-flush at every $DD00 access. The
   alternate modes (`lockstep-only`, `push-flush-only`) remain as
   ablation toggles for diagnosis only, never as production
   acceptance gates. Mode reported in session output (Spec 144).

## Acceptance

- [ ] `docs/headless-machine-kernel-architecture.md` exists
      (≥2000 words, ≥1 mermaid).
- [ ] `MachineKernel` interface sketched in TypeScript with full
      method signatures and JSDoc.
- [ ] Bus address responsibility table complete.
- [ ] Migration map names every existing file impacted, with
      retain/refactor/replace annotation.
- [ ] Document feeds Spec 140's exact deliverable list.
- [ ] No code changes outside this doc + the spec itself.

## Estimated effort

2-3 days:
- 1.0d: write architecture doc skeleton + clock-domain section
- 0.5d: API sketch
- 0.5d: bus address table
- 0.5d: migration map
- 0.5d: cross-check vs 142+143 evidence (probe 138 result)

## Risks

- **R1**: Design diverges from probe 138 evidence. Mitigation:
  spec 139 starts AFTER probe 138 (per execution order). Probe
  result feeds the cache-vs-flush decision in §1.
- **R2**: Over-engineering. Mitigation: kernel interface keeps
  scheduler-mode choice (lockstep/push-flush) — does not force one.

## Files

To create:
- `docs/headless-machine-kernel-architecture.md`

To modify:
- None. Design only.
