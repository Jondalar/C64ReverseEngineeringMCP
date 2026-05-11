# Spec 218 - MoTM TX3/TX4 bit-level divergence

**Status:** CLOSED 2026-05-08 — root cause fixed in commit `d927a1a`.
**Resolution:** HL drive `stepInward` had off-by-one allowing head to step past track 35 mechanical stop on G64 images with extended tracks (motm.g64 has 42). Drive ROM JOB-1 with target T35 stepped past T35 → GCR shifter bound to track 36+ → 17/48 reads = "no SYNC" → stage-1 INX-counter $11 instead of $00 → motm runtime LDA operand wrong → sector chain broken → drive deadlock.

Fix: cap stepInward at `Math.min(maxHalfTracks-1, 70)` = real 1541 mechanical stop at track 35. G64 buffer addressing unchanged for write-side support.

Verification:
- motm boots: ALL 7 files load (dad+16dad+riv3+riv2+kernal+riv4+riv1)
- motm title screen renders ("Murder on the Mississippi")
- maniac mansion s1: title + character selection menu
- impossible mission ii: title + in-game
- last ninja remix s1: KERNAL load OK
- Lorenz Disk1 100% PASS (no CPU regression)
- gcr-shifter + sync-detector unit tests PASS
- Screenshots: `samples/screenshots/proof/`

Diagnostic trace tooling (Spec 217 DuckDB store + Spec 205 trace contract) supported the investigation but Spec 218's specific TX3/TX4 swimlane diff was not built — the head-cap root cause was found via per-second head-position probe instead.

**Original Sprint:** diagnostic support for V1 TrueDrive acceptance
**Depends on:** 205 trace contract, 217 DuckDB trace store
**References:**
- `docs/1541-IRQ-FastLoader-Bug.md`
- `samples/traces/v2-baseline/motm-vice-store-2026-05-07/trace.duckdb`
- `samples/traces/v2-baseline/motm-headless-store-2026-05-07/trace.duckdb`
- `/Users/alex/Development/C64/Cracking/Murder/analysis/disk/motm/02_ab_disasm.asm`

## Problem

MoTM `LOAD"*",8,1` now reaches the custom fastloader but headless stalls
after exactly 4096 bytes. VICE continues to game handoff.

Spec 217 reduced the bug from "fastloader broken" to a narrow timing
fault:

- VICE `rx_byte` (`$43CF`) count: 523177
- headless `rx_byte` count: 4096
- VICE `bitbang_tx_24bit` (`$425C`) count: 250
- headless `bitbang_tx_24bit` count: 3
- VICE reaches `game_handoff`; headless does not

The remaining question is not whether headless diverges. It does. The
question is the first AB-fastloader transaction where VICE and headless
stop matching.

## Goal

Produce a small, LLM-readable transaction-level divergence report for
the MoTM AB custom-fastloader path.

**Current scope reset (2026-05-07):** start at AB entry `$4000`, not
drive cold-boot and not KERNAL `LOAD "AB"` internals. The next report
must walk the first AB-side fastloader activation path:

```text
$4000 -> W40B4 -> W42F2/W4314 -> W425C -> W4294
```

and include matching drive `$1800` reads/writes and branches in the
same aligned window.

This spec is the first concrete specialization of the generic
transaction-swimlane tool defined in Spec 217. The MoTM report may have
game-specific anchors and labels, but the underlying capability must
remain reusable for later reverse-engineering questions.

The report must answer:

1. Do VICE and headless execute the same C64 instructions from `$4000`
   through the first `W425C` return/failure?
2. Do they perform the same `$DD00` reads/writes in that window?
3. Does the drive observe the same `$1800` values and take the same
   branch path?
4. What is the first transaction row where they differ?
5. Only after that: which timing source explains that first difference?

The result should be precise enough that the next code change can be a
targeted emulator fix, not another broad probe.

## Non-Goals

- Do not recapture multi-GiB JSONL traces.
- Do not rewrite the G64 parser.
- Do not change fastloader/disassembly artifacts.
- Do not accept lockstep-only behavior as a production fix.
- Do not fix emulator timing inside this spec unless the first
  divergent bit already identifies a one-line defect with clear VICE
  evidence.
- Do not investigate drive cold-boot ordering, KERNAL IOINIT,
  pre-`ab_entry` ATN/LISTEN, `$EBE8/$EBED`, ATNA/PRB boot state, CIA
  timers, VIA1 CA1/T1/IFR, scheduler ratio, CPU implementation swaps,
  G64 parser, or GCR extraction unless the AB-scoped transaction stream
  explicitly points back to them.

