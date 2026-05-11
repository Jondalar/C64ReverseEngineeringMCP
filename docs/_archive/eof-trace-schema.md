# EOF Trace Schema (Spec 094 / M0.1)

This document specifies the JSONL artifact emitted by the EOF trace
harness (`src/runtime/headless/trace/eof-trace.ts`, CLI
`scripts/trace-eof.mjs`). Schema version: **1**.

The artifact captures a structured window across the LOAD-completion
moment. It is consumed by Spec 095 (M0.2) for VICE-side comparison and
by Spec 096 (M0.3) as the evidence base for the Bug 40 fix.

## File shape

One JSON object per line, no trailing comma, UTF-8. Lines are emitted in
this order:

1. exactly one `header`
2. zero or more `fine` lines (run-length-compressed PC samples)
3. zero or more `coarse` lines (full state snapshots, decimated)
4. zero or more `moment` lines (named events)
5. exactly one `summary` line

Consumers should tolerate unknown fields and unknown line types.

## `header`

```json
{
  "type": "header",
  "schemaVersion": 1,
  "diskPath": "samples/foo.g64",
  "loadName": "MM",
  "bootInstructions": 800000,
  "coarseEvery": 100,
  "postEoiCycles": 6000,
  "preEoiKeepDriveCycles": 50000,
  "c64CycStart": 0,
  "drvCycStart": 0
}
```

`c64CycStart` / `drvCycStart` are sampled immediately before the LOAD
command is typed. All `c64Cyc` / `drvCyc` values elsewhere in the file
are absolute (not relative to the start).

## `fine`

Run-length-compressed PC sample. One entry per `(drvPc, c64Pc)` run:

```json
{
  "type": "fine",
  "c64Pc": 60020,
  "drvPc": 59672,
  "c64CycStart": 12345,
  "drvCycStart": 12500,
  "c64CycLast":  12399,
  "drvCycLast":  12554,
  "count": 7
}
```

Run terminates when either PC changes. `count` is the number of C64
instructions in the run (one sample is taken per `runFor(1)`).

Sampled in a window from boot through `postEoiCycles` drive cycles past
the first observed EOI signal. Pre-EOI samples older than
`preEoiKeepDriveCycles` drive cycles are dropped to bound memory.

## `coarse`

Full state snapshot, sampled at most once every `coarseEvery` drive
cycles:

```json
{
  "type": "coarse",
  "c64Cyc": 12345,
  "drvCyc": 12500,
  "c64Pc": 60020,
  "drvPc": 59672,
  "iec":          { "atn": false, "clk": false, "data": true },
  "c64Released":  { "atn": true,  "clk": true,  "data": true },
  "driveReleased":{ "clk": true,  "data": false, "atnAck": true },
  "ram":          { "z90": 0, "zA4": 0, "zA5": 0 },
  "drvRam":       { "z77": 0, "z79": 0, "z85": 0 },
  "drvInTalk": true
}
```

- `iec.line.*` reflect the wired-OR bus state (true = released).
- `c64Released.*` and `driveReleased.*` reflect each side's drive bit.
- `ram` keys are C64 zero-page bytes at `$90` (status), `$A4` (EOI
  scratch), `$A5` (EOI counter).
- `drvRam` keys are 1541 zero-page bytes at `$77`, `$79`, `$85`
  (channel state).
- `drvInTalk` is `drvPc ∈ [$E700, $EB00]`.

## `moment`

A single named event. The harness records each moment at most once
except `last_talk_pc`, which is emitted with the most recent observation:

```json
{ "type": "moment", "name": "first_a5_ge1",     "c64Cyc": ..., "drvCyc": ..., "c64Pc": ..., "drvPc": ... }
{ "type": "moment", "name": "first_eoi",        "c64Cyc": ..., "drvCyc": ..., "c64Pc": ..., "drvPc": ... }
{ "type": "moment", "name": "untalk_send",      "c64Cyc": ..., "drvCyc": ..., "c64Pc": ..., "drvPc": ... }
{ "type": "moment", "name": "drive_idle_return","c64Cyc": ..., "drvCyc": ..., "c64Pc": ..., "drvPc": ... }
{ "type": "moment", "name": "last_talk_pc",     "c64Cyc": ..., "drvCyc": ..., "c64Pc": ..., "drvPc": ... }
```

