# Spec 094 — Headless M0.1: Bug 40 EOF Trace Harness

Status: in progress — harness + CLI + schema doc + legacy move landed; G64 builder also landed (Spec 097 generator). Headless LOAD against synthetic 1-byte G64 currently stalls (drive idle at $D6BB never receives ATN); cause unclear — could be Bug 40 surfacing on ANY LOAD or a generator-side bug we haven't found yet. CI smoke gating deferred until that's resolved.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 0, story M0.1
Depth: deep
Predecessors: Sprint 96 (Bug 39 IEC bit-bang), Sprint 97 (current Bug 40 probe)
Successors: Spec 095 (M0.2 VICE EOF compare), Spec 096 (M0.3 EOI/TALK fix)

## Motivation

Bug 40 blocks every real-LOAD acceptance path: after a complete byte-perfect
transfer (e.g. `LOAD"MM",8,1` = 38658 bytes), the C64 KERNAL stays in the
ACPTR/EOI retry loop instead of returning to direct mode. Existing probe
scripts (`scripts/sprint96-acptr-loop.mjs`, `scripts/sprint97-drive-eof.mjs`)
were written ad hoc for a single hypothesis and emit unstructured console
logs that are hard to align against a VICE trace.

This spec is the **observation layer only** — produce one reusable command
that captures a structured EOF window we can diff against VICE in M0.2 and
use as the evidence base for the fix in M0.3. No emulator behavior changes.

## Acceptance

- A reusable command `npm run trace:eof -- --disk=<g64> --file=<name>`
  produces a JSONL artifact at `--out` (default
  `samples/traces/<disk>-eof.jsonl`).
- The artifact captures, per sample:
  - drive CPU PC, drive cycles
  - C64 CPU PC, C64 cycles
  - IEC lines: ATN, CLK, DATA (line + per-side released flags)
  - C64 RAM `$90` (status), `$A5` (EOI counter), `$A4`
  - drive channel state: drive RAM `$77`, `$79`, `$85`
  - TALK-state hint: boolean `drive_in_talk_area`
    (drive PC in `$E700..$EB00`)
  - UNTALK transmit moment (C64 PC enters UNTALK send path)
  - drive idle return moment (drive PC enters `$EBE7..$EC2D` idle band)
- The trace window covers from "last data byte transferred" minus 500 C64
  cycles, until "drive idle OR C64 stuck-loop detected for 50000 cycles".
- The output schema is versioned (`schema_version: 1`) and documented at
  `docs/eof-trace-schema.md`.
- The artifact ends with a summary block:
  - first `$A5 ≥ 1` moment (drive PC, C64 PC, IEC, cycle)
  - first EOI-flag-set moment (`$90 & 0x40` becomes 1)
  - last drive TALK-area PC and cycle
  - C64 PC histogram top 10 of the post-EOI window
  - drive PC histogram top 10 of the post-EOI window
  - boolean flags: `eoi_seen`, `drive_completed_via_atn`, `c64_in_retry_loop`
- Smoke acceptance: command runs end-to-end against the MM disk in
  under 60 seconds and produces an artifact under 5 MB.

## Sub-stories

### M0.1a — Trace harness module
`src/runtime/headless/trace/eof-trace.ts` (~300 LOC).
Encapsulates ring buffer + sample loop. Two sample channels:
- **fine**: drive PC + C64 PC every drive cycle (decimated by run-length
  compression — consecutive identical PCs collapse to `{pc, count, firstCyc, lastCyc}`).
- **coarse**: full state snapshot every N drive cycles (default N=100).

Public API:

```ts
export interface EofTraceOptions {
  diskPath: string;
  loadName: string;     // e.g. "MM" or "*"
  budget?: number;      // C64 cycles; default 60_000_000
  postEoiCycles?: number; // default 6000
  coarseEvery?: number;   // default 100
  outPath?: string;
}

export interface EofTraceResult {
  schemaVersion: 1;
  outPath: string;
  bytes: number;
  summary: EofTraceSummary;
}

export async function runEofTrace(opts: EofTraceOptions): Promise<EofTraceResult>;
```

### M0.1b — CLI wrapper
`scripts/trace-eof.mjs` (~80 LOC).
Thin argv → `runEofTrace` adapter. Flags:
- `--disk=<path>` (required)
- `--file=<name>` (default `*`)
- `--budget=<cycles>` (default 60M)
- `--out=<path>` (default `samples/traces/<disk-basename>-eof.jsonl`)
- `--coarse-every=<n>` (default 100)
- `--post-eoi-cycles=<n>` (default 6000)