## Required Pre-Work

### 1. Normalize trace diffs to a shared anchor

`trace-store-diff.mjs` currently compares absolute `master_clock`
values. The existing VICE and headless captures start at different
absolute offsets, so the report shows an artificial first divergence
of about 15.6M cycles even when the relative fastloader entry aligns.

Add:

```text
--align-anchor ab_entry
```

When set, all comparison clocks are normalized to:

```text
relative_master_clock = event.master_clock - first(ab_entry.master_clock)
```

For anchors that currently store only `clock`, either add
`master_clock` to the `anchors` table and rebuild anchors, or join
back to `instructions` by `(run_id, cpu, seq)` to project
`master_clock`. The preferred durable fix is adding `master_clock` to
`anchors`.

Acceptance:

- `ab_entry` relative clock is `0` for both stores.
- First `rx_byte` relative clocks are within a small tolerance:
  headless about `24.935M`, VICE about `24.894M`.
- Diff output clearly labels absolute and aligned modes.

### 2. Preserve 64-bit clocks

Remove `>>> 0` clock truncation from trace producer and capture code.
This bug does not trigger in the current 60-153s MoTM captures, but it
breaks the long-run trace architecture and must not be copied into the
new diagnostic.

Affected areas observed:

- `src/runtime/trace-store/producer.ts`
- `scripts/headless-trace-store-capture.mjs`
- `scripts/vice-trace-store-capture.mjs`

Use `BigInt(clock)` for integer clocks that are already safe JS
integers, and preserve `bigint` inputs unchanged. Do not route clocks
through unsigned 32-bit coercion.

### 3. Ensure full instruction context in headless captures

The headless capture summary currently says:

```text
instructions table omits register state
```

For this spec, headless instruction rows must include:

- `pc`
- opcode byte and operand bytes
- `a`, `x`, `y`, `sp`, `p`
- native `clock`
- `master_clock`

If the generic CPU channel cannot provide this yet, add targeted
instrumentation only for the PCs in this spec's capture window.

## Capture Window

Use an aligned, narrow window around the post-4096-byte TX.

Primary headless anchors:

- last `rx_byte` occurrence (`$43CF`), currently occurrence 4096
- following `bitbang_tx_24bit` (`$425C`), currently occurrence 3
- surrounding `bitbang_tx_inner` (`$4294`), 24 iterations per command
- drive wait/receive PCs around `$0714`, `$0723`, `$0728`, `$07BE`
- wrong-handler PCs around `$0420-$044C`

Window:

```text
from: last(rx_byte).master_clock - 20_000
to:   bitbang_tx_24bit[3].master_clock + 80_000
```

If VICE occurrence numbers do not line up because VICE continues after
the block, select the VICE TX by aligned relative clock and neighboring
semantic state, not by absolute occurrence number.

## Event Families

The report needs these events, in order by `master_clock`:

### C64 side

- CPU instructions in `$425C-$42BD` (24-bit TX path)
- CPU instructions in `$43C7-$43E9` (RX wait/read path)
- `$DD00` reads and writes
- decoded IEC output bits from `$DD00`
- registers for each instruction row

### 1541 side

- CPU instructions in `$0714-$0732` (active drive RX)
- CPU instructions in `$07BE-$07C8` (drive RX wait)
- CPU instructions in `$0723-$072A` (expected command decode path)
- CPU instructions in `$0420-$044C` (observed wrong handler path)
- `$1800` reads/writes (VIA1 PRB / IEC lines)
- `$1804/$1805` T1 counter/latch accesses
- `$180B` ACR reads/writes
- `$180D` IFR reads/writes
- registers for each instruction row

### IEC line state

For every `$DD00` write and every drive `$1800` read, record:

- ATN line
- CLK line
- DATA line
- source actor (`c64`, `drive8`, or `bus`)
- line state before event
- line state after event

Use open-collector semantics in the decoded view. Do not compare raw
port bits without explaining inversion and line ownership.

## Bit-Swimlane Output

Create a report:

```text
analysis/runtime/<session-id>/motm-tx3-tx4-bit-diff.md
```

The report must include one row per sampled command bit:

```text
| bit | side | rel_master_clock | pc | op | a | x | y | p | dd00_or_1800 | atn | clk | data | sampled_bit | note |
```

