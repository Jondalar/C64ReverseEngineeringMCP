# VIC-II Literal Port Debug Notes — 2026-05-10

## Context

The 1541/TrueDrive path is no longer the main blocker. Current visible
failures are VIC-II specific C64 effects:

- raster splits driven by `$D012` IRQ timing
- changing `$D018` mid-frame to switch screen RAM / charset / bitmap
- changing `$D011` and `$D016` for vertical/horizontal smooth scroll
- split screens where top area is logo/bitmap and lower area uses a
  different text/font/screen layout

Claude started a literal VICE x64sc VIC-II port under:

- `src/runtime/headless/vic/literal/vicii-types.ts`
- `src/runtime/headless/vic/literal/vicii-chip-model.ts`
- `src/runtime/headless/vic/literal/vicii-fetch.ts`
- `src/runtime/headless/vic/literal/vicii-draw-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-irq.ts`
- `src/runtime/headless/vic/literal/vicii.ts`

The V3 UI can opt into this renderer through `C64RE_LITERAL_VIC=1`.

## Current Assessment

The literal VIC port is not yet the real VIC-II core. It is currently a
sidecar renderer driven from the existing `VicIIVice` instance through
`vic.onCycle`.

That is enough to render a BASIC READY screen, but not enough for
cycle-sensitive raster effects. Raster splits and smooth scrolling need
the same VIC instance to own:

- register read/write side effects
- raster position
- raster IRQ generation
- BA/AEC bus stealing
- badline state
- matrix/graphics fetch
- pixel pipeline

Right now those responsibilities are split between `VicIIVice` and the
literal port.

## Evidence From Code Review

### 1. CPU/VIC timing is instruction-granular, not cycle-granular

`IntegratedSession.stepMicrocodedC64Instruction()` executes a complete
C64 instruction:

```ts
do {
  this.updateMicrocodedInterruptLines();
  cpu.executeCycle();
} while (!cpu.isAtInstructionBoundary());
```

Only after that does the session tick the VIC by the consumed cycles:

```ts
const consumed = this.c64Cpu.cycles - before;
const vicTick = this.vic.tick(consumed);
```

Files:

- `src/runtime/headless/integrated-session.ts`

Problem:

If a CPU instruction writes `$D011`, `$D016`, `$D018`, `$D020`, etc. on
its final bus cycle, `VicIIVice.tick(consumed)` sees the already-mutated
register value while replaying the whole instruction window. That makes
the write effectively visible too early for the VIC.

This is exactly the class of bug that breaks raster splits and scroll
effects.

### 2. Two VIC models are active at the same time

The existing runtime still uses `VicIIVice` for C64-visible behavior:

- memory-mapped `$D000-$D03F` reads/writes
- raster IRQ state
- `raster_y` / `raster_cycle`
- BA / bus stealing
- scanline logs

The literal port is attached as a renderer sidecar:

```ts
this.vic.onCycle = (...) => {
  litCycle.vicii_cycle();
};
```

Files:

- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/vic/vic-ii-vice.ts`

Problem:

One VIC determines when the CPU sees IRQs and raster state. Another VIC
draws the pixels. If they diverge by even one cycle, raster effects will
be wrong.

### 3. `$D011` smooth-scroll / badline state is not wired into the literal port

The literal port's badline check uses `vicii.ysmooth`:

```ts
if ((vicii.raster_line & 7) === vicii.ysmooth) {
  vicii.bad_line = 1;
}
```

But the integration only shares `vicii.regs = this.vic.regs`. The
literal field `vicii.ysmooth` is not updated by `$D011` writes because
`vicii-mem.c` is not ported/integrated as the active store path.

Files:

- `src/runtime/headless/vic/literal/vicii-cycle.ts`
- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/vic/vic-ii-vice.ts`

Problem:

Vertical smooth scroll and badline timing depend on `$D011 & 7`. If
`vicii.ysmooth` is stale, D011 scroll effects and badline placement are
wrong.

### 4. `vicii-mem.c` is missing from the active path

The current C64 memory bus writes to `VicIIVice.write()`:

```ts
this.ioHandlers.get(normalized)?.write?.(normalized, byte);
```

`VicIIVice.write()` contains the existing translated write logic. The
literal port does not receive the real VICE `vicii_store()` side effects.
Color registers are mirrored by polling:

```ts
for (let r = 0x20; r <= 0x2e; r++) {
  const v = this.vic.regs[r] & 0x0f;
  if (v !== prevColRegs[r - 0x20]) {
    litDraw.vicii_monitor_colreg_store(r, v);
  }
}
```

Files:

- `src/runtime/headless/memory-bus.ts`
- `src/runtime/headless/vic/vic-ii-vice.ts`
- `src/runtime/headless/integrated-session.ts`

Problem:

VICE register writes are not just `regs[reg] = value`. They update
derived state, IRQ state, badline state, color pipeline state, raster
compare state, memory pointers, collision latches, and sometimes timing.

Polling color registers is not a substitute for `vicii-mem.c`.

### 5. Literal VIC state is a singleton and not reset with the session

The literal port exports one global:

```ts
export const vicii: vicii_t = new_vicii_t();
```

It is initialized in `installLiteralPortRenderer()`, but `resetCold()`
does not reset the literal port.

Files:

- `src/runtime/headless/vic/literal/vicii-types.ts`
- `src/runtime/headless/integrated-session.ts`

