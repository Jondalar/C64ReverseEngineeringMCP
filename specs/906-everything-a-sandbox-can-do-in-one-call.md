# Spec 906 — Everything the shared session can do without a human, a sandbox does in one call

**Status:** PROPOSED (2026-10-14).
**Repo:** C64RE. No TRX64 part expected: every capability below is a daemon RPC the shared
session already uses against the same binary (see §1). If a scenario shows the daemon is the
limit (index build time, S4), that part goes to TRX64 by decision, recorded in §5.
**Number:** 906 (registry: `specs/README.md`).
**Origin:** issue #78 (2026-10-14, the reporter's LLM on Impossible Mission II): "one shared runtime
per machine — parallel projects compete for it". The owner, same day: the LLM has sandboxes; bring
the sandbox to parity with the daemon wherever that needs no UI.
**Depends on:** nothing. Related: #77 (the loader-lens false FAIL on that same capture) is its own
spec; this one only makes the capture possible off the shared machine.

---

## §1 The problem

**Who:** an LLM working in a project, while other projects (often other LLM sessions of the same
person) are open on the same computer.

**What it is trying to do:** verify a result it derived by reading — here: does the extraction
manifest of a custom-GCR loader match what the loader really reads? That needs a capture: mount
the disk, `LOAD"*",8,1`, wait for the title, press SPACE, run on into the game with the
`drive-mechanism` domain armed, finalize, then `validate_extraction` / `runtime_loader_lens` on
the `.c64retrace`.

**What happens today:** `runtime_sandbox_run` cannot capture. The LLM falls back to the one shared
session. After a daemon restart that session served another project (`projectMismatch … decided
in the workbench UI's requester, not by a tool`), and the validation was blocked until the other
project let go. Measured in the code, not in the description:

- The sandbox CAN trace already. `runSandbox()` has a `trace` option
  (`src/reel/run-sandbox.ts:113-124`, start `:515-543`, stop `:685-689`) using the same RPCs as
  the shared session (`trace/start_domains`, `trace/run/mark`, `trace/run/stop`). Its only caller is
  `trace_cost` (`src/cost/capture.ts:50-62`). `runtime_sandbox_run`
  (`src/server-tools/runtime-sandbox.ts:299-314`) never passes it.
- A capture made in a sandbox would vanish: the sandbox binds its project dir to a scratch dir that
  is deleted on close (`src/reel/sandbox-session.ts:134,150,279-282`), and nothing writes the
  `runtime/traces.json` pointer, so `trace_store_*` could not find it by name.
- A long capture does not fit: the budget is wall-clock only, capped at 600 s
  (`runtime-sandbox.ts:49-53,242-248`) — already past the MCP host's ~180 s stall limit, with no
  job mode; one `session/run` per frame (`run-sandbox.ts:297-304`); and a synchronous index build
  under a 300 s RPC timeout. 80M cycles is ≈4070 PAL frames (≈81 s of machine time).
- DOCTRINE.md:52 says a sandbox is born with a budget "(cycles and wall-clock)". No cycle budget
  exists in the code.
- With a C64 Ultimate selected, `src/runtime/c64u/routing.ts:67-69` refuses every `trace/*` call —
  including `trace/read` on a file — and its way out names `runtime_sandbox_run` "for a trace store
  capture", which cannot capture. A door that points at a door that does not exist.
- `docs/runtime-sandbox.md:136-143` lists "trace it" among the things a sandbox cannot do.

Beyond the trace, the inventory of every tool on the shared session (research 2026-10-14) shows
more that a sandbox could express in one call but does not: write memory, mark an instant, run a
fixed list of monitor commands, read drive registers and drive/cart status, VIC inspection at an
instant, two instants compared inside one run, an end-of-run snapshot to a file, a PRG loaded
mid-run at an address, ejecting a medium, raw bytes to a `.bin`, audio to a file.

**What stays out, and why it is not a gap.** Spec 836 (`specs/_archive/836-a-machine-of-your-own.md:87-100`):
"a call may express anything complete in itself; nothing whose value depends on a later call" —
no session id, so no stepping, no interactive breakpoints, no monitor REPL, no rewind, no second
read. That rule stays (doctrine rule 2: one shared machine). What replaces the conversation is
**chaining**: a sandbox can end by writing a snapshot, and the next sandbox can start from it
(P6). Each call is complete in itself; the LLM still gets to look, think, and continue.

