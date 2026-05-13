# Spec 451 — NTSC regression check (PAL-first done)

**Status:** OPEN  
**Priority:** LOW  
**Parent:** Epic 440  
**Depends on:** Spec 450

## Goal

After PAL is locked-down via 1:1 port, verify NTSC still works.
Per [[feedback_pal_first_ntsc_later]] NTSC is a follow-up
validation, never a parallel track.

## Tasks

1. NTSC `sync_factor` from `drivesync.c` table (Spec 446 already
   established).
2. Switch a single canary (e.g. an NTSC variant of motm or any
   NTSC test image) to NTSC mode.
3. Run trace + diff vs VICE NTSC baseline.

## Acceptance

1. NTSC sync constant matches VICE.
2. Trace divergence report shows clean NTSC operation on one
   canary.
3. Doc `docs/spec-451-ntsc-regression.md`.

## Do Not

- Don't make NTSC the default.
- Don't combine PAL+NTSC dual-mode.
