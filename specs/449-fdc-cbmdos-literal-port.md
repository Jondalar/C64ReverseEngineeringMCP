# Spec 449 — `fdc.c` + `cbmdos.h` literal port (1541-only mandate)

**Status:** DONE (2026-05-14)
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 445 (INTERIM `fdc_err_t` in `gcr.ts`)
**Proof:** [docs/spec-449-production-proof.md](../docs/spec-449-production-proof.md)
**Mapping:** [docs/spec-449-fdc-cbmdos-mapping.md](../docs/spec-449-fdc-cbmdos-mapping.md)
**Doctrine:** 1541-only V1 scope ([[feedback_vice_no_alternatives]]).
Port literal-VICE WHERE 1541 actually calls it. Document everything
else as OUT V1 with explicit reason — never "weil kann nicht
schaden" / "für später wegnehmen".

## VICE source

- `src/cbmdos.h` (171 LoC) — shared CBM-DOS API surface.
- `src/cbmdos.c` (747 LoC) — DOS command channel implementation.
- `src/drive/ieee/fdc.c` (1253 LoC) — **IEEE-drive-only** WD17xx
  floppy controller state machine.
- `src/drive/ieee/fdc.h` (69 LoC) — fdc.c header.

## Charter correction (vs. epic table)

The epic-1541 row labels this "fdc.c + cbmdos.h" but **fdc.c is
not 1541 code**. 1541 has no separate floppy-controller chip —
the drive CPU drives VIA1 + VIA2 directly to read/write GCR. The
FDC state machine in `src/drive/ieee/fdc.c` belongs to the IEEE
family (8050 / 8250 / 1001 / 2031 / 2040 / 3040 / 4040 / 9000)
and `src/drive` 1571 / 1581 / 4000 paths.

**Conclusion:** fdc.c is 100% OUT-V1 under [[feedback_1541_port_workflow]] /
1541-only mandate. No port. No stub. Ticketed-out only.

## In-scope (1541 V1)

| Item | VICE source | TS target | Action |
|---|---|---|---|
| `fdc_err_t` enum (CBMDOS_FDC_ERR_*) | cbmdos.h:104-119 | new `src/runtime/headless/drive/fdc.ts` | **MIGRATE** from `src/disk/gcr.ts:105-127` INTERIM to canonical file |

Single migration only. ~13 enum values. The full enum is shipped
unchanged (no 1541-only filter inside `fdc_err_t` — VICE 1541
gcr.c can return any of OK/HEADER/SYNC/NOBLOCK/DCHECK/VERIFY/
WPROT/HCHECK/BLENGTH/ID/FSPEED/DRIVE/DECODE depending on disk
state).

## Out-V1 (ticketed)

| Item | VICE source | Reason |
|---|---|---|
| Full `fdc.c` state machine | drive/ieee/fdc.c (1253 LoC) | IEEE-drive-only. 1541 has no FDC chip. |
| `fdc.h` types | drive/ieee/fdc.h | Same — IEEE-only. |
| `CBMDOS_IPE_*` host-level error codes | cbmdos.h:33-78 | 1541 V1 emits no IPE codes via TS IEC layer yet — KERNAL load path doesn't exercise. Defer to DOS-channel spec (post-V1). |
| `CBMDOS_FT_*` filetype constants | cbmdos.h:81-90 | No dir-listing / file-open in 1541 V1 ([[feedback_truedrive_101]] silicon-equivalent goal targets fastloader pass-through, not DOS file API). |
| `CBMDOS_FAM_*` access modes | cbmdos.h:93-96 | Same — no DOS file API. |
| `CBMDOS_SLOT_NAME_LENGTH` | cbmdos.h:101 | Same. |
| `cbmdos_cmd_parse_t` / `_plus_t` | cbmdos.h:121-159 | DOS command channel parser — not exercised by 1541 V1 KERNAL load path. |
| `cbmdos_errortext` | cbmdos.c | Same. |
| `cbmdos_filetype_get` | cbmdos.c | Same. |
| `cbmdos_parse_wildcard_check` / `_compare` | cbmdos.c | Same. |
| `cbmdos_dir_slot_create` | cbmdos.c | Same. |
| `cbmdos_command_parse` / `_plus` | cbmdos.c | Same. |
| 1581 partition codes (CBMDOS_IPE_SEL_PARTN, _TOOLARGE, _ILLEGAL_SYSTEM_T_OR_S, _BAD_PARTN) | cbmdos.h | 1581 only. |

Total OUT V1: ~2000 LoC VICE.
Total IN V1: 13 enum values (~20 LoC TS).

## Workflow (7-step per [[feedback_1541_port_workflow]])

1. **Mapping** — `docs/spec-449-fdc-cbmdos-mapping.md`. Per-item
   IN / OUT rows with file:line cites + reason.
2. **Port** — new file `src/runtime/headless/drive/fdc.ts`. Literal
   port of `fdc_err_t` enum. snake_case verbatim names.
3. **Purge** — remove INTERIM block in `src/disk/gcr.ts:105-127`;
   re-export same names through `fdc.ts` so caller code is
   unchanged. Migrate `gcr.ts` import to point at `fdc.ts`.
4. **Proof** — `docs/spec-449-production-proof.md` with SHAs,
   IN / OUT-V1 table, verification gates.
5. **Tests** — `tests/unit/drive/fdc-conformance.test.ts` —
   13 enum-value pins vs cbmdos.h.
6. **No subagent verdicts.** Claude-self full audit.
7. **No scope creep.** Anything beyond `fdc_err_t` migration MUST
   be ticketed in the OUT-V1 table with file:line + reason.

## Acceptance

1. `src/runtime/headless/drive/fdc.ts` created; defines `fdc_err_t`
   + 13 `CBMDOS_FDC_ERR_*` consts byte-identical to cbmdos.h.
2. `src/disk/gcr.ts` INTERIM block removed; gcr.ts imports from
   `fdc.ts`. Other consumers (`tests/unit/disk/gcr-write-sector.test.ts`)
   continue working unchanged.
3. `tests/unit/drive/fdc-conformance.test.ts`: 13/13 pin tests
   pass.
4. `npm run build`: PASS.
5. Spec 444 cycle-diff unchanged (9999/9999 ±2 sanity gate).
6. canary:spec-430 5/5 PASS.
7. Production-proof doc lists OUT-V1 items with explicit reasons.

## Do Not

- **Don't port `fdc.c`.** It's IEEE-only. Tempting because the
  spec title says "fdc.c", but the title is wrong.
- **Don't port `cbmdos.c`.** 1541 V1 doesn't exercise it. Future
  DOS-channel spec.
- **Don't invent a generic drive-error abstraction.** Use the
  VICE enum verbatim.
- **Don't add `@deprecated` aliases.** Single rename from gcr.ts
  to fdc.ts; gcr.ts becomes a re-export shim or migrates consumers
  atomically.

## Risk

Low. Mechanical migration. Cycle-diff + canary are sanity gates,
not actual drive read/write integration (which is already covered
by Spec 445 / 444 baselines). The only behavioural change is the
import path.

## Out of scope → future specs

- Spec 449.x (post-V1): full `cbmdos.h` + `cbmdos.c` port for DOS
  command channel.
- Spec 449.y (1571/1581 era): `fdc.c` port for IEEE / advanced drives.
- Both are NOT prereqs for shipping 1541 V1 stock silicon-equivalent.