**Worked example (the #78 case, after this spec):**

```
runtime_sandbox_run {
  media_path: "media/im2.g64",
  steps: "I type \"LOAD{QUOTE}*{QUOTE},8,1{RETURN}\"\nI wait until the screen is still for 50 frames within 3000 frames\nI mark \"title\"\nI hold the key \"SPACE\" for 3 frames\nI wait until the CPU reaches $0880 within 6000 frames\nI mark \"game\"\nI wait 1500 frames",
  trace: { domains: ["drive-mechanism","memory","drive8-cpu"], hypothesis: "custom GCR at $05B2 reads 320-byte blocks; manifest from the drive code" },
  snapshot_out: "analysis/im2-ingame.c64re",
  budget_cycles: 90000000, budget_seconds: 1800
}
→ job id; then: capture analysis/traces/…/sandbox_….c64retrace (+ .duckdb), marks title/game,
  snapshot written; validate_extraction { capture_path: <that> } runs with no shared machine.
```

### Parts (MECE)

- **P1 Capture.** A sandbox records a trace with the same domains, gates and marks as the shared
  session, and the capture outlives the sandbox, findable like any other.
- **P2 Long runs.** A capture of tens of millions of cycles completes: a cycle budget, a job mode
  past the host's stall limit, multi-frame runs, an index build that does not die on a timeout.
- **P3 Write and observe at an instant.** The missing one-call verbs: write memory, monitor command
  list, registers (C64 + drive), drive/cart status, VIC inspection, mark.
- **P4 Media and bytes in and out.** Load a PRG mid-run at an address, eject / pull a medium, raw
  bytes to a `.bin`, audio to a file.
- **P5 Compare inside one run.** Two instants of one run compared (memory diff, cheat search) —
  what `runtime_find_cheat` / `runtime_diff_snapshots` do across the shared ring.
- **P6 Chain.** A run ends in a snapshot file; the next run starts from it — the replacement for
  "come back to the machine".
- **P7 Doors and docs tell the truth.** The C64U refusal's way out, `trace/read` on a file with a
  C64U selected, the sandbox docs' "cannot trace", DOCTRINE's cycle budget.

## §2 Scenarios — what proves it is solved

All runtime scenarios spawn their own daemons, never the shared one, on synthetic media built in
the test (`scripts/lib/asm6502-mini.mjs`, the synthetic-disk generator) — no third-party bytes.
They need the TRX64 daemon and ROMs, so they run in the local pre-push gate.

```gherkin
Scenario: S1 a sandbox capture survives the sandbox and is found by name
  Given a project and a synthetic custom-loader disk whose drive code reads known sectors
  When  runtime_sandbox_run runs it with trace { domains: [drive-mechanism, memory], hypothesis }
  Then  the answer names a .c64retrace and .duckdb under the project's trace root
  And   runtime/traces.json carries a pointer to it
  And   trace_store_info finds it by its run id, and its marks are listed
  And   validate_extraction with that capture_path gives the same verdict as a shared-session capture of the same steps
  And   the shared session's cycle did not move and it was never attached

Scenario: S2 the trace gates hold in the sandbox too
  When  trace is given without a hypothesis, or drive-mechanism without passing the substrate gate
  Then  the call is refused with the same refusal runtime_trace_start gives, before a daemon is spawned

Scenario: S3 a cycle budget ends the run at a cycle, and says so
  Given budget_cycles: 2000000
  When  the steps would run for 5000000 cycles
  Then  the run stops at the first frame boundary at or after 2000000, the answer says "cycle budget reached at <cycle>"
  And   a capture in progress is finalized and indexed, not lost

Scenario: S4 a long capture completes past the host's stall limit
  Given a run of ≥ 60M cycles with trace armed
  When  runtime_sandbox_run is called
  Then  it returns a job id within the host's limit, and analysis_job_status later returns the full answer
  And   the index exists (or, if the index build failed, the answer names the intact .c64retrace and the lazy index retry)
  And   the measured wall-clock and index-build time are recorded in §5

Scenario: S5 write and observe at an instant
  When  steps hold "I write $01 to $C000", "I run the monitor commands \"r\", \"m c000 c00f\"", "I read the drive registers", "I inspect the VIC at line 100 cycle 20", "I mark \"here\""
  Then  each is answered at the cycle it ran, with that cycle, in step order
  And   the write is visible to the program (a later check reads it back through the CPU lens)

Scenario: S6 media and bytes in and out
  When  steps hold "I load \"x.prg\" at $2000", "I eject drive 8", and read_memory carries an output path, and audio_out is given
  Then  the PRG is in memory at $2000 and the PC unchanged; the drive is empty; the .bin holds exactly those bytes; the audio file covers the run

Scenario: S7 two instants of one run, compared
  When  steps hold "I remember the memory as \"before\"" … "I compare the memory with \"before\""
  Then  the answer lists the changed bytes between the two instants (address, old, new), the same as runtime_diff_snapshots on two snapshots of those instants
  And   "I search for a value that went from 3 to 2 since \"before\"" lists the candidate addresses, as runtime_find_cheat does

Scenario: S8 chain: end in a snapshot, start the next run from it
  When  run A ends with snapshot_out, and run B starts with media_path = that snapshot and the same remaining steps
  Then  run B's end state (cycle, registers, RAM digest) equals one run with A's and B's steps together, across fresh daemons
  And   the snapshot carries the mounted media, so B's drive continues where A's stopped

Scenario: S9 the doors tell the truth
  Given a C64 Ultimate selected as the backend (the fake Ultimate)
  When  trace_store_query reads a store file
  Then  it is served (by an emulator reader, not the device), not refused
  And   the refusal of a live trace on the device names runtime_sandbox_run with trace, and that call works
  And   docs/runtime-sandbox.md no longer lists "trace it" as impossible; DOCTRINE's sandbox budget matches the code
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | capture survives, found, validates | `scripts/e2e-906-sandbox-parity.mjs` → `e2e:906` | local gate (daemon + ROMs) |
| S2 | P1 | gates hold | `e2e:906` (refusal half needs no daemon) | local gate; refusal half hermetic → `gates.yml` |
| S3 | P2 | cycle budget | `e2e:906` | local gate |
| S4 | P2 | long capture, job mode | `e2e:906` (long case behind `C64RE_E2E_LONG=1`) + one by-hand run on the reporter-style IM II capture, numbers into §5 | local, by hand for the real disk |
| S5 | P3 | write + observe | `e2e:906` | local gate |
| S6 | P4 | media + bytes | `e2e:906` | local gate |
| S7 | P5 | compare in one run | `e2e:906` | local gate |
| S8 | P6 | chain | `e2e:906` (fresh daemons, as `e2e:replay-determinism`) | local gate |
| S9 | P7 | doors + docs | `e2e:906` with `scripts/lib/fake-ultimate.mjs`; `check:docs-current` | local gate + `gates.yml` for the doc check |

## §3 Decision

- **D1 (P1) `trace` on `runtime_sandbox_run`:** `{ domains, hypothesis, output? }`. Same domain list,
  same `checkTraceDiscipline` and substrate gate as `runtime_trace_start`, checked before the spawn.
  Output defaults to `defaultTraceOut(project)` (outside the sandbox scratch, absolute); the pointer
  goes into `runtime/traces.json` via `recordTracePointer` with `source: "sandbox"`. Steps
  `I mark "x"` map to `trace/run/mark`. The memory-map sidecar is written as after
  `runtime_trace_finalize`.
- **D2 (P2) budgets and length:** `budget_cycles` (new; the doctrine's missing half) and
  `budget_seconds`. A call whose budget can exceed ~150 s runs as a background job
  (`startAnalysisJob` / `analysis_job_status`, as `runtime_loader_lens` does); short calls stay
  synchronous. `budget_seconds` max rises from 600 to 1800 for job-mode calls only — still a stated
  budget, so still point work (DOCTRINE.md:63). Frames with no pending per-frame predicate run as
  one multi-frame `session/run`. `trace/run/stop` gets an explicit timeout sized to the capture; on
  timeout the answer names the intact `.c64retrace` and the lazy index on first read. The budget
  reaper finalizes a capture before SIGTERM.
- **D3 (P3) steps:** `I write $VV [$WW …] to $ADDR`, `I run the monitor commands "…", "…"`
  (`monitor/exec`, output in the answer), `I read the registers` / `I read the drive registers`,
  `I read the drive status` / `I read the cartridge status`, `I inspect the VIC at line L cycle C`
  / `I map the frame` / `I trace raster line L` (the `vic/*` RPCs at a checkpoint taken there),
  `I mark "x"`. Each answer row carries its cycle. Parsed in `scenario-gherkin.ts`, so `.feature`
  files and `c64re scenario run` get them too.
- **D4 (P4):** `I load "x.prg" [at $ADDR]` (`session/load_prg`, no autostart), `I eject drive 8` /
  `I pull the cartridge`, `read_memory` entries take `> path.bin`, `audio_out: path` (`audio/export`).
- **D5 (P5):** `I remember the memory as "x"` (a checkpoint inside the run) and
  `I compare the memory with "x"` / `I search for a value that went from A to B since "x"`, using
  the same diff and cheat-candidate RPCs the shared-ring tools use.
- **D6 (P6):** `snapshot_out: path` (`vsf/save` at the end; media embedded as in 707). A `.c64re`
  as `media_path` already starts a run; S8 proves the chain is exact.
- **D7 (P7):** `trace/read` on a file is served by an emulator reader (a short-lived headless daemon
  with no machine work, or the shared emulator daemon if the backend is the emulator) when the
  selected backend is a C64U; the C64U refusal of a LIVE trace keeps its way out, which now works.
  Fix `docs/runtime-sandbox.md`, `docs/tools/sandbox.md`, the tool description, DOCTRINE.md's budget
  line, and the stale comment at `src/server-tools/trace-read.ts:19-23`.

Lost: one daemon per project (the reporter's first choice) — it multiplies the shared machine that
rule 2 keeps single, and every need in #78 is a one-call capture. Private interactive sessions
without a budget (his second) — the 836 rule; chaining (D6) gives the continuation without a
machine that outlives its call.

## §4 Out

- Session id, stepping, interactive breakpoints, monitor REPL, rewind, recorder/scrub history,
  anchors in the filmstrip, `runtime_promote_branch` — interactive by nature (836).
- Live streaming to a UI, host keymap/input config — UI-only.
- A sandbox in the workspace UI — DOCTRINE.md:44 (the UI shows only the shared session).
- Fixing the loader lens's reading of #77's loader — #77's own spec.

## §5 Decisions taken while building

(filled in at the end)
