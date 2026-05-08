# Spec 093 — Maniac Mansion G64 1541 lockstep debug path

Analysis: `docs/analysis/mm-g64-1541-failure-analysis.md`

## Problem

Maniac Mansion boots far enough to enter the custom-loader path, then
stalls around C64 PC `$46A7` waiting for the drive to release `CLK`.
This looks like a real IEC timing failure, not like a G64 file parsing
failure.

The current headless integrated-session tool description implies real
C64+1541 lockstep, but the default MCP path does not enable the new
cycle-lockstep scheduler or the microcoded 6510. The normal tool call can
therefore still run in the legacy instruction-batched mode:

- C64 instruction executes as a whole.
- Drive catches up before/after the instruction via lazy
  `executeToClock`.
- `$DD00` IEC line changes are observed too late by the 1541.
- Fastloader bit-bang handshakes can deadlock even when the disk image
  and drive ROM are valid.

This spec defines the narrow next step: prove and fix the runtime path
used by the MCP tool. The existing `src/disk/g64-parser.ts` is not part
of this work and must not be rewritten.

## Evidence

- Sprint 80 notes: Maniac Mansion reaches game code, then stalls at
  `$46A7` waiting for drive `CLK` release.
- Sprint 92 says instruction-batch + lazy execute was a workaround, not
  the target architecture.
- `IntegratedSessionOptions.useCycleLockstep` defaults to `false`.
- `IntegratedSessionOptions.useMicrocodedCpu` defaults to `false`.
- `headless_integrated_session_start` does not currently expose either
  option.
- The non-microcoded cycle wrapper still documents that bus access
  happens at instruction start, which is insufficient for IEC edges.
- The drive-side GCR consumption layer is byte-oriented and approximate,
  but that should be treated as the second suspect only after the
  lockstep path is proven. This is separate from the G64 parser.

## Goal

Make the MCP integrated-session path capable of running Maniac Mansion
with the intended cycle-lockstep runtime, and produce enough diagnostics
to identify the exact remaining blocker if the title screen is still not
reached.

## Non-goals

- Do not rewrite or tune the G64 parser.
- Do not add new KERNAL serial traps for Maniac Mansion stage-2 loading.
- Do not paper over the stall with game-specific PC traps.
- Do not tune GCR byte stepping until the run is proven to use
  cycle-lockstep + microcoded CPU.
- Do not remove legacy instruction stepping in the same change unless it
  is already unused by tests and tools.

## Implementation

### 1. Expose runtime mode in MCP tool

Update `headless_integrated_session_start`:

- Add `use_cycle_lockstep?: boolean`.
- Add `use_microcoded_cpu?: boolean`.
- Add `trace_iec?: boolean`.
- Add `trace_drive?: boolean`.
- Add `trace_until_pc?: string | number` or an equivalent breakpoint
  option.

The tool must pass these through to `startIntegratedSession`.

Default policy:

- For G64 integrated sessions, default `use_cycle_lockstep` to `true`.
- For G64 integrated sessions, default `use_microcoded_cpu` to `true`.
- Keep explicit caller values authoritative.
- If the caller disables either flag for a G64 image, include a warning
  in the tool result that custom-loader compatibility is reduced.

The tool result must always include:

- resolved `diskPath`
- `imageFormat`
- `useCycleLockstep`
- `useMicrocodedCpu`
- active `driveClockRatio`
- whether KERNAL serial traps are enabled
- whether IEC tracing is enabled

### 2. Reject misleading success

If the tool description says "cycle-accurate lockstep", the returned
session must actually be lockstep. Either:

- make lockstep the default as above, or
- change the description to say the caller must explicitly enable it.

Preferred: default-on for G64 integrated sessions.

### 3. Add Maniac Mansion diagnostic run

Add a repeatable diagnostic helper or test script that boots Maniac
Mansion from G64 and stops at one of these conditions:

- title/character-select screen reached
- C64 PC hits `$46A7` and remains in the wait loop for N iterations
- drive PC repeats inside the same small loop for N iterations
- cycle budget exhausted
- emulator exception

The diagnostic output must record:

- C64 PC, A/X/Y/SP/P, cycle
- Drive PC, A/X/Y/SP/P, drive cycle
- IEC line state: `ATN`, `CLK`, `DATA`
- C64 CIA2 PA/DDRA relevant bits for IEC
- Drive VIA1 PB/DDRB relevant bits for IEC
- Drive VIA1 CA1/CA2/CB1/CB2 state if modelled
- Drive VIA2 PB7 `SYNC` state
- Current track, halftrack, byte offset
- Last N IEC edges with cycle timestamps
- Last N writes to `$DD00`
- Last N reads/writes to drive `$1800`

