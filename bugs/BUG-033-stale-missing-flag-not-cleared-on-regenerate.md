# BUG-033 — `missing` artifact-version flag is sticky; not cleared when the file reappears

**Severity:** low (cosmetic + confusing current-version selection)
**Area:** artifact version store / `project_inventory_sync` / `mark_artifact_version_stale`
**Status:** fixed (main + secondary)

## Repro
1. `mark_artifact_version_stale(subject, artifact_id, status='missing')` on a version whose file you deleted (clean-restart workflow).
2. Regenerate the same file on disk (`disasm_prg` writes `02_2.0_disasm.asm` again, byte-identical).
3. `project_inventory_sync`.

## Expected
The regenerated file is present on disk → its version status flips back to `available`, and it becomes eligible as auto-current.

## Actual
- The `missing` flag stays set even though the file exists (sticky).
- `project_inventory_sync` instead registered a NEW *related* `.sym` (rank 50) and picked **that** as `Current (auto)` — a symbol file winning over the actual `.asm` listing.
- `set_current_artifact_version` on the `.asm` pins it correctly (manual), but it still displays `· missing` while being current → the Inspector likely shows a "file missing" warning on the current source.

## Evidence (Wasteland project, subject `02_2.0`)
```
Current (manual): .../02_2.0_disasm.asm (…mpsg8d1x) [generated · kickass · rank 100 · missing]   <- present on disk, byte-identical rebuild
                  .../02_2.0_disasm.sym (…mpx0c5op0gfg) [related · sym · rank 50 · available]    <- was auto-current after sync
```

## Suggested fix
- `project_inventory_sync` should reconcile status by filesystem presence: if a `missing`/`stale` version's file is found on disk, clear the flag to `available`.
- Auto-current ranking should never pick a `related` artifact (`.sym`) over a primary listing (`.asm`/`.tass`) of the same subject.

## Resolution (main — FIXED 2026-06-02)
`reconcileArtifactVersionGroups()` (`service.ts`):
- **Reappeared-file clears the flag:** a `missing`/`stale` member whose file now exists
  on disk (`existsSync(resolve(root, path))`) is reconciled back to `available` instead
  of preserving the sticky flag.
- **Primary beats related:** auto-current prefers the best AVAILABLE candidate with
  `role !== "related"` (a `.sym`/doc companion), falling to a related one only when no
  primary is available. So a regenerated `.asm` re-wins over its `.sym`.

Gate `e2e:bug033` 7/7 — primary-not-sym auto-current; mark-missing → reconcile (file
present) → cleared + .asm current + .sym available; genuine-delete → stays missing +
.sym becomes current (only available). Regressions: `e2e:artifact-best-version` 19/19,
`e2e:024` 15/15, project-knowledge-smoke green.

## Secondary (separate, minor) — FIXED 2026-06-05
File-space `routines[]` annotations (e.g. `{address:"C000", name:"installer_entry"}`) only emitted a header *comment* block above the auto-label `WC000:` — they did NOT rename the label. By contrast, relocation `subSegments[].label` DOES rename (`serial_send_2bit:`).

**Fix** (`buildAnnotationsIndex`, `pipeline/src/lib/annotations.ts`): a routine with a
`name` now also seeds `labelsByAddress` → the auto-label is renamed (`WC000:` →
`installer_entry:`), matching the reloc path. The descriptive name is sanitised to a
valid assembler identifier via `toLabelIdent` (`Turn advance` → `Turn_advance`,
`3d engine` → `_3d_engine`) so the rebuild stays byte-identical (labels are symbolic).
Explicit `labels[]` win (seeded first); a name that collides with an explicit label
or another routine, or sanitises to nothing, keeps the auto-label + the routine's
header-comment block (no silent duplicate-label rebuild break). The header comment
block (full prose name) is unchanged.

Gate `smoke:bug033-label` 7/7. No regression: `smoke:741` 50/50, `e2e:751` 27/27,
`e2e:bug033` 7/7, `smoke:resolve-pc` 26/26, `probe:721-j3` 13/13.
