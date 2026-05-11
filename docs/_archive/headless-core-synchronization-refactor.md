# Headless Core Synchronization Refactor

## Status

Draft architecture note for the post-Sprint-111 TrueDrive work.

This document reframes the motm fastloader failure from a local
bit-bang bug into a core synchronization problem. Spec 138 remains a
useful probe, but it is not the architecture-level fix.

## Hypothesis

The current headless runtime is close enough for normal KERNAL LOAD and
some real-serial flows, but it is not yet a coherent emulator kernel.
It combines several timing models:

- cycle-lockstep scheduler
- VICE-style `executeToClock`
- live IEC bus getters
- optional C64-side flush hooks
- per-object chip wrappers
- direct workaround hooks such as the drive RAM `$7C` ATN poke

This hybrid model can produce observable states VICE never produces.
The likely failure mode in motm is not payload corruption or G64 parser
behavior. The drive executes the right custom code, but a drive-side
`$1800` read during the 24-bit receive window samples a different IEC
DATA/CLK state than VICE at the same logical point.

In other words: the bug is probably caused by a missing global
synchronization invariant, not by a single wrong bit mask.

## Design Claim

TypeScript is not the blocker. A synchronous Node process can behave
like a single native emulator binary if all chips share one explicit
simulation kernel and no asynchronous work exists in the hot path.

The problem is architectural:

- VICE centralizes observable IEC synchronization around main CPU clock
  access points.
- The headless runtime distributes the same concern across object
  callbacks, scheduler order, live getters, and compatibility hooks.

For TrueDrive fastloader support, the runtime must prefer a VICE-like
observable contract over a clean but under-specified object model.

## Target Invariants

The refactor should establish these hard rules:

1. **Single machine kernel owns time.**
   C64 CPU, drive CPU, CIA, VIA, VIC, SID, IEC, GCR, keyboard, and disk
   all run through one scheduler contract. Components do not advance
   time independently in production TrueDrive mode.

2. **Every bus access has an explicit timestamp.**
   Reads and writes to `$DD00`, `$1800`, `$1C00`, CIA, VIA, and memory
   mapped I/O happen at a defined C64 or drive clock.

3. **IEC follows a VICE-compatible observable contract.**
   C64-side `$DD00` reads/writes flush the drive to the current C64
   clock before returning or mutating externally visible bus state.

4. **The IEC bus has one authoritative state.**
   Decide deliberately whether each line/port is VICE-style cached
   (`cpu_port`, `drv_port`, `drv_bus`, `drv_data`) or physically live.
   For compatibility debugging, VICE-style cached state should be the
   default until proven otherwise.

5. **IRQ edge timing is clocked, not incidental.**
   CA1/CB1/T1/T2 events carry the clock at which they occurred. The CPU
   interrupt entry delay is computed from that timestamp, not from
   whichever instruction boundary happens to observe the flag.

6. **No hidden rescue hooks in TrueDrive mode.**
   Direct `$7C` pokes, synthetic line releases, and KERNAL/file traps are
   debug or fallback modes only. TrueDrive acceptance cannot depend on
   them.

7. **Traceability is part of the architecture.**
   Every unresolved fastloader bug must be reducible to a side-by-side
   VICE/headless event diff at bus-access granularity.

## Epics

### Epic A — Kernel Contract

Define the machine-kernel API and ownership boundaries:

- one `MachineKernel` or equivalent runtime coordinator
- explicit C64 and drive clock domains
- central stepping APIs for cycles, instructions, events, and scenarios
- no chip component may advance another subsystem outside the kernel
  contract

Acceptance:

- TrueDrive sessions can report the exact active kernel mode.
- C64 and drive clocks are monotonic and reproducible.
- all hot-path bus callbacks receive a clock/context object.

### Epic B — VICE-Compatible IEC Core

Replace ad hoc IEC synchronization with a VICE-style IEC core:

- authoritative `cpuBus`, `cpuPort`, `drvBus`, `drvData`, `drvPort`
  state
- C64-side read/write flush contract
- drive-side VIA1 read/write contract
- explicit ATN edge propagation and CA1 signaling
- multi-drive shape preserved, even if only drive 8 is active first

Acceptance:

- synthetic IEC matrix still passes.
- MM real KERNAL LOAD stays green.
- motm 24-bit receive produces the same first three command bytes as
  VICE.

### Epic C — Clocked VIA/CIA Interrupt Model

Move CA1/T1/T2/IFR/IER behavior from immediate flag side effects to a
clocked interrupt model:

- event timestamp on CA1/CB1/CA2/CB2 transitions
- timer underflow timestamp
- interrupt delay matching VICE/relevant 6522 behavior
- trace output includes event clock and service clock

Acceptance:

- drive IRQ entry timing can be compared to VICE within a small cycle
  tolerance.
- the Sprint 66 `$7C` workaround is no longer needed in TrueDrive mode.

