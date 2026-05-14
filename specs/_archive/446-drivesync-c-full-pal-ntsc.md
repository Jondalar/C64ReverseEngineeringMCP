# Spec 446 — `drivesync.c` full PAL/NTSC switch (ARCHIVED)

**Status:** SUPERSEDED-BY-058bc45 — replaced by
`specs/446-drivesync-pal-ntsc.md` charter (commit 058bc45). This
older charter file existed in main pre-Epic-440 rewrite. Spec 446
DONE 2026-05-14 (commit 5819f56). Read-only archive.

**Original status (pre-supersede):** OPEN
**Original priority:** MEDIUM
**Parent:** Epic 440  
**Depends on:** Spec 445  
**Doctrine:** Sprint 430 hat nur `sync_factor` PAL-konstante.
`drivesync.c` enthält per-drive-type sync, drive_set_machine_parameter,
event timing, clock_frequency-handling.

## VICE source

`drive/drivesync.c` ~350 LoC. Functions:

- `drivesync_init`
- `drivesync_factor(diskunit_context_t*)` — main entry
- `drive_set_machine_parameter`
- `drivesync_clock_frequency`
- `drivesync_set_4000_mode` / 8x50 / 1581 variants

Plus the relation to `mainc64cpu_clk` (host) and per-drive
`drive_clk`.

## Headless target

`src/runtime/headless/drive/drive-cpu.ts` — `sync_factor` constants
+ accessor. Move to dedicated `drive-sync.ts` per VICE shape.

## Acceptance

1. `src/runtime/headless/drive/drive-sync.ts` exists with
   `drivesync_factor(unit)` and per-drive-type tables.
2. PAL-1541 + NTSC-1541 both produce the exact `sync_factor` VICE
   produces.
3. Audit doc `docs/spec-446-drivesync-audit.md` committed.
4. Canaries green.
5. NTSC regression check deferred to Spec 451.

## Do Not

- Don't add 1571/1581 sync (deferred).
- Don't merge with `drive-cpu.ts` — keep VICE module boundary.
