# Spec 143 — VICE / Headless IEC Diff

**Sprint**: 112 (core sync refactor)
**Phase**: tooling
**Status**: proposed
**Depends on**: Spec 142

## Why

VICE is the behavioral oracle. Spec 142 made our trace
schema-stable; Spec 143 closes the loop by capturing the same window
in VICE and producing a structured first-divergence report.

Without Spec 143, every probe (Spec 138) and every architectural
change (Specs 139-141) is judged by "does motm boot?" — a noisy
binary that masks true divergence cause.

Spec 143 must work without GUI; it runs as a node script and
returns a JSON artifact suitable for the LLM to read end-to-end.

## Scope

**In scope**:

- VICE binmon adapter (`scripts/vice-iec-capture.mjs`) — drives
  x64sc with `-binarymonitor`, sets watchpoints on $DD00 and
  drive's $1800 (memspace=1 for drive 8), captures matching events
  into the same `BusAccessEvent` schema as Spec 142. Scenarios
  driven by `samples/test-manifest.json` (--id arg).
- Mapping layer: VICE doesn't expose all schema fields directly
  (e.g. `at_boundary`, `phase`). Document which fields are
  "best-effort" vs "exact". Best-effort fields get a `vice_approx`
  flag in the merged event.
- Diff command (`tools/vice-headless-diff.ts`):
  Inputs: two JSONL trace files (theirs + ours). Output: a
  divergence report (JSON + Markdown).
- Divergence classification: at the first event index where the
  pair (`side`, `op`, `addr`, `value`, `iec.{atn,clk,data}`) doesn't
  match, report:
  - **C64 output divergence**: c64 wrote different value to $DD00.
  - **Drive sample divergence**: drive read of $1800 returned
    different value despite identical bus state on both sides.
  - **Cached port state divergence**: cached `cpu_port`/`drv_port`
    differ from the live IEC line state on our side at same event.
  - **IRQ timing divergence**: drive's PC at the divergence event
    doesn't match VICE's PC, indicating different IRQ entry
    timing.
  - **Dispatch divergence**: PC at first divergence is in a region
    the other side never visits — suggests bigger flow divergence
    upstream.
- Logical send/receive index: post-process events into
  byte-stream representation (24-bit receive at $042F-$044C
  produces N receive bytes per scenario). Diff at byte level
  before falling back to bus-event level.
- Artifact: `traces/<scenario>_diff.json` and `<scenario>_diff.md`.

**Out of scope**:

- GUI debugger
- Generic whole-machine trace diff (CPU/VIC/SID)
- Replacing existing VICE runtime tools
- Live (in-process) co-stepping mode — separate spec if ever needed
- VICE source code modification

## VICE adapter design

```ts
// tools/vice-iec-capture.ts
export interface ViceIecCaptureOpts {
  vicePath: string;       // x64sc binary
  d64OrG64Path: string;
  port?: number;          // default 6502
  scenario: "motm" | "mm-load" | { autostart: string };
  cycleBudget: number;
  pcWindowsC64?: Array<[number, number]>;
  pcWindowsDrive?: Array<[number, number]>;
  outputJsonl: string;
}

// Internals (Q10 decision = A: binmon checkpoints, non-warp):
// 1. Spawn x64sc with -binarymonitor (NO -warp). Time is
//    uncritical; correctness > speed.
// 2. Connect via existing ViceMonitorClient.
// 3. Set checkpoints:
//    - C64 mem $DD00..$DD00 read+write
//    - Drive 8 mem $1800..$1800 read+write (memspace=1)
//    - Optional PC checkpoints from windows
// 4. resume() loop: wait for hit. On hit:
//    a. getRegisters(memspace) for cpu side
//    b. getMemory($1800, 1, memspace=1) for the byte value
//    c. getMemory($DD00, 1, memspace=0) for c64 side
//    d. fill BusAccessEvent + append to JSONL
//    e. continue
// 5. Optionally also call getCpuHistory for context dumps at
//    diagnostic checkpoints (PC enter motm receive window etc.).
//    CPU history is rich (PC trajectory, opcode bytes, register
//    snapshots) but does NOT contain memory-access values — that's
//    why we still need checkpoints for the actual byte data.
// 6. Stop after cycleBudget exceeded.
```

VICE binmon limitations to document:
- VICE doesn't expose `at_boundary` directly. We approximate via
  `instruction_pc == checkpoint_pc` heuristic.
- VICE's drive-side cycle counter via `getRegisters(memspace=1)`,
  CLK register id (typically 7). Map to `cycle_drive`.
