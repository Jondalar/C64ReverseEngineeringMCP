# CIA Fidelity Notes (Spec 104 / M2.2)

## v1 status

| Sub-story | Status     | Where                                                          |
|-----------|------------|----------------------------------------------------------------|
| M2.2a Timer A modes  | **Covered** | continuous, one-shot via `runTimerAContinuousTest`/`...OneShotTest` |
| M2.2a Timer B modes  | **Covered** | Φ2 + TA-underflow cascade via `runTimerBCascadeTest`. CNT-pin still gap |
| M2.2b TOD R/W        | **Covered** | round-trip + HR-triggered latch + alarm vs clock target via CRB bit 7 |
| M2.2b TOD ticking    | **Gap**     | needs scheduler 50/60 Hz pin source — software path unaffected |
| M2.2c ICR mask       | **Covered** | write `$80\|m` sets, write `m` clears, read clears flags + IRQ |
| M2.2c ICR 1-cyc latch| **Gap pinned** | v1 fires IRQ immediately on mask write that catches existing flag; real CIA inserts 1-cycle delay |
| M2.2d Serial SR      | **Gap**     | stub only — SDR R/W round-trips, no CNT-clocked shift |
| M2.2e Keyboard matrix| **Covered** | Sprint 79 scriptable keyboard + integrated-session smoke |
| M2.2f CIA2 NMI       | **Covered** | integrated-session NMI path tested under regress L7 (MM 38KB) |
| M2.2g Documentation  | **This file** | — |

`npm run smoke:cia-fidelity` — 23/23 pass.
`npm run regress` — 5/5 still green.

## TOD register file

Four BCD registers per CIA, with separate alarm shadow:

```
$DC08 / $DD08  TOD 1/10s (bits 0-3)
$DC09 / $DD09  TOD seconds (BCD, bits 0-6)
$DC0A / $DD0A  TOD minutes (BCD, bits 0-6)
$DC0B / $DD0B  TOD hours   (BCD, bits 0-4 + AM/PM bit 7)
```

Writes go to **clock** when CRB bit 7 = 0, **alarm** when bit 7 = 1.
Reads always return clock fields; alarm fields only programmable, no
public read register on real CIA either.

**HR-triggered latch.** Reading `$DC0B` (HR) latches all four
registers; subsequent reads of MIN / SEC / 10ths return the latched
values until 10ths is read, which releases the latch. This matches
the real-CIA spec; software that reads HR/MIN/SEC/10ths in that
order gets a coherent snapshot.

## ICR semantics

Read of `$DC0D` returns `flags | (summary if any-mask-flag-set)` and
**clears** all flag bits. Subsequent reads return 0 until a new
underflow / source.

Write of `$DC0D`:
- bit 7 = 1: set every bit-0-4 that is 1 in the value into mask
- bit 7 = 0: clear every bit-0-4 that is 1 in the value from mask

Both CIA1 (IRQ) and CIA2 (NMI) use the same shape; CIA2 just gets
its summary line wired to the NMI vector path.

## Gaps + rationale

### M2.2c — ICR 1-cycle latch delay

Real CIA: when ICR mask write enables a flag that is already set,
the IRQ line goes high one cycle later, not the same cycle as the
write. Our model raises IRQ immediately. Pinned in
`runIcrLatchSemanticsTest` so any change to add the 1-cycle delay
shows up as a deliberate behavior shift.

Impact: software that races ICR write + immediate IRQ-probe in a
tight loop sees IRQ one cycle earlier than real HW. No commercial
software in the acceptance ladder is known to depend on this.

### M2.2b — TOD ticking

TOD currently does not advance over time. Real CIA derives TOD ticks
from a 50 Hz (PAL) or 60 Hz (NTSC) pin tied to the AC line. Our
scheduler does not yet expose that pin; adding it requires a per-
session real-time-source tick that the cycle-lockstep scheduler
emits at ~19704 / ~16639 cycles per tick.

Impact: software that polls TOD for elapsed time sees the value frozen
at last-write. No commercial software in the acceptance ladder
depends on TOD.

### M2.2d — Serial shift register

CIA SDR currently only stores written value. CNT-pin clocked
shift-out / shift-in not modeled. Used by some fastloaders for
parallel-cable mods (XP1541) — explicit out-of-scope per Sprint 100
roadmap.

### M2.2a — Timer A CNT-pin mode + Timer B CNT-only mode

Both gated on CNT-pin source. `tickTimerA` returns 0 when
`(cra & 0x20) != 0` (CNT mode). `tickTimerB` returns when CRB mode
selects CNT-only. Real software using these modes would observe
counters frozen.

## Open follow-ups

- TOD ticking from a scheduler 50/60 Hz pin.
- ICR 1-cycle latch delay (default off; on via `accurateIrq` mode flag).
- Serial shift register CNT-clocked behavior.
- CNT-pin timer-A / timer-B counting modes.

## Files

- `src/runtime/headless/cia/cia6526.ts` — TOD register file + alarm
  shadow + HR-latch (Spec 104 v1 addition).
- `src/runtime/headless/c64/cia-fidelity-tests.ts` — 7 suites, 23
  fixture checks.
- `scripts/smoke-cia-fidelity.mjs` + `npm run smoke:cia-fidelity`.
