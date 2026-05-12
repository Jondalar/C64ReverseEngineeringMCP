# Spec 095 — Headless M0.2: VICE EOF Compare

Status: in progress — schema extended, VICE harness CLI, diff `--mode=eof` + report renderer, schema doc, package scripts shipped. Manual VICE-side smoke vs MM disk + synthetic 1-byte G64 fixture deferred.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 0, story M0.2
Depth: deep
Predecessor: Spec 094 (M0.1 EOF trace harness)
Successor: Spec 096 (M0.3 EOI/TALK fix)
Builds on: Sprint 93.2 (`scripts/swimlane-diff.mjs`,
`src/runtime/vice/trace-runtime.ts`, MCP `vice_trace_runtime_start`)

## Motivation

Sprint 93.2 already shipped instruction-level swimlane diff between
headless and VICE traces, anchored at cold boot. That works for boot
divergence but not for Bug 40: the divergence is 30M+ cycles in, after
LOAD completes. We need an EOF-windowed comparison that adds drive PC,
IEC line state, and the relevant zero-page bytes (`$90`, `$A5`) to the
existing instruction trace, and a diff mode that aligns on the EOI edge
rather than reset.

This spec is the comparison layer only. No emulator behavior changes; no
fix. The output of M0.2 is the markdown report that names the wrong
side and the wrong subsystem, so M0.3 can do the surgical fix.

## Acceptance

- The existing `vice_trace_runtime_start` (or a new sibling tool) emits
  trace events with optional channels: `drive_pc`, `iec`, `zp`. Schema
  extension is backward-compatible — existing trace files still parse.
- A new CLI `npm run trace:eof:vice -- --disk=<g64> --file=<name>` starts
  a VICE session with the disk, sends the LOAD command, runs runtime-trace
  with EOF channels enabled, and stops 6000 drive cycles after the EOI
  rising edge (`$90 & 0x40` first set).
- The headless side (Spec 094) and the VICE side both write JSONL in the
  same schema, identified only by the header field `source: "headless" |
  "vice"`.
- `scripts/swimlane-diff.mjs --mode=eof --headless=<jsonl>
  --vice=<jsonl>` produces a markdown report at `--out` with:
  - alignment cycle (EOI rising edge) for both sides
  - first-divergence cycle per channel: c64 PC, drive PC, IEC ATN,
    IEC CLK, IEC DATA, `$90`, `$A5`
  - per-channel summary table (count of mismatches, total samples)
  - suspect-subsystem callout: "drive ROM TALK", "C64 KERNAL ACPTR retry",
    "IEC edge timing", "UNTALK handling", or "ATN ACK", picked by the
    first channel that diverged
- Smoke acceptance: synthetic 1-byte G64 fixture → diff reports zero
  divergence within tolerance (±2 drive cycles on edge events,
  configurable). MM disk → diff reports a definite first divergence.

## Sub-stories

### M0.2a — Extend trace event schema
Add to `src/runtime/vice/trace-runtime.ts`:

```ts
export interface ViceTraceEofChannels {
  drivePc?: number;
  iec?: { atn: 0|1; clk: 0|1; data: 0|1 };
  zp?: Record<string, number>; // e.g. {"90": 0x40, "a5": 0x01}
}

export interface ViceTraceEofSampleEvent {
  kind: "eof-sample";
  sampleIndex: number;
  clock: string;          // VICE clock string
  c64Cyc: number;
  driveCyc: number;
  c64Pc: number;
  channels: ViceTraceEofChannels;
}
```

Add `eof-sample` to the `ViceTraceEvent` union. Keep `instruction` and
`sample` events unchanged.

### M0.2b — VICE channel emission
Decision point during implementation:
- **Option A**: extend `vice_trace_runtime_start` with optional
  `channels` param. Pro: one tool, consistent. Con: mixes EOF concern
  into the general runtime trace.
- **Option B**: new tool `vice_trace_eof_window` that owns the EOF
  channels and trigger logic. Pro: clear scope. Con: duplicates session
  setup.

Default to A; switch to B only if channel logic exceeds ~150 LOC in the
runtime-trace path.

Implementation notes:
- Drive PC via VICE monitor `bank drive8 ; r`. Cost ~2ms per call. Avoid
  per-cycle sampling. Sample drive PC at coarse interval (default every
  100 drive cyc) plus on breakpoints (M0.2c).
- IEC lines via VICE monitor `mem dd00 dd00` and `mem 1800 1800`
  (drive VIA1 PB). Coarse interval same.
- ZP bytes: `mem 90 a5` per sample. Cheap.
- Fine channel: rely on existing CPU history (`chis`) post-hoc, not live
  monitor calls.

### M0.2c — EOF window trigger
- Set VICE breakpoint at the C64 KERNAL store to `$90` (write watchpoint
  on `$90`). When the value transitions to `value & 0x40 != 0`, mark
  `eoiCycle = current C64 clock`.
- After `eoiCycle`, run for `postEoiCycles` (default 6000 drive cycles ≈
  6090 C64 cycles), then stop trace.
- Fallback: if write-watchpoint approach is unstable in VICE, set BP at
  the KERNAL `LDA $90` PC after ACPTR (`$EE13` family) and check
  `($90 & 0x40)` after each break.

### M0.2d — CLI orchestrator
`scripts/trace-eof-vice.mjs` (~120 LOC):
- Args: `--disk`, `--file`, `--budget`, `--out`, `--coarse-every`,
  `--post-eoi-cycles`.
