# Bug: a 1541 that never ran its motor loses lockstep after a restore

- **ID:** BUG-062
- **Date:** 2026-09-23
- **Reporter:** llm (Spec 873 build agent, found while writing the checkpoint gate)
- **Area:** runtime
- **Severity:** high
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: TRX64 `v0.8.8` (main `bc54bcf`); reproduced on branch `spec-873-folder`
  with and without a folder device attached
- Surface: trx64-core as a library (gate test)
- Project dir: n/a
- Tool / endpoint / tab: drive checkpoint save/restore (`drive_snapshot.rs`)

## What happened

A 1541 that has not run its motor since power-on is checkpointed and restored. The
restored run and the straight run then diverge: the restored drive reads SYNC differently.
The drive's rotation state carries its reset value, "motor on", while VIA2 says the motor
is off. The restore re-derives motor and speed zone from VIA2 (VICE's undump order), so the
restored rotation says "off" where the straight one still says "on".

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

Either the rotation's reset value disagrees with VIA2's reset state (the straight machine is
wrong: at power-on the motor is off), or the restore should carry the rotation's motor flag
instead of re-deriving it. Check what VICE's rotation init sets at drive reset before
choosing.

## Notes / follow-up

- Remove the workaround in the 873 gate when fixed.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
