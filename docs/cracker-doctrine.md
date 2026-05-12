# Cracker-Mode Doctrine

This file is the agent-facing doctrine for cracker / port work. Pair it
with `docs/agent-doctrine.md` (analyst doctrine) — pick one based on
the project goal and switch with `agent_set_role(role="cracker")`.

## Goal Hierarchy

Shipping a patched binary or playable cartridge layout outranks
understanding every byte. Annotate only what the patch / port needs.

## Priority Order (per file kind)

1. **Loader / custom kernal / sector-load ABI** — annotate, document,
   write a `loader-abi` model (Spec 028).
2. **Protection / copy-check** — find triggers, document the gate,
   write patch recipes (Spec 027) that bypass them.
3. **Save / progress / hi-score** — model storage layout and any
   slot/erase ordering constraints (Spec 029).
4. **KERNAL replacement / IRQ table** — document overlay regions and
   constraint collisions before patching.
5. **Asset PRGs** (sprite banks, scene data) — Phase 1 analyze + visual
   preview only. No full annotation. The Spec 022 status checklist
   marks asset PRGs done at this point.

## Required Artifacts Per Patch

Every behaviour-affecting change must produce:

- A `patch-recipe` (Spec 027) with byte assertions.
- A byte-identity rebuild check on the affected listing artifact
  (the `// rebuild verified byte-identical` marker emitted by
  `disasm_prg`).
- Constraint verification (Spec 029) when overlay / flash / KERNAL
  state is touched.
- A scenario diff vs original (Spec 030) when behaviour changes.

## Forbidden Shortcuts

- In-place file edits without a patch recipe.
- Ad-hoc shell scripts that bypass `apply_patch_recipe`.
- Unverified rebuilds. If `assemble_source --compare_to` is missing,
  the patch is not done.
- Untracked overlay copies. Declare resource regions and operations.

## Scenario Discipline

Every behaviour-affecting patch is paired with a named scenario
(Spec 030). Run baseline before patching, run candidate after. Record
the diff. Refuse to call the change "good" without the diff.

## Output Formats

- Patched binary or cartridge layout.
- Build pipeline (Spec 032) that reproduces the patched output.
- No encyclopedic disasm. Document only what the cracker work needs.

## Switching Back

`agent_set_role(role="analyst")` flips back to analyst doctrine.
Switching never deletes prior knowledge; it only changes proposed-next
ranking and onboarding text.
