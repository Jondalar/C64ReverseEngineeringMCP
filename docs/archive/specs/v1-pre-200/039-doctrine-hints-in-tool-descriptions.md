# Spec 039: Doctrine Hints In Tool Descriptions

## Problem

Tool descriptions tell the agent what a tool does but not how it
fits into the workflow. `save_finding` description does not mention
that the result is visible in the Findings tab, or that
`render_docs` writes `docs/FINDINGS.md`, or that it belongs to
phase 5+. REQUIREMENTS R11.

## Goal

Add concise doctrine hints to the descriptions of every
state-changing MCP tool. Phase tags are auto-injected from the
`phase-tools.ts` registry so they stay in sync.

## Approach

### Auto-injected phase tag

A wrapper `tagDescriptionWithPhase(toolName, baseDescription)`
prepends `[Phase N]` (or `[Phase agnostic]`) read from
`PHASE_TOOLS` / `PHASE_AGNOSTIC_TOOLS`.

Applied at server-init by walking the tool registry. The original
description string in source stays clean; the prefix appears in the
description the client receives.

Implementation: light wrapper around `server.tool()` that reads the
allow-list lookup and rewrites the description before
registration. Falls back to the original description if the tool is
not phase-tagged.

### Manual "Note:" lines per tool

Hand-curated 1-2 line "Note:" addendum on the tools where it adds
value:

| Tool family | Note template |
|-------------|---------------|
| `save_finding` | "Visible in UI Findings tab; render_docs writes docs/FINDINGS.md; pair with save_entity to make findings discoverable; evidence[] strongly recommended for refuted/dangerous status." |
| `save_entity` | "Visible in UI Entities tab; pair with save_artifact (artifactIds) so entities are discoverable from the artifact panel." |
| `save_open_question` | "Visible in UI Questions tab; default source=human-review; pass source=heuristic-phase1 for auto-generated questions." |
| `save_anti_pattern` | "Surfaced in agent_onboard high-severity warnings; render_docs writes docs/ANTI_PATTERNS.md." |
| `save_patch_recipe` | "Pair with apply_patch_recipe; status starts at draft; snapshots prior bytes via Spec 025." |
| `register_load_context` | "Surfaces in memory-map view as additional cell when kind=runtime; pair with declare_loader_entrypoint for full ABI capture." |
| `declare_loader_entrypoint` | "Pair with record_loader_event from a VICE trace to capture observed call sites." |
| `register_resource_region` | "Reference from register_operation.affects to enable verify_constraints checks." |
| `register_payload` | "Use bulk_create_cart_chunk_payloads for cart-chunk-derived payloads; sets payloadFormat / payloadLoadAddress / payloadSourceArtifactId so the reverse workflow can find the bytes." |
| `render_docs` | "Bulk operations should pass defer=true and call render_docs once at the end." |
| `agent_advance_phase` | "Skipping more than one phase forward requires evidence string; cannot move backward." |
| `agent_freeze_artifact` | "Freezes the artifact at its current phase; counts as 'done' for cracker mode asset PRGs." |

### Coverage scope

- All `save_*` tools
- All `apply_*` / `revert_*` tools
- All `register_*` tools
- All `declare_*` tools
- All `render_*` tools
- `advance_*` / `freeze_*` tools
- ~50 tools total

`list_*` and `read_*` tools skipped — self-evident.

## Acceptance Criteria

- `save_finding` description starts with `[Phase 5]` and ends with
  the visibility/render_docs note.
- A tool not in the phase registry keeps its original description
  unchanged (no phantom phase tag).
- `c64ref_lookup` (read-only) keeps its original description
  unchanged.

## Tests

- Smoke: query MCP tool list, assert top-N tools have phase prefix
  matching their `PHASE_TOOLS` membership.
- Smoke: assert a list-only tool keeps its description.

## Out Of Scope

- Per-tool LLM-generated documentation.
- Auto-translation to other languages.

## Dependencies

- Spec 034 phase registry (`src/agent-orchestrator/phase-tools.ts`).
- Spec 031 doc renderer (referenced in Notes).