### Epic D — Bus-Access Trace and Diff Tooling

Add mandatory tracing for timing bugs:

- C64 `$DD00` read/write events
- drive `$1800` read/write events
- raw IEC lines and cached IEC ports
- CPU, PC, opcode, instruction phase, clock domain, cycle
- VICE trace import for the same event shape
- diff command that reports first logical divergence

Acceptance:

- motm failure can be reduced to one first differing `$1800` or `$DD00`
  event.
- the trace is small enough to keep as a regression artifact.

### Epic E — TrueDrive Mode Cleanup

Separate production TrueDrive behavior from debug/fallback behavior:

- trap flags remain available but are excluded from TrueDrive
  acceptance
- `$7C` poke and synthetic IEC releases become explicit compatibility
  hacks with mode guards
- session reports expose all non-hardware shortcuts

Acceptance:

- a TrueDrive test run can prove no trap or hidden hack fired.
- debug/fallback modes still exist for RE convenience.

## Proposed Spec Cut

### Spec 139 — Kernel Synchronization Architecture

Goal: produce the concrete design for the central machine kernel before
more bug fixes land.

Deliverables:

- architecture doc for clock domains and component ownership
- API sketch for `MachineKernel`
- migration map from `IntegratedSession` and `CycleLockstepScheduler`
- list of hot-path APIs that need clock/context arguments

Acceptance:

- approved design says exactly where C64, drive, VIA, CIA, IEC, VIC,
  SID, GCR, and input tick.
- no implementation story is allowed to invent a second timing model.

### Spec 140 — IEC Port Cache and Flush Contract

Goal: make our IEC observable semantics intentionally VICE-compatible.

Deliverables:

- add authoritative IEC cached state equivalent to VICE `cpu_bus`,
  `cpu_port`, `drv_bus`, `drv_data`, `drv_port`
- C64 `$DD00` read/write path flushes drive before returning/mutating
- drive `$1800` read path reads the authoritative drive port state
- synthetic tests for standard KERNAL LISTEN/TALK and custom bit-bang
  edge cases

Acceptance:

- existing IEC matrix green
- MM LOAD green
- motm first 24-bit receive command bytes match VICE for at least the
  first three receives

### Spec 141 — Clocked VIA1 CA1 / IRQ Timing

Goal: remove incidental ATN IRQ timing and model CA1 with a clocked
event contract.

Deliverables:

- CA1 edge event carries clock, edge polarity, and source
- VIA1 IFR/IER update is timestamped
- drive CPU interrupt service honors deterministic delay
- trace records edge clock, IRQ-visible clock, and service PC

Acceptance:

- drive ATN handler entry aligns with VICE trace within tolerance
- TrueDrive mode can run without the `$7C` ATN-pending poke

### Spec 142 — Bus-Access Trace Ring

Goal: make the next motm investigation mechanical instead of forensic.

Deliverables:

- instruction-boundary trace for C64 and drive
- `$DD00` and `$1800` access trace with values and line/port state
- optional capture window around PC ranges such as drive `$042F-$044C`
- JSONL output suitable for regression artifacts

Acceptance:

- one headless motm run produces a compact trace of the 24-bit receive
  window
- the trace proves which exact bit/access diverges

### Spec 143 — VICE / Headless IEC Diff

Goal: compare headless and VICE at bus-event level.

Deliverables:

- VICE capture adapter for `$DD00`/drive `$1800` windows
- normalization into the same event schema as Spec 142
- first-divergence report grouped by logical receive/send index

Acceptance:

- report says whether divergence is C64 output, drive sample, cached
  port state, IRQ timing, or dispatch logic
- output is concise enough for an LLM to consume without raw trace
  scanning

### Spec 144 — TrueDrive Mode Hygiene

Goal: remove ambiguity about whether a passing run used real hardware
semantics or a shortcut.

Deliverables:

- mode guard around `$7C` poke, synthetic releases, KERNAL/file traps
- session summary lists every non-hardware shortcut used
- acceptance tests assert no shortcut fired in TrueDrive scenarios

Acceptance:

- TrueDrive pass/fail cannot be accidentally satisfied by traps or
  rescue hooks
- fallback/debug modes remain explicitly available

## Relationship To Spec 138

Spec 138 should be treated as a probe and possible short-term fix. If
it improves motm, it validates the synchronization hypothesis. If it
does not, it still documents a real VICE/headless divergence.

But Spec 138 must not become the final architectural answer. The final
answer is a coherent kernel contract plus VICE-compatible IEC semantics
with traceable timing.

## Recommended Execution Order

1. Spec 142 first if debugging must continue immediately.
2. Spec 143 next so every future attempt has VICE/headless evidence.
3. Spec 139 before large implementation changes.
4. Spec 140 as the first kernel-facing behavior change.
5. Spec 141 to remove ATN/IRQ timing ambiguity.
6. Spec 144 before declaring any TrueDrive acceptance milestone.

