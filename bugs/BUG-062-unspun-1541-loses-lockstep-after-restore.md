# Bug: a 1541 that never ran its motor loses lockstep after a restore

- **ID:** BUG-062
- **Date:** 2026-09-23
- **Reporter:** llm (Spec 873 build agent, found while writing the checkpoint gate)
- **Area:** runtime
- **Severity:** high
- **Status:** fixed (branch `bug-062-motor-at-reset`, not merged) <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: TRX64 `v0.8.8` (main `bc54bcf`); reproduced on branch `spec-873-folder`
  with and without a folder device attached
- Surface: trx64-core as a library (gate test)
- Project dir: n/a
- Tool / endpoint / tab: drive checkpoint save/restore (`drive_snapshot.rs`)

## What happened

A drive that was empty at power-on, got its disk later and has not run its motor since is
checkpointed and restored. The restored run and the straight run then diverge as soon as
the drive spins up (apart after frame 47). The drive's rotation says "motor on" (its
power-on value) while VIA2's pin says off. The restore re-derives the motor from the pin
(VICE's `undump_prb`), so the restored rotation says "off" where the straight one says
"on".

Why the straight machine disagrees with its own pin: TRX64 skipped VIA2's port-B stores
(`store_prb`, `undump_prb`) while the drive had no disk — a guard carried over from the
TS port. VICE has no such guard; its drive is live with or without a disk. So the DOS's
power-on "motor off" (`$F260`) was lost whenever the disk came after it. The same guard
also dropped head steps and zone changes made with no disk in.

Physically (owner, 2026-09-23): the motor does run for a moment at power-on — VIA pins
are inputs after reset and the line is pulled high until the DOS drives it low. That is
what the rotation's power-on value models; the defect was only the lost store.

## Expected

Restore is cycle-exact for any drive state, including a drive that has never spun. v0.8.8
claims cycle-exact drive restores for 500 frames; the gates that prove it all spin the
drive first.

## Repro steps

1. Power on, drive 8 with a D64, never touch drive 8.
2. Checkpoint, restore into a fresh machine.
3. Run both side by side, then access drive 8 → the runs diverge at the first SYNC read.

Workaround in the 873 gate: list drive 8 once before the checkpoint
(`crates/trx64-core/tests/folder_device_gate.rs:863-870` on `spec-873-folder`).

## Scope guess (optional)

`viacore.rs` `Via2dBackend::store_prb` / `undump_prb`: the `has_image` guard.

## Notes / follow-up

- Remove the workaround in the 873 gate when fixed.
- Open, not this bug: whether a 1541-II starts its motor when a disk is inserted (owner's
  recollection). The 1541-II ROM and schematic decide; not checked yet.
- The other VIA2 hooks (`set_ca2`, `set_cb2`, `store_pra`, `store_pcr`, the reads) keep
  the no-disk guard; each is a deviation from VICE and was left alone here.

---

## Resolution (fill on fix)

- **Root cause:** `Via2dBackend::store_prb` / `undump_prb` returned early without a disk
  (TS-port guard); VICE's drive is live either way.
- **Fix commit:** TRX64 `e9b3691` on `bug-062-motor-at-reset`.
- **Gate proving the fix:** `drive_int_snapshot_gate::a_drive_that_never_spun_restores_cycle_for_cycle`
  (red before: apart after frame 47). Workspace 1398 passed, 1 failed: `trx64-ffi` smoke
  `audio_persistent_engine_continuity`, flaky (passes 2 of 3 reruns alone), not a drive test.
- **Regression risk:** every machine whose disk comes after boot now stops its rotation at
  the DOS's power-on "motor off", as VICE does, and steps its head with no disk in (half-track
  36 → 37 at boot). `snapshot_roundtrip_fidelity` drive-active had passed only through this
  bug (it never pressed RETURN); fixed in the same commit.
