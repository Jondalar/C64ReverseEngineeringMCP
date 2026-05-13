# Spec 441 step 4 — gcr-shifter.ts → rotation.ts migration plan

## Scope

82 references to `gcrShifter` / `GcrShifter` / `gcr-shifter` across
the TS codebase. The new literal-port `rotation.ts` (committed in
step 3b) does not yet replace gcr-shifter; both modules exist.

Doctrine requires the old TS-OO class be deleted, with all callers
switched to the VICE-shaped top-level functions.

## Sub-steps (each = own commit, builds+canary in between)

### 4a — Drive_t construction
- Add `drive: Drive_t` field to `DriveCpu` (Spec 444 already plans
  this; 441 introduces a minimal version).
- Constructor calls `makeDrive_t({drive, mynumber, clk_ptr})` once.
- `rotation_init(freq=0, dnr=mynumber)` + `rotation_reset(drive)`
  called from `DriveCpu.constructor` and `DriveCpu.reset`.
- Path through cycle-wrappers: `rotation_rotate_disk(drive)`
  invoked alongside existing `gcrShifter.tick(1)` for verification.
- Verification: trace HL shifter byte sequence vs rotation byte
  sequence — must match for a fresh G64 disk.

### 4b — Consumer read migration
- Find every read of `gcrShifter.dataByte`, `gcrShifter.syncBit`,
  `gcrShifter.isSyncActive` and replace:
  - `dataByte` → `drive.GCR_read` (post `rotation_byte_read`)
  - `syncBit` / `isSyncActive` → `rotation_sync_found(drive)`
    (returns 0x80 = no sync, 0 = sync detected — VIA2 PB7)
- Callers identified:
  - `via2-gcr-shifter-coupling.ts` (the adapter — entire module
    gets removed in 4d)
  - `via2d1541.ts` PA backend (reads GCR_read into PA)
  - kernel CIA2 / IEC paths (none for stock 1541; verify)

### 4c — Motor / density / write migration
- Replace `gcrShifter.setMotor(on)` with
  `drive.byte_ready_active = (on ? BRA_MOTOR_ON : 0) | (drive.byte_ready_active & ~BRA_MOTOR_ON)`.
- Replace `gcrShifter.setDensity(zone)` with
  `rotation_speed_zone_set(zone, drive.diskunit.mynumber)`.
- Replace `gcrShifter.notifyAttach/Detach/MediaChange` with direct
  writes to `drive.attach_clk` / `drive.detach_clk` /
  `drive.attach_detach_clk`.
- Caller: `head-position.ts`, `integrated-session.ts`.

### 4d — Snapshot migration
- Replace `gcrShifter.snapshot()` / `gcrShifter.restore()` with
  `rotation_table_get(buf, diskunit_context)` /
  `rotation_table_set(buf, diskunit_context)`.
- Callers: `snapshot.ts` (Spec 215 save-state), `save-load-tests.ts`.

### 4e — Cycle-wrapper switch
- In `cycle-wrappers.ts:121`, replace `gcrShifter.tick(1)` with
  `rotation_rotate_disk(drive)` (only branch).
- Verify per-cycle equivalence via canary trace.

### 4f — Delete legacy
- Remove imports of `GcrShifter` from all files.
- Delete `gcr-shifter.ts`, `via2-gcr-shifter-coupling.ts`,
  `sync-detector.ts` (subsumed).
- Remove `drive-types.ts` `gcrShifter` field; replace with `drive: Drive_t`.

### 4g — Production-proof + tests
- `docs/spec-441-production-proof.md` — single rotation path with
  file:line cites + grep zero for `GcrShifter` / `gcr-shifter`.
- `tests/rotation-formulas.test.ts` — speed-zone tables, sync
  detection, byte-ready signaling per VICE vectors.
- `npm run canary:spec-430` — all 5 canaries green.

## Risk

Steps 4a→4f cannot be merged into one PR safely. Each step
requires its own canary-gate pass. Best executed in a worktree
to keep the working branch buildable.

## Schedule estimate

| Sub-step | Effort | Risk |
|---|---|---|
| 4a Drive_t plumbing | medium | low |
| 4b Consumer reads (via2 PA + 5 grep hits) | medium | high (byte-ready timing) |
| 4c Motor/density/attach | medium | medium |
| 4d Snapshot (save-state plumbing) | medium | high (save-state format change) |
| 4e Cycle-wrapper switch | small | high (per-cycle correctness) |
| 4f Delete legacy + 82 grep hits | medium | medium |
| 4g Proof+tests | medium | low |

Realistic: 7-12 commits across 1-3 dedicated sessions, with
canary verification between each commit. The current session
already invested heavily in P64 stubs + rotation.ts. Resume step
4a in a fresh session OR continue NOW knowing each sub-step may
take 30+ min of focused work.

## What's committed today

- `docs/spec-441-mapping.md` (step 1)
- `src/disk/p64-types.ts` (step 2a)
- `src/disk/p64.ts` (steps 2b + 2c)
- `src/runtime/headless/drive/drive-t.ts` (step 3a)
- `src/runtime/headless/drive/rotation.ts` (step 3b)

## What's NOT yet committed

- gcr-shifter.ts still in production path
- rotation.ts exists but never called from runtime
- No production-proof / tests
