# Spec 704 — Runtime Codebase Cleanup and Legacy Retirement

Status: §11 (1541 legacy retirement) DONE — merged master `0411295` (2026-05-22). Other phases (704.2/.5/.6/.7) open.  
Created: 2026-05-22 CEST  
Depends: Specs 429, 610-623, 700-703  
Owner: runtime / workspace-ui / project-knowledge

## 1. Goal

Reduce the C64RE MCP runtime codebase to the active, VICE-shaped paths and
remove or quarantine obsolete implementation branches that keep causing wrong
debugging hypotheses.

This is a cleanup spec, not a behavior-change spec.

Primary goals:

- make the active C64/1541/VIC/SID/UI runtime path obvious;
- delete dead legacy code after proving it is unused;
- keep compatibility code only where it has a named owner and test;
- prevent future agents from using old paths as authority.

## 2. Motivation

Several recent bugs were amplified by stale paths:

- legacy 1541 host validation interfered with VICE1541 behavior;
- old 1541/drive/GCR assumptions sent investigations toward GCR/halftracks
  after those paths were no longer root causes;
- V3 UI still carried older screenshot and run-loop assumptions while Spec 701
  moved timing to the backend;
- archived specs and quarantine directories are easy for agents to mistake as
  active instructions;
- simplified TS SID audio exists beside the intended reSID/WASM direction.

The codebase needs an explicit retirement pass.

## 3. Non-Goals

- Do not fix Spec 429 inside this cleanup.
- Do not change emulator timing, VIC output, IEC/DD00 behavior, or drive
  semantics.
- Do not remove knowledge-layer migrations that are still needed for historical
  project data.
- Do not delete sample media, gold traces, or archived specs unless a separate
  archival policy says so.
- Do not remove a legacy path merely because its name says legacy. Prove it is
  unused or replace it through an active interface first.

## 4. Cleanup Doctrine

Every removal must pass this checklist:

1. Identify the active replacement.
2. Prove no production import path still reaches the old code.
3. Prove no CLI/script/test gate still intentionally depends on it.
4. Remove or move it.
5. Re-run the relevant gates.
6. Document the decision in this spec.

If proof is incomplete, isolate the path behind an explicit `legacy/` or
`compat/` boundary and add a loud comment naming the owning spec.

## 5. Active Runtime Authorities

These are the current intended authorities:

- C64 CPU/tick: VICE-shaped microcoded CPU path and Spec 701 runtime controller.
- VIC-II: literal `viciisc` port under `src/runtime/headless/vic/literal/**`.
- 1541: VICE1541 path under `src/runtime/headless/vice1541/**`.
- Live loop: `src/runtime/headless/debug/runtime-controller.ts`.
- V3 live transport: binary WS frame stream, not PNG/base64 frame polling.
- Monitor/debugger: Spec 623 backend-owned monitor/debug controller semantics.
- SID register state: `sid.ts` until Spec 703 reSID/WASM lands.
- SID audio: future `resid-wasm`; current TS `resid.ts` is fallback only.
- Knowledge layer: current `src/project-knowledge/**` schemas and migrations.

Anything outside these paths is suspect until proven active.

## 6. Initial Suspect Inventory

This inventory is intentionally a starting point, not automatic delete list.

### 6.1 1541 / Drive

Known suspects:

```text
src/runtime/headless/_quarantine_vice1541_v4
src/runtime/headless/drive/LEGACY1541.md
src/runtime/headless/drive1541/legacy1541-adapter.ts
```

Questions:

- Is `legacy1541-adapter.ts` still selectable or only historical?
- Do any tests still compare against legacy as a gate?
- Does any production code still instantiate the legacy drive by default?
- Can `_quarantine_vice1541_v4` be removed entirely now that Specs 610-623
  define the active VICE1541 path?

Expected outcome:

- default runtime has no legacy 1541 fallback;
- quarantine source is deleted or moved outside `src/` so it cannot compile or
  be imported accidentally;
- if a legacy mode is retained for comparison, it is moved to an explicit
  `tools/legacy-reference/` area and never used by active runtime.

