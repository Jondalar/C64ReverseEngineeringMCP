# Legacy 1541 / drive-residue audit (Spec 723.6b)

**Date:** 2026-05-29. Audit-only — input for the 723.6 removal. No code change
in this commit except this file.

Goal: remove the dead legacy-1541 / drive-selection residue **without touching
the VICE1541 port**. The legacy drive itself (`src/runtime/headless/drive/**`,
`DriveCpu`, `TrackBuffer`, `HeadPosition`, `GcrShifter`) was already deleted in
Spec 704 §11 R3. What remains is the *selection scaffolding* that still pretends
a choice exists — every path now resolves to `"vice"`.

## Protected — do NOT touch (active VICE1541 runtime)

- `src/runtime/headless/vice1541/drivecpu.ts`, `drive_6510core.ts`
- VICE1541 VIA / rotation / GCR / diskunit / driverom idle-trap code under
  `vice1541/**`
- `src/runtime/headless/drive1541/vice1541-facade.ts` (the live facade)
- `src/runtime/headless/drive1541/drive-session-manager.ts` — already
  vice-backed (`Vice1541Facade`); the standalone `headless_drive_session_*`
  tools. Not residue. (Has `startTrack`/`deviceId` "API compat" params the vice
  drive ignores — cosmetic, leave.)
- `kernel.drive1541` facade instance + all its methods (`tickToClock`,
  `attachDisk`/`detachDisk`, `reset`, `snapshot`/`restore`, `getAttachedMedia`,
  `unit`) and the `drive1541` checkpoint/VSF blob.

## Inventory + classification

### A) public input, value always `"vice"` → remove

| site | note |
|------|------|
| `IntegratedSessionOptions.drive1541?: Drive1541Implementation` (integrated-session.ts:148) | accepted, passed to kernel deps (461) — always coerced to vice |
| `HeadlessMachineKernelDeps.drive1541?` (headless-machine-kernel.ts:92) | only feeds `resolveDrive1541Implementation` |

### B) dead branch / legacy guard → delete

| site | note |
|------|------|
| `Drive1541Implementation = "legacy" \| "vice"` (drive1541.ts:1) | `"legacy"` arm dead → narrow to `"vice"` or drop the type |
| `resolveDrive1541Implementation()` (drive1541-factory.ts:5-12) | unconditionally returns `"vice"` |
| `assertDrive1541ImplementationAvailable()` (factory:20-24) | empty no-op + its callsite (kernel:191) |
| `createDrive1541(_implementation)` impl param (factory:30-34) | ignores arg; always `new Vice1541Facade()` |
| mount.ts `isViceMode` / `drive1541Implementation === "vice"` guards (mount.ts:145-146, 154, 197-198, 271-274) | always true → the `if (!isViceMode) throw` legacy-fatal arm is dead; collapse to unconditional vice attach/detach + non-fatal disk-parse |

### C) compat alias / status field → remove

| site | note |
|------|------|
| `kernel.drive1541Implementation: Drive1541Implementation` field (headless-machine-kernel.ts:167, set 190) | always `"vice"`; read only by the dead mount.ts guards (B) — remove field once guards gone |

### D) active VICE1541 state/source → KEEP

`kernel.drive1541` facade + methods; `drive1541/` dir (facade + vice-backed
session manager); checkpoint/VSF `drive1541` blob (runtime-checkpoint.ts:160,
snapshot-persistence.ts, drive-vsf.ts); trace-run / v3-ws-server reads of
`kernel.drive1541`. `TrackBuffer`/`HeadPosition`/`GcrShifter` now appear ONLY in
explanatory comments (no live class) — comment tidy optional, not code residue.

## Tool-surface check

- **CLEAN already.** No MCP/UI/agent tool input sets `drive1541` (no schema hit
  in `src/server-tools/**`).
- No `C64RE_DRIVE1541` env is read (the string survives only in a factory
  comment).
- v3-ws-server + tools only *read* `kernel.drive1541` state — never select an
  implementation.

So the product drive path is already unconditionally vice1541; 723.6 removes the
illusion of choice, it does not change the runtime path.

## Status (2026-05-29): 6a + 6b + 6c DONE

- **6a** (commit `620f1b8`) — selection layer deleted; build + probe green.
- **6b** (commit `25558e9`) — mount.ts vice-guards collapsed; build +
  proof-kernal-load + proof-directory-load + runtime:proof 7/7 green.
  `kernel.drive1541Implementation` kept as a constant `"vice"` status field
  (proof scripts assert it — it became a single-path indicator, not dead code).
- **6c** — probe-single-path checks 13-15b added (21/21). Spec 723 updated.
- Pre-existing (NOT a 723.6 regression): `smoke-611-7f-vice-load-directory`
  fails on a stale golden screen-SHA (fails at the 6a baseline too); the
  equivalent `proof-directory-load` is GREEN. Flag for a golden refresh.

## Slices (implementation — gates AFTER each)

- **723.6a — delete the selection layer (A + B-type + C).**
  Remove `resolveDrive1541Implementation` + `assertDrive1541ImplementationAvailable`;
  drop the `Drive1541Implementation` `"legacy"` arm (narrow to `"vice"` or remove
  type + use the literal); `createDrive1541()` param-less; drop
  `IntegratedSessionOptions.drive1541` + kernel dep + `drive1541Implementation`
  field. Structural only.
  Gates: `build:mcp` + `probe-single-path`.
- **723.6b — simplify mount.ts (B-mount).**
  Collapse `isViceMode` / `=== "vice"` guards: unconditional vice attach/detach,
  disk-parse failure stays non-fatal (was the vice-mode behavior). Touches the
  live LOAD/mount path.
  Gates: `build:mcp` + 616 load + 617 save (or the focused mount/disk smokes) +
  `runtime:proof` once (drive path is execution-relevant).
- **723.6c — guard + doc.**
  Extend `probe-single-path.mjs`: no `drive1541` option on the session-start
  tool; factory has no `"legacy"` arm; default kernel drive is the vice facade
  (already check 1g). Update Spec 723 (723.6 done). CLAUDE.md note rides with
  723.8.
  Gates: `build:mcp` + `probe-single-path`.
