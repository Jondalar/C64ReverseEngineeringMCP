# Spec 704 — Runtime Codebase Cleanup and Legacy Retirement

Status: DRAFT  
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