### 6.2 C64 Runtime / v2

Known suspect:

```text
src/runtime/headless/v2
```

Questions:

- Is it still used for any CLI, trace, or project tool?
- Is it a historical VICE process wrapper or part of current workflows?
- Can it move to `src/runtime/vice/` or `tools/` if still useful?

Expected outcome:

- no active runtime imports from `headless/v2`;
- if kept, its name reflects its actual role and not a competing headless core.

### 6.3 V3 UI / Frame Transport

Known suspects:

```text
src/workspace-ui/v3-ws-server.ts session/screenshot
ui/src/v3/tabs/Live.tsx screenshot fallback paths
PNG/base64 data URL live-frame code
```

Questions:

- Is `session/screenshot` still needed only for snapshots/export?
- Does live mode exclusively use binary frame transport from Spec 701?
- Can screenshot be renamed to `session/screenshot_png` and documented as a
  passive debug/export helper?

Expected outcome:

- no live UI frame loop depends on PNG/base64;
- screenshot route is passive and never advances emulation;
- comments no longer describe old UI-owned timing.

### 6.4 SID

Known suspects:

```text
src/runtime/headless/sid/resid.ts
src/runtime/headless/sid/sid-engine.ts default/fallback comments
```

Questions:

- Until Spec 703 lands, is TS `resid.ts` used by anything important?
- Should default remain register-only or reSID/WASM once implemented?
- How do trace-only sessions opt out of audio?

Expected outcome:

- TS `resid.ts` is marked fallback/test-only or removed after reSID/WASM;
- SID engine names match Spec 703: `fastsid-register` and `resid-wasm`.

### 6.5 Specs / Docs

Known issue:

- archived specs still contain superseded instructions that can mislead agents.

Expected outcome:

- active specs contain concise current truth;
- archived specs stay archived, but active specs must not point agents at
  superseded bodies without warning;
- no new work prompt should ask agents to bulk-read `_archive`.

### 6.6 One-off Scripts and Test Debris

Known suspects:

```text
scripts/diag-614-*.mjs
tests/spec-615/schritt*.test.ts
tests/spec-615/talk-trace-motm.test.ts
session/
snapshots/
```

Questions:

- Are these reproducible regression gates or disposable diagnostics?
- Are `session/` and `snapshots/` generated runtime output that should be
  gitignored / cleaned?

Expected outcome:

- durable tests are renamed and documented;
- disposable probes are removed or moved under `scripts/_archive/`;
- generated output directories are not tracked.

## 7. Phases

### 704.1 Inventory Report

Produce a table:

```text
path | kind | imported by | runtime reachable? | tests reachable? | owner spec | action
```

No source deletion in this phase.

Required commands:

```bash
rg "from .*<candidate>|import .*<candidate>|require\\(" src ui tests scripts
rg "legacy|quarantine|deprecated|session/screenshot|data:image/png|base64" src ui tests scripts specs
```

### 704.2 Generated Output Cleanup

- classify `session/` and `snapshots/`;
- update `.gitignore` if needed;
- remove generated outputs from the working tree if safe.

### 704.3 1541 Legacy Retirement

- remove `_quarantine_vice1541_v4` from `src/` if unused;
- decide whether `legacy1541-adapter.ts` is deleted or moved to explicit
  reference-only location;
- ensure VICE1541 is the only active runtime authority.

### 704.4 v2 / VICE Process Boundary

- audit `src/runtime/headless/v2`;
- delete or rename/move to match actual role.

### 704.5 V3 Transport Cleanup

- remove old live PNG/base64 assumptions;
- keep a passive screenshot/export helper only if needed;
- update comments and route names to avoid implying UI-owned timing.

### 704.6 SID Cleanup

- align engine names and comments with Spec 703;
- do not remove `sid.ts` register baseline;
- demote/remove TS `resid.ts` only after reSID/WASM path exists.

### 704.7 Spec Hygiene

- mark active specs that supersede old bodies;
- avoid long historical bodies in active specs;
- move misleading historical sections to `_archive` or delete from active docs.

