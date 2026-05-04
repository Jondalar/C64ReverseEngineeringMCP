# EOF Trace Diff Schema (Spec 095 / M0.2)

The EOF diff (`scripts/swimlane-diff.mjs --mode=eof`) consumes two
JSONL traces, aligns them on the EOI rising edge, walks per channel,
and writes a markdown report. This file documents:

1. The trace input schema accepted by the diff (a superset of the
   Spec 094 headless schema and the Spec 095 VICE schema).
2. The output markdown report format.

## Accepted trace formats

Both inputs are JSONL. Lines may use the headless schema
(`type: "header" | "fine" | "coarse" | "moment" | "summary"`) or the
VICE schema (`kind: "eof-header" | "eof-sample" | "eof-moment"`). The
diff parses each line into a normalised sample shape:

```ts
interface Sample {
  c64Cyc: number;
  drvCyc: number;
  c64Pc: number;
  drvPc: number;
  iec: { atn: 0|1; clk: 0|1; data: 0|1 };
  z90: number;   // C64 RAM $90
  zA5: number;   // C64 RAM $A5
}
```

`fine` lines (run-length-compressed PC samples) are ignored — the diff
only walks coarse / eof-sample lines, which include enough state to
compare per channel.

## Alignment

The diff finds `first_eoi` from each input (either an `eof-moment` /
`moment` line, or — for the headless schema — the embedded `summary`
moments list). Both sides' samples are then translated to a relative
cycle counter `relCyc = c64Cyc - eoiC64Cyc`. Sample pairs are matched
by `relCyc` with a ±4 cycle tolerance (configurable in code).

If either side is missing `first_eoi`, the diff aborts with an explicit
error and exit code 3.

## Channels compared

| channel | source field |
|---------|---|
| `c64Pc` | sample.c64Pc |
| `drvPc` | sample.drvPc |
| `iecAtn` | sample.iec.atn |
| `iecClk` | sample.iec.clk |
| `iecData` | sample.iec.data |
| `z90` | sample.z90 |
| `zA5` | sample.zA5 |

For each channel the diff records:

- `samples`: how many aligned pairs were compared
- `mismatches`: count of pairs where the channel value differed
- `firstDivCyc`: the relative cycle of the first mismatch, or `-1` if
  none
- `firstHV`: the headless and vice values at that point

## Suspect subsystem

The diff names a single suspect subsystem based on the earliest channel
divergence, in this priority order (ties broken by which fired first):

1. `drvPc` → "drive ROM TALK"
2. `iecClk` → "IEC edge timing (CLK)"
3. `iecData` → "IEC edge timing (DATA)"
4. `iecAtn` → "ATN ACK"
5. `c64Pc` → "C64 KERNAL ACPTR retry"
6. `z90` → "C64 KERNAL status byte"
7. `zA5` → "C64 KERNAL EOI counter"

This is a heuristic — the actual fix in Spec 096 reads the divergence
detail and decides which side is wrong.

## Output report

Markdown with sections:

```markdown
# EOF Trace Diff Report

- headless trace: `path`
- vice trace:     `path`
- alignment cycle (EOI rising edge):
  - headless c64Cyc=...
  - vice     c64Cyc=...

## Per-channel summary

| channel | samples | mismatches | first divergence (rel cyc) |
|---------|--------:|-----------:|---------------------------:|
| c64Pc   |     ... |        ... |                        ... |
| ...

## First divergence detail

- **channel** at relCyc=...: headless=... vice=... (h.c64Cyc=..., v.c64Cyc=...)

## Suspect subsystem

**<subsystem>** — earliest channel divergence is on `<channel>` at relCyc=...
```

## Tolerances

- `relCyc` matching window: ±4 C64 cycles. VICE warp scheduling jitter
  is typically smaller than this.
- IEC line transitions are sampled at coarse granularity
  (`coarseEvery` instructions, default 100). A divergence inside a
  single coarse window may not be caught — bump down `coarseEvery` if
  the suspect callout looks wrong.

## Limitations

- The VICE-side harness uses `sampleIndex × coarseEvery` as a synthetic
  C64 cycle counter. Absolute clock alignment against the headless
  side is not exact; only relative-to-EOI alignment is meaningful.
- Drive PC sampling perturbs VICE timing slightly (monitor calls hold
  the CPU). The ±4 cycle tolerance absorbs this.
- Bank IDs for c64 and drive memory reads default to 0. If a custom
  build of VICE renumbers banks, edit `scripts/trace-eof-vice.mjs`.
