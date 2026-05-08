# Spec 011: Headless Trace Throughput

## Problem

`headless_runtime` writes `trace/runtime-trace.jsonl` one record per
6502 instruction. A typical Exomizer-SFX depack runs ~700k instructions
and produces a multi-megabyte trace, with file-write I/O dominating the
emulator step. This makes whole-program traces impractical and
discourages using the runtime tooling.

## Goal

Reduce trace write cost so a full depack trace finishes in a fraction
of the current time without losing the data the analysis tools need.

## Approach

Three independent levers; pick whichever is fastest to implement first
and measure before adding the others.

1. **Write batching**
   - Buffer N records (default 1024) and flush periodically.
   - Flush on stop, breakpoint hit, or buffer full.

2. **Sampled / off mode**
   - Add a `trace_mode` parameter to `headless_session_run`:
     `full` (current), `sampled` (every Nth instruction or PC change),
     or `off` (no trace, only end-state memory + register snapshots).
   - The `headless_trace_*` tools must report when a trace is sampled
     or absent so analysis tools do not silently miss frames.

3. **Binary frame format (optional follow-up)**
   - JSONL encodes register state as ASCII per record. A packed binary
     frame format (e.g. 16 bytes/instruction) cuts size and parse cost.
   - Only worth doing if batching + sampling is not enough.

## Acceptance Criteria

- A 700k-instruction depack trace finishes faster than the current
  baseline; record the measurement in the PR description.
- `trace_mode=off` runs to end-state without generating trace files.
- Existing `headless_trace_*` analysis tools still work in `full`
  mode without behaviour change.
- Sampled traces are clearly labelled in trace metadata so tooling
  knows the index is incomplete.

## Tests

- Smoke run of a known PRG in each `trace_mode`.
- Trace-loader rejects index builds against a `sampled` trace unless
  the caller opts in.

## Out Of Scope

- Live streaming of trace data to the UI.
- Cross-session trace comparison.