## 8. Gates

Run after every deletion phase:

```bash
npm run build:mcp
npm run check:1541-fidelity
```

Run where applicable:

```bash
npm run smoke:701
npm run smoke:v3-ws
```

Runtime gates:

- 616 LOAD matrix remains at current expected status.
- 617 SAVE matrix remains green.
- Existing raster-sensitive corpus remains at current expected status.
- Spec 429 behavior must not change unless the active work is explicitly Spec
  429, not cleanup.

## 9. Acceptance

- Inventory report committed or included in the cleanup PR.
- No active runtime import reaches deleted/quarantined code.
- Default runtime path is VICE1541 + literal VIC + Spec 701 controller.
- Live UI does not use PNG/base64 as its frame clock or frame transport.
- Generated runtime output is not tracked.
- Remaining compatibility paths have explicit owner specs and tests.

## 10. Prompt Template

Use this for an isolated cleanup session:

```text
STOP. Isolated cleanup session for Spec 704. Do not work on Spec 429 or any
runtime bugfix.

Read:
- specs/704-runtime-codebase-cleanup.md

Goal:
Inventory and retire dead legacy/quarantine/runtime debris without changing
emulation behavior.

Rules:
- No timing, VIC, IEC, 1541, SID behavior changes.
- No game-specific fixes.
- No deleting samples, gold traces, or archived specs.
- Do not remove a path until imports and tests prove it is unreachable or an
  active replacement is named.
- If unsure, produce inventory only.

First deliverable:
Create the 704.1 inventory table:
path | kind | imported by | runtime reachable? | tests reachable? | owner spec | action

Then propose the first safe deletion batch. Do not delete before the inventory
is clear.

Gates after any deletion:
- npm run build:mcp
- npm run check:1541-fidelity
- npm run smoke:701
- npm run smoke:v3-ws

Commit only cleanup. No runtime behavior fixes in the same commit.
```

## 11. Legacy 1541 Retirement Plan (measured 2026-05-22)

This section replaces the speculative parts of §6.1. It is grounded in a
measured run, not assumptions. **The conclusion is that retiring LEGACY1541
is no longer blocked on emulator work — it is a formalization + delete task.**

### 11.1 Measured current state

- `drive1541-factory.ts:22` — default implementation is already `"vice"`.
  Spec 611.9's "default flip" is, in code, **already done**. Legacy is
  opt-in only (`requested="legacy"` or `C64RE_DRIVE1541=legacy`).
- `start-v3-server.mjs:34` — the V3 backend defaults to `"vice"`. The live
  UI (motm, LNR, etc.) runs on VICE1541.
- `runtime-proof-gate.mjs` spawns each per-game child with `spawn("node",
  [script])` and **never sets `C64RE_DRIVE1541` in the child env**. With the
  shell var unset, every game child therefore runs on the factory default =
  **vice**. The gate's `flags.drive1541 = "legacy"` (lines 93/123) is a
  cosmetic label in the gate's own summary; it does not reach the GAMES
  loop. The §7 false-green guard (lines 127–166) only blocks the SCENARIOS
  dispatch (`load-directory`), not the 7-game GAMES loop.
- **Consequence: the 7/7 GREEN proof run that gates master was VICE1541.**
  Re-measured 2026-05-22: motm reaches `$b7bf` under **both**
  `C64RE_DRIVE1541=vice` and `=legacy`. vice passes; legacy still passes
  (so legacy is a safe regression lane, not the active path).

So the §7 guard premise — "the C64/IEC/disk runtime path still flows through
LEGACY1541" — is **stale**. It was true at phase 611.2/611.7; it is false now.

### 11.2 The gap is honesty + cleanup, not capability

VICE1541 is the active drive AND passes the gate. What remains:

1. the gate **mislabels** which drive it runs;
2. the §7 guard guards a condition that no longer holds;
3. LEGACY1541 source is still present and selectable;
4. spec text (this doc §5, spec 611 §5 611.9) still reads as "future".

### 11.3 Ordered retirement steps

