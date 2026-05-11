# Spec 414 — 1541 Phase H: Lifecycle and integration

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 413
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring drive init / enable / reset / snapshot in line with
`docs/vice-1541-arch.md §13 Phase H` (steps 31–34) and §11.

## Doc anchor

- §13 Phase H
- §2.3 boot/init sequence, §2.4 image attach/detach
- §11 snapshot
- §14 invariants 10, 11

## Canonical content (verbatim §13 Phase H)

31. `drive_init()`: per unit, allocate, set defaults, call
    `drivesync_factor()`, init alarms, init dispatch tables.
32. `drive_enable()` / `drive_disable()`: hook IEC bus callbacks
    (so C64-side flushes target this drive).
33. Reset: hard-reset clears RAM, restarts CPU at reset vector.
    Soft reset = pulse RESET line (or `JMP ($FFFC)` from monitor).
34. Snapshot: per §11.

## VICE source cite

- `drive_init`: `src/drive/drive.c:162`.
- `drive_shutdown`: `src/drive/drive.c:298`.
- Snapshot: `src/drive/drive-snapshot.c`.

## Audit — current TS state

Status:

- Drive init / reset works (boot to $EBFF observed).
- VSF snapshot save/load infrastructure exists (per memos +
  archived Spec 309-H).
- Image attach pulses WPS (§14 invariant 11) — works since memo
  `mount-swap-fixed`.

Deviations to verify:

1. **Drive enable/disable IEC callbacks** (§13 step 32):
   - Required: enable hooks the drive into IEC bus callback list;
     disable removes.
   - Current TS: drive always enabled. Verify whether disable path
     unhooks cleanly (= multi-drive readiness).

2. **Hard vs soft reset** (§13 step 33):
   - Hard: clear RAM, reset CPU.
   - Soft: pulse RESET, RAM preserved.
   - Verify both paths.

3. **Snapshot module order + alarm reschedule** (§14 invariant 10):
   - Required: snapshot stores cycles-until-fire (relative), not
     absolute clock; restore re-arms relative.
   - Current TS: VSF save/load. Verify alarm reschedule.

4. **WPS pulse on attach** (§14 invariant 11):
   - Memo says fixed 2026-05-09. Verify still applied after
     restructure.

## TS extras to DELETE

- Any "auto-enable" hooks that bypass the IEC callback registration
  step.

## NTSC stub

- Lifecycle is rate-agnostic.

## Producer changes

1. Implement clean `drive_enable` / `drive_disable` hooks.
2. Verify reset paths (hard + soft).
3. Verify snapshot alarm rescheduling.

## Consumer changes

- `IntegratedSession` mount/unmount paths route through
  `drive_enable` / `drive_disable`.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4 PASS.
- New smoke `scripts/smoke-414-snapshot-drive.mjs`: VSF save mid-
  game, restore, advance same cycles, drive state identical.
- New smoke `scripts/smoke-414-reset.mjs`: hard reset clears
  RAM; soft reset preserves RAM (sentinel byte test).
- MM + Scramble unchanged.

## Open Questions

- **OQ-414-1**: VICE `drive_enable` exact resource list to hook —
  alarms, IEC callbacks, ROM patches (if any). Cite `drive.c:991`.
- **OQ-414-2**: Snapshot drive module write order — pin in doc §11.

## Files touched

- `src/runtime/headless/drive/drive-cpu.ts` (init/reset)
- `src/runtime/headless/integrated-session.ts` (enable/disable hooks)
- VSF snapshot code (audit)
- 2 new smokes
- `specs/414-1541-phase-h-lifecycle.md` (this)

## Next spec

Spec 415 — 1541 Phase I: Validation.