- Steps: start VICE session via `viceSessionManager`, attach disk,
  reset, type `LOAD"<file>",8,1<RET>`, attach EOF watchpoint, run trace,
  stop on post-EOI budget exhausted, write JSONL.
- Output path defaults to
  `samples/traces/<disk-basename>-eof-vice.jsonl`.

### M0.2e — Diff mode
Extend `scripts/swimlane-diff.mjs`:
- Add `--mode=eof` flag. In EOF mode, treat input traces as EOF-windowed
  with the schema in M0.2a.
- Alignment: zero both relative cycle counters at the EOI rising edge.
  If either side missed the edge, abort with explicit error.
- Per-channel diffing: walk both traces in parallel by relative cycle.
  For each channel, record the first cycle where values differ outside
  tolerance.
- Output mode: `--out <file.md>` writes a markdown report. Sections:
  Header (sources, files, alignment cycle), Per-channel summary table,
  First divergence per channel, Suspect callout.

### M0.2f — Cross-spec schema alignment
The schema in M0.2a is the canonical EOF trace schema. Update
`specs/094-headless-m0-1-bug40-eof-trace.md` to point at this schema,
and update `docs/eof-trace-schema.md` (Spec 094 deliverable) to match.
The headless trace harness (Spec 094) emits the same `kind: "eof-sample"`
events, with `source: "headless"` in the header.

## Deliverables

- EDIT `src/runtime/vice/trace-runtime.ts` (event union + types)
- EDIT or NEW in `src/server-tools/vice.ts` (channels param OR new tool;
  decided in implementation)
- NEW `scripts/trace-eof-vice.mjs`
- EDIT `scripts/swimlane-diff.mjs` (`--mode=eof`)
- NEW `docs/eof-trace-diff-schema.md`
- EDIT `package.json`: `trace:eof:vice`, `trace:eof:diff`
- Smoke test against synthetic 1-byte G64
- EDIT `specs/094-...md` to reference this schema

## Test fixtures

- Synthetic 1-byte G64 fixture (shared with Spec 094).
- `/tmp/mm-vice-bench/mm.g64` (already on disk locally).
- Sample expected output committed under `samples/traces/`
  (gitignored if large; small synthetic-fixture diff committed as
  golden file).

## Dependencies

- Spec 094 (M0.1) — schema and headless side.
- `src/runtime/vice/trace-runtime.ts`, `vice_trace_runtime_start`,
  `viceSessionManager` — already shipped.
- `scripts/swimlane-diff.mjs` — already shipped.
- VICE binary installed locally.

## Risks and mitigations

- **VICE monitor cost**: switching `bank drive8` per sample is ~2ms.
  50k drive cyc × 1 sample/cyc → 100s wall. Mitigation: coarse channel
  only for drive bus + per-BP sampling; fine channel via post-hoc CPU
  history.
- **EOI watchpoint instability**: VICE write-watchpoints can miss in
  some configurations. Mitigation: fallback BP at KERNAL `LDA $90` PC
  with software check.
- **Schema split**: extending existing event types could break old trace
  consumers. Mitigation: all new fields optional; existing parsers
  ignore `kind: "eof-sample"`.
- **Cross-spec coupling**: M0.1 schema bleeds into M0.2. Mitigation:
  095 owns the schema definition, 094 references it.
- **VICE non-determinism in warp**: small scheduling jitter possible.
  Mitigation: tolerance window (default ±2 drive cyc) on edge events.
- **Drive PC sampling skew**: monitor calls perturb VICE timing slightly.
  Mitigation: prefer BP-driven dumps over polling; document that the
  diff tolerates ±2 cyc by default.

## Fallback paths

- Server-tools extension is invasive: build standalone harness in
  `scripts/trace-eof-vice.mjs` using `viceSessionManager` directly, no
  MCP-tool change.
- Drive PC sampling too slow: drop periodic, sample only on drive PC
  entry to `[$E700-$EB00, $EBE7-$EC2D, $E853-$E8FA]` via BPs.
- Diff alignment fails (EOI never seen on one side): abort with error,
  do not produce a misleading report.

## Exit criteria

Running the diff on MM produces a markdown report whose "First divergence
per channel" section names a single channel and a single side
(headless vs VICE) that is on the wrong PC at that cycle. That naming is
the input M0.3 acts on.

## File-touch list

- EDIT `src/runtime/vice/trace-runtime.ts` (~30 LOC added)
- EDIT `src/server-tools/vice.ts` (~50 LOC, or NEW tool ~80 LOC)
- NEW `scripts/trace-eof-vice.mjs` (~120 LOC)
- EDIT `scripts/swimlane-diff.mjs` (~80 LOC added)
- NEW `docs/eof-trace-diff-schema.md`
- EDIT `package.json`
- NEW smoke test (location follows existing smoke pattern)
- EDIT `specs/094-headless-m0-1-bug40-eof-trace.md` (schema section
  references this spec)
- EDIT `docs/eof-trace-schema.md` (when produced under Spec 094)

## Out of scope

- The fix itself (M0.3).
- LOAD acceptance smoke matrix (M0.4).
- Generic VICE swimlane reframe (Milestone 5 trace channels).
- MOTM or other game compare (only synthetic + MM here).
- Refactoring the runtime-trace tool into a modular pipeline.