Problem:

Multiple sessions, UI resets, warm resets, or repeated tests can carry
literal VIC state across runs. That will create non-deterministic visual
bugs.

## Primary Hypothesis

The current bugs are not mainly in `vicii-draw-cycle.ts`.

The primary bug class is integration timing:

> CPU register writes reach the VIC at the wrong cycle, and the literal
> port is not the same VIC instance that owns register IO, IRQs, badlines,
> and BA.

Fixing individual pixels before this is corrected will likely only move
the error around.

## Debug Target

Do not start with a full game.

Start with a tiny deterministic VIC test PRG that does only this:

1. Set normal text mode.
2. Wait for a specific `$D012` line.
3. On that line, change `$D020` only.
4. On a later line, change `$D018`.
5. On another line, change `$D016 & 7`.
6. On another line, change `$D011 & 7`.

Expected output:

- horizontal border color split at the exact raster line
- lower screen uses different screen/charset after the `$D018` split
- horizontal pixel offset changes exactly after the `$D016` write
- badline/vertical scroll behavior changes exactly after the `$D011`
  write

Capture the same PRG in VICE x64sc and Headless literal port. Compare
framebuffer and event trace around the first differing raster line.

## Required Trace For This Bug

For a focused window around the failing raster line, record:

| Clock | CPU PC | CPU op | Write addr/value | VIC raster line | VIC cycle | Literal raster line | Literal cycle | D011 | D016 | D018 | bad_line | ysmooth | vc | rc | vmli |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

Minimum events:

- every CPU write to `$D011`, `$D012`, `$D016`, `$D018`, `$D020-$D026`
- every literal `vicii_cycle()` with line/cycle state
- badline transitions
- matrix fetches
- graphics fetches
- raster IRQ trigger/clear

The key question:

> On the exact CPU cycle where the store occurs, does the literal VIC
> apply the write at the same relative point as VICE?

## Fix Plan

### Step 1 — Port/integrate `vicii-mem.c`

Port `viciisc/vicii-mem.c` into:

- `src/runtime/headless/vic/literal/vicii-mem.ts`

It must provide literal equivalents for at least:

- `vicii_store()`
- `vicii_read()`
- `d011_store()`
- `d012_store()`
- `d016_store()`
- `d018_store()`
- `d019_store()`
- `d01a_store()`
- collision reads/clears
- color register stores

Do not keep polling color registers once this lands.

### Step 2 — Make literal VIC own `$D000-$D03F` in literal mode

When `useLiteralPortRenderer=true`, register C64 IO handlers so CPU
reads/writes go through literal `vicii_read/store`, not through
`VicIIVice.write()`.

Temporary bridge is acceptable only if it is explicit:

- `VicIIVice` may remain for non-literal mode.
- literal mode must have one active VIC owner for register semantics.

### Step 3 — Apply CPU writes at the exact cycle

The C64 CPU microcoded path already has `executeCycle()`. The VIC must
advance in the same loop, not after the whole instruction.

Desired shape:

```ts
do {
  updateInterruptLines();
  cpu.executeCycle();      // may read/write IO on this bus cycle
  vicii_cycle();           // or the correct VICE-relative phase order
  cia.tick(1);
  sid.tick(1);
  keyboard.advance(1);
} while (!cpu.isAtInstructionBoundary());
```

The exact CPU/VIC phase order must be checked against VICE. Do not guess.
If VICE applies the store before the next VIC cycle, match that. If after,
match that.

### Step 4 — Stop using `VicIIVice` as the hidden timing source in literal mode

Literal mode should not depend on `this.vic.raster_y` or
`this.vic.raster_cycle` for correctness. It can expose compatibility
fields for UI/status, but the source of truth must be `literal.vicii`.

### Step 5 — Reset literal state on every machine reset

`resetCold()` must reset literal VIC state when literal mode is active:

- `vicii_reset()`
- bind RAM/char/color again if needed
- reset framebuffer accumulator
- reset line capture bookkeeping

## Do Not Investigate Yet

Do not spend time on these until the above is fixed:

- optimizing renderer performance
- refactoring the literal port into idiomatic TypeScript
- changing palettes
- tuning crop/alignment as the main fix
- game-specific hacks for MotM, Maniac Mansion, etc.
- sprite priority/collision polish unless the minimal split PRG reaches
  that exact failure
- replacing G64/1541/IEC code

## Acceptance

This bug is not closed by "BASIC READY renders".

Acceptance requires:

1. Minimal split PRG matches VICE for `$D020` raster color split.
2. Minimal split PRG matches VICE for `$D018` screen/charset switch.
3. Minimal split PRG matches VICE for `$D016` horizontal smooth scroll.
4. Minimal split PRG matches VICE for `$D011` vertical smooth scroll /
   badline behavior.
5. A real game screen with split VIC layout renders without structural
   drift.
6. Any remaining pixel diffs are documented with VICE source line refs
   and exact known limitation.

## Useful Commands

Build:

```sh
npm run build:mcp
```

Current literal renderer sanity checks:

```sh
node scripts/smoke-vic-298-literal-render-frame.mjs
node scripts/smoke-vic-298k-integrated.mjs
node scripts/smoke-vic-298-diff-vs-rasterized.mjs
```

These are useful, but they are not sufficient acceptance for raster
effects.