Write the report as a registered artifact under the project root, e.g.:

`analysis/headless/mm-g64-lockstep-debug.json`

The JSON must be importable or at least registered, so the project UI can
link to it. If it contains knowledge-relevant findings, import them.

### 4. Add targeted assertions

The diagnostic must answer these questions without manual log scraping:

- Did the session run with `useCycleLockstep=true`?
- Did it run with `useMicrocodedCpu=true`?
- Did C64 `$DD00` writes propagate to IEC state in the same C64 cycle?
- Did drive VIA1 `$1800` reads observe the changed IEC state on the next
  drive cycle?
- At `$46A7`, which side is holding `CLK` low?
- At `$46A7`, is the drive attempting to release `CLK`?
- Is the drive CPU still executing loader code, ROM serial code, or a
  stuck loop?
- Is the drive seeing `ATN`/`DATA` transitions at the expected moments?
- Is VIA2 `SYNC` permanently wrong or plausibly toggling?

### 5. Add regression command

Provide one command that can be run by an agent without improvising:

```sh
npm run headless:mm:g64-debug -- --project-dir "/path/to/project" --disk "/path/to/maniac.g64"
```

or an equivalent MCP workflow tool.

The command must:

1. start the integrated session with lockstep + microcoded CPU
2. boot via the normal C64 path
3. run to the acceptance condition or stall condition
4. register the diagnostic artifact
5. return a short human-readable verdict

### 6. Fix the first proven timing blocker only

After the diagnostic exists, make the smallest runtime fix supported by
the report.

Expected first suspects, in order:

1. MCP tool not enabling lockstep/microcoded CPU.
2. Cycle wrapper used instead of true microcoded 6510 bus cycles.
3. IEC state changes still delayed until instruction boundary.
4. Drive VIA1 PB polarity / DDR / line-driver state mismatch.
5. Drive clock ratio or PAL/NTSC ratio wrong.
6. Illegal opcode microcode missing for loader timing loop.
7. VIA2 GCR `SYNC`/byte-ready timing too approximate.
8. G64 bit-level shifter needed instead of byte-level cursor.

Do not jump to item 7 or 8 until items 1-6 are proven correct. Even
then, keep `src/disk/g64-parser.ts` unchanged unless a parser-specific
regression is independently proven.

## Acceptance

### Minimum acceptance

- `headless_integrated_session_start` exposes and returns
  `useCycleLockstep` and `useMicrocodedCpu`.
- G64 sessions default to both enabled unless explicitly overridden.
- A Maniac Mansion diagnostic run produces a registered JSON artifact.
- The diagnostic artifact says whether the stall is:
  - tool configuration
  - C64 IEC write propagation
  - drive VIA1 observation
  - drive CPU execution
  - GCR/SYNC timing
  - unknown

### Runtime acceptance

- Maniac Mansion no longer stalls indefinitely at `$46A7`, or the report
  identifies the exact line owner and repeated drive/C64 loop.
- If it still stalls, the next required fix is a single concrete runtime
  subsystem, not "debug emulator".

### Final acceptance

- Maniac Mansion reaches the title/character-select screen from the G64
  image without game-specific traps.
- The same diagnostic command remains in the repo as a regression test.
- Murder on the Mississippi still boots at least as far as before.
- Existing project-knowledge smoke tests and UI typecheck/build pass.

## Files likely touched

- `src/server-tools/headless.ts`
- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts`
- `src/runtime/headless/scheduler/cycle-wrappers.ts`
- `src/runtime/headless/cpu/cpu6510-cycled.ts`
- `src/runtime/headless/iec/iec-bus.ts`
- `src/runtime/headless/iec/cia2-stub.ts`
- `src/runtime/headless/peripherals/cia2.ts`
- `src/runtime/headless/drive/via1-iec.ts`
- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/drive/via2-gcr.ts`
- `src/runtime/headless/drive/head-position.ts`
- `src/project-knowledge/*` only if artifact registration/import needs a
  small extension
- `scripts/*` or `package.json` for the diagnostic command

## Notes

The drive-side GCR runtime model is still too coarse for complete 1541
compatibility:

- density bits are not fully modelled
- motor timing is approximate
- byte-ready/read-shift behaviour is byte-level
- SYNC is approximated from consecutive `$ff` bytes

That matters, but it is the wrong first target and it does not imply a
G64 parser rewrite. Maniac Mansion's current observed failure at `$46A7`
is an IEC handshake wait. The first proof must be that C64 `$DD00` and
drive VIA1 `$1800` interact at the correct cycle boundary through the
MCP path the agents actually use.