Exits 0 on artifact-written, 1 on internal error, 2 on missing disk.

### M0.1c — Schema documentation
`docs/eof-trace-schema.md`.
Sections: header line shape, sample line shape (fine + coarse), summary
block shape, version-bump policy, example excerpt.

### M0.1d — Legacy script migration
Move `scripts/sprint96-acptr-loop.mjs` and `scripts/sprint97-drive-eof.mjs`
to `scripts/legacy/`. Add a one-line README in `scripts/legacy/` pointing
to the harness as the replacement. Do not delete — they encode the
hypothesis history that informed this spec.

## Deliverables

- `src/runtime/headless/trace/eof-trace.ts`
- `scripts/trace-eof.mjs`
- `docs/eof-trace-schema.md`
- `package.json` script entry: `"trace:eof": "node scripts/trace-eof.mjs"`
- `scripts/legacy/sprint96-acptr-loop.mjs`
- `scripts/legacy/sprint97-drive-eof.mjs`
- `scripts/legacy/README.md`
- Smoke test in `tests/` (or wherever existing smoke pattern lives) that
  runs the harness against a synthetic 1-byte G64 fixture (not MM).

## Test fixtures

- **Synthetic single-byte file**: 1-block file on a generated G64 image.
  Acceptance: harness produces a clean EOF window with `eoi_seen=true`,
  `drive_completed_via_atn=true`, `c64_in_retry_loop=false`. Used in CI.
- **MM G64** (gitignored sample): manual run only. Acceptance: harness
  reproduces the Bug 40 footprint, summary records `c64_in_retry_loop=true`.

## Dependencies

- Existing `startIntegratedSession` with `useCycleLockstep: true` and
  `useMicrocodedCpu: true`.
- Existing `session.iecBus.snapshot()`.
- Existing `session.c64Bus.ram` and `session.drive.bus.ram` access.
- No new emulator features.

## Risks and mitigations

- **Sample volume**: per-cycle sampling over 50k drive cycles produces
  > 1 M raw samples. Mitigation: run-length compress fine channel by PC
  before write; coarse channel decimated by `coarseEvery`.
- **Drift back to ad-hoc scripts**: trace harness becomes the next disposable
  script if schema isn't enforced. Mitigation: schema doc + version field
  + smoke test; treat schema as a stable contract for M0.2+.
- **I/O cost**: per-cycle JSONL writes tank throughput. Mitigation:
  in-memory buffer, single flush at end. Estimated peak memory ~50 MB
  before compression.
- **Window-edge ambiguity**: "last data byte" is ambiguous mid-run.
  Mitigation: trigger window-end detection on `$90 & 0x40` rising edge,
  which is a well-defined KERNAL EOI signal.
- **Drive crash early**: harness must not hang. Mitigation: budget cap +
  fallback summary path that records partial state with `eoi_seen=false`.

## Fallback paths

- EOI never fires within budget: emit artifact with `eoi_seen=false`, last
  5000 drive cycles of fine + coarse samples retained, summary marks
  `drive_state=stuck` if drive PC histogram is concentrated outside
  `$E700..$EB00 ∪ $EBE7..$EC2D`.
- C64 livelock: detected via top-10 PC concentration > 80%; flagged as
  `c64_in_retry_loop=true` regardless of EOI state.

## Exit criteria

The harness, run against MM, produces an artifact whose summary block
identifies (a) the first `$A5 ≥ 1` moment with full state snapshot at that
exact cycle, and (b) the C64 PC distribution after EOI. That artifact is
the input M0.2 aligns against VICE and M0.3 uses to decide which side is
wrong.

## File-touch list

- NEW `src/runtime/headless/trace/eof-trace.ts`
- NEW `scripts/trace-eof.mjs`
- NEW `docs/eof-trace-schema.md`
- NEW `scripts/legacy/README.md`
- MOVE `scripts/sprint96-acptr-loop.mjs` → `scripts/legacy/`
- MOVE `scripts/sprint97-drive-eof.mjs` → `scripts/legacy/`
- EDIT `package.json` (add `trace:eof` script)
- NEW smoke test file (location TBD, follow existing smoke pattern)

## Out of scope

- VICE-side capture (M0.2).
- Any drive-ROM or C64-KERNAL behavior change (M0.3).
- LOAD acceptance smoke matrix (M0.4).
- Generic per-bug trace framework (Milestone 5 trace channels).
- Replacing existing in-conversation breakpoint/monitor MCP tools.
