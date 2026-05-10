# ADR: VICE Execution Contract Port

**Status:** Accepted 2026-05-10

**Scope:** Headless Runtime core, V1/V2/V3 emulator behavior.

**Amends:** `docs/adr-headless-machine-kernel.md`

## Context

The project goal is no longer "VICE-inspired behavior". The goal is a
headless C64 + 1541 runtime that behaves like VICE `x64sc` at the
software-visible boundary.

Recent work moved several chips toward literal VICE ports:

- CPU: `Cpu65xxVice`
- CIA: `Cia6526Vice`
- VIA: `Via6522Vice`
- VIC-II: literal `viciisc` TypeScript port
- 1541 drive CPU/VIA/GCR path

This is necessary but not sufficient. A literal chip port can still
behave incorrectly when the outer execution order differs from VICE.
The current VIC-II Scramble bugs show this failure mode clearly: the
literal VIC-II files have been audited against VICE, but raster effects
still drift. The remaining suspect is not isolated pixel code; it is
the global execution contract:

- which component runs first in a master cycle
- when alarm contexts dispatch
- when CIA/VIC assert IRQ/NMI lines
- when the CPU samples those lines
- when CPU writes become visible to VIC/CIA/IEC
- when drive/C64 domains catch up to each other

Therefore, future core work must port the VICE call graph and timing
contract, not just isolated chip source files.

## Decision

C64RE Headless Runtime shall treat the VICE execution contract as the
compatibility authority.

For emulator-core behavior, an implementation is not considered correct
because it has a locally plausible TypeScript scheduler or because a chip
file resembles VICE. It is correct only when the following are identified
and matched:

1. The exact VICE source function.
2. The VICE caller.
3. The VICE clock domain.
4. The VICE alarm context.
5. The VICE dispatch order.
6. The VICE line/state visibility point.
7. The VICE CPU-boundary relationship.

The project may use TypeScript, helper classes, and API boundaries, but
they must preserve this execution contract exactly.

## Binding Rule

Do not port isolated chips. Port the VICE execution path.

For any timing-sensitive fix, the implementation agent must answer:

```text
Which VICE function does this correspond to?
Who calls it in VICE?
At which clock?
Before or after PROCESS_ALARMS?
Before or after interrupt check?
Before or after VIC/CIA/IEC line visibility changes?
What is the first trace event proving parity?
```

If these questions are unanswered, the change is a probe, not a core
fix.

## Current Known Deviation

The active Headless microcoded path still has an external interrupt-line
refresh layer in `IntegratedSession`.

The current shape is approximately:

```text
updateMicrocodedInterruptLines()
tickLitVic()
cpu.executeCycle()
```

This differs from the intended VICE-style contract. A VIC raster IRQ can
be generated inside `tickLitVic()` after the CPU IRQ line has already
been refreshed for that cycle. CIA alarms can also dispatch inside the
CPU boundary path, while the external mirrored `cpu.irqLine` was set
earlier.

This can shift IRQ handler entry by one cycle or one instruction
boundary. For normal code this is often invisible. For D012/D016/D018
raster effects it is enough to move mid-frame register writes to the
wrong raster position.

This is now the primary architectural suspect for the remaining VIC-II
real-game drift.

## Required Target Shape

The runtime needs one VICE-compatible execution owner for a C64 master
cycle / CPU boundary.

Conceptually:

```text
advance due chip/event state at the VICE-defined point
dispatch due alarms at the VICE-defined point
make IRQ/NMI line state visible at the VICE-defined point
CPU performs VICE interrupt check / opcode fetch / cycle execution
advance VIC/CIA/SID/IEC/drive state in VICE-compatible order
```

The final implementation does not need to look textually identical to
VICE C, but the call order and visibility points must be trace-equivalent.

## Non-Goals

Until the execution contract is aligned, do not investigate or patch:

- Scramble-specific rendering hacks
- sprite/border semantic changes in `vicii-draw-cycle.ts`
- palette differences
- framebuffer capture races already eliminated by stable-frame capture
- `VicIIVice` dual-truth diff harnesses already made obsolete
- further isolated CIA/VIC/VIA rewrites without caller-order analysis
- new renderers
- Rust port work
- game-specific workarounds

## Required Next Spec

Create one focused spec for the execution contract alignment.

Suggested title:

```text
Spec 309 - VICE execution contract: alarms, IRQ lines, CPU boundary order
```

Mandatory scope:

1. Map VICE `maincpu.c` / `6510core.c` CPU boundary order.
2. Map VICE alarm dispatch order for maincpu and drivecpu contexts.
3. Map VIC raster IRQ visibility into CPU IRQ state.
4. Map CIA IRQ/NMI visibility into CPU line state.
5. Remove or relocate `IntegratedSession.updateMicrocodedInterruptLines`
   so it no longer runs before the events it is supposed to expose.
6. Add a trace harness that reports, for VICE and Headless:
   - master clock
   - CPU PC
   - CPU instruction boundary
   - VIC raster line/cycle
   - VIC IRQ status/mask
   - CIA1/CIA2 IRQ/NMI line state
   - CPU irqLine/nmiLine sampled state
   - first IRQ handler PC
7. Prove one minimal D012 raster IRQ PRG matches VICE by event order,
   not screenshot.
8. Only then re-run Scramble pixel diffs.

Out of scope for that spec:

- pixel pipeline changes
- sprite/border fixes
- palette
- UI
- drive media attach
- performance

## Acceptance Standard

A core timing change is accepted only when it includes at least one
trace-level parity proof against VICE.

Screenshot improvement alone is not acceptance.

Required proof shape:

```text
VICE:
  irq asserted at master_clock A
  CPU samples IRQ at boundary B
  handler PC reached at C

Headless:
  irq asserted at master_clock A
  CPU samples IRQ at boundary B
  handler PC reached at C
```

Allowed tolerance is zero unless a documented VICE source reason says
otherwise.

## Consequences

- The scheduler/alarm/IRQ boundary becomes part of the emulator core,
  not glue code.
- `IntegratedSession` must continue moving toward facade status.
- Literal chip ports remain valuable, but their callers are now equally
  important.
- Implementation agents must stop treating "fix the game" as the task.
  The task is "match the VICE event that makes the game work".
- VirtualC64 remains useful as a clean cycle-scheduler architecture
  reference, but VICE remains the compatibility oracle.

## Working Instruction For Agents

When touching runtime core code, write this at the top of the plan:

```text
I am porting a VICE execution path, not inventing a TypeScript scheduler.
The VICE call order I am matching is: ...
The first parity trace I will produce is: ...
```

If the plan cannot fill those blanks, stop and do source analysis first.
