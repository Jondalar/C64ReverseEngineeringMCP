# Spec 027: Patch Recipes With Byte Assertions And Relocation

## Problem

Crack and port work repeatedly patches extracted binaries. Today
patches live in shell snippets, Python helpers, or hand notes.
Important safety properties — expected original bytes, file offset,
runtime address, relocation bias, source assembler, backup artifact,
verification command, derived artifact — are not first-class.
REQUIREMENTS R18 (Critical).

## Goal

Express every binary patch as a structured record with byte-level
assertions. Apply the patch only when the assertions hold; record
the result as a derived artifact with provenance.

## Approach

### Schema

New artifact role `patch-recipe`. Stored at
`knowledge/patches/<id>.json`:

```ts
interface PatchRecipe {
  id: string;
  title: string;
  reason: string;
  evidence?: EvidenceRef[];
  targetArtifactId: string;
  targetFileOffset?: number;
  targetRuntimeAddress?: number;
  expectedBytes: string;        // hex, e.g. "ad 21 d0 8d 20 d0"
  replacementBytes?: string;    // hex; if absent use `replacementSourcePath`
  replacementSourcePath?: string;
  relocation?: { kind: "bias"; delta: number } | { kind: "absolute"; baseAddress: number };
  sourceAssembler?: string;     // for paste-back from .asm rebuilds
  backupArtifactId?: string;    // pre-patch artifact preserved automatically
  verificationCommand?: string; // optional shell that asserts post-patch invariants
  status: "draft" | "applied" | "verified" | "reverted" | "failed";
  appliedAt?: string;
  appliedHash?: string;
}
```

### MCP tools

- `save_patch_recipe(...)` — create or update a recipe in `draft`.
- `apply_patch_recipe(id, allow_mismatch?: boolean)`:
  1. Read `expectedBytes` from the target file at offset.
  2. If they do not match, refuse unless `allow_mismatch=true`.
  3. Snapshot the pre-patch file via Spec 025 versioning so
     rollback is possible.
  4. Write replacement bytes (with optional relocation transform).
  5. Register the post-patch file as a derived artifact via
     `derivedFrom: targetArtifactId`.
  6. Run `verificationCommand` if present; record exit code and
     `appliedHash`.
- `revert_patch_recipe(id)` — restore from snapshot.
- `list_patch_recipes(filter?)` — by status, target, tag.

### Audit integration

`project_audit` reports:

- recipes in `draft` longer than N days
- recipes whose target artifact bytes no longer match
  `expectedBytes` (drift detection)
- recipes whose `verificationCommand` last failed

### UI

Patches tab (joined to Sprint 18 work):

| Title | Target | Status | Original hash | Patched hash | Verified |

Click row → recipe detail with `expectedBytes` / `replacementBytes`
diff and applied evidence.

## Acceptance Criteria

- A recipe like Accolade `/0` prompt-skip can be saved, applied,
  rolled back, and re-applied without losing the original bytes.
- An `apply_patch_recipe` against drifted target bytes refuses by
  default and reports the actual bytes seen.
- The patched artifact appears in the lineage view as a child of
  the original (Spec 025).

## Tests

- Smoke: create a recipe against a fixture binary, apply, assert
  bytes changed, snapshot exists, derived artifact registered.
- Smoke: apply against drifted bytes, assert refusal.
- Smoke: revert restores original.

## Out Of Scope

- Source-level patching (assembler diffs). Recipes operate on
  bytes; source-level patching is a higher layer that emits
  recipes.
- Chained patch ordering; `apply_patch_recipe` runs one recipe.

## Dependencies

- Sprint 22 (Spec 025) for snapshot + lineage chain.
- Sprint 26 (R20 scenario diff) optional verification hook.