Detection rules:

- `first_a5_ge1` — first cycle where C64 RAM `$A5 ≥ 1`.
- `first_eoi` — first cycle where C64 RAM `$90 & 0x40 != 0`.
- `untalk_send` — C64 PC enters loose KERNAL UNTALK range
  `[$ED09, $ED40]`.
- `drive_idle_return` — drive PC has stayed in `[$EBE7, $EC2D]` for
  ≥ 500 drive cycles after `first_eoi`.
- `last_talk_pc` — last drive PC observed inside `[$E700, $EB00]` over
  the entire window.

If a moment is never observed, the entry is omitted.

## `summary`

```json
{
  "type": "summary",
  "schemaVersion": 1,
  "diskPath": "...",
  "loadName": "...",
  "c64CycStart": 0,
  "c64CycEnd":  ...,
  "drvCycStart": 0,
  "drvCycEnd": ...,
  "moments": [ ... same shapes as moment lines ... ],
  "c64PcHistogramTop": [ { "pc": 60020, "count": 1234 }, ... ],
  "drvPcHistogramTop": [ { "pc": 59672, "count": 5678 }, ... ],
  "flags": {
    "eoiSeen": true,
    "driveCompletedViaAtn": true,
    "c64InRetryLoop": false,
    "driveStuck": false,
    "budgetExhausted": false
  }
}
```

Histograms cover the post-EOI window only when EOI was seen. If EOI was
never seen, they cover the full retained pre-EOI window.

Flag definitions:

- `eoiSeen` — `first_eoi` moment recorded.
- `driveCompletedViaAtn` — `drive_idle_return` moment recorded.
- `c64InRetryLoop` — within a rolling window of `stuckLoopCycles` C64
  cycles after EOI, top-1 PC concentration > 80 %.
- `driveStuck` — EOI never seen and top-1 drive PC sits outside the
  TALK ∪ idle bands.
- `budgetExhausted` — sampling loop hit the `budget` cap before any
  end-trigger fired.

The flag set is the **structured contract** for downstream tooling.
Renames or removals require a `schemaVersion` bump.

## Version-bump policy

Bump `schemaVersion` (and update this doc) whenever any of the
following changes:

- A new line type is added that consumers must reason about.
- An existing field is renamed, removed, or changes meaning.
- A flag's true/false semantics change.

Adding a new optional field on `coarse` / `fine` / `moment` does **not**
require a bump as long as older readers can ignore it. The harness MAY
emit additional fields in summary entries; consumers MUST tolerate
unknown keys.

## Example excerpt

```jsonl
{"type":"header","schemaVersion":1,"diskPath":"samples/mm.g64","loadName":"MM","bootInstructions":800000,"coarseEvery":100,"postEoiCycles":6000,"preEoiKeepDriveCycles":50000,"c64CycStart":1234567,"drvCycStart":1252300}
{"type":"fine","c64Pc":60020,"drvPc":59672,"c64CycStart":1234567,"drvCycStart":1252300,"c64CycLast":1234599,"drvCycLast":1252354,"count":7}
{"type":"coarse","c64Cyc":1234600,"drvCyc":1252355,"c64Pc":60024,"drvPc":59676,"iec":{"atn":false,"clk":false,"data":true},"c64Released":{"atn":true,"clk":true,"data":true},"driveReleased":{"clk":true,"data":false,"atnAck":true},"ram":{"z90":0,"zA4":0,"zA5":0},"drvRam":{"z77":0,"z79":0,"z85":0},"drvInTalk":true}
{"type":"moment","name":"first_a5_ge1","c64Cyc":...,"drvCyc":...,"c64Pc":...,"drvPc":...}
{"type":"moment","name":"first_eoi","c64Cyc":...,"drvCyc":...,"c64Pc":...,"drvPc":...}
{"type":"summary","schemaVersion":1,...}
```
