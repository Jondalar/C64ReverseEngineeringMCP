# Spec 447 — `memiec.c` + `driverom.c` literal port (ARCHIVED PRE-EPIC-440 STUB)

**Status:** SUPERSEDED — pre-Epic-440 stub. Production charter is
`specs/447-memiec-driverom.md` (new in Spec 447 charter commit).
Read-only archive.

**Original status:** OPEN  
**Priority:** MEDIUM  
**Parent:** Epic 440  
**Depends on:** Spec 446

## VICE source

- `drive/iec/memiec.c` 177 LoC — 1541 memory map setup
- `drive/driverom.c` ~300 LoC — ROM image loading + checksum

Functions to port:

- `memiec_init` (138-177) — page-by-page dispatch table setup
- `driverom_load_images`
- `driverom_initialize_traps`
- `driverom_checksum_rom`

## Headless target

Currently spread across `drive-cpu.ts` (memory map) and
`headless-machine-kernel.ts` (ROM loading). Move to dedicated
`drive-mem.ts` and `drive-rom.ts` matching VICE module shape.

## Audit + port

`docs/spec-447-mem-rom-audit.md`.

## Acceptance

1. New files `src/runtime/headless/drive/drive-mem.ts` +
   `drive-rom.ts` with literal VICE function map.
2. Page dispatch tables produce 1:1 same address-to-handler mapping
   for every page 0x00..0xFF.
3. ROM checksum verified against VICE-known checksum constants.
4. Audit doc committed.
5. Canaries green.

## Do Not

- Don't change ROM file paths (existing convention).
- Don't add trap-fastload here (out of V1 scope).
