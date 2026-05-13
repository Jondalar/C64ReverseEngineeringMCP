# Spec 441 — overnight halt note

Generated 2026-05-13 23:46 CEST. Claude session running while user
asleep. Halted before per-cycle migration to avoid silent-breakage.

## Why halted before step 4b

Steps 4b through 4g change per-cycle drive behavior. Specifically:

- **4e (cycle-wrapper switch)** replaces `gcrShifter.tick(1)` with
  `rotation_rotate_disk(drive)` in `cycle-wrappers.ts:121`. This is
  the per-drive-cycle entry point. A bug anywhere in rotation.ts
  (1070 LoC of fresh port, audited only by Claude in step 3b) silently
  produces wrong byte-ready timing → fastloaders fail → canary red.
- **4b (consumer reads)** replaces `gcrShifter.dataByte` with
  `drive.GCR_read`. Requires 4e to have updated `drive.GCR_read` per
  cycle. Tightly coupled.
- **4c (motor/density/attach)** changes when rotation starts. Drives
  that fail to wake up are silently dead.
- **4d (snapshot)** changes save-state format. Existing snapshots
  become incompatible.

Without a human watching the canary results, a silent break could
cascade into multiple "fixes" that compound the problem.

## What IS done (committed today)

- `docs/spec-441-mapping.md` (step 1)
- `src/disk/p64-types.ts` (step 2a — TP64* structs)
- `src/disk/p64.ts` (step 2b real MemoryStream + step 2c stubs)
- `src/runtime/headless/drive/drive-t.ts` (step 3a — Drive_t struct
  with 50 fields)
- `src/runtime/headless/drive/rotation.ts` (step 3b — 22 fns,
  1070 LoC literal port of VICE rotation.c)
- `docs/spec-441-step-4-migration-plan.md` (step 4 plan)
- `DriveCpu.drive: Drive_t` field + `rotation_init/reset` calls
  (step 4a — parallel plumbing, no behavior change)

Canary gate (motm) post-4a: **PASS** — no regression.

## What needs human-supervised work (steps 4b-4g)

| Step | Effort | Risk | Action |
|---|---|---|---|
| 4b consumer reads | 30-45 min | HIGH | replace ~10 .dataByte/.syncBit sites with drive.GCR_read / rotation_sync_found |
| 4c motor/density/attach | 30 min | MED | route notifyAttach/Detach/MediaChange to drive.* fields |
| 4d snapshot | 45 min | HIGH | save-state format compat needed |
| 4e cycle-wrapper switch | 15 min | HIGH | flip cycle-wrappers.ts:121 to rotation_rotate_disk |
| 4f delete gcr-shifter | 30 min | MED | 82 grep hits to clean |
| 4g production-proof + tests | 45 min | LOW | docs + smokes |

Total: ~3 hours focused work with canary gate between each step.

## Resume instructions

1. `git log --oneline -10` to confirm `98e9133` ("step 4a") is latest.
2. `npm run canary:spec-430 -- --only motm,im2,lnr-s1` to baseline.
3. Start step 4b — see migration plan
   (`docs/spec-441-step-4-migration-plan.md`).
4. Build + canary between each sub-step.
5. Halt + commit if any canary regresses; investigate against the
   literal port (per Spec 430 doctrine).

## Doctrine reminders

- Subagent verdicts forbidden ([[feedback_1541_port_workflow]]).
- No alternatives / always 1:1 VICE ([[feedback_vice_no_alternatives]]).
- P64 helpers stay stubs ([[feedback_p64_stubs_ok]]).
- Architectural decisions require user approval; halt on conflict
  (workflow step 7).
