# Spec 445 — `gcr.c` write-path + encoder

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 444  
**Doctrine:** Sprint 430 hat nur lese-pfad gemacht. Write-path,
encoder, sector→GCR conversion komplett nicht-portiert.

## VICE source

`gcr.c` 357 LoC. Functions NOT yet in TS:

- `gcr_convert_4bytes_to_GCR` (68-86) — encode 4 raw → 5 GCR bytes
- `gcr_convert_sector_to_GCR` (112-168) — build full sector image
  with header sync, header, gap, data sync, data block, tail gap
- `gcr_write_sector` (294-346) — find header + data sync, replace
  data block with new GCR bytes
- `gcr_create_image` (348-352)
- `gcr_destroy_image` (353-357)
- `GCR_conv_data[16]` table (51-57) — encode lookup

The post-Sprint-430 fix put `From_GCR_conv_data` (decode) inline.
The encode table `GCR_conv_data` is missing.

## Headless target

`src/disk/gcr.ts` — extend with:

- `GCR_ENCODE` constant table = VICE `GCR_conv_data[16]`
- `gcr_convert_4bytes_to_GCR(src: Uint8Array, dest: Uint8Array, srcOffset, destOffset)`
- `gcr_convert_sector_to_GCR(buffer, data, header, gap, sync, errorCode)`
  full signature including the header_t struct + gap + sync override
- `gcr_write_sector(raw: Uint8Array, data: Uint8Array, sector: number) → fdc_err_t`

Plus a `headless_drive_persist_writes` plumbing audit (MCP tool
already exists per `mcp__c64-re__headless_drive_persist_writes`).

## Audit

`docs/spec-445-gcr-write-audit.md` — row per VICE function.

## Acceptance

1. Encode table values literal match VICE `GCR_conv_data`.
2. `gcr_write_sector` literal port with same fdc_err_t return values.
3. Round-trip smoke: random 256-byte data → encode → decode → equal.
4. Replace-sector smoke: write known data to sector 5 of motm
   track 18 → read back via `gcr_read_sector` → equal.
5. Audit doc committed.
6. Canaries still green (write-path not exercised by them).

## Do Not

- Don't add write-back persistence beyond what VICE does.
- Don't change file-format mapping (G64 / D64 write).
- Don't introduce a "fast write" mode.
