# Spec 507 — VIA2, GCR, and Media

**Status:** STUB  
**Depends on:** 506

## Goal

Allow the native 1541 to read D64/G64 media through drive ROM behavior.

## Scope

- VIA2 PA/PB disk controller behavior
- motor, head step, density, write protect
- GCR shifter/rotation model
- byte-ready / SO line behavior
- SYNC detection
- D64 to GCR conversion path
- G64 parser path
- media trace events

## Acceptance

- `LOAD"$",8` succeeds through real serial on D64.
- native drive status reports motor/head/track/density/SYNC.
- GCR/IEC trace windows can be compared to VICE.
- write support is either implemented or explicitly feature-gated.

