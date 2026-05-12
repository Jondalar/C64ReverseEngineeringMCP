# Spec 299 — Per-cycle CPU/VIC interleave (= literal-port timing fix)

**Sprint:** 148  **Status:** OPEN 2026-05-10  **Depends:** 298a-i, 298k steps 1+2+5

## Goal

Per docs/vic-ii-literal-port-debug-2026-05-10.md fix plan **Step 3
ONLY**. Make CPU register writes reach the VIC at the exact cycle
they happen, not at end-of-instruction batched tick.

Today the integrated session steps a complete C64 instruction, then
ticks the VIC by `consumed` cycles. If the instruction writes
`$D011`/`$D016`/`$D018`/`$D020` on its final bus cycle, the VIC
replays that whole cycle window with the already-mutated register —
the write is effectively visible too early.

This is the structural cause of raster split / scroll inaccuracy
that motivates the literal port. Fixing it is a prerequisite for
acceptance of any cycle-sensitive C64 effect.

## Hard scope guards (= per user mandate)

- **Feature-flagged.** New behavior MUST be opt-in. Default path
  unchanged. No regression risk for existing 280-298 smokes / V3 UI.
- **No VicIIVice removal.** VicIIVice keeps owning regs[], raster_y,
  raster_cycle, IRQ, BA in legacy paths. Literal port still tracks
  in parallel. Step 4 (= literal as source of truth) is a SEPARATE
  spec and lands ONLY after Spec 299 is clean.
- **No game debugging.** Acceptance harness uses 4 minimal PRGs ONLY.
  motm / IM2 / Scramble Infinity / MM are explicitly out of scope
  here.
- **No optimization.** Cycle-pumped tick may be slower. Accept it.
  Performance pass = future spec only after acceptance closes.
- **No refactoring.** Same struct field names, same control flow,
  literal port mandate from Spec 298 still binds.

## Acceptance (binary gates)

For EACH of the 4 minimal PRGs:

1. PRG runs against VICE x64sc → capture reference frame PNG.
2. PRG runs against headless with literal port enabled + Spec 299
   per-cycle interleave enabled → capture literal frame PNG.
3. Pixel diff. Tolerance: zero diff in the visible band, or
   documented residual with VICE source line ref.

The 4 PRGs:

  299-PRG-1   `$D020` raster split — change border color at known
              `$D012` IRQ line. Bottom half border ≠ top half.
  299-PRG-2   `$D018` mid-frame swap — change screen RAM pointer at
              raster IRQ. Lower half displays different chars.
  299-PRG-3   `$D016` xsmooth scroll — change xsmooth low 3 bits at
              raster IRQ. Pixel offset shifts at split line.
  299-PRG-4   `$D011` ysmooth/badline — change ysmooth at raster IRQ.
              Vertical scroll + badline line shifts.

Spec 299 closes when all 4 PRGs match VICE within tolerance.

## Implementation outline

### Flag

  Session option: `useLiteralPortVicPerCycle?: boolean` (default false)
  Env: `C64RE_VIC_PERCYCLE=1` enables in start-v3-server.mjs

### Hot path change

  In `IntegratedSession.stepMicrocodedC64Instruction()` (= the
  microcoded CPU loop):

  Before (current):
  ```ts
  do {
    this.updateMicrocodedInterruptLines();
    cpu.executeCycle();
  } while (!cpu.isAtInstructionBoundary());
  const consumed = this.c64Cpu.cycles - before;
  this.vic.tick(consumed);
  ```

  After (gated on flag):
  ```ts
  if (this.useLiteralPortVicPerCycle) {
    do {
      this.updateMicrocodedInterruptLines();
      cpu.executeCycle();
      this.vic.tick(1);   // VicIIVice per-cycle (= drives onCycle hook
                          // which ticks literal port)
    } while (!cpu.isAtInstructionBoundary());
  } else {
    /* legacy batched path unchanged */
  }
  ```

  CIA / SID / drive ticking stays as-is for now (= don't touch
  scheduler unless minimal PRGs prove it's needed).

  Note: VicIIVice already supports per-cycle tick when `onCycle` is
  set (= 297a). Calling tick(1) repeatedly = onCycle fires per cycle
  = literal port advances per cycle = CPU writes land at cycle of
  store, not end of instruction.

### Reset propagation

  Spec 298k step 5 already resets literal port in resetCold. No
  additional changes needed.

### Per-PRG smoke harness

  scripts/smoke-vic-299-prg-{d020,d018,d016,d011}.mjs

  Each smoke:
  1. Boot session (= literal mode + 299 percycle on)
  2. Inject minimal PRG into RAM at $0801
  3. Set PC = $080d (after BASIC SYS line)
  4. Run N cycles enough to hit raster IRQ + render frame
  5. Render literal-port PNG
  6. Compare to checked-in VICE x64sc reference
  7. Pass if pixel diff = 0 in visible band

  PRG sources checked into samples/vic-corpus/299-prgs/
    d020-split.prg + d020-split.asm
    d018-split.prg + d018-split.asm
    d016-scroll.prg + d016-scroll.asm
    d011-scroll.prg + d011-scroll.asm

  VICE references:
    samples/vic-corpus/299-prgs/{name}-vice.png
    Captured separately via x64sc CLI (instructions in spec).

## Out of scope

- ANYTHING beyond per-cycle interleave
- VicIIVice removal (= Spec 300 / Step 4 territory)
- CIA / SID per-cycle interleave (= only if PRG-3 / PRG-4 demands it)
- Per-cycle BA / bus stealing rework
- Real game testing (= deferred until 300 closes)
- Performance optimization
- Refactoring of literal port modules

## Risk register

- **Smoke regressions:** 280-298 smokes assume legacy batched tick.
  Mitigation: per-cycle path is OPT-IN flag. Default path unchanged.
- **CIA timing drift:** CIA1 timer A fires every ~16K cycles based on
  CPU clk. Per-cycle VIC tick doesn't affect CPU clk; CIA stays.
  Mitigation: monitor PRG-4 acceptance (= ysmooth split = depends on
  raster IRQ which depends on VIC raster_line which depends on VIC
  tick).
- **Per-cycle perf:** 985K vic.tick(1) calls/sec instead of N batched.
  Mitigation: accepted per spec mandate. Perf is future spec.
- **Drive timing:** drive ticks via separate path, not affected.
