# Spec 033: Cracker-Mode Doctrine

## Problem

`agent_set_role(role="cracker")` exists but does not differ visibly
from `analyst`. The analyst doctrine optimises for exhaustive
documentation; the cracker doctrine optimises for shipping a
patched binary (or cart layout) with minimal surface area. Without
an explicit doctrine, cracker sessions either over-document
(wasting effort on asset PRGs) or skip safety steps (no patch
recipes, no constraint checks). REQUIREMENTS P3 (process item).

## Goal

Document the cracker doctrine as `docs/cracker-doctrine.md`. Surface
it via the MCP prompt `c64re_cracker_doctrine` analogous to
`c64re_agent_doctrine`. Have `agent_set_role(role="cracker")`
actually affect tool suggestions and onboarding.

## Approach

### Doctrine document

`docs/cracker-doctrine.md` covers:

- **Goal hierarchy**: shipping a patched binary > understanding
  every byte. Annotate only what the patch / port needs.
- **Priority order** by file kind:
  1. loader / custom kernal / sector-load ABI
  2. protection / copy-check
  3. save / progress / hi-score
  4. KERNAL replacement / IRQ table
  5. asset PRGs (sprite banks, scene data) — Phase-1 + visual
     preview only, no full annotation.
- **Required artifacts per patch**: patch recipe (Spec 027),
  byte-identity rebuild check, constraint verification (Spec 029),
  scenario diff vs original (Spec 030).
- **Forbidden shortcuts**: in-place file edits without a patch
  recipe, ad-hoc shell scripts that bypass `apply_patch_recipe`,
  unverified rebuilds, untracked overlay copies.
- **Scenario discipline**: every behaviour-affecting patch has a
  named runtime scenario (Spec 030) that proves the change before
  and after.
- **Output formats**: patched binary, cartridge layout, build
  pipeline (Spec 032). Encyclopedic disasm is out of scope.

### MCP prompt

`c64re_cracker_doctrine` returns the doctrine text plus the
project-specific overrides from `project-profile.json`
(`crackerOverrides?: string[]`).

### Role-aware behavior

`agent_set_role(role="cracker")` flips a project-state flag
`activeRole: "cracker"`. With the flag set:

- `agent_propose_next` ranks loader / protection / save routines
  ahead of asset PRGs.
- `agent_onboard` quotes the cracker doctrine instead of the
  analyst doctrine.
- Tools that produce encyclopedic output (e.g. `disasm_prg` against
  a content asset) emit a low-priority hint instead of being
  suggested.
- Per-file workflow status (Spec 022 / Sprint 19) uses a shorter
  done-checklist for asset PRGs (Phase-1 + preview = done) and the
  full checklist for loader / protection routines.

### Switching back

`agent_set_role(role="analyst")` restores analyst doctrine.
Switching does not delete prior knowledge; it changes proposed-next
ranking only.

## Acceptance Criteria

- `c64re_cracker_doctrine` returns a non-empty doctrine document
  that describes the cracker priority order and required artifacts.
- After `agent_set_role(role="cracker")`, `agent_propose_next` on
  the BWC project ranks loader / protection PRGs above asset PRGs.
- Asset PRG status check (Sprint 19) reports "done" after analyze +
  preview, without requiring annotations.

## Tests

- Smoke: set role to cracker, assert proposed-next ordering on a
  staged fixture with a loader PRG and an asset PRG.
- Smoke: doctrine prompt returns expected sections.

## Out Of Scope

- Auto-classifying a PRG as "loader" vs "asset" (manual tag for
  v1; auto-classify in a later sprint).
- A separate cracker UI.

## Dependencies

- Sprint 19 (per-file status) — uses the role to choose the
  checklist.
- Sprint 23 (Spec 026 project profile) — overrides come from
  `project-profile.json`.
- Sprint 24 (Spec 027 patches) — required artifact.