**R0 — Honest gate (formalize 611.9, no behavior change).**
- In `runtime-proof-gate.mjs`, pass the resolved drive into each child env:
  `spawn("node",[g.script],{ env:{...process.env, C64RE_DRIVE1541: flags.drive1541}, ... })`.
- Flip the gate default from `"legacy"` to `"vice"` (lines 93/123) so the
  label matches what already runs.
- Replace the §7 false-green guard with an opt-in legacy regression lane:
  default = vice (7 games), `--drive1541=legacy` = regression check.
- Gate: `npm run runtime:proof` → confirm 7/7 GREEN under vice **explicitly**
  (all 7, not just motm); `--drive1541=legacy` → confirm regression status.
- This is the measured acceptance of spec 611.9.

**R1 — Severability audit (DONE 2026-05-22, result: NOT cleanly severable).**

A surgery-map audit found LEGACY1541 `drive/**` is **structurally co-resident**
with the vice drive, not an opt-in sidecar. The kernel constructs the legacy
`DriveCpu` / `TrackBuffer` / `HeadPosition` / `GcrShifter` **unconditionally**
(even in vice mode); the vice path overlays onto the shared `iec/**` bus
(which is a SEPARATE module, NOT a deletion target). **Nine active-path call
sites read legacy objects while `drive1541="vice"`:**

| # | site | coupling |
|---|---|---|
| 1 | `kernel/headless-machine-kernel.ts:38-43,161-164,219-473` | builds legacy objects unconditionally; `readonly` typed fields |
| 2 | `headless-machine-kernel.ts:39-40` | shared consts `C64_PAL/NTSC_CYCLES_PER_SEC` from `drive/drive-cpu.ts:79,81` |
| 3 | `kernel/event-catchup-strategy.ts:16,20,84` | types/calls `DriveCpu` (vice uses `eventCatchup`); call already vice-skipped |
| 4 | `scheduler/cycle-wrappers.ts:32,108-151` | `DriveCpuCycled` ticks legacy drive |
| 5 | `integrated-session.ts:17-19,260-266,528-532` | mirrors legacy fields; reads `drive.cpu` (641,723,1042,1367) |
| 6 | `media/mount.ts:176-317` | calls legacy GCR/head methods even in vice mode |
| 7 | `vsf/module-mapping.ts:29,166,483` | legacy GCR-head VSF serialize |
| 8 | `server-tools/headless.ts:217-783` | `headless_drive_session_*` MCP tools via `drive-session-manager` |
| 9 | `traps/kernal-serial.ts:19,89` | type-only `DriveCpu` |

Mitigating: `vice1541/**` + the facade import **nothing** from `drive/**`
(vice logic is self-contained); most vice-mode legacy reads are already inert
(driveClockSource falls back, `executeToClock` skipped, mount.enable skipped);
the only true shared symbols are the two cycles-per-sec constants. So the
retirement is tractable but is a **decoupling refactor, not a delete** — and
it touches live kernel/scheduler/mount wiring, which conflicts with §3's
"no emulator timing / IEC / drive-semantics change" non-goal unless done very
carefully and gated.

**UPDATE 2026-05-22 — R2/R3 DONE (merged master `0411295`).** A dedicated
session executed the full R0→R3 path (user chose "komplett durchziehen", **R2
regression-lane skipped** — legacy is fully gone, not a one-release opt-in).
R0 (honest gate) + R1 (audit) + **Phase A (decouple) + Phase B (delete
`drive/**`)** all landed. The 7-game vice gate stayed GREEN before AND after the
delete. `−13470` lines: `drive/**` (19 files) + `_quarantine_vice1541_v4/**` +
`legacy1541-adapter.ts` removed; all drive readers redirect via
`session.driveDebug()`; standalone `headless_drive_session_*` tools rebuilt
vice-backed. The Phase A/B step-lists below are kept as the historical record
of what was done.

#### Phase A — decouple the active vice path from `drive/**` — DONE (merged 0411295)

Ordered so the build never breaks:

