# Spec 060 — UX2: canonical payload flow + migration prompt

## Problem

The Payloads tab on Murder (screenshot 2026-05-03 12.25.00) shows
33 rows for 16 unique PRGs. Each PRG appears twice — once as
`murder` (disk-extract import), once as `01_murder` (load-sequence
import). Plus the artifact layer has 364 entries for 276 unique
paths (Bug 30): every PRG is registered 3x because `analyze_prg`,
`disasm_prg`, and `register_existing_files` each pass a different
generated `input.id`, bypassing the path-based dedupe in
`saveArtifact`.

The natural fix the user requested is structural, not UI-side:
**fix the data layer so lineage actually works, then the existing
UI lineage filter (Spec 054) just works.** Patching the UI would
only mask the corruption.

## Canonical flow (rule)

> Every code-modify / asset-extract / discovery action MUST honour
> Spec 025 lineage. The UI ALWAYS shows only the latest version of
> a lineage chain. No special-case dedupe in the UI.

Concretely:

1. **First discovery** (e.g. `extract_disk`, `extract_crt`,
   `register_existing_files` on a never-seen file):
   - Compute content hash.
   - Mint artifact with stable id; `lineageRoot = id`,
     `versionRank = 0`, `derivedFrom = undefined`.
   - Mint payload entity (when applicable) with the file's base
     name + the artifact's content hash + load address.

2. **Re-discovery** (same file seen again by another tool —
   `analyze_prg` after `extract_disk`, `register_existing_files`
   on a known file, etc.):
   - **MUST reuse** the existing artifact when `(absPath, contentHash)`
     matches OR `absPath` matches and the existing record carries
     a `contentHash` that hashes the file at the new path.
   - Tools update fields (role, tags, sourceArtifactIds, loadContexts)
     in place. They do NOT create a new artifact id.

3. **Real modification** (patch applied, derivat created, version
   bump):
   - Mint a NEW artifact with `derivedFrom: <existing.id>`.
   - Inherit `lineageRoot` from the parent. `versionRank = parent.versionRank + 1`.
   - The payload entity (if any) ALSO becomes a new entity with
     `derivedFrom` set to the prior payload entity id (entity
     lineage mirrors the artifact lineage).

4. **Naming variants** (load-order-prefix `01_murder` vs base
   `murder`):
   - NEVER spawn a sibling entity. The variant goes into
     `aliases: string[]` on the existing entity.
   - Importers look up by `payloadContentHash` (primary) or
     `(payloadSourceArtifactId, payloadLoadAddress)` (fallback)
     before creating any new entity.

## What this means for the UI

After the canonical flow is enforced, the UI needs **no special
dedupe** for payloads, artifacts, or any list:

- `latestArtifactsByLineage` (Spec 054) collapses lineage chains
  to the latest representative — that's already shipped and
  correct.
- The Stage 2 same-path fallback inside `latestArtifactsByLineage`
  (Bug 24 v2) becomes redundant once Bug 30 migration has run on
  the project. Keep it as a safety net for a release window, then
  remove.
- Payload entity `aliases[]` surface in the inspector header as
  "also known as" pills.

## Implementation: Bug 30 + Bug 31

The architecture rule needs two implementation tracks, tracked as
separate bugs:

- **Bug 30**: artifact saver + migration. Path-based dedupe in
  `saveArtifact` must fire even when callers pass different
  `input.id`. Migration tool `dedupe_artifact_registry()` collapses
  legacy duplicates.
- **Bug 31**: payload entity importer + migration. Importers
  consult existing entities by `payloadContentHash`. Schema add
  `aliases: string[]`. Migration tool `dedupe_payload_entities()`
  folds prefixed-name siblings into the base entity's aliases and
  remaps references.

Both bugs include reference-remap (entities, findings, relations,
flows, tasks, open-questions) so collapsing rows doesn't leave
dangling links.

## Migration prompt for legacy projects (Murder, etc.)

When this spec lands and Bug 30 + Bug 31 are merged, run this
prompt against any existing project workspace to repair the data
base. The prompt is intentionally agent-driven so the LLM can
narrate the diff and surface anything unusual.

```
You are operating inside a C64 RE project workspace. The
project-knowledge layer was previously corrupted by missing
deduplication in saveArtifact (Bug 30) and by parallel payload
entity creation from disk-extract + load-sequence imports
(Bug 31). Spec 060 documents the canonical flow that the data
should now follow.

Run these steps in order. Stop after each and report counts.

1. agent_onboard()
   Verify project metadata + read the timeline.

2. project_audit(fresh=true)
   Capture the audit baseline so we can see what cleans up.

3. List the duplication sample:
   - jq via the Bash tool: count duplicate paths in
     knowledge/artifacts.json
       jq '[.items[] | .relativePath] | length' artifacts.json
       jq '[.items[] | .relativePath] | unique | length' artifacts.json
   - Same for payload entities by content hash:
       jq '[.items[] | select(.payloadLoadAddress != null) | .name]' entities.json | sort | uniq -c
   Report: total artifacts, unique paths, total payload entities,
   number of payload entities sharing a payloadContentHash.

4. dedupe_artifact_registry(dry_run=true)
   Preview the artifact merge plan. Do NOT apply yet. Report
   counts: rows to merge, references to remap (entities, findings,
   relations, flows, tasks, open-questions). Sanity-check a couple
   of merges by reading the survivor + the to-be-merged rows.

5. dedupe_artifact_registry()
   Apply. Verify by re-running the duplicate-paths jq from step 3
   and confirming total == unique.

6. dedupe_payload_entities(dry_run=true)
   Preview the payload-entity merge. Per group, show base entity
   + prefixed siblings + the alias list that will be created.
   Sanity-check that no two genuinely-different payloads (e.g.
   "dad" vs "03_dad" vs "16_dad" if they have different content
   hashes) get merged.

7. dedupe_payload_entities()
   Apply. Verify by listing payload entities again — count should
   match the unique payloadContentHash count from step 3.

8. project_audit(fresh=true)
   Capture the post-migration audit. Diff against step 2's
   baseline; surface any new warnings.

9. agent_record_step(...)
   Record what was done, including the before/after counts and
   anything unusual surfaced during dry-run.

If at any point a dry-run shows an unexpected merge (different
content being collapsed under one row), STOP and report. Do not
apply the migration without explicit user confirmation.
```

The prompt assumes Bug 30 + 31 ship the two MCP tools
`dedupe_artifact_registry` and `dedupe_payload_entities`. Both tools
support `dry_run` and persist nothing on dry runs, so the agent can
preview safely.

## Cross-reference

- Spec 025 (`025-artifact-lineage-and-versions.md`): the
  derivedFrom / lineageRoot / versionRank model this spec enforces.
- Spec 054 (`054-bug24-latest-version-default.md`): the UI lineage
  filter that automatically does the right thing once the data is
  clean.
- Bug 30: artifact saver dedupe + `dedupe_artifact_registry`.
- Bug 31: payload entity dedupe + `aliases[]` schema +
  `dedupe_payload_entities`.
- Bug 24 v2: same-path fallback in `latestArtifactsByLineage` —
  becomes redundant after migration; revert later.
- UX1 (Spec 059): view-centric tabs — Payloads tab survives but
  becomes the canonical "what this project loads" surface; click
  selects, inspector shows aliases + lineage chain.