And one comparison row per bit:

```text
| bit | vice_c64_clk | vice_drive_clk | vice_bit | headless_c64_clk | headless_drive_clk | headless_bit | delta_cycles | status |
```

Rules:

- `status=match` if both sampled bits match and timing is within
  tolerance.
- `status=timing-skew` if bits match but drive sample delta exceeds
  tolerance.
- `status=bit-diverge` at the first sampled bit value mismatch.
- Stop summarizing after the first divergent bit, then include a
  20-instruction zoom around that bit for both VICE and headless.

## Historical Hypothesis Tests - Out Of Scope Until AB Mismatch

The following buckets came from the earlier broad TX3/TX4 investigation.
Do **not** run them as next-session work. They become valid only if the
AB-scoped `$4000 -> W425C` transaction stream identifies a first
mismatch that points directly at the bucket.

### H1 - Drive 6502 cycle accounting

Compare VICE vs headless PC-to-PC deltas inside the drive loop:

- `$0714-$0732`
- `$07BE-$07C8`
- `$0723-$072A`
- `$0420-$044C`

Report per-PC transition deltas:

```text
| from_pc | to_pc | vice_cycles | headless_cycles | delta | opcode | addressing_mode |
```

If a transition is off by one or more cycles, identify the opcode and
addressing mode. Branch taken/not-taken, page crossing, interrupt
entry, and `BIT abs` timing must be explicit.

### H2 - VIA1 T1 arithmetic

For each relevant T1CH write and T1 fire near the window, report:

- write clock
- `tal`
- `t1zero`
- computed fire clock
- actual fire clock
- ACR
- IFR before/after
- IRQ line before/after

Compare against the VICE timing rule. If headless uses
`t1zero = rclk + 1 + tal`, verify the `+1` against VICE behavior in
this exact window.

### H3 - IEC propagation / poll-loop timing

For each C64 `$DD00` write that changes an IEC line:

- when the C64 write commits
- when the bus line changes
- when the drive next reads `$1800`
- what value the drive sees

If the drive reads one cycle too early/late relative to VICE, classify
the bug as IEC propagation/catch-up ordering. Include whether the
wrongness is in C64 write commit timing, bus line derivation, drive
read timing, or open-collector resolution.

## Tools

Add or extend tools as needed:

- `trace-store-diff.mjs --align-anchor ab_entry`
- `trace-store-query.mjs zoom --clock <rel_master_clock>`
- `trace-store-query.mjs bit-swimlane --window motm-tx3-tx4`
- optional MCP tool: `trace_store_bit_swimlane`

The CLI form is required. MCP exposure is optional but preferred once
the CLI output is stable.

## Testing

Smoke tests are allowed for CLI wiring, but not sufficient.

Required:

- `npm run build:mcp`
- trace-store smoke test
- integration test with the existing MoTM VICE/headless stores
- report-generation test that verifies:
  - `ab_entry` alignment works
  - `rx_byte` count mismatch is preserved
  - a `motm-tx3-tx4-bit-diff.md` report is emitted
  - the report contains a first divergent bit or explicitly says no
    bit divergence was found in the selected window

E2E follow-up after the eventual emulator fix:

- MoTM G64 boots past the 4096-byte stall
- Maniac Mansion G64 still boots
- Last Ninja and Impossible Mission II remain at least no-regression
  for their current acceptance state

## Agent Usage

One integrator owns code changes touching emulator timing.

Parallel agents are allowed only for disjoint work:

- VICE reference extractor: queries VICE store and reports expected
  bit sequence/timing, no code writes outside analysis output.
- Headless trace extractor: adds or verifies trace rows for the
  requested PCs/events, no emulator timing changes.
- Report/query worker: builds CLI report code only.

Do not run parallel agents that both edit drive CPU, VIA, IEC, or
kernel timing code.

## Acceptance Criteria

This spec is complete when:

1. The aligned diff no longer reports artificial absolute-clock
   divergence at `ab_entry`.
2. A deterministic bit-swimlane report exists for MoTM post-4096-byte
   TX.
3. The report identifies the first divergent sampled bit, or proves the
   bits match and the remaining divergence is pure timing.
4. The first divergent point is assigned to H1, H2, or H3 with enough
   local evidence to implement the next fix.
5. The bug document links to the generated report and records the
   chosen root-cause bucket.

This spec is not complete if the only output is another full trace,
another histogram, or another broad "likely timing" statement.