1. Extract `C64_PAL/NTSC_CYCLES_PER_SEC` out of `drive/drive-cpu.ts:79,81` into
   a neutral `c64/timing-constants.ts`; update kernel import (39-40). (Verify
   the vice facade even needs them once the legacy drive is gone.)
2. Kernel: gate legacy object construction behind non-vice mode (make
   `trackBuffer`/`headPosition`/`gcrShifter`/`drive` vice-optional); take the
   vice branch unconditionally (remove the `=== "legacy"` branch 684-688);
   drop the `legacyDeps` arg to `createDrive1541`; re-point `driveClockSource`
   (491-494); guard/remove legacy trace wiring (584-641).
3. `event-catchup-strategy.ts`: make `deps.drive` optional, type-decouple from
   `DriveCpu`; remove `forceLegacyDriveTick`/`C64RE_VICE_LEGACY_DRIVE` plumbing.
4. `scheduler/cycle-wrappers.ts`: remove `DriveCpuCycled` from the vice
   steppable list + delete the class + `DriveCpu` import.
5. `integrated-session.ts`: remove/guard legacy fields + `drive.cpu` reads;
   re-point debug reads to `kernel.drive1541.debugProbe()`.
6. `media/mount.ts`: gate every `trackBuffer`/`gcrShifter`/`headPosition`/
   `drive` call so they no-op in vice mode (vice attach already uses
   `drive1541.attachDisk`).
7. `vsf/module-mapping.ts` + `vsf/drive-vsf.ts`: confirm legacy GCR-head VSF +
   `drive-session-manager` unused in vice; remove or re-point to
   `vice1541/drive_snapshot.ts`.
8. `traps/kernal-serial.ts`: retype off `DriveCpu`.
9. `server-tools/headless.ts`: delete or migrate the `headless_drive_session_*`
   MCP tools (decouple from `drive-session-manager`).

Gate between A and B: `npm run build:mcp` + `npm run runtime:proof`
(vice 7/7) + full `tests/` suite green.

#### Phase B — delete legacy — DONE (merged 0411295)

- Delete `src/runtime/headless/drive/**` (19 files).
- Delete `src/runtime/headless/drive1541/legacy1541-adapter.ts`.
- `drive1541-factory.ts` → vice-only (drop `Legacy1541Adapter` import, the
  `"legacy"` branch, `legacyDeps`, the legacy env/validation).
- `drive1541.ts`: collapse `Drive1541Implementation` to `"vice"`.
- Delete `tests/unit/drive/*.test.ts` + the `drive/**`-importing
  smoke/sprint/probe/audit/diag-611-legacy scripts.
- `runtime-proof-gate.mjs`: remove the `"legacy"`/`"both"` selector handling.
- Gates after each delete: `npm run build:mcp`, `npm run check:1541-fidelity`,
  `npm run runtime:proof` (vice), `npm run smoke:701`, `npm run smoke:v3-ws`.

### 11.4 Out of scope for THIS plan

The two other items from the cleanup request are **not** part of 1541
retirement and are not dead:

- **VIC-II**: only two implementations exist and they are **coupled**, not
  redundant — `vic/literal/**` renders pixels; `vic/vic-ii-vice.ts` is the
  raster / IRQ / bus-steal state authority the literal port reads
  (`integrated-session.ts:1510`). Neither is removable; any change is a
  rewrite, tracked separately.
- **Renderer**: `renderLiteralPortToPng` is active; `renderFrame` is a legacy
  alias still used by the video-export path; VicIIVice snapshot renderers
  were already removed (Spec 404). Only `renderFrame` is a future candidate,
  and only after the export path is migrated.

### 11.5 Prerequisite checklist before R3

- [ ] R0 shipped: gate runs + labels vice honestly, 7/7 GREEN under vice.
- [ ] `--drive1541=legacy` regression lane documented (one release).
- [ ] 617 SAVE matrix green under vice.
- [ ] Spec 429 (LNR) behavior unchanged under vice.
- [ ] No production import reaches `drive/**` or `legacy1541-adapter.ts`.
