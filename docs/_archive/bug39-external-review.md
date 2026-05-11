# Bug 39 external review — real IEC LOAD bit-skip

## Status

This review reflects the state after Sprint 93, Sprint 93.1, Sprint 95,
and Sprint 96 part 1-4.

The original Spec 093 concern is resolved: the MCP integrated-session
tool now exposes `use_cycle_lockstep` and `use_microcoded_cpu`; G64
sessions default both to enabled; the tool returns the effective runtime
mode.

The current blocker is Bug 39: real KERNAL `LOAD"*",8,1` over IEC fails
with `?DEVICE NOT PRESENT`. This happens before Maniac Mansion reaches
the custom-loader stage. It is not a G64 parser problem.

## What is solid

- The drive ROM is running.
- The C64 reaches the real KERNAL IEC path.
- ATN is observed by the drive.
- Drive device-ID jumper polarity was wrong and is now fixed.
- Drive RAM `$77` now becomes `$28`, matching LISTEN device 8.
- The drive enters the 1541 ACPTR byte-receive path.
- The byte being assembled in drive RAM `$85` is wrong.
- Reproduced locally after rebuilding:
  - `scripts/sprint96-byte85.mjs` ends with `$85=a0`, `$79=0`,
    `$77=28`.
  - `scripts/sprint96-bit-edge.mjs` shows the drive gets the first
    bits correctly, then loses alignment.

This means Sprint 96 has narrowed the issue to real IEC bit receive
timing, not disk decoding or file lookup.

## Main concern

The current Bug 39 handoff says the drive probably skips exactly one bit
because `DriveCpuCycled` runs the legacy drive CPU instruction in one
chunk. That hypothesis is plausible and likely, but the existing probes
do not yet prove it cleanly.

Most scripts sample with `session.runFor(1)`. In this API, `1` means one
C64 instruction, not one drive cycle. That makes the probes good enough
to identify the symptom, but not precise enough to prove the exact
sub-cycle cause.

Before implementing a large fix, add one direct probe at the bus-read
site.

## Code-level observation

The C64 side can run the true microcoded CPU:

- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/cpu/cpu6510-cycled.ts`

The drive side does not. In lockstep mode, drive execution currently
uses:

- `src/runtime/headless/scheduler/cycle-wrappers.ts`
- class `DriveCpuCycled`

`DriveCpuCycled.executeCycle()` calls `this.drive.cpu.step()` when
`cyclesOwed === 0`, then burns the remaining cycles. That means the
legacy `Cpu6510.step()` decides all memory accesses inside one JS call.
The 1541 VIA1 read at `$1800` is therefore not guaranteed to happen on
the real 6502 sub-cycle of `LDA $1800`.

For IEC bit-bang, that is a serious limitation. The 1541 ROM ACPTR loop
depends on sampling DATA while CLK is released. If the `$1800` read lands
a few cycles too early or too late, the drive can miss a short CLK-high
window and shift the received byte.

## Recommended next step

Add exact instrumentation at the point where the drive actually reads
VIA1 `$1800`.

The log should be emitted from `DriveBus.read()` or the VIA1 PB backend,
not from a polling loop. Record every `$1800` read while drive PC is in
the ACPTR receive window:

- C64 cycle
- drive cycle
- drive PC
- drive A/X/Y/P/SP
- drive RAM `$85`, `$98`, `$77`, `$79`
- effective IEC line state: ATN, CLK, DATA
- C64 driver state
- drive driver state
- last C64 `$DD00` write before this read
- distance in cycles from that `$DD00` write

This answers whether the drive sampled just before, inside, or just
after the CLK-high window.

## Fix decision gate

Only after that direct read-site log exists:

1. If `$1800` is read at the wrong sub-instruction moment, move the drive
   CPU to a true cycle-stepped implementation.
2. If `$1800` reads at the correct moment but DATA is wrong, inspect IEC
   polarity/driver composition again.
3. If `$1800` reads at the correct moment and DATA is correct, inspect
   the 1541 ROM path around `$EA0B-$EA22` and RAM `$85/$98`.
4. If the drive is correct but the C64 bit windows are too short or
   shifted, inspect CIA1 timer and KERNAL-side timing.

## Preferred fix

The durable fix is to make the drive CPU cycle-stepped too, using the
same microcoded CPU machinery or an equivalent 6502-specific variant.
The drive-side CPU does not need C64 `$00/$01` port behavior, but it does
need:

- correct reset/vector handling
- correct IRQ service timing
- bus reads/writes on real instruction sub-cycles
- support for the documented and stable undocumented opcodes used by the
  1541 ROM or loaders

An ad-hoc fixed delay in `DriveCpuCycled` may be useful as an experiment,
but it should not become the final architecture unless the direct
read-site probe proves the delay is sufficient across LISTEN, SECOND,
NAME, payload, and ACK phases.

## Additional caveat

`Cpu6510Cycled.serviceInterrupt()` still compresses interrupt service in
one method call and adds cycles internally. That may be acceptable for
the C64 side after the scheduler delta fix, but drive ATN IRQ timing is
especially sensitive. If the drive CPU is moved to the microcoded path,
verify interrupt entry as part of the drive acceptance test.

## Acceptance

Bug 39 is not closed until all of these are true:

- all 8 bits of LISTEN `$28` are sampled correctly:
  `0,0,0,1,0,1,0,0`
- drive RAM `$85 == $28` after the byte receive
- drive RAM `$79` enters listener-active state
- KERNAL does not print `?DEVICE NOT PRESENT`
- SECOND byte and NAME byte are accepted after LISTEN
- `LOAD"*",8,1` starts returning file bytes without KERNAL serial traps

## Do not touch

- Do not touch `src/disk/g64-parser.ts`.
- Do not add Maniac Mansion-specific PC traps.
- Do not use KERNAL serial traps to declare Bug 39 fixed.
- Do not rewrite the GCR/SYNC layer before LISTEN/SECOND/NAME over IEC
  works.
