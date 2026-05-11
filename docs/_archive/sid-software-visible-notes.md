# SID Software-Visible Behavior (Spec 108 / M2.6) — v1

## Goal

Poll-correct SID without audio output. Software that polls oscillator
readback ($D41B), envelope readback ($D41C), or POT pins ($D419/$D41A)
sees correct values. Audio synthesis is **explicitly out of scope**.

## v1 status

| Sub-story | Status     | Where                                                          |
|-----------|------------|----------------------------------------------------------------|
| M2.6 register write/read | **Covered** | All 32 SID registers latch; reads at $D41D-$D41F return open-bus 0 |
| M2.6a Phase accumulator + waveform readback | **Stubbed** | $D41B returns LFSR-driven noise; full waveform phase accumulator deferred |
| M2.6b ADSR envelope counter | **Covered** | Existing per-voice ADSR tick already correct; tests pin attack ramp + release decay |
| M2.6c POT readback bridge | **Covered** | $D419 ← `paddles[0]`, $D41A ← `paddles[2]` via `sid.potReader` callback |
| M2.6d SID write-trace channel | **Gap** | eof-trace.ts schema extension deferred to follow-up |
| M2.6e Documentation | **This file** | — |

`npm run smoke:sid-fidelity` — 14/14 pass.
`npm run regress` — 5/5 still green.

## Audio output policy

`audioOut: null` is the contract. There is no `getSamples` method, no
WAV export, no PCM stream. SID emulation exists exclusively to
satisfy software polling.

## POT readback bridge

`Sid6581.potReader: (idx: 0|1) => number` is set by `IntegratedSession`
to:

```
sid.potReader = (idx) => paddles[idx === 0 ? 0 : 2] ?? 0;
```

So:
- `read $D419` → `paddles[0]`
- `read $D41A` → `paddles[2]`

Paddles 1 + 3 (POTAY, POTBY) are currently not surfaced via SID
because real-HW paddle wiring multiplexes through CIA2 PA bits 6-7
in a more involved fashion. Spec 107 stores the values; `setPaddle(1,..)`
and `setPaddle(3,..)` are valid but invisible to SID until v2.

## ADSR readback ($D41C — env3)

Voice 3's envelope counter is exposed for software that uses voice 3
as a low-frequency modulation source (a common demo trick). Current
implementation:

- GATE rising edge → attack phase, ramp 0 → 255
- Attack rate from $D413 high nibble drives cycles per step
- Decay phase ramps down to sustain level (low nibble of $D414)
- GATE falling edge → release phase, ramps to 0

Test asserts envelope rises after GATE-on tick + falls to near-zero
after long release tick.

## Oscillator readback ($D41B — osc3)

Voice 3's waveform output exposed for software using osc3 as a
random-noise source. v1 implementation: LFSR-driven noise (matches
real-HW noise mode behaviour). Triangle / saw / pulse waveforms
return current LFSR state, which is *wrong* for those modes but
sufficient for noise-mode-only consumers (most demos using osc3 do
use noise).

## Documented gaps

### M2.6a — Phase accumulator

Real HW: 24-bit phase accumulator per voice incremented by frequency
register × ~1 step per cycle. $D41B returns top 8 bits of accumulator
as transformed by waveform select. We use LFSR only.

**Impact:** Triangle / saw / pulse readback returns noise-pattern
values. Software that reads osc3 expecting waveform-shaped output
sees wrong data. No commercial software in the acceptance ladder
known to depend on this.

**Fix path (v2):** add `phase[3]: number[]` 24-bit accumulator,
tick by frequency register on each cycle, transform to 8-bit per
waveform select.

### M2.6d — SID write-trace channel

eof-trace.ts schema currently has channels for IEC, drive PC, etc.
Adding `sid_writes` channel with `{ cycle, pc, reg, value }` per
write is straightforward but deferred — no consumer currently wants
it.

### Filter

$D415-$D418 (filter cutoff + resonance + filter mode + volume)
latched but no filter math. Software-visible: write/read round-trip
works; `read $D418` returns the volume nibble + filter-mode bits,
which is what polling cares about.

### Chip-revision differences

6581 vs 8580 differences (filter cutoff curve, no-noise-output bug)
not modeled. Software polling rarely cares; if a target game does,
add a `chipRev: "6581" | "8580"` knob to session.

## Files

- `src/runtime/headless/peripherals/sid.ts` — `potReader` callback
  hook + POT register read wiring; existing ADSR tick + env3 read
  unchanged.
- `src/runtime/headless/integrated-session.ts` — `sid.potReader`
  installed during construction.
- `src/runtime/headless/c64/sid-fidelity-tests.ts` — 4 suites,
  14 fixture checks.
- `scripts/smoke-sid-fidelity.mjs` + `npm run smoke:sid-fidelity`.