- C64 cycle via `getRegisters(memspace=0)`, CLK register. Map to
  `cycle_c64`.
- VICE phase info is not available. Set `phase = undefined` and
  `vice_approx.at_boundary = true`.

**ViceMonitorClient API check (Q11)**: existing API
(`src/runtime/vice/monitor-client.ts`) already exposes everything
needed: `setCheckpoint` with memspace, `waitForCheckpointOrStop`,
`getRegisters(memspace)`, `readMemory(start, end, bank, memspace)`,
`getCpuHistory(N, memspace)`. **No extension required.**

## Diff algorithm

```ts
// tools/vice-headless-diff.ts
function diff(theirs: BusAccessEvent[], ours: BusAccessEvent[]):
  DivergenceReport {

  // Step 1: align by (side, op, addr) sequence — both sides should
  // produce same logical sequence even if cycle counts differ.
  // Use Myers-style sequence diff with low cost on cycle mismatch.

  // Step 2: at first index where alignment fails, classify:
  //   - if ours has extra event: c64 made an unexpected access
  //   - if theirs has extra event: c64 missed an expected access
  //   - if same (side, op, addr) but value differs: value divergence
  //   - if iec line state differs but value matches: bus state
  //     divergence

  // Step 3: post-process the matched events into byte-streams.
  //   - 24-bit receive: 24 consecutive drive $1800 reads with
  //     CLK toggle pattern → 1 logical byte
  //   - byte-level diff: at byte index B, theirs=X ours=Y → first
  //     command byte divergence

  // Step 4: emit report.
}
```

Report format:

```json
{
  "scenario": "motm",
  "their_events": 327,
  "our_events": 411,
  "first_divergence_idx_event": 42,
  "first_divergence_idx_byte": 1,
  "their_byte_stream": [0x23, 0x06, 0x01],
  "our_byte_stream": [0x23, 0x06, 0x06],
  "classification": "drive_sample_divergence",
  "their_event_at_div": { ... },
  "our_event_at_div": { ... },
  "delta": {
    "value": "0x06 vs 0x10",
    "iec_match": true,
    "phase_mismatch": false,
    "pc_mismatch": false
  },
  "trace_paths": {
    "theirs": "traces/motm_vice.jsonl",
    "ours": "traces/motm_headless.jsonl"
  }
}
```

Markdown output: same data + human-readable narrative ("First
divergence at byte 1 of receive stream: theirs=$06, ours=$10. Both
sides agree on bus line state. Most likely cause: drive sampled at
different point in clock window.")

## Acceptance

- [ ] `vice-iec-capture.ts` produces JSONL matching Spec 142 schema
      for motm scenario.
- [ ] `vice-headless-diff.ts` produces both JSON + Markdown report.
- [ ] Smoke run of motm captures the same first 3 cmd bytes from
      VICE that we already know empirically (`$23 $06 $01`).
- [ ] Diff report on current (broken) headless code identifies
      first byte divergence at index 1 or 2 with classification
      "drive_sample_divergence".
- [ ] Report fits in <8KB so an LLM can consume it without raw
      trace scanning.
- [ ] CI / smoke target: `npm run trace:motm-diff`.

## Estimated effort

4-5 days:
- 1.5d: VICE adapter + checkpoint logic + cycle mapping
- 1.0d: diff algorithm
- 1.0d: byte-stream post-process for motm receive
- 0.5d: report rendering (JSON + MD)
- 0.5-1.0d: smoke scenario + CI

## Risks

- **R1**: VICE binmon may miss watchpoint hits at warp speed
  (race between resume and event delivery). Mitigation: use
  step-mode in critical windows; verify event count matches
  expectations.
- **R2**: Cycle clock domain misalignment between VICE and ours
  could make seq alignment fail. Mitigation: align by (side, op,
  addr) sequence first, use cycle only as tiebreaker.
- **R3**: VICE adapter spawns x64sc which is slow to boot. Mitigation:
  reuse existing `vice_session_start` MCP tool wiring.

## Files

To create:
- `scripts/vice-iec-capture.mjs`
- `scripts/vice-iec-diff.mjs`
- `scripts/test-motm-diff.mjs` (smoke harness)

To modify:
- `package.json` (npm script `trace:motm-diff`)
- `src/server.ts` (MCP tool wrapper, optional)

## Out-of-scope notes for follow-up specs

- A live co-stepping mode (running VICE and ours in lockstep with
  per-cycle compare) would be far more powerful but requires major
  VICE control work. Track as a wishlist item; not scoped here.
