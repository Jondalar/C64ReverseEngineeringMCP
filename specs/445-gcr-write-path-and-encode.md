# Spec 445 — `gcr.c` write-path + encode literal port

**Status:** OPEN
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441 (rotation), Spec 442 (viacore), Spec 443 (devices),
                Spec 444 (drivecpu)
**Doctrine:** Claude-self literal audit. No subagents
([[feedback_1541_port_workflow]] + [[feedback_vice_no_alternatives]]).

**Anchors:**
- `docs/vice-1541-arch.md` §8 (GCR), §8.2 (encode), §8.3 (write-back)
- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.c` (357 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.h` (73 LoC)

## Klartext

Sprint 430 hat den `gcr.c` LESE-pfad geportet + nach-spec gefixt
(GCR_DECODE table invalid-marker `0xff`→`0`, `gcr_decode_block` num-arg
semantic correction). Aber:

- **Encoder fehlt**: `gcr_convert_4bytes_to_GCR` (core 4→5), `gcr_convert_sector_to_GCR` (full sector incl. header/sync/gap).
- **Write-back fehlt**: `gcr_write_sector` (find target sector, encode new data, write back into track buffer).
- **Runtime write-path coupling fehlt**: drive PA write → GCR_write_value → track bitstream (Spec 441 step 4 wired `GCR_write_value` field but the actual TRACK write isn't.

Spec 445 closes the GCR chip:
- Literal port of all encode functions (gcr_convert_*, gcr_convert_sector_to_GCR)
- Literal port of gcr_write_sector
- Runtime write-back coupling
- Round-trip invariant tests (decode → encode → decode = identity)
- Re-audit existing read-path against VICE (Sprint 430 subagent-audit
  was invalidated under Epic 440 doctrine)

## VICE source of truth

| File | LoC | Function family |
|---|---|---|
| `gcr.c` | 357 | `gcr_convert_4bytes_to_GCR`, `gcr_convert_GCR_to_4bytes`, `gcr_convert_sector_to_GCR`, `gcr_find_sync`, `gcr_decode_block`, `gcr_find_sector_header`, `gcr_read_sector`, `gcr_write_sector`, `gcr_create_image`, `gcr_destroy_image` |
| `gcr.h` | 73 | `gcr_t`, `gcr_header_t`, `disk_track_t`, constants (MAX_GCR_TRACKS=168, SECTOR_GCR_SIZE_WITH_HEADER=335, NUM_MAX_BYTES_TRACK=7928) |

## Headless targets

- `src/disk/gcr.ts` (588 LoC) — already hosts read-path; encode + write-path
  added here.
- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts` — runtime
  write-back hook: when motor on + write-mode + new GCR_write_value
  + byte-ready edge → write byte to track.
- Drive_t struct: `GCR_write_value` + `GCR_dirty_track` already present
  (Spec 441 step 4a).

## Scope

In scope:
- `gcr_convert_4bytes_to_GCR` (gcr.c:68-86): 5×GCR table mapping per
  nybble (GCR_conv_data[16] @ gcr.c:51).
- `gcr_convert_GCR_to_4bytes` (gcr.c:87-111): inverse using
  From_GCR_conv_data[32]. **Re-audit** — TS has `decodeGCRGroup`
  but Sprint 430 subagent flagged + partially fixed; Claude-self verify.
- `gcr_convert_sector_to_GCR` (gcr.c:112-168): full sector encode
  with header GCR + sector-data GCR + sync marks + gaps.
- `gcr_find_sync` (gcr.c:170-204): **Re-audit** — TS has it (Spec 430).
- `gcr_decode_block` (gcr.c:205-233): **Re-audit** — Sprint 430 num-arg
  fix already applied; verify line-by-line.
- `gcr_find_sector_header` (gcr.c:234-end): **Re-audit**.
- `gcr_read_sector` (gcr.h:67, body in gcr.c): **Re-audit**.
- `gcr_write_sector` (gcr.h:68, body in gcr.c): **NEW PORT** — find
  target sector header → write new data-block-GCR + recompute checksum.
- Constants: MAX_GCR_TRACKS, SECTOR_GCR_SIZE_WITH_HEADER, NUM_MAX_BYTES_TRACK.
- Runtime write-back coupling: drive writes (PA store + motor on +
  write-mode) propagate to track buffer.

Out of scope (other specs):
- `gcr_create_image` / `gcr_destroy_image` — image lifecycle, OMIT-OK
  (TS GC + parser owns track allocation).
- VSF snapshot of write-dirty state — Spec 451.
- Disk save-back to .g64 file — separate IO concern.

## Audit procedure (7-step + Claude-self)

1. **Mapping** — `docs/spec-445-gcr-mapping.md` row-per-function +
   row-per-constant verdict matrix. Target 30+ rows.
2. **Port** — fix BUG / MISSING rows literally vs VICE.
3. **Purge** — remove TS-only convenience methods that don't have
   gcr.c equivalent.
4. **Proof** — `docs/spec-445-production-proof.md`.
5. **Tests** — `tests/unit/disk/gcr-encode-decode-roundtrip.test.ts` +
   `tests/unit/disk/gcr-write-sector.test.ts`.
6. **No subagent verdicts** (Sprint 430 audit invalidated; Claude
   re-prüft).
7. **No arch decisions without ask.**

## Acceptance

1. `docs/spec-445-gcr-mapping.md` 30+ row mapping.
2. Each MISSING → port-patch; each BUG → fix.
3. Round-trip invariant test: encode(decode(GCR-buf)) == GCR-buf for
   a representative sample (random sector data from motm/im2 trace).
4. `gcr_write_sector` correctness: write a known data buffer into a
   known sector, decode it back, byte-identical.
5. `npm run canary:spec-430` 5/5 PASS (regression).
6. Existing VIA + drive unit suites no regression.
7. `tests/integration/drivecpu-vs-vice-baseline.test.mjs` still
   9999/9999 within ±1 cycle.
8. `docs/spec-445-production-proof.md` final verdict.
9. No subagent verdicts.

## Do Not

- Do not delegate audit to subagent.
- Do not touch rotation/drive-cpu/viacore semantics (Specs 441-444 closed).
- Do not start Spec 446 before 445 DONE.
- Do not implement disk save-back to G64 file (separate IO concern,
  out of scope).

## Workflow gates

7-step per [[feedback_1541_port_workflow]].
